import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { FeedbackDb } from './ingest';
import { drainFeedbackNotifications } from './notifications';
import { readFileSync } from 'node:fs';
import { additiveSQL } from '../../../../.github/scripts/production-migrations.mjs';
const now = new Date('2026-11-11T20:00:00Z');
const notice = { reportId: '550e8400-e29b-41d4-a716-446655440002', category: 'bug', createdAt: now, attempts: 0 };
function database(input: { locked?: boolean; notice?: typeof notice | null } = {}) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const execute = vi.fn(async (query: SQL) => {
        const q = new PgDialect().sqlToQuery(query); statements.push(q);
        if (q.sql.includes('pg_try_advisory_xact_lock')) return [{ locked: input.locked ?? true }];
        if (q.sql.includes('SELECT n.report_id')) return input.notice === null ? [] : [input.notice ?? notice];
        return [];
    });
    const transaction = vi.fn(async (cb: (tx: { execute: typeof execute }) => Promise<unknown>) => cb({ execute }));
    return { db: { transaction } as unknown as FeedbackDb, statements, transaction };
}
describe('durable feedback notification drain', () => {
    it('keeps live queued reports but removes orphan metadata without mail configuration', async () => {
        const d = database();
        expect(await drainFeedbackNotifications(d.db, null, now)).toEqual({ accepted: 0, retry: 0, skipped: true });
        expect(d.transaction).toHaveBeenCalledTimes(1);
        expect(d.statements).toHaveLength(2);
        expect(d.statements[1]!.sql).toContain('NOT EXISTS');
    });
    it('cannot send while another sweep owns the transaction lock', async () => {
        const d = database({ locked: false }); const send = vi.fn();
        expect(await drainFeedbackNotifications(d.db, send, now)).toEqual({ accepted: 0, retry: 0, skipped: true });
        expect(send).not.toHaveBeenCalled(); expect(d.statements).toHaveLength(1);
    });
    it('claims only due undelivered rows and records acceptance in the same transaction', async () => {
        const d = database(); const send = vi.fn(async () => ({ accepted: true as const, messageId: 'provider-123' }));
        expect(await drainFeedbackNotifications(d.db, send, now)).toEqual({ accepted: 1, retry: 0, skipped: false });
        expect(send).toHaveBeenCalledExactlyOnceWith({ reportId: notice.reportId, category: notice.category, createdAt: now.toISOString() });
        const claim = d.statements.find(s => s.sql.includes('SELECT n.report_id'))!;
        expect(claim.sql).toContain('accepted_at IS NULL'); expect(claim.sql).toContain('FOR UPDATE SKIP LOCKED');
        expect(d.statements.at(-1)!.sql).toContain('accepted_at =');
        expect(d.statements.at(-1)!.params).toContain('provider-123');
    });
    it.each([0, 20])('keeps failures durably retryable with bounded backoff (attempt %i)', async attempts => {
        const d = database({ notice: { ...notice, attempts } });
        expect(await drainFeedbackNotifications(d.db, async () => { throw new Error('secret'); }, now)).toEqual({ accepted: 0, retry: 1, skipped: false });
        const update = d.statements.at(-1)!;
        expect(update.sql).not.toContain('accepted_at =');
        expect(update.params[0]).toBe(new Date(now.getTime() + (attempts === 0 ? 60_000 : 6 * 3_600_000)).toISOString());
    });
    it('never sends when there is no due report', async () => {
        const d = database({ notice: null }); const send = vi.fn();
        expect(await drainFeedbackNotifications(d.db, send, now)).toEqual({ accepted: 0, retry: 0, skipped: false });
        expect(send).not.toHaveBeenCalled();
    });
    it('uses the production additive grammar and enqueues no historical feedback', () => {
        const migration = readFileSync(new URL('../../../drizzle/0022_feedback_notifications.sql', import.meta.url), 'utf8');
        expect(additiveSQL(migration, ['public'])).toBe(migration);
        expect(migration).not.toMatch(/INSERT|SELECT/i);
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('FROM public, anon, authenticated');
    });
});

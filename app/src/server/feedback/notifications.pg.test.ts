/** Disposable PostgreSQL only; actual transaction locks and queue persistence, no mail credential. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FeedbackDb } from './ingest';
import { drainFeedbackNotifications } from './notifications';
const PG = process.env.EZIL_PG_TEST_URL;
const now = new Date('2026-11-11T20:00:00Z');
describe.skipIf(!PG)('feedback notification outbox on PostgreSQL', () => {
    const name = `feedback_mail_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const db = (client ? drizzle(client) : null) as unknown as FeedbackDb;
    let created = false;
    beforeAll(async () => {
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${name}`); created = true;
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_feedback_reports (id uuid NOT NULL)`);
        const migration = readFileSync(new URL('../../../drizzle/0022_feedback_notifications.sql', import.meta.url), 'utf8');
        await admin!.begin(tx => tx.unsafe(migration.replaceAll('public.', `${name}.`)));
    });
    afterAll(async () => {
        if (created) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await client?.end(); await admin?.end();
    });
    async function enqueue() {
        const id = randomUUID();
        await client!.unsafe('INSERT INTO ezil_feedback_reports VALUES ($1)', [id]);
        await client!.unsafe(`INSERT INTO ezil_feedback_notifications VALUES ($1,'bug',$2,0,$2,NULL,NULL)`, [id, now.toISOString()]);
        return id;
    }
    it('overlapping sweeps send once and committed acceptance is never resent', async () => {
        const id = await enqueue();
        let entered!: () => void, finish!: () => void;
        const inSend = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const send = vi.fn(async () => { entered(); await gate; return { accepted: true as const, messageId: 'provider-accepted' }; });
        const first = drainFeedbackNotifications(db, send, now);
        await inSend;
        try { expect(await drainFeedbackNotifications(db, send, now)).toEqual({ accepted: 0, retry: 0, skipped: true }); }
        finally { finish(); }
        expect(await first).toEqual({ accepted: 1, retry: 0, skipped: false });
        expect(await drainFeedbackNotifications(db, send, now)).toEqual({ accepted: 0, retry: 0, skipped: false });
        expect(send).toHaveBeenCalledTimes(1);
        const [row] = await client!.unsafe('SELECT attempts, accepted_at, provider_message_id FROM ezil_feedback_notifications WHERE report_id=$1', [id]);
        expect(row).toMatchObject({ attempts: 1, provider_message_id: 'provider-accepted' });
        expect(row!.accepted_at).not.toBeNull();
    });
    it('provider downtime survives transactions and retries only after its durable due time', async () => {
        const id = await enqueue(); const fail = vi.fn(async () => ({ accepted: false as const }));
        expect(await drainFeedbackNotifications(db, fail, now)).toEqual({ accepted: 0, retry: 1, skipped: false });
        expect(await drainFeedbackNotifications(db, fail, now)).toEqual({ accepted: 0, retry: 0, skipped: false });
        expect(fail).toHaveBeenCalledTimes(1);
        const [row] = await client!.unsafe('SELECT attempts,next_attempt_at,accepted_at FROM ezil_feedback_notifications WHERE report_id=$1', [id]);
        expect(row!.attempts).toBe(1); expect(row!.accepted_at).toBeNull();
        expect(new Date(row!.next_attempt_at).toISOString()).toBe('2026-11-11T20:01:00.000Z');
        const send = vi.fn(async () => ({ accepted: true as const, messageId: 'retry-accepted' }));
        expect(await drainFeedbackNotifications(db, send, new Date('2026-11-11T20:01:00Z'))).toEqual({ accepted: 1, retry: 0, skipped: false });
    });
    it('removes deleted reports without sending their queued notice', async () => {
        const id = await enqueue(); await client!.unsafe('DELETE FROM ezil_feedback_reports WHERE id=$1', [id]);
        const send = vi.fn();
        expect(await drainFeedbackNotifications(db, null, now)).toEqual({ accepted: 0, retry: 0, skipped: true });
        expect(send).not.toHaveBeenCalled();
        expect(await client!.unsafe('SELECT 1 FROM ezil_feedback_notifications WHERE report_id=$1', [id])).toHaveLength(0);
    });
});

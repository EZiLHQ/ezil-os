/**
 * Same pg-proxy harness as queries.test.ts: these assert the generated SQL
 * and driver result shape, not execution against a live Postgres server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { persistenceHealth, type PersistenceHealthRow, type QueryDb } from './queries';

function makeTestDb(rows: unknown[] = []) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => {
        statements.push({ sql, params });
        return { rows };
    }, { schema }) as unknown as QueryDb;
    return { db, statements };
}

async function generatedSql() {
    const { db, statements } = makeTestDb();
    await persistenceHealth(db);
    return statements[0]!.sql.replace(/\s+/g, ' ').trim();
}

describe('persistenceHealth', () => {
    it('returns an empty-safe array and binds a deterministic clock as a timestamp', async () => {
        const { db, statements } = makeTestDb();
        const now = new Date('2026-10-11T12:00:00Z');
        expect(await persistenceHealth(db, { now })).toEqual([]);
        expect(statements).toHaveLength(1);
        expect(statements[0]!.params).toEqual([now.toISOString()]);
        expect(statements[0]!.sql).toMatch(/SELECT \$1::timestamptz AS at/);
        expect(statements[0]!.sql).not.toContain(now.toISOString());
    });

    it('uses the database clock by default and restricts the receipt window to attributed persistence events', async () => {
        const query = await generatedSql();
        expect(query).toContain('SELECT now() AS at');
        expect(query).toContain("e.event_class = 'persistence'");
        expect(query).toContain('e.computer_id IS NOT NULL');
        expect(query).toContain("e.received_at >= c.at - interval '7 days'");
        expect(query).toContain('e.received_at <= c.at');
        expect(query).toContain('FROM recent GROUP BY computer_id');
    });

    it('computes the eight-hex MD5 prefix in SQL and exposes no raw computer or user identifiers', async () => {
        const query = await generatedSql();
        expect(query).toContain('left(md5(t.computer_id::text), 8) AS "computerShort"');
        expect(query).not.toMatch(/user_id|user_hash|detail/);
        const healthProjection = query.split('health AS ( SELECT ')[1]!.split(' FROM totals')[0]!;
        expect(healthProjection.replace('left(md5(t.computer_id::text), 8)', '')).not.toContain('computer_id');
        const finalProjection = query.split('SELECT h.')[1]!.split(' FROM health')[0]!;
        expect(finalProjection).not.toContain('computer_id');
        expect(finalProjection).not.toContain('user_hash');
        expect(query).not.toMatch(/SELECT (?:e\.|t\.|l\.)?\*/);
    });

    it('uses occurrence order with stable receipt/event tie breakers for all latest event selections', async () => {
        const query = await generatedSql();
        expect(query.match(/SELECT DISTINCT ON \(computer_id\)/g)).toHaveLength(5);
        expect(query.match(/ORDER BY computer_id, occurred_at DESC, received_at DESC, event_id DESC/g)).toHaveLength(5);
        expect(query).toContain("WHERE site IN ('persist.system.restore', 'persist.workspace.restore')");
        expect(query).toContain("jsonb_build_object('site', site, 'code', code, 'outcome', outcome, 'at', occurred_at)");
        expect(query).toContain("WHERE site IN ('persist.system.flush', 'persist.system.restore')");
        expect(query).toContain("WHERE site IN ('persist.workspace.flush', 'persist.workspace.restore')");
        for (const relation of ['restores r', 'system_events s', 'workspace_events w']) {
            expect(query).toContain(`LEFT JOIN ${relation} USING (computer_id)`);
        }
    });

    it('keeps shell saving-paused reports and attr-less worker events from replacing the latest age sample', async () => {
        const query = await generatedSql();
        expect(query).toContain('e.event_id, e.source, e.site');
        const latest = query.split('latest AS ( ')[1]!.split('), latest_events AS (')[0]!;
        expect(latest).toContain(
            "FROM recent WHERE source = 'worker' AND site <> 'persist.shell_seen' " +
            "AND (attrs ? 'system_age_s' OR attrs ? 'workspace_age_s') ORDER BY",
        );
        // An age sample is optional: a computer seen only by the shell or
        // with attr-less events must still appear with unknown ages.
        expect(query).toContain('LEFT JOIN latest l USING (computer_id)');
    });

    it.each(['system', 'workspace'])('adds elapsed seconds to the latest %s age and preserves unknown ages', async (layer) => {
        const query = await generatedSql();
        // CASE without ELSE keeps missing/non-number attrs null; nullif
        // keeps the contract's -1 sentinel null even after adding elapsed time.
        expect(query).toContain(
            `CASE WHEN jsonb_typeof(l.attrs -> '${layer}_age_s') = 'number' ` +
            `THEN nullif((l.attrs ->> '${layer}_age_s')::double precision, -1) ` +
            `+ extract(epoch FROM (c.at - l.occurred_at))::double precision END AS "${layer}OkAgeS"`,
        );
        expect(query).toContain('SELECT DISTINCT ON (computer_id) computer_id, attrs, occurred_at FROM recent');
        expect(query).not.toMatch(/coalesce\([^)]*age_s/i);
    });

    it('counts only stops with the JSON boolean true and uses occurrence time for heartbeat and activity', async () => {
        const query = await generatedSql();
        expect(query).toContain(
            "count(*) FILTER (WHERE site = 'persist.stop' AND attrs -> 'discarded_unsaved' = 'true'::jsonb)::int AS discarded",
        );
        expect(query).toContain("max(occurred_at) FILTER (WHERE site = 'persist.heartbeat') AS heartbeat_at");
        expect(query).toContain('max(occurred_at) AS seen_at');
    });

    it.each(['system', 'workspace'])('flags all three blocked-save codes for the %s layer independently', async (layer) => {
        const query = await generatedSql();
        expect(query).toContain(`coalesce("${layer}Code" IN ('too_large', 'stale', 'not_restored'), false)`);
        expect(query).toContain(
            `coalesce("systemCode" IN ('too_large', 'stale', 'not_restored'), false) OR ` +
            `coalesce("workspaceCode" IN ('too_large', 'stale', 'not_restored'), false) OR`,
        );
    });

    it('flags system ages strictly over 1800 seconds only when seen within 30 minutes', async () => {
        const query = await generatedSql();
        expect(query).toContain(
            `OR coalesce("lastSeenAt" >= c.at - interval '30 minutes' AND "systemOkAgeS" > 1800, false)`,
        );
        expect(query).not.toMatch(/"workspaceOkAgeS"\s*>/);
    });

    it('flags the latest event strictly older than 30 minutes, except stops, when seen within 2 hours', async () => {
        const query = await generatedSql();
        expect(query).toContain(
            `OR coalesce("lastSeenAt" < c.at - interval '30 minutes' ` +
            `AND "lastEventSite" <> 'persist.stop' ` +
            `AND "lastSeenAt" >= c.at - interval '2 hours', false) AS flagged`,
        );
        // Heartbeat presence/age cannot make a normally idle-stopped computer
        // stale, or hide stale computers that have never emitted a heartbeat.
        expect(query).not.toMatch(/"lastHeartbeatAt"\s*(?:<|>|IS NULL)/);
        expect(query).toContain('ORDER BY flagged DESC, "lastSeenAt" DESC, "computerShort"');
    });

    it('uses the latest event site for the stop exemption, so later activity supersedes an old stop', async () => {
        const query = await generatedSql();
        const latestEvents = query.split('latest_events AS ( ')[1]!.split('), restores AS (')[0]!;
        expect(latestEvents.trim()).toBe(
            'SELECT DISTINCT ON (computer_id) computer_id, site FROM recent ' +
            'ORDER BY computer_id, occurred_at DESC, received_at DESC, event_id DESC',
        );
        expect(query).toContain('JOIN latest_events e USING (computer_id)');
        expect(query).toContain('e.site AS "lastEventSite"');
        // This is internal flag metadata, not a new public result field.
        const finalFields = query.split('SELECT h.')[1]!.split('coalesce(')[0]!;
        expect(finalFields).not.toContain('lastEventSite');
        expect(finalFields).not.toContain('*');
    });

    it('preserves the typed driver result, including null metadata, zero ages and counts', async () => {
        const row: PersistenceHealthRow = {
            computerShort: 'b8f8e62a',
            lastRestore: { site: 'persist.system.restore', code: 'ok', outcome: 'ok', at: '2026-10-11T11:00:00Z' },
            systemCode: 'ok',
            workspaceCode: null,
            systemOkAgeS: 0,
            workspaceOkAgeS: null,
            discardedUnsaved: 0,
            lastHeartbeatAt: null,
            lastSeenAt: '2026-10-11T12:00:00Z',
            flagged: false,
        };
        const { db } = makeTestDb([row, { ...row, computerShort: 'd1e2f3a4', lastRestore: null }]);
        expect(await persistenceHealth(db)).toEqual([row, { ...row, computerShort: 'd1e2f3a4', lastRestore: null }]);
    });

    it('keeps the standalone read-only SQL identical to the application query', async () => {
        const document = readFileSync(path.resolve(__dirname, '../../../../docs/sql/persistence-health.sql'), 'utf8');
        const sql = document.replace(/^--.*$/gm, '').trim();
        expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT)\b/i);
        expect(sql).toMatch(/^WITH clock AS/);
        expect(sql).toMatch(/;$/);
        const query = sql.replace(/;$/, '');
        expect(query.replace(/\s+/g, ' ').trim()).toBe(await generatedSql());
        expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    });
});

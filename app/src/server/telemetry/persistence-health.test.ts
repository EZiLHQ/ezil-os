/**
 * Same pg-proxy harness as queries.test.ts: these assert the generated SQL
 * and driver result shape, not execution against a live Postgres server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { persistenceHealth, PERSISTENCE_PAUSE_CODES, type PersistenceHealthRow, type QueryDb } from './queries';

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
    const { sql, params } = statements[0]!;
    // Render bound code literals for comparison with the pasteable SQL file.
    return sql.replace(/\$(\d+)/g, (_, index: string) =>
        `'${String(params[Number(index) - 1]).replace(/'/g, "''")}'`,
    ).replace(/\s+/g, ' ').trim();
}

describe('persistenceHealth', () => {
    it('returns an empty-safe array and binds a deterministic clock as a timestamp', async () => {
        const { db, statements } = makeTestDb();
        const now = new Date('2026-10-11T12:00:00Z');
        expect(await persistenceHealth(db, { now })).toEqual([]);
        expect(statements).toHaveLength(1);
        expect(statements[0]!.params).toEqual([
            now.toISOString(), ...PERSISTENCE_PAUSE_CODES, ...PERSISTENCE_PAUSE_CODES, ...PERSISTENCE_PAUSE_CODES,
        ]);
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

    it('uses occurrence order for worker selections and receipt order for shell transitions', async () => {
        const query = await generatedSql();
        expect(query.match(/SELECT DISTINCT ON \(computer_id\)/g)).toHaveLength(6);
        expect(query.match(/ORDER BY computer_id, occurred_at DESC, received_at DESC, event_id DESC/g)).toHaveLength(5);
        expect(query.match(/ORDER BY computer_id, received_at DESC, event_id DESC/g)).toHaveLength(1);
        expect(query).toContain("WHERE site IN ('persist.system.restore', 'persist.workspace.restore')");
        expect(query).toContain("jsonb_build_object('site', site, 'code', code, 'outcome', outcome, 'at', occurred_at)");
        expect(query).toContain("WHERE site IN ('persist.system.flush', 'persist.system.restore')");
        expect(query).toContain("WHERE site IN ('persist.workspace.flush', 'persist.workspace.restore')");
        for (const relation of ['restores r', 'system_events s', 'workspace_events w']) {
            expect(query).toContain(`LEFT JOIN ${relation} USING (computer_id)`);
        }
    });

    it('uses the latest worker event even without attrs; shell reports cannot replace it', async () => {
        const query = await generatedSql();
        expect(query).toContain('e.event_id, e.source, e.site');
        const latest = query.split('latest AS ( ')[1]!.split('), shell_events AS (')[0]!;
        expect(latest).toContain(
            "FROM recent WHERE source = 'worker' AND site <> 'persist.shell_seen' ORDER BY",
        );
        // No fallback to an older age sample when the latest event lacks attrs.
        expect(latest).not.toContain('attrs ?');
        expect(query).toContain('LEFT JOIN latest l USING (computer_id)');
        expect(query).toContain('l.occurred_at AS "lastWorkerEventAt"');
    });

    it.each(['system', 'workspace'])('reports the latest %s age at event time and preserves unknown ages', async (layer) => {
        const query = await generatedSql();
        // CASE without ELSE keeps missing/non-number attrs null; nullif
        // keeps the contract's -1 sentinel null.
        expect(query).toContain(
            `CASE WHEN jsonb_typeof(l.attrs -> '${layer}_age_s') = 'number' ` +
            `THEN nullif((l.attrs ->> '${layer}_age_s')::double precision, -1) END AS "${layer}OkAgeS"`,
        );
        expect(query).toContain('SELECT DISTINCT ON (computer_id) computer_id, site, attrs, occurred_at FROM recent');
        expect(query).not.toContain('extract(epoch');
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

    it('flags reported system ages strictly over 1800 unless the latest worker event is a stop', async () => {
        const query = await generatedSql();
        expect(query).toContain(
            `OR coalesce("lastWorkerEventSite" <> 'persist.stop' AND "systemOkAgeS" > 1800, false)`,
        );
        expect(query).not.toMatch(/"workspaceOkAgeS"\s*>/);
    });

    it('retains the latest worker blocked-open timestamp and code independently of later recovery', async () => {
        const query = await generatedSql();
        const blocked = query.split('open_blocked_events AS ( ')[1]!.split('), totals AS (')[0]!;
        expect(blocked.trim()).toBe(
            'SELECT DISTINCT ON (computer_id) computer_id, code, occurred_at FROM recent ' +
            "WHERE source = 'worker' AND site = 'persist.open_blocked' " +
            'ORDER BY computer_id, occurred_at DESC, received_at DESC, event_id DESC',
        );
        expect(query).toContain('LEFT JOIN open_blocked_events ob USING (computer_id)');
        expect(query).toContain('ob.occurred_at AS "openBlockedAt", ob.code AS "openBlockedCode"');
        const finalFields = query.split('SELECT h.')[1]!.split('coalesce(')[0]!;
        expect(finalFields).toContain('h."openBlockedAt", h."openBlockedCode"');
    });

    it('flags a latest worker blocked open even with healthy layers, but not historical blocked opens', async () => {
        const query = await generatedSql();
        const flag = query.split('coalesce("systemCode"')[1]!.split(' AS flagged')[0]!;
        // A separate OR flags both blocked-open codes regardless of layer
        // codes/ages. Later worker events clear this condition; shell reports
        // cannot replace the latest worker event (pinned above).
        expect(flag).toContain(`OR coalesce("lastWorkerEventSite" = 'persist.open_blocked', false)`);
        expect(flag).not.toMatch(/openBlockedAt|openBlockedCode/);
    });

    it('does not flag drain lag or missing/old heartbeats', async () => {
        const query = await generatedSql();
        expect(query).not.toMatch(/interval '(?:30 minutes|2 hours)'/);
        expect(query).not.toMatch(/"lastSeenAt"\s*(?:<|>|IS NULL)/);
        expect(query).not.toMatch(/"lastHeartbeatAt"\s*(?:<|>|IS NULL)/);
        expect(query).toContain('ORDER BY flagged DESC, "lastSeenAt" DESC, "computerShort"');
    });

    it('uses the latest shell report independently, including a pause clear after a worker stop', async () => {
        const query = await generatedSql();
        const shellEvents = query.split('shell_events AS ( ')[1]!.split('), restores AS (')[0]!;
        expect(shellEvents.trim()).toBe(
            'SELECT DISTINCT ON (computer_id) computer_id, code FROM recent ' +
            "WHERE source = 'shell' AND site = 'persist.shell_seen' " +
            'ORDER BY computer_id, received_at DESC, event_id DESC',
        );
        expect(query).toContain('LEFT JOIN shell_events sh USING (computer_id)');
        expect(query).toContain('l.site AS "lastWorkerEventSite", sh.code AS "shellCode"');
        expect(query).toContain(`OR coalesce("shellCode" IN ('too_large', 'stale', 'not_restored'), false) AS flagged`);
        const finalFields = query.split('SELECT h.')[1]!.split('coalesce(')[0]!;
        expect(finalFields).toContain('h."lastWorkerEventAt"');
        expect(finalFields).not.toContain('lastWorkerEventSite');
        expect(finalFields).not.toContain('shellCode');
        expect(finalFields).not.toContain('*');
    });

    it.each([
        ['too_large', 'ok'],
        ['ok', 'stale'],
    ])('does not let a future-dated shell %s report pin a later %s transition', async (previousCode, latestCode) => {
        const query = await generatedSql();
        const shellEvents = query.split('shell_events AS ( ')[1]!.split('), restores AS (')[0]!;
        const events = [
            { event_id: '003', occurred_at: '2099-01-01T00:00:00Z', received_at: '2026-10-11T10:00:00Z', code: previousCode },
            { event_id: '001', occurred_at: '2100-01-01T00:00:00Z', received_at: '2026-10-11T11:00:00Z', code: previousCode },
            { event_id: '002', occurred_at: '2026-10-11T11:00:00Z', received_at: '2026-10-11T11:00:00Z', code: latestCode },
        ];
        // Exercise the actual generated ordering against skewed-clock fixtures
        // for one computer, including equal receipt times. This pg-proxy suite
        // does not execute the full query against Postgres.
        type OrderColumn = 'occurred_at' | 'received_at' | 'event_id';
        const ordering = shellEvents.split('ORDER BY computer_id, ')[1]!.trim().split(', ').map(term => {
            const [column, direction] = term.split(' ');
            expect(['occurred_at', 'received_at', 'event_id']).toContain(column);
            expect(['ASC', 'DESC']).toContain(direction);
            return { column: column as OrderColumn, descending: direction === 'DESC' };
        });
        events.sort((a, b) => {
            for (const { column, descending } of ordering) {
                const comparison = a[column].localeCompare(b[column]);
                if (comparison !== 0) return descending ? -comparison : comparison;
            }
            return 0;
        });
        expect(events[0]!.code).toBe(latestCode);
        expect(events[0]!.event_id).toBe('002');
    });

    it('preserves the typed driver result, including null metadata, zero ages and counts', async () => {
        const row: PersistenceHealthRow = {
            computerShort: 'b8f8e62a',
            lastRestore: { site: 'persist.system.restore', code: 'ok', outcome: 'ok', at: '2026-10-11T11:00:00Z' },
            openBlockedAt: null,
            openBlockedCode: null,
            systemCode: 'ok',
            workspaceCode: null,
            systemOkAgeS: 0,
            workspaceOkAgeS: null,
            discardedUnsaved: 0,
            lastHeartbeatAt: null,
            lastWorkerEventAt: '2026-10-11T12:00:00Z',
            lastSeenAt: '2026-10-11T12:00:00Z',
            flagged: false,
        };
        const { db } = makeTestDb([row, { ...row, computerShort: 'd1e2f3a4', lastRestore: null }]);
        expect(await persistenceHealth(db)).toEqual([row, { ...row, computerShort: 'd1e2f3a4', lastRestore: null }]);
    });

    it('keeps the standalone read-only SQL identical to the application query', async () => {
        const document = readFileSync(path.resolve(__dirname, '../../../../docs/sql/persistence-health.pgsql'), 'utf8');
        const sql = document.replace(/^--.*$/gm, '').trim();
        expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT)\b/i);
        expect(sql).toMatch(/^WITH clock AS/);
        expect(sql).toMatch(/;$/);
        const query = sql.replace(/;$/, '');
        expect(query.replace(/\s+/g, ' ').trim()).toBe(await generatedSql());
        expect(query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    });
});

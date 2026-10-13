/**
 * `computer_id` carries a real FK to `ezil_computers(id)`. These tests pin the
 * two attribution rules (docs/PERSISTENCE-SIGNAL-CONTRACT.md §4):
 *   - an unknown computer UUID nulls THAT row's computer_id, never fails the
 *     batch (one forged/stale id used to lose every sibling event);
 *   - the spool path stores a worker event naming a real computer under its
 *     OWNER's pseudonymous hash; everything else keeps the sentinel.
 * Same real-Drizzle `pg-proxy` technique as `ingest.test.ts`.
 */
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { ingestBatch, ingestOwnerAttributedBatch, type IngestDb } from './ingest';
import { safeUserHash } from './sanitize';
import type { ParsedTelemetryEventInput } from './schema';
import { WORKER_SENTINEL_USER_HASH } from './types';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const COMP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMP_UNKNOWN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface InsertedRow {
    eventId: string;
    userHash: string;
    computerId: string | null;
}

function makeDb(known: Record<string, string>) {
    const inserted: InsertedRow[] = [];
    let lookups = 0;
    const proxy = drizzle(
        async (sql, params) => {
            if (/^\s*select\b/i.test(sql) && /from "ezil_computers"/i.test(sql)) {
                lookups++;
                const ids = params as string[];
                return { rows: ids.filter((id) => id in known).map((id) => [id, known[id]]) };
            }
            const m = sql.match(/insert into "ezil_error_events" \(([^)]*)\)/i);
            if (m) {
                const cols = m[1].split(',').map((c) => c.trim().replace(/"/g, ''));
                const out: string[] = [];
                for (let i = 0; i + cols.length <= params.length; i += cols.length) {
                    const get = (c: string) => params[i + cols.indexOf(c)];
                    const row = {
                        eventId: get('event_id') as string,
                        userHash: get('user_hash') as string,
                        computerId: (get('computer_id') as string | null) ?? null,
                    };
                    inserted.push(row);
                    out.push(row.eventId);
                }
                return { rows: out.map((id) => [id]) };
            }
            return { rows: [] };
        },
        { schema },
    );
    const db = { transaction: (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy) } as unknown as IngestDb;
    return { db, inserted, lookups: () => lookups };
}

let seq = 0;
function ev(overrides: Partial<ParsedTelemetryEventInput> = {}): ParsedTelemetryEventInput {
    seq++;
    return {
        eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        schemaVersion: 1,
        eventClass: 'persistence',
        source: 'worker',
        occurredAt: '2026-10-11T00:00:00.000Z',
        site: 'persist.system.flush',
        code: 'too_large',
        outcome: 'skipped',
        ...overrides,
    };
}

describe('ingestBatch: computer_id is FK-safe and owner-checked', () => {
    it('a valid-but-nonexistent computer UUID nulls only that row; siblings keep theirs', async () => {
        const { db, inserted } = makeDb({ [COMP_A]: OWNER_A });
        const result = await ingestBatch(db, [ev({ computerId: COMP_A }), ev({ computerId: COMP_UNKNOWN })], 'u_12345678');
        expect(result.inserted).toBe(2);
        expect(inserted.map((r) => r.computerId)).toEqual([COMP_A, null]);
    });

    it('shell path: a computer owned by someone else is stored as NULL', async () => {
        const { db, inserted } = makeDb({ [COMP_A]: OWNER_A, [COMP_B]: OWNER_B });
        await ingestBatch(db, [ev({ computerId: COMP_A }), ev({ computerId: COMP_B })], safeUserHash(OWNER_A), {
            computerOwner: OWNER_A,
        });
        expect(inserted.map((r) => r.computerId)).toEqual([COMP_A, null]);
    });

    it('does not query ezil_computers when no event names a computer', async () => {
        const { db, lookups } = makeDb({});
        await ingestBatch(db, [ev()], 'u_12345678');
        expect(lookups()).toBe(0);
    });
});

describe('ingestOwnerAttributedBatch: worker events are stored under the computer owner', () => {
    it('groups by owner hash with ONE lookup; unknown/absent computers keep the sentinel and NULL', async () => {
        const { db, inserted, lookups } = makeDb({ [COMP_A]: OWNER_A, [COMP_B]: OWNER_B });
        const result = await ingestOwnerAttributedBatch(db, [
            ev({ computerId: COMP_A }),
            ev({ computerId: COMP_B }),
            ev({ computerId: COMP_UNKNOWN }),
            ev(),
            ev({ computerId: COMP_A }),
        ]);
        expect(lookups()).toBe(1);
        expect(result.inserted).toBe(5);
        const byHash = (h: string) => inserted.filter((r) => r.userHash === h).map((r) => r.computerId);
        expect(byHash(safeUserHash(OWNER_A))).toEqual([COMP_A, COMP_A]);
        expect(byHash(safeUserHash(OWNER_B))).toEqual([COMP_B]);
        expect(byHash(WORKER_SENTINEL_USER_HASH)).toEqual([null, null]);
        // The raw owner id never reaches the events table.
        expect(JSON.stringify(inserted)).not.toContain(OWNER_A);
    });
});

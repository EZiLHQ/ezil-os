/**
 * TEST SUPPORT ONLY. An in-memory stand-in for Postgres that runs the REAL
 * statements `placement.ts` builds, rendered by drizzle's own PgDialect.
 *
 * What it models, and how faithfully:
 * - `pg_advisory_xact_lock` — a real async mutex per (namespace, key), held
 *   until the fake transaction commits or rolls back.
 * - The CAS `UPDATE` — the WHERE and SET clauses are PARSED FROM THE SQL TEXT,
 *   and an unrecognised predicate throws. Removing a guard from the SQL
 *   therefore changes which rows match: the guard mutations are honest.
 *   The match-and-apply is atomic (Postgres row locking), with a yield before.
 * - The INSERT — columns and VALUES parsed from the SQL text.
 * - Counter/usage/duplicate reads — answered from the model by statement tag
 *   (`/* placement:<tag> *\/`). Their SQL text is pinned separately by the
 *   capture assertions; the model does not re-derive it.
 * - Every statement yields to the event loop first, so two concurrent
 *   transactions interleave between reads and writes exactly where an
 *   unlocked implementation would race.
 *
 * It names no table: the single-writer scan must not need to allowlist it.
 */

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

export type Row = Record<string, unknown>;

export interface Statement {
    sql: string;
    params: unknown[];
    tx: number | null;
}

class Mutex {
    private held = false;
    private waiters: (() => void)[] = [];
    async acquire(): Promise<void> {
        if (!this.held) {
            this.held = true;
            return;
        }
        await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    release(): void {
        const next = this.waiters.shift();
        if (next) next();
        else this.held = false;
    }
}

interface Tx {
    id: number;
    locks: Mutex[];
    undo: (() => void)[];
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const RUNNING_EXCLUDED = new Set(['STOPPED', 'RETIRED', 'PURGE_ELIGIBLE']);

export interface FakeSeed {
    placements?: Row[];
    usage?: Row[];
    computers?: { id: string; user_id: string }[];
}

export function placementRow(over: Row & { computer_id: string }): Row {
    return {
        provider: 'aws-ec2',
        workspace_store: 'ebs',
        generation: 1,
        lease_epoch: 0,
        state: 'STOPPED',
        region: null,
        zone_id: null,
        instance_id: null,
        instance_type: null,
        volume_id: null,
        fs_uuid: null,
        tunnel_id: null,
        enroll_nonce_hash: null,
        enroll_expires_at: null,
        lease_until: null,
        presence_at: null,
        updated_at: new Date('2026-10-01T00:00:00Z'),
        ...over,
    };
}

export function createFakePlacementDb(seed: FakeSeed = {}, clock: () => Date = () => new Date('2026-10-13T12:00:00Z')) {
    const placements: Row[] = (seed.placements ?? []).map((r) => ({ ...r }));
    const usage: Row[] = (seed.usage ?? []).map((r) => ({ ...r }));
    const computers = seed.computers ?? [];
    const statements: Statement[] = [];
    const locks = new Map<string, Mutex>();
    let txSeq = 0;

    const present = (r: Row): Row => ({
        ...r,
        generation: String(r.generation),
        lease_epoch: String(r.lease_epoch),
    });

    const value = (expr: string, params: unknown[]): unknown => {
        const p = expr.match(/^\$(\d+)(?:::\w+)?$/);
        if (p) return params[Number(p[1]) - 1];
        if (expr === 'now()') return clock();
        if (/^\d+$/.test(expr)) return Number(expr);
        throw new Error(`fake db: unsupported value expression ${expr}`);
    };

    async function run(query: SQL, tx: Tx | null): Promise<{ rows: Row[] }> {
        const { sql: text, params } = dialect.sqlToQuery(query);
        statements.push({ sql: text, params, tx: tx?.id ?? null });
        await tick();
        const tag = text.match(/\/\* placement:([a-z-]+) \*\//)?.[1];
        switch (tag) {
            case 'lock-computer':
            case 'lock-admission': {
                if (!tx) throw new Error('fake db: pg_advisory_xact_lock outside a transaction is a no-op in Postgres');
                const key = `${tag}:${JSON.stringify(params)}`;
                let m = locks.get(key);
                if (!m) locks.set(key, (m = new Mutex()));
                await m.acquire();
                tx.locks.push(m);
                return { rows: [{ pg_advisory_xact_lock: '' }] };
            }
            case 'read':
                return { rows: placements.filter((r) => r.computer_id === params[0]).slice(0, 2).map(present) };
            case 'duplicates': {
                const counts = new Map<string, number>();
                for (const r of placements) counts.set(String(r.computer_id), (counts.get(String(r.computer_id)) ?? 0) + 1);
                return { rows: [...counts].filter(([, n]) => n > 1).map(([computer_id, rows]) => ({ computer_id, rows })) };
            }
            case 'computer-owner': {
                const c = computers.find((x) => x.id === params[0]);
                return { rows: c ? [{ user_id: c.user_id }] : [] };
            }
            case 'count-running': {
                const states = new Set(params as string[]);
                const n = placements.filter((r) => r.provider === 'aws-ec2' && states.has(String(r.state))).length;
                return { rows: [{ n }] };
            }
            case 'count-user': {
                const [userId, computerId] = params as string[];
                const owned = new Set(computers.filter((c) => c.user_id === userId).map((c) => c.id));
                const n = placements.filter(
                    (r) => r.provider === 'aws-ec2' && owned.has(String(r.computer_id)) && r.computer_id !== computerId && r.state !== 'PURGE_ELIGIBLE',
                ).length;
                return { rows: [{ n }] };
            }
            case 'usage-month': {
                const [now, monthStart] = (params as string[]).map((s) => new Date(s).getTime());
                return {
                    rows: usage
                        .filter((u) => (u.started_at as Date).getTime() < now! && (u.stopped_at === null || (u.stopped_at as Date).getTime() >= monthStart!))
                        .map((u) => ({ ...u, egress_bytes: u.egress_bytes === null ? null : String(u.egress_bytes) })),
                };
            }
            case 'retention':
                return { rows: placements.filter((r) => r.state === 'STOPPED' || r.state === 'RETIRED').map((r) => ({ computer_id: r.computer_id, state: r.state, updated_at: r.updated_at })) };
            case 'insert': {
                const m = text.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*RETURNING/);
                if (!m) throw new Error('fake db: unparsed insert');
                const cols = m[1]!.split(',').map((s) => s.trim());
                const vals = m[2]!.split(',').map((s) => s.trim());
                const row: Row = placementRow({ computer_id: '' });
                cols.forEach((c, i) => (row[c] = value(vals[i]!, params)));
                placements.push(row);
                tx?.undo.push(() => placements.splice(placements.indexOf(row), 1));
                return { rows: [present(row)] };
            }
            case 'cas': {
                const m = text.match(/SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)\s+RETURNING/);
                if (!m) throw new Error('fake db: unparsed update');
                const where = m[2]!.split(/\s+AND\s+/).map((pred) => {
                    const w = pred.trim().match(/^(\w+) = (\$\d+(?:::\w+)?)$/);
                    if (!w) throw new Error(`fake db: unsupported predicate ${pred}`);
                    return [w[1]!, value(w[2]!, params)] as const;
                });
                const sets = m[1]!.split(/,\s*/).map((assign) => {
                    const inc = assign.match(/^(\w+) = (\w+) \+ (\$\d+)$/);
                    if (inc) return (r: Row) => (r[inc[1]!] = Number(r[inc[2]!]) + Number(value(inc[3]!, params)));
                    const set = assign.match(/^(\w+) = (.+)$/);
                    if (!set) throw new Error(`fake db: unsupported assignment ${assign}`);
                    return (r: Row) => (r[set[1]!] = value(set[2]!.trim(), params));
                });
                // Atomic match-and-apply, like row-locked UPDATE re-evaluation.
                const hit = placements.filter((r) => where.every(([col, v]) => String(r[col]) === String(v)));
                for (const r of hit) {
                    const before = { ...r };
                    sets.forEach((apply) => apply(r));
                    tx?.undo.push(() => Object.assign(r, before));
                }
                return { rows: hit.map(present) };
            }
            default:
                throw new Error(`fake db: untagged statement ${text.slice(0, 60)}`);
        }
    }

    const db = {
        execute: (query: SQL) => run(query, null),
        async transaction<T>(fn: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<T>): Promise<T> {
            const tx: Tx = { id: ++txSeq, locks: [], undo: [] };
            statements.push({ sql: 'BEGIN', params: [], tx: tx.id });
            try {
                const result = await fn({ execute: (query: SQL) => run(query, tx) });
                statements.push({ sql: 'COMMIT', params: [], tx: tx.id });
                return result;
            } catch (error) {
                tx.undo.reverse().forEach((undo) => undo());
                statements.push({ sql: 'ROLLBACK', params: [], tx: tx.id });
                throw error;
            } finally {
                tx.locks.forEach((m) => m.release());
            }
        },
    };

    return { db, placements, usage, statements, runningExcluded: RUNNING_EXCLUDED };
}

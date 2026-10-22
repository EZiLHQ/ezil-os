/**
 * TEST SUPPORT ONLY. An in-memory stand-in for Postgres that runs the REAL
 * statements `placement.ts` builds, rendered by drizzle's own PgDialect.
 *
 * What it models, and how faithfully:
 * - `pg_advisory_xact_lock` — a real async mutex per (namespace, key), held
 *   until the fake transaction commits or rolls back. The key follows the SQL:
 *   `hashtext($n::uuid::text)` keys on the lower-cased id (uuid canonical
 *   text), `hashtext($n::text)` on the raw string — as Postgres does. The
 *   statement answers `isolation` from the `isolation` option.
 * - uuid comparisons (`= $n::uuid`) are case-insensitive, as in Postgres.
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

import { monthUsageFromRows } from './usage';
import { instanceVcpu } from './aws-config';

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
    imageJobs?: Row[];
    usage?: Row[];
    computers?: { id: string; user_id: string; deleted_at?: Date | null; created_at?: Date }[];
}

export interface FakeOptions {
    clock?: () => Date;
    /** What `current_setting('transaction_isolation')` answers. */
    isolation?: string;
}

/** Default owner of seeded rows (tests' U1 / `userId`). */
export const DEFAULT_OWNER = '11111111-1111-4111-8111-111111111111';

export function placementRow(over: Row & { computer_id: string }): Row {
    return {
        owner_user_id: DEFAULT_OWNER,
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
        enroll_consumed_hash: null,
        lease_until: null,
        presence_at: null,
        fence_token: null,
        lifecycle_job_id: null,
        lifecycle_digest: null,
        last_error: null,
        updated_at: new Date('2026-10-01T00:00:00Z'),
        reconciled_at: null,
        ...over,
    };
}

const uuidEq = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

export function createFakePlacementDb(seed: FakeSeed = {}, options: FakeOptions = {}) {
    const clock = options.clock ?? (() => new Date('2026-10-13T12:00:00Z'));
    const isolation = options.isolation ?? 'read committed';
    const placements: Row[] = (seed.placements ?? []).map((r) => ({ ...r }));
    const imageJobs: Row[] = (seed.imageJobs ?? []).map(r => ({ ...r }));
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
        if (p) return expr.endsWith('::jsonb') && typeof params[Number(p[1]) - 1] === 'string' ? JSON.parse(params[Number(p[1]) - 1] as string) : params[Number(p[1]) - 1];
        if (expr === "'aws-ec2'") return 'aws-ec2';
        if (expr === 'now()') return clock();
        if (/^\d+$/.test(expr)) return Number(expr);
        throw new Error(`fake db: unsupported value expression ${expr}`);
    };

    async function run(query: SQL, tx: Tx | null): Promise<{ rows: Row[] }> {
        const { sql: text, params } = dialect.sqlToQuery(query);
        statements.push({ sql: text, params, tx: tx?.id ?? null });
        await tick();
        // Existing placement-only fixtures have no migration intent; migration tests wrap this executor.
        if (text.startsWith('SELECT') && text.includes('FROM public.ezil_compute_migrations')) return { rows: [] };
        const imageTable = text.includes('public.ezil_computer_image_jobs') && !text.includes('UNION ALL');
        const writeRows = imageTable ? imageJobs : placements;
        const presentWrite = imageTable ? (r: Row) => ({ ...r }) : present;
        if (imageTable && text.startsWith('SELECT')) {
            const byJob = /WHERE job_id =/.test(text);
            return { rows: imageJobs.filter(r => byJob ? r.job_id === params[0] : r.computer_id === params[0]
                && !['succeeded', 'recovered', 'cancelled'].includes(String(r.phase))).slice(0, 2).map(r => ({ ...r })) };
        }
        if (text.startsWith('SELECT user_id::text AS user_id FROM public.ezil_computers'))
            return { rows: computers.filter(c => c.id === params[0] && c.deleted_at == null).map(c => ({ user_id: c.user_id })) };
        if (text.startsWith('SELECT id FROM public.ezil_compute_pool_hosts')) return { rows: [] };
        if (text.startsWith('SELECT lower_image_digest')) return { rows: placements.filter(r => r.computer_id === params[0]
            && r.generation === params[1] && r.lease_epoch === params[2] && r.enroll_consumed_hash === params[3]
            && r.image_upgrade_job_id == null).map(r => ({ lower_image_digest: r.lower_image_digest })) };
        const tag = imageTable && text.startsWith('INSERT') ? 'insert' : imageTable && text.startsWith('UPDATE') ? 'cas'
            : text.match(/\/\* placement:([a-z-]+) \*\//)?.[1];
        switch (tag) {
            case 'image-reservation':
                return { rows: placements.filter(r => r.image_upgrade_job_id != null && r.computer_id === params[0]).map(r => ({ job_id: r.image_upgrade_job_id })) };
            case 'lock-computer':
            case 'lock-admission': {
                if (!tx) throw new Error('fake db: pg_advisory_xact_lock outside a transaction is a no-op in Postgres');
                const canonical = /hashtext\(\$\d+::uuid::text\)/.test(text);
                const keyParams = params.map((p, i) => (canonical && i === params.length - 1 ? String(p).toLowerCase() : p));
                const key = `${tag}:${JSON.stringify(keyParams)}`;
                let m = locks.get(key);
                if (!m) locks.set(key, (m = new Mutex()));
                await m.acquire();
                tx.locks.push(m);
                return { rows: [{ pg_advisory_xact_lock: '', isolation }] };
            }
            case 'image-read':
                return { rows: placements.filter(r => uuidEq(r.computer_id, params[0])).slice(0, 2).map(r => present({
                    lower_image_digest: null, lower_digest_observed_at: null, image_upgrade_job_id: null, ...r })) };
            case 'read':
                return { rows: placements.filter((r) => uuidEq(r.computer_id, params[0])).slice(0, 2).map(present) };
            case 'duplicates': {
                const counts = new Map<string, number>();
                for (const r of placements) counts.set(String(r.computer_id), (counts.get(String(r.computer_id)) ?? 0) + 1);
                return { rows: [...counts].filter(([, n]) => n > 1).map(([computer_id, rows]) => ({ computer_id, rows })) };
            }
            case 'computer-owner': {
                const c = computers.find((x) => uuidEq(x.id, params[0]));
                if (!c) return { rows: [] };
                return { rows: [{ user_id: c.user_id, deleted: c.deleted_at != null }] };
            }
            case 'canary-computer': {
                const c = computers.find((x) => uuidEq(x.id, params[0]));
                if (!c) return { rows: [] };
                return { rows: [{ user_id: c.user_id, deleted: c.deleted_at != null, created_at: c.created_at ?? clock() }] };
            }
            case 'usage-foreign': {
                const [computerId, userId] = params as string[];
                return { rows: [{ n: usage.filter((u) => uuidEq(u.computer_id, computerId) && !uuidEq(u.user_id, userId)).length }] };
            }
            case 'count-running': {
                const states = new Set(params as string[]);
                const rows = placements.filter((r) => r.provider === 'aws-ec2' && states.has(String(r.state)));
                return { rows: [{ n: rows.length, vcpu: rows.reduce((sum, r) => sum + instanceVcpu(r.instance_type as string | null), 0) }] };
            }
            case 'count-running-region': {
                if (!/provider = 'aws-ec2' AND state IN \([^)]*\)\s+GROUP BY region/.test(text)) throw new Error('fake db: unexpected per-region count SQL');
                const states = new Set(params as string[]);
                const byRegion = new Map<string | null, { n: number; vcpu: number }>();
                for (const r of placements) {
                    if (r.provider !== 'aws-ec2' || !states.has(String(r.state))) continue;
                    const key = (r.region as string | null) ?? null;
                    const prev = byRegion.get(key) ?? { n: 0, vcpu: 0 };
                    byRegion.set(key, { n: prev.n + 1, vcpu: prev.vcpu + instanceVcpu(r.instance_type as string | null) });
                }
                return { rows: [...byRegion].map(([region, counts]) => ({ region, ...counts })) };
            }
            case 'count-user': {
                const [computerId, userId] = params as string[];
                const mine = (r: Row) =>
                    uuidEq(r.owner_user_id, userId) || usage.some((u) => uuidEq(u.computer_id, r.computer_id) && uuidEq(u.user_id, userId));
                const n = new Set(
                    placements
                        .filter((r) => r.provider === 'aws-ec2' && mine(r) && !uuidEq(r.computer_id, computerId) && r.state !== 'PURGE_ELIGIBLE')
                        .map((r) => String(r.computer_id).toLowerCase()),
                ).size;
                return { rows: [{ n }] };
            }
            case 'usage-month': {
                // The SQL totals per user in the database; answer with the same arithmetic
                // (usage.ts `monthUsageFromRows`, the reference placement-usage-sql pins on real
                // Postgres). Params: [now, monthStart, nextMonth].
                const now = new Date(String(params[0]));
                const rows = usage.map((u) => ({
                    computerId: String(u.computer_id), userId: String(u.user_id),
                    instanceType: (u.instance_type as string | null) ?? null,
                    startedAt: u.started_at as Date, stoppedAt: (u.stopped_at as Date | null) ?? null,
                    egressBytes: u.egress_bytes === null || u.egress_bytes === undefined ? null : Number(u.egress_bytes),
                }));
                const totals = monthUsageFromRows(rows, now);
                return {
                    rows: [...totals.byUser].map(([user_id, t]) => ({
                        user_id, seconds: (t.hours * 3_600).toFixed(6), weighted_seconds: String(t.weightedSeconds), egress_bytes: String(t.egressBytes),
                    })),
                };
            }
            case 'usage-close':
            case 'usage-close-other': {
                if (!tx) throw new Error('fake db: a usage write outside its transition transaction');
                const [observedBy, computerId, keepInstance] = params as string[];
                const hit = usage.filter((u) => uuidEq(u.computer_id, computerId) && u.stopped_at == null
                    && (tag === 'usage-close' || u.instance_id !== keepInstance));
                for (const u of hit) {
                    const before = { ...u };
                    Object.assign(u, { stopped_at: clock(), observed_by: observedBy, updated_at: clock() });
                    tx.undo.push(() => Object.assign(u, before));
                }
                return { rows: [] };
            }
            case 'usage-open': {
                if (!tx) throw new Error('fake db: a usage write outside its transition transaction');
                if (!/WHERE NOT EXISTS \(SELECT 1 FROM [\w.]+\s+WHERE computer_id = \$7::uuid AND instance_id = \$8 AND stopped_at IS NULL\)/.test(text)) {
                    throw new Error('fake db: unexpected usage-open SQL');
                }
                const [computerId, userId, instanceId, instanceType, startedAt, observedBy] = params as (string | null)[];
                if (usage.some((u) => uuidEq(u.computer_id, computerId) && u.instance_id === instanceId && u.stopped_at == null)) return { rows: [] };
                const row: Row = {
                    computer_id: computerId, user_id: userId, instance_id: instanceId, instance_type: instanceType,
                    started_at: startedAt ? new Date(startedAt) : clock(), stopped_at: null, egress_bytes: null, observed_by: observedBy, updated_at: clock(),
                };
                usage.push(row);
                tx.undo.push(() => usage.splice(usage.indexOf(row), 1));
                return { rows: [] };
            }
            case 'reconcile-claim': {
                // The rotation is the point: the SQL text is pinned, the model claims the
                // least recently reconciled rows (never-reconciled first) and stamps them.
                if (!/SET reconciled_at = now\(\)\s+WHERE computer_id IN \(SELECT computer_id FROM [\w.]+\s+WHERE provider = 'aws-ec2' AND state IN \([^)]*\)\s+ORDER BY reconciled_at ASC NULLS FIRST, updated_at ASC, computer_id ASC\s+LIMIT \$\d+\s+FOR UPDATE SKIP LOCKED\)/.test(text)) {
                    throw new Error('fake db: unexpected reconcile-claim SQL');
                }
                const limit = Number(params.at(-1));
                const states = new Set(params.slice(0, -1) as string[]);
                const at = (v: unknown) => (v === null || v === undefined ? -Infinity : new Date(v as Date).getTime());
                const picked = placements
                    .filter((r) => r.provider === 'aws-ec2' && states.has(String(r.state)))
                    .sort((a, b) => at(a.reconciled_at) - at(b.reconciled_at) || at(a.updated_at) - at(b.updated_at)
                        || String(a.computer_id).localeCompare(String(b.computer_id)))
                    .slice(0, limit);
                const ids = new Set(picked.map((r) => String(r.computer_id).toLowerCase()));
                const hit = placements.filter((r) => ids.has(String(r.computer_id).toLowerCase()));
                for (const r of hit) {
                    const before = r.reconciled_at;
                    r.reconciled_at = clock();
                    tx?.undo.push(() => { r.reconciled_at = before; });
                }
                return { rows: hit.map((r) => ({ computer_id: r.computer_id, owner_user_id: r.owner_user_id })) };
            }
            case 'retire-pending-claim': {
                // Deleted-computer rotation (LEFT JOIN ezil_computers: row gone or soft-deleted).
                // The SQL text is pinned; the model claims least-recently-checked rows and stamps them.
                if (!/SET reconciled_at = now\(\)\s+WHERE computer_id IN \(SELECT p\.computer_id FROM [\w.]+ p\s+LEFT JOIN [\w.]+ c ON c\.id = p\.computer_id\s+WHERE p\.provider = 'aws-ec2' AND p\.state IN \([^)]*\)\s+AND \(c\.id IS NULL OR c\.deleted_at IS NOT NULL\)\s+ORDER BY p\.reconciled_at ASC NULLS FIRST, p\.updated_at ASC, p\.computer_id ASC\s+LIMIT \$\d+\s+FOR UPDATE OF p SKIP LOCKED\)/.test(text)) {
                    throw new Error('fake db: unexpected retire-pending-claim SQL');
                }
                const limit = Number(params.at(-1));
                const states = new Set(params.slice(0, -1) as string[]);
                const gone = (id: unknown) => {
                    const c = computers.find((x) => uuidEq(x.id, id));
                    return !c || c.deleted_at != null;
                };
                const at = (v: unknown) => (v === null || v === undefined ? -Infinity : new Date(v as Date).getTime());
                const picked = placements
                    .filter((r) => r.provider === 'aws-ec2' && states.has(String(r.state)) && gone(r.computer_id))
                    .sort((a, b) => at(a.reconciled_at) - at(b.reconciled_at) || at(a.updated_at) - at(b.updated_at)
                        || String(a.computer_id).localeCompare(String(b.computer_id)))
                    .slice(0, limit);
                const ids = new Set(picked.map((r) => String(r.computer_id).toLowerCase()));
                const hit = placements.filter((r) => ids.has(String(r.computer_id).toLowerCase()));
                for (const r of hit) {
                    const before = r.reconciled_at;
                    r.reconciled_at = clock();
                    tx?.undo.push(() => { r.reconciled_at = before; });
                }
                return { rows: hit.map((r) => ({ computer_id: r.computer_id, owner_user_id: r.owner_user_id })) };
            }
            case 'retention': {
                // The provider predicate is read from the SQL text, so dropping it changes the answer.
                const awsOnly = /provider = 'aws-ec2'/.test(text);
                return { rows: placements
                    .filter((r) => (r.state === 'STOPPED' || r.state === 'RETIRED') && (!awsOnly || r.provider === 'aws-ec2'))
                    .map((r) => ({ computer_id: r.computer_id, state: r.state, updated_at: r.updated_at })) };
            }
            case 'insert': {
                const m = text.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*RETURNING/);
                if (!m) throw new Error('fake db: unparsed insert');
                const cols = m[1]!.split(',').map((s) => s.trim());
                const vals = m[2]!.split(',').map((s) => s.trim());
                const row: Row = imageTable ? {} : placementRow({ computer_id: '' });
                cols.forEach((c, i) => (row[c] = value(vals[i]!, params)));
                writeRows.push(row);
                tx?.undo.push(() => writeRows.splice(writeRows.indexOf(row), 1));
                return { rows: [presentWrite(row)] };
            }
            case 'image-cas':
            case 'image-write':
            case 'enroll-digest':
            case 'cas': {
                const m = text.match(/SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?)\s+RETURNING/);
                if (!m) throw new Error('fake db: unparsed update');
                const instant = (v: unknown) => (v === null || v === undefined ? NaN : new Date(v as string | Date).getTime());
                const where = m[2]!.split(/\s+AND\s+/).map((pred): ((r: Row) => boolean) => {
                    const text = pred.trim();
                    const isNull = text.match(/^(\w+) IS NULL$/);
                    if (isNull) return (r) => r[isNull[1]!] == null;
                    const nullable = text.match(/^(\w+) IS NOT DISTINCT FROM (\$\d+(?:::\w+)?)$/);
                    if (nullable) return (r) => (r[nullable[1]!] ?? null) === value(nullable[2]!, params);
                    const available = text.match(/^\((\w+) IS NULL OR \1 = (\$\d+)\)$/);
                    if (available) return (r) => r[available[1]!] == null || r[available[1]!] === value(available[2]!, params);
                    const list = text.match(/^(\w+) IN \(([^)]+)\)$/);
                    if (list) {
                        const values = list[2]!.split(',').map((v) => value(v.trim(), params));
                        return (r) => values.includes(r[list[1]!]);
                    }
                    const w = text.match(/^(\w+) (=|>) (\$\d+(?:::\w+)?|now\(\)|'aws-ec2')$/);
                    if (!w) throw new Error(`fake db: unsupported predicate ${pred}`);
                    if (w[2] === '>' && w[3] !== 'now()' && !w[3]!.endsWith('::timestamptz')) throw new Error(`fake db: unsupported comparison ${pred}`);
                    const col = w[1]!, v = value(w[3]!, params);
                    return (r) => w[2] === '>'
                        ? instant(r[col]) > instant(v)
                        : w[3]!.endsWith('::timestamptz') ? instant(r[col]) === instant(v)
                        : col === 'computer_id' || col === 'owner_user_id'
                          ? uuidEq(r[col], v)
                          : r[col] !== null && r[col] !== undefined && String(r[col]) === String(v);
                });
                // Split on top-level commas only: `GREATEST(col, $n)` holds one of its own.
                const assignments: string[] = [];
                let depth = 0, start = 0;
                const setText = m[1]!;
                for (let k = 0; k < setText.length; k++) {
                    if (setText[k] === '(') depth++;
                    else if (setText[k] === ')') depth--;
                    else if (setText[k] === ',' && depth === 0) { assignments.push(setText.slice(start, k).trim()); start = k + 1; }
                }
                assignments.push(setText.slice(start).trim());
                const sets = assignments.map((assign) => {
                    const inc = assign.match(/^(\w+) = (\w+) \+ (\$\d+)$/);
                    if (inc) return (r: Row) => (r[inc[1]!] = Number(r[inc[2]!]) + Number(value(inc[3]!, params)));
                    // Postgres GREATEST ignores NULLs: NULL only when both sides are.
                    const greatest = assign.match(/^(\w+) = GREATEST\(\1, (\$\d+::timestamptz)\)$/);
                    if (greatest) return (r: Row) => {
                        const cur = r[greatest[1]!], next = value(greatest[2]!, params);
                        const a = instant(cur), b = instant(next);
                        r[greatest[1]!] = Number.isNaN(a) ? (Number.isNaN(b) ? null : next) : Number.isNaN(b) || a >= b ? cur : next;
                    };
                    const set = assign.match(/^(\w+) = (.+)$/);
                    if (!set) throw new Error(`fake db: unsupported assignment ${assign}`);
                    return (r: Row) => (r[set[1]!] = set[2]!.trim() === set[1] ? r[set[1]!] : value(set[2]!.trim(), params));
                });
                // Atomic match-and-apply, like row-locked UPDATE re-evaluation.
                const hit = writeRows.filter((r) => where.every((matches) => matches(r)));
                for (const r of hit) {
                    const before = { ...r };
                    sets.forEach((apply) => apply(r));
                    tx?.undo.push(() => Object.assign(r, before));
                }
                return { rows: hit.map(presentWrite) };
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

    return { db, placements, imageJobs, usage, statements, runningExcluded: RUNNING_EXCLUDED };
}

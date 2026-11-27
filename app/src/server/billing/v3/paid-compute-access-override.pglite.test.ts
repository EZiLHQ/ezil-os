/**
 * Explicit access overrides in paid-compute SQL (pool eligibility, forward-move discovery), in-memory PGlite only.
 * Each test rolls back its transaction, using the exact 0019/0038 migrations and synthetic identities. Each scenario
 * is checked against TypeScript precedence. Set EZIL_PGLITE_MODULE to an installed PGlite ESM entry; no DB URL or env file.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SubscriptionRow } from '../meters';
import { planFromSubscriptions } from './catalog';
import type { AccessRow } from './effective-access';
import { paidComputeAccessCtes, paidComputeBranches } from './paid-compute-access-sql';
import { paidComputeAccessCtes as baselineCtes } from './live86a6-paid-compute-access-sql.test-support';
import { readOperatorEntitlements } from '@/server/entitlements/operator/store';
import { operatorOverridesInstalled } from '@/server/entitlements/operator/installed';
import { deriveStanding, operatorAccessFor, paidAccess } from './standing';

const modulePath = process.env.EZIL_PGLITE_MODULE;
interface LocalPg {
    exec(query: string): Promise<unknown>;
    query(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    transaction<T>(run: (tx: LocalPg) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
const DAY = 86_400_000;
const at = new Date('2026-11-25T12:00:00Z');
const period: [Date, Date] = [new Date('2026-11-10T00:00:00Z'), new Date('2026-12-10T00:00:00Z')];
type Tx = { execute(query: SQL): Promise<unknown> };
const rowsOf = (result: unknown) => [...(result as Iterable<Record<string, unknown>>)];

class Rollback extends Error {}

describe.skipIf(!modulePath)('paid-compute SQL: explicit access overrides (in-memory PostgreSQL)', () => {
    let pg: LocalPg;
    const dialect = new PgDialect();
    beforeAll(async () => {
        const { PGlite } = await import(/* @vite-ignore */ modulePath!);
        pg = new PGlite() as LocalPg;
        await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz, deleted_at timestamptz, banned_until timestamptz);
            CREATE TABLE public.ezil_billing_subscriptions (stripe_subscription_id text PRIMARY KEY, user_id uuid, sku text, status text,
                current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean,
                stripe_event_created timestamptz, trial_end timestamptz, first_paid_at timestamptz);
            CREATE TABLE public.ezil_billing_grants (user_id uuid, subscription_id text, meter text, kind text, amount bigint,
                period_start timestamptz, period_end timestamptz, source_type text, source_id text);
            CREATE TABLE public.ezil_billing_payment_issues (user_id uuid, subscription_id text, invoice_kind text,
                resolved_at timestamptz, issue text, stripe_event_created timestamptz);
            CREATE TABLE public.ezil_billing_size_preferences (user_id uuid PRIMARY KEY, size text);`);
    }, 60_000);
    afterAll(async () => { await pg?.close(); });

    async function rolledBack(fn: (tx: Tx) => Promise<void>) {
        await expect(pg.transaction(async source => {
            const tx: Tx = { execute: async query => {
                const compiled = dialect.sqlToQuery(query);
                // Migrations contain multiple statements; parameterized production reads use query.
                return compiled.params.length || /^\s*(SELECT|WITH)\b/i.test(compiled.sql)
                    ? (await source.query(compiled.sql, compiled.params)).rows : source.exec(compiled.sql);
            } };
            await fn(tx);
            throw new Rollback();
        })).rejects.toBeInstanceOf(Rollback);
    }

    /** Account fixtures: what TypeScript reads, and the same rows in SQL. */
    interface Account { id: string; subs: SubscriptionRow[]; grants: AccessRow[]; size: string | null }
    async function account(tx: Tx, name: string, spec: { stripe?: 'premium_monthly_v3' | 'standard_monthly_v3'; size?: string;
        rows?: Partial<AccessRow>[] }): Promise<Account> {
        const id = randomUUID();
        await tx.execute(sql`INSERT INTO auth.users (id, email, created_at) VALUES (${id}::uuid, ${`${name}.${id.slice(0, 8)}@example.com`}, now())`);
        const subs: SubscriptionRow[] = [];
        if (spec.stripe) {
            const sub = `sub_${id.replace(/-/g, '').slice(0, 20)}`;
            subs.push({ stripeSubscriptionId: sub, status: 'active', sku: spec.stripe, currentPeriodStart: period[0], currentPeriodEnd: period[1], cancelAtPeriodEnd: false });
            await tx.execute(sql`INSERT INTO public.ezil_billing_subscriptions (stripe_subscription_id, user_id, status, sku, current_period_start,
                current_period_end, cancel_at_period_end, stripe_event_created) VALUES (${sub}, ${id}::uuid, 'active', ${spec.stripe},
                ${period[0].toISOString()}::timestamptz, ${period[1].toISOString()}::timestamptz, false, ${period[0].toISOString()}::timestamptz)`);
            await tx.execute(sql`INSERT INTO public.ezil_billing_grants (user_id, subscription_id, meter, kind, amount, period_start, period_end, source_type, source_id)
                VALUES (${id}::uuid, ${sub}, 'compute_std_seconds', 'plan_period', 144000, ${period[0].toISOString()}::timestamptz,
                    ${period[1].toISOString()}::timestamptz, 'invoice', ${`in_${sub}`})`);
        }
        if (spec.size) await tx.execute(sql`INSERT INTO public.ezil_billing_size_preferences (user_id, size) VALUES (${id}::uuid, ${spec.size})`);
        const grants: AccessRow[] = [];
        for (const over of spec.rows ?? []) {
            const row: AccessRow = { ref: `osg-${randomUUID()}`, revision: 1, userId: id, accountPublicId: randomUUID(), sku: 'standard_monthly_v3',
                startsAt: new Date(at.getTime() - DAY), endsAt: new Date(at.getTime() + 30 * DAY), endedAt: null, ...over };
            grants.push(row);
            await tx.execute(sql`INSERT INTO public.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at, ends_at, ended_at, access_override)
                VALUES (${row.ref}, ${id}::uuid, ${row.accountPublicId}::uuid, ${row.sku}, 1, ${row.startsAt.toISOString()}::timestamptz,
                    ${row.endsAt?.toISOString() ?? null}::timestamptz, ${row.endedAt?.toISOString() ?? null}::timestamptz, ${row.accessOverride === true})`);
        }
        return { id, subs, grants, size: spec.size ?? null };
    }

    /** The TypeScript answer: paid standing on a v3 paid plan → that sku; otherwise not eligible. */
    function tsEligible(a: Account): string | null {
        const operator = operatorAccessFor({ subscriptions: a.subs, paymentIssues: [], grants: a.grants, now: at });
        const { standing } = deriveStanding({ subscriptions: a.subs, paymentIssues: [], placementProvider: null, now: at, operator });
        const plan = planFromSubscriptions({ subs: a.subs, now: at, userCreatedAt: null, operator });
        return paidAccess(standing) && (plan.sku === 'standard_monthly_v3' || plan.sku === 'premium_monthly_v3') ? plan.sku : null;
    }
    async function sqlEligible(tx: Tx, userId: string) {
        return rowsOf(await tx.execute(sql`WITH ${paidComputeAccessCtes(at.toISOString(), await paidComputeBranches(tx), userId)}
            SELECT sku, instance_type FROM eligible`));
    }
    async function installOverrideSchema(tx: Tx) {
        const migration = readFileSync(path.resolve(__dirname, '../../../../drizzle/0019_operator_entitlements.sql'), 'utf8');
        await tx.execute(sql.raw(migration));
        await tx.execute(sql.raw(readFileSync(path.resolve(__dirname, '../../../../drizzle/0038_operator_access_overrides.sql'), 'utf8')));
    }

    it('verified absence, pre-0038 and installation in one process use fresh availability and compatible reads', async () => {
        await rolledBack(async tx => {
            expect(await paidComputeBranches(tx)).toEqual({ operator: false });
            const payer = await account(tx, 'pre_table', { stripe: 'standard_monthly_v3' });
            expect(await sqlEligible(tx, payer.id)).toEqual([{ sku: 'standard_monthly_v3', instance_type: 'm6i.large' }]);
            await tx.execute(sql.raw(readFileSync(path.resolve(__dirname, '../../../../drizzle/0019_operator_entitlements.sql'), 'utf8')));
            expect(await paidComputeBranches(tx)).toEqual({ operator: true });
            expect(await operatorOverridesInstalled(tx)).toBe(false);
            expect(await readOperatorEntitlements(tx, payer.id)).toEqual([]);
            await tx.execute(sql`INSERT INTO public.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at)
                VALUES (${`osg-${randomUUID()}`}, ${payer.id}::uuid, ${randomUUID()}::uuid, 'premium_monthly_v3', 1, ${period[0].toISOString()}::timestamptz)`);
            expect(await sqlEligible(tx, payer.id)).toEqual([{ sku: 'standard_monthly_v3', instance_type: 'm6i.large' }]);
            await tx.execute(sql`UPDATE public.ezil_billing_subscriptions SET status = 'canceled' WHERE user_id = ${payer.id}::uuid`);
            expect(await sqlEligible(tx, payer.id)).toEqual([{ sku: 'premium_monthly_v3', instance_type: 'm6i.large' }]);
            await tx.execute(sql.raw(readFileSync(path.resolve(__dirname, '../../../../drizzle/0038_operator_access_overrides.sql'), 'utf8')));
            expect(await operatorOverridesInstalled(tx)).toBe(true);
            await tx.execute(sql`INSERT INTO public.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at, access_override)
                VALUES (${`osg-${randomUUID()}`}, ${payer.id}::uuid, ${randomUUID()}::uuid, 'free_v3', 1, ${period[0].toISOString()}::timestamptz, true)`);
            expect(await sqlEligible(tx, payer.id)).toEqual([]);
        });
    });

    it('partial 0038: live Free/paid overrides still decide without the capability index; no column probe is needed', async () => {
        await rolledBack(async tx => {
            await installOverrideSchema(tx);
            const free = await account(tx, 'partial_free', { stripe: 'premium_monthly_v3', rows: [{ sku: 'standard_monthly_v3' }, { sku: 'free_v3', accessOverride: true }] });
            const paid = await account(tx, 'partial_paid', { stripe: 'standard_monthly_v3', size: 'cmp-8', rows: [{ sku: 'premium_monthly_v3', accessOverride: true }] });
            await tx.execute(sql.raw('DROP INDEX public.ezil_operator_entitlements_one_live_override'));
            expect(await operatorOverridesInstalled(tx)).toBe(false);
            const guarded: Tx = { execute: query => {
                if (dialect.sqlToQuery(query).sql.includes('information_schema.columns')) throw new Error('column probe unavailable');
                return tx.execute(query);
            } };
            expect(await sqlEligible(guarded, free.id)).toEqual([]);
            expect(await sqlEligible(guarded, paid.id)).toEqual([{ sku: 'premium_monthly_v3', instance_type: 'm6i.2xlarge' }]);
        });
    });

    it('override precedence in SQL matches TypeScript for every scenario (Free removes, paid replaces, ended falls back)', async () => {
        await rolledBack(async tx => {
            await installOverrideSchema(tx);
            const cases: [string, Parameters<typeof account>[2], string | null, string | null][] = [
                ['stripe_premium', { stripe: 'premium_monthly_v3', size: 'cmp-8' }, 'premium_monthly_v3', 'm6i.2xlarge'],
                ['free_over_stripe', { stripe: 'premium_monthly_v3', size: 'cmp-8', rows: [{ sku: 'free_v3', accessOverride: true }] }, null, null],
                ['standard_over_stripe', { stripe: 'premium_monthly_v3', size: 'cmp-8', rows: [{ sku: 'standard_monthly_v3', accessOverride: true }] },
                    'standard_monthly_v3', 'm6i.large'],
                ['premium_over_free', { size: 'cmp-8', rows: [{ sku: 'premium_monthly_v3', accessOverride: true, endsAt: null }] }, 'premium_monthly_v3', 'm6i.2xlarge'],
                ['free_over_grant', { rows: [{ sku: 'standard_monthly_v3' }, { sku: 'free_v3', accessOverride: true }] }, null, null],
                ['grant_only', { rows: [{ sku: 'standard_monthly_v3' }] }, 'standard_monthly_v3', 'm6i.large'],
                ['premium_over_grant', { size: 'cmp-4', rows: [{ sku: 'standard_monthly_v3' }, { sku: 'premium_monthly_v3', accessOverride: true }] },
                    'premium_monthly_v3', 'm6i.xlarge'],
                ['ended_free_over_stripe', { stripe: 'premium_monthly_v3', rows: [{ sku: 'free_v3', accessOverride: true, endedAt: new Date(at.getTime() - 1000) }] },
                    'premium_monthly_v3', 'm6i.large'],
                ['expired_free_over_grant', { rows: [{ sku: 'standard_monthly_v3' }, { sku: 'free_v3', accessOverride: true, endsAt: new Date(at.getTime() - 1000) }] },
                    'standard_monthly_v3', 'm6i.large'],
                ['future_free_over_stripe', { stripe: 'standard_monthly_v3', rows: [{ sku: 'free_v3', accessOverride: true, startsAt: new Date(at.getTime() + 60_000) }] },
                    'standard_monthly_v3', 'm6i.large'],
            ];
            for (const [name, spec, sku, instanceType] of cases) {
                const a = await account(tx, name, spec);
                const rows = await sqlEligible(tx, a.id);
                expect(tsEligible(a), `${name}: TypeScript`).toBe(sku);
                expect(rows, `${name}: SQL`).toEqual(sku === null ? [] : [{ sku, instance_type: instanceType }]);
            }
        });
    });

    it('negative control: exact live86a6 source admits the Free-overridden payer; rollback source excludes it', async () => {
        await rolledBack(async tx => {
            await installOverrideSchema(tx);
            const a = await account(tx, 'baseline', { stripe: 'premium_monthly_v3', rows: [{ sku: 'standard_monthly_v3' }, { sku: 'free_v3', accessOverride: true }] });
            expect(rowsOf(await tx.execute(sql`WITH ${baselineCtes(at.toISOString(), true, a.id)} SELECT sku, instance_type FROM eligible`)))
                .toEqual([{ sku: 'premium_monthly_v3', instance_type: 'm6i.large' }]);
            expect(await sqlEligible(tx, a.id)).toEqual([]);
            const fleet = rowsOf(await tx.execute(sql`WITH ${paidComputeAccessCtes(at.toISOString(), await paidComputeBranches(tx))}
                SELECT user_id::text AS user_id FROM eligible`));
            expect(fleet).toEqual([]);
        });
    });
});

describe('rollback SQL source control', () => {
    it('pins the negative-control file byte-for-byte to the exact live parent', () => {
        const baseline = readFileSync(path.resolve(__dirname, 'live86a6-paid-compute-access-sql.test-support.ts'));
        expect(createHash('sha256').update(baseline).digest('hex')).toBe('38047061dcd5eff80f60077d7fc28b1ccc10f59d2234151eaa934b752678da56');
    });
    it('every present-table form uses compatible override reads; absent-table form never references the table', () => {
        const text = (q: SQL) => new PgDialect().sqlToQuery(q).sql;
        expect(text(paidComputeAccessCtes(at.toISOString(), true))).toContain("to_jsonb(o)->>'access_override'");
        expect(text(paidComputeAccessCtes(at.toISOString(), { operator: true }))).toBe(text(paidComputeAccessCtes(at.toISOString(), true)));
        expect(text(paidComputeAccessCtes(at.toISOString(), false))).not.toContain('ezil_operator_entitlements');
    });
});

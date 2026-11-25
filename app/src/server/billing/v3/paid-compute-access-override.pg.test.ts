/**
 * Explicit access overrides in the paid-compute SQL (pool eligibility, forward-move discovery) against a real, disposable
 * Postgres (`app/scripts/billing-test-db.sh up`). Everything runs in ONE transaction that is rolled back: 0019 when absent,
 * and the source lane's declared override schema, TEST-ONLY here (`access_override boolean NOT NULL DEFAULT false`, `free_v3`
 * admitted, one live row per account and slot). Each scenario is checked against the TypeScript precedence (parity).
 * Skipped without BILLING_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SubscriptionRow } from '../meters';
import { planFromSubscriptions } from './catalog';
import type { AccessRow } from './effective-access';
import { accessOverrideInstalled, paidComputeAccessCtes, resetAccessOverrideInstalled } from './paid-compute-access-sql';
import { deriveStanding, operatorAccessFor, paidAccess } from './standing';

const url = process.env.BILLING_TEST_DATABASE_URL;
const DAY = 86_400_000;
const at = new Date('2026-11-25T12:00:00Z');
const period: [Date, Date] = [new Date('2026-11-10T00:00:00Z'), new Date('2026-12-10T00:00:00Z')];
type Tx = { execute(query: SQL): Promise<unknown> };
const rowsOf = (result: unknown) => [...(result as Iterable<Record<string, unknown>>)];

class Rollback extends Error {}

describe.skipIf(!url)('paid-compute SQL: explicit access overrides (real Postgres, rolled back)', () => {
    let client: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle>;
    beforeAll(() => {
        client = postgres(url!, { max: 2, prepare: false });
        db = drizzle(client);
    });
    afterAll(async () => { await client?.end(); });

    async function rolledBack(fn: (tx: Tx) => Promise<void>) {
        await expect(db.transaction(async tx => { await fn(tx); throw new Rollback(); })).rejects.toBeInstanceOf(Rollback);
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
    async function sqlEligible(tx: Tx, userId: string, override: boolean) {
        return rowsOf(await tx.execute(sql`WITH ${paidComputeAccessCtes(at.toISOString(), { operator: true, override }, userId)}
            SELECT sku, instance_type FROM eligible`));
    }
    async function installOverrideSchema(tx: Tx) {
        const migration = readFileSync(path.resolve(__dirname, '../../../../drizzle/0019_operator_entitlements.sql'), 'utf8');
        await tx.execute(sql.raw(migration));
        await tx.execute(sql.raw(`ALTER TABLE public.ezil_operator_entitlements ADD COLUMN access_override boolean NOT NULL DEFAULT false;
            ALTER TABLE public.ezil_operator_entitlements DROP CONSTRAINT ezil_operator_entitlements_sku_check;
            ALTER TABLE public.ezil_operator_entitlements ADD CONSTRAINT ezil_operator_entitlements_sku_check
                CHECK (sku IN ('standard_monthly_v3', 'premium_monthly_v3') OR (access_override AND sku = 'free_v3'));
            DROP INDEX public.ezil_operator_entitlements_one_live;
            CREATE UNIQUE INDEX ezil_operator_entitlements_one_live ON public.ezil_operator_entitlements (user_id, access_override) WHERE ended_at IS NULL;`));
    }

    it('the column probe is "no" without the source lane column and "yes" with it', async () => {
        await rolledBack(async tx => {
            const migration = readFileSync(path.resolve(__dirname, '../../../../drizzle/0019_operator_entitlements.sql'), 'utf8');
            await tx.execute(sql.raw(migration));
            await tx.execute(sql.raw('ALTER TABLE public.ezil_operator_entitlements DROP COLUMN IF EXISTS access_override'));
            resetAccessOverrideInstalled();
            expect(await accessOverrideInstalled(tx, 0)).toBe(false);
            resetAccessOverrideInstalled();
            await tx.execute(sql.raw('ALTER TABLE public.ezil_operator_entitlements ADD COLUMN access_override boolean NOT NULL DEFAULT false'));
            expect(await accessOverrideInstalled(tx, 0)).toBe(true);
            resetAccessOverrideInstalled();
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
                const rows = await sqlEligible(tx, a.id, true);
                expect(tsEligible(a), `${name}: TypeScript`).toBe(sku);
                expect(rows, `${name}: SQL`).toEqual(sku === null ? [] : [{ sku, instance_type: instanceType }]);
            }
        });
    });

    it('positive control: without the override branch the same Free override over Stripe is still eligible (today\'s SQL)', async () => {
        await rolledBack(async tx => {
            await installOverrideSchema(tx);
            const a = await account(tx, 'branch_off', { stripe: 'premium_monthly_v3', rows: [{ sku: 'free_v3', accessOverride: true }] });
            expect(await sqlEligible(tx, a.id, false)).toEqual([{ sku: 'premium_monthly_v3', instance_type: 'm6i.large' }]);
            expect(await sqlEligible(tx, a.id, true)).toEqual([]);
            // The fleet-wide form (no user filter) agrees: the account is absent with the branch, present without it.
            const fleet = async (override: boolean) => rowsOf(await tx.execute(sql`WITH ${paidComputeAccessCtes(at.toISOString(), { operator: true, override })}
                SELECT user_id::text AS user_id FROM eligible WHERE user_id = ${a.id}::uuid`)).length;
            expect(await fleet(true)).toBe(0);
            expect(await fleet(false)).toBe(1);
        });
    });
});

describe('paid-compute SQL text without the override branch', () => {
    it('a bare boolean and { override: false } build the same SQL, with no override reference', () => {
        const text = (q: SQL) => new PgDialect().sqlToQuery(q).sql;
        const user = '00000000-0000-4000-8000-000000000001';
        const legacy = text(paidComputeAccessCtes(at.toISOString(), true, user));
        expect(legacy).not.toContain('override');
        expect(text(paidComputeAccessCtes(at.toISOString(), { operator: true, override: false }, user))).toBe(legacy);
        expect(text(paidComputeAccessCtes(at.toISOString(), { operator: true, override: true }))).toContain('access_override');
        // The override branch needs the operator branch (no table, no column).
        expect(text(paidComputeAccessCtes(at.toISOString(), { operator: false, override: true }))).not.toContain('override');
    });
});

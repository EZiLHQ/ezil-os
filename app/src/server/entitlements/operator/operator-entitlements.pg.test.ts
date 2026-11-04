/**
 * Product entitlements v1 on real PostgreSQL (EZIL_PG_TEST_URL, a disposable database): the signed-source command
 * persists through app/drizzle/0019_operator_entitlements.sql, and the SAME rows then drive the billing resolver
 * (loadComputeBillingState, the start gate, the entitlement reader), paid-pool eligibility (ready-pool.ts) and the
 * Cloudflare-to-AWS move candidates (placement.ts). Synthetic identities only; no Stripe, credit or provider call.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '@/server/billing/config';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, BillingStore } from '@/server/billing/ports';
import { billingV2EntitlementReader, gateComputerStart, loadComputeBillingState, paidComputeUnmeteredState } from '@/server/billing/v2/compute-access';
import { paidCloudflareCandidates } from '@/server/lib/compute/placement';
import { readPaidPoolEligibility } from '@/server/lib/compute/ready-pool';
import { sourceCatalog } from './contract';
import { handleCommand } from './service';
import { SENDER_KEYS_ENV } from './signature';
import { createOperatorEntitlementDeps, readOperatorEntitlements, resetOperatorEntitlementsInstalled, type Executor, type TransactionalExecutor } from './store';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `operator_entitlements_${randomUUID().replaceAll('-', '')}`;
const NOW = new Date('2026-11-04T12:00:00.000Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINKED = uuid(1), UNLINKED = uuid(2), DELETED = uuid(3), OTHER = uuid(4);
const REVISION = sourceCatalog().catalog_revision;

describe.skipIf(!PG)('product entitlements v1 on PostgreSQL: source command → persisted grant → billing, pool and move readers', () => {
    const client = PG ? postgres(PG, { max: 8, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`).replaceAll('auth.users', `${schema}.test_users`)
        .replaceAll('ezil_works.ai_members', `${schema}.ai_members`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (source: Pick<NonNullable<typeof production>, 'execute'>): Executor => ({ execute: q => source.execute(scoped(q)) });
    const db: TransactionalExecutor = { execute: q => executor(production!).execute(q), transaction: run => production!.transaction(tx => run(executor(tx))) };
    let subs: SubscriptionRow[] = [];
    // A billing store whose Stripe rows are in memory (never written) and whose operator grants are the real table.
    const store = {
        subscriptionsFor: async () => subs, userCreatedAt: async () => null, openPlanChanges: async () => [], openPaymentIssues: async () => [],
        epochsFor: async () => [], grantsForPeriod: async () => [], sizePreference: async () => null, openEpochFor: async () => null,
        operatorEntitlementsFor: (userId: string) => readOperatorEntitlements(db, userId),
    } as unknown as BillingStore;
    const billing: BillingDeps = { config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }), store, stripe: null, usage: null, now: () => NOW };
    const deps = createOperatorEntitlementDeps(db, billing, () => NOW);
    let commandSeq = 0;
    const command = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        format: 'ezil.admin-entitlement-command.v1', command_id: `20000000-0000-4000-8000-${String(++commandSeq).padStart(12, '0')}`, action: 'assign',
        producer: 'ezil-os', scope: 'individual', operator: { via: 'auth0_operator', actor: uuid(900), email: 'operator@example.test' },
        product: { ref: 'standard_monthly_v3', catalog_revision: REVISION },
        target: { kind: 'individual', os_user_id: LINKED, account_public_id: account(1) }, quantity: null, starts_at: null,
        validity: { ends_at: '2026-12-04T12:00:00.000Z' }, reason: 'Synthetic: staging access', assignment: null, billing_effect: 'none', credit_option: 'none', ...over,
    });
    const send = (body: Record<string, unknown>) => handleCommand(deps, body, String(body.command_id), 'test-ae-1');
    let created = false;

    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        await client!.unsafe(`CREATE TABLE ${schema}.test_users (id uuid PRIMARY KEY, deleted_at timestamptz, banned_until timestamptz, is_anonymous boolean);
            CREATE TABLE ${schema}.ai_members (auth_user_id uuid, public_id uuid);
            CREATE TABLE ${schema}.ezil_billing_subscriptions (stripe_subscription_id text PRIMARY KEY, user_id uuid, sku text, status text,
                current_period_start timestamptz, current_period_end timestamptz);
            CREATE TABLE ${schema}.ezil_billing_size_preferences (user_id uuid PRIMARY KEY, size text);
            CREATE TABLE ${schema}.ezil_billing_grants (user_id uuid, subscription_id text, meter text, amount bigint, period_start timestamptz, period_end timestamptz);
            CREATE TABLE ${schema}.ezil_billing_payment_issues (user_id uuid, subscription_id text, invoice_kind text, resolved_at timestamptz, issue text);
            CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot int NOT NULL DEFAULT 1, deleted_at timestamptz);
            CREATE TABLE ${schema}.ezil_computer_placements (computer_id uuid PRIMARY KEY, provider text);
            CREATE TABLE ${schema}.ezil_compute_migrations (computer_id uuid, user_id uuid, state text, last_error text, updated_at timestamptz);`);
        // The migration under test, exactly as released (schema-scoped like the other PostgreSQL suites).
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0019_operator_entitlements.sql'), 'utf8')));
    });
    beforeEach(async () => {
        subs = [];
        commandSeq = 0;
        resetOperatorEntitlementsInstalled();
        vi.stubEnv(SENDER_KEYS_ENV, JSON.stringify({ 'test-ae-1': 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a' }));
        await client!.unsafe(`ALTER TABLE ${schema}.ezil_operator_entitlement_events DISABLE TRIGGER ezil_operator_entitlement_events_append_only;
            TRUNCATE ${schema}.ezil_operator_entitlement_events, ${schema}.ezil_operator_entitlements, ${schema}.test_users, ${schema}.ai_members,
                ${schema}.ezil_computers, ${schema}.ezil_computer_placements, ${schema}.ezil_billing_subscriptions;
            ALTER TABLE ${schema}.ezil_operator_entitlement_events ENABLE TRIGGER ezil_operator_entitlement_events_append_only;
            INSERT INTO ${schema}.test_users (id, deleted_at) VALUES ('${LINKED}', NULL), ('${UNLINKED}', NULL), ('${DELETED}', now()), ('${OTHER}', NULL);
            INSERT INTO ${schema}.ai_members VALUES ('${LINKED}', '${account(1)}'), ('${DELETED}', '${account(3)}'), ('${OTHER}', '${account(4)}');
            INSERT INTO ${schema}.ezil_computers (id, user_id) VALUES ('${uuid(101)}', '${LINKED}');`);
    });
    afterEach(() => { vi.unstubAllEnvs(); });
    afterAll(async () => {
        if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await client?.end();
    });

    it('assign persists one grant and one audit event; the same grant then drives billing, the gate, the reader, the pool and the move', async () => {
        expect(await readPaidPoolEligibility(db, LINKED, NOW)).toBeNull();
        expect(await paidCloudflareCandidates(db, NOW)).toEqual([]);
        const result = await send(command());
        expect(result).toMatchObject({ outcome: 'applied', effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'operator' } });
        const rows = await client!.unsafe(`SELECT user_id::text, account_public_id::text, sku, revision, ended_at FROM ${schema}.ezil_operator_entitlements`);
        expect(rows).toEqual([{ user_id: LINKED, account_public_id: account(1), sku: 'standard_monthly_v3', revision: 1, ended_at: null }]);
        const events = await client!.unsafe(`SELECT action, revision, sender_kid, operator_actor, result->>'outcome' AS outcome FROM ${schema}.ezil_operator_entitlement_events`);
        expect(events).toEqual([{ action: 'assign', revision: 1, sender_kid: 'test-ae-1', operator_actor: uuid(900), outcome: 'applied' }]);
        expect(JSON.stringify(await client!.unsafe(`SELECT * FROM ${schema}.ezil_operator_entitlement_events`))).not.toContain('operator@example.test');

        const state = await loadComputeBillingState(billing, LINKED, NOW);
        expect(state).toMatchObject({ planSku: 'standard_monthly_v3', subscriptionId: null, provider: 'aws', sessionMaxSeconds: 21_600 });
        expect(paidComputeUnmeteredState(state)).toBe(true);
        expect(await gateComputerStart({ deps: billing, userId: LINKED, computerId: uuid(101), kind: 'aws-ec2', instanceType: 'm6i.large', now: NOW })).toEqual({ allowed: true });
        expect(await billingV2EntitlementReader(() => billing).read(LINKED)).toMatchObject({ status: 'active', planId: 'standard_monthly_v3', provider: 'aws' });
        expect(await readPaidPoolEligibility(db, LINKED, NOW)).toEqual({ instanceType: 'm6i.large' });
        expect(await paidCloudflareCandidates(db, NOW)).toEqual([{ userId: LINKED, computerId: uuid(101), toSize: 'standard' }]);
        // No Stripe row was written for it.
        expect(await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_billing_subscriptions`)).toEqual([{ n: 0 }]);
    });

    it('end takes the access away everywhere at once; an expired grant is no access either', async () => {
        const applied = await send(command());
        const ended = await send(command({ action: 'end', product: null, validity: null, assignment: { ref: applied.assignment!.ref, expected_revision: 1 } }));
        expect(ended).toMatchObject({ outcome: 'applied', assignment: { revision: 2, state: 'ended' }, effective_access: { state: 'none' } });
        expect((await loadComputeBillingState(billing, LINKED, NOW)).planSku).toBe('free_v3');
        expect(await readPaidPoolEligibility(db, LINKED, NOW)).toBeNull();
        expect(await paidCloudflareCandidates(db, NOW)).toEqual([]);
        // A new assign after the end is allowed (one LIVE assignment per account), and after its own end date nothing is in effect.
        await send(command({ validity: { ends_at: '2026-11-05T12:00:00.000Z' } }));
        const after = new Date('2026-11-05T12:00:00.000Z');
        expect((await loadComputeBillingState({ ...billing, now: () => after }, LINKED, after)).planSku).toBe('free_v3');
        expect(await readPaidPoolEligibility(db, LINKED, after)).toBeNull();
    });

    it('idempotency on the real table: replay, payload mismatch, and two concurrent sends of one command apply once', async () => {
        const body = command();
        const [a, b] = await Promise.all([send(body), send(body)]);
        expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'replayed']);
        expect(await send({ ...body, reason: 'Different' })).toMatchObject({ refusal: { code: 'payload_mismatch' } });
        // Two different commands for one fresh account at once: the advisory locks give exactly one grant, the other is refused.
        const other = { kind: 'individual', os_user_id: OTHER, account_public_id: account(4) };
        const [x, y] = await Promise.all([send(command({ target: other, product: { ref: 'premium_monthly_v3', catalog_revision: REVISION } })), send(command({ target: other }))]);
        expect([x.outcome, y.outcome].sort()).toEqual(['applied', 'refused']);
        expect([x, y].find(r => r.outcome === 'refused')).toMatchObject({ refusal: { code: 'invalid_command' } });
        expect(await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_operator_entitlements WHERE ended_at IS NULL`)).toEqual([{ n: 2 }]);
        expect(await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_operator_entitlement_events`)).toEqual([{ n: 2 }]);
    });

    it('identity: unlinked, deleted, another user\'s account and a doubly linked account are refused; nothing written', async () => {
        // A fifth user linked to two Gateway accounts.
        const DOUBLE = uuid(5);
        await client!.unsafe(`INSERT INTO ${schema}.test_users (id) VALUES ('${DOUBLE}');
            INSERT INTO ${schema}.ai_members VALUES ('${DOUBLE}', '${account(5)}'), ('${DOUBLE}', '${account(6)}')`);
        for (const [target, code] of [
            [{ os_user_id: UNLINKED, account_public_id: account(2) }, 'identity_not_found'],
            [{ os_user_id: DELETED, account_public_id: account(3) }, 'identity_not_found'],
            [{ os_user_id: uuid(999), account_public_id: account(9) }, 'identity_not_found'],
            [{ os_user_id: LINKED, account_public_id: account(4) }, 'ambiguous_identity'],
            [{ os_user_id: DOUBLE, account_public_id: account(5) }, 'ambiguous_identity'],
        ] as const) {
            expect(await send(command({ target: { kind: 'individual', ...target } }))).toMatchObject({ outcome: 'refused', refusal: { code } });
        }
        expect(await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_operator_entitlements`)).toEqual([{ n: 0 }]);
    });

    it('a paid Stripe subscription refuses the assign before any write, and wins in every reader', async () => {
        subs = [{ stripeSubscriptionId: 'sub_paid', sku: 'premium_monthly_v3', status: 'active', currentPeriodStart: new Date('2026-10-20T00:00:00Z'),
            currentPeriodEnd: new Date('2026-11-20T00:00:00Z'), cancelAtPeriodEnd: false }];
        expect(await send(command())).toMatchObject({ refusal: { code: 'paid_subscription_conflict' }, effective_access: { via: 'stripe', product_ref: 'premium_monthly_v3' } });
        expect(await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_operator_entitlements`)).toEqual([{ n: 0 }]);
    });

    it('pool eligibility lets a paid Stripe subscription win over an operator row for the same user (one row, never ambiguous)', async () => {
        // An operator row written while there was no paid plan, then a Stripe subscription mirrored (paid wins).
        await send(command());
        await client!.unsafe(`INSERT INTO ${schema}.ezil_billing_subscriptions VALUES ('sub_paid', '${LINKED}', 'premium_monthly_v3', 'active',
                '2026-10-20T00:00:00Z', '2026-11-20T00:00:00Z');
            INSERT INTO ${schema}.ezil_billing_grants VALUES ('${LINKED}', 'sub_paid', 'compute_std_seconds', 1800000, '2026-10-20T00:00:00Z', '2026-11-20T00:00:00Z');
            INSERT INTO ${schema}.ezil_billing_size_preferences VALUES ('${LINKED}', 'cmp-8')`);
        expect(await readPaidPoolEligibility(db, LINKED, NOW)).toEqual({ instanceType: 'm6i.2xlarge' });
        await client!.unsafe(`TRUNCATE ${schema}.ezil_billing_grants, ${schema}.ezil_billing_size_preferences`);
    });

    it('the event log is append-only and the live-assignment rule is enforced by the database itself', async () => {
        const applied = await send(command());
        await expect(client!.unsafe(`UPDATE ${schema}.ezil_operator_entitlement_events SET reason = 'x'`)).rejects.toThrow(/append-only/);
        await expect(client!.unsafe(`DELETE FROM ${schema}.ezil_operator_entitlement_events`)).rejects.toThrow(/append-only/);
        await expect(client!.unsafe(`INSERT INTO ${schema}.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at)
            VALUES ('osg-${uuid(77)}', '${LINKED}', '${account(1)}', 'standard_monthly_v3', 1, now())`)).rejects.toThrow(/one_live/);
        await expect(client!.unsafe(`INSERT INTO ${schema}.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at)
            VALUES ('osg-${uuid(78)}', '${OTHER}', '${account(4)}', 'team_standard', 1, now())`)).rejects.toThrow();
        expect(applied.assignment!.ref).toMatch(/^osg-/);
    });

    it('without the source configured the compute SQL is unchanged and ignores grants (the release applies 0019 first)', async () => {
        await send(command());
        vi.stubEnv(SENDER_KEYS_ENV, '');
        resetOperatorEntitlementsInstalled();
        expect(await readPaidPoolEligibility(db, LINKED, NOW)).toBeNull();
        expect(await paidCloudflareCandidates(db, NOW)).toEqual([]);
    });
});

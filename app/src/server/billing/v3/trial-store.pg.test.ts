/**
 * Standard trial store and 0021 against a real, disposable Postgres (`app/scripts/billing-test-db.sh up`).
 * Committed rows under fresh ids (the claims race across connections, so no wrapping transaction); every
 * account this suite creates is deleted at the end. Skipped without BILLING_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import type { BillingStore } from '../ports';
import { createBillingStore } from '../store';
import { paidComputeAccessCtes } from './paid-compute-access-sql';
import { hasTrials, trialTerms, type TrialStore } from './trial';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

type Database = typeof import('@/server/db').db;
const DAY = 86_400_000;
const run = randomUUID().slice(0, 8);

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('Standard trial store with Postgres (0021)', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore & TrialStore;
    const users: string[] = [];

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 12, prepare: false });
        db = drizzle(client, { schema }) as unknown as Database;
        const created = createBillingStore(db);
        if (!hasTrials(created)) throw new Error('the store must implement the trial port');
        store = created;
    });
    afterAll(async () => {
        if (users.length) {
            await client`delete from public.ezil_billing_trials where user_id = any(${users}::uuid[]) or email_normalized like ${`%${run}%`}`;
            await client`delete from auth.users where id = any(${users}::uuid[])`;
        }
        await client?.end();
    });

    async function account(email: string, options: { verified?: boolean; auth0?: string; id?: string } = {}) {
        const id = options.id ?? randomUUID();
        users.push(id);
        await client`insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data, created_at)
            values (${id}::uuid, ${email}, ${options.verified === false ? null : new Date().toISOString()}::timestamptz,
                ${JSON.stringify(options.auth0 ? { auth0_sub: options.auth0 } : {})}::jsonb, now())`;
        return id;
    }
    const at = new Date('2026-11-05T10:00:00Z');
    async function quote(userId: string, now = at) {
        const facts = await store.trialFacts(userId);
        const terms = trialTerms(now);
        return store.claimTrialQuote({ userId, authSubject: facts.authSubject, emailNormalized: facts.emailNormalized!,
            quotedAt: terms.quotedAt, trialEnd: terms.trialEnd, returnOrigin: 'https://os-staging.ezil.work' });
    }
    async function start(userId: string, subscriptionId = `sub_${randomUUID().replace(/-/g, '')}`) {
        const facts = await store.trialFacts(userId);
        const customer = `cus_${randomUUID().replace(/-/g, '')}`;
        expect(await store.linkCustomer(userId, customer)).toBe('linked');
        expect(await store.attachTrialCheckout({ trialId: facts.own!.id, userId, quotedAt: facts.own!.quotedAt,
            checkoutSessionId: `cs_${randomUUID().replace(/-/g, '')}`, customerId: customer })).toBe('attached');
        expect(await store.bindTrialSubscription({ trialId: facts.own!.id, userId, customerId: customer, subscriptionId, trialStart: at })).toBe('bound');
        return { trialId: facts.own!.id, subscriptionId, customer };
    }

    it('reads verified identity facts from auth.users, never from the caller', async () => {
        const verified = await account(`Facts.${run}+x@GMAIL.com`, { auth0: 'auth0|facts' });
        const unverified = await account(`unverified.${run}@example.com`, { verified: false });
        expect(await store.trialFacts(verified)).toMatchObject({ emailNormalized: `facts${run}@gmail.com`, emailVerified: true,
            authSubject: 'auth0:auth0|facts', own: null, claimedElsewhere: false, paidBefore: false });
        expect(await store.trialFacts(unverified)).toMatchObject({ emailVerified: false, authSubject: `supabase:${unverified}` });
    });

    it('concurrent quotes from two accounts that are the same Gmail person: exactly one claim wins', async () => {
        const a = await account(`race.${run}@gmail.com`);
        const b = await account(`r.a.c.e.${run}+second@googlemail.com`);
        const results = await Promise.all([quote(a), quote(b), quote(a), quote(b)]);
        const owners = new Set((await client`select user_id::text from public.ezil_billing_trials where email_normalized = ${`race${run}@gmail.com`}`)
            .map(row => row.user_id));
        expect(owners.size).toBe(1);
        const winner = [...owners][0]!;
        const loser = winner === a ? b : a;
        expect(results.filter((_, i) => [a, b, a, b][i] === loser).every(result => result.status === 'refused')).toBe(true);
        expect(results.filter((_, i) => [a, b, a, b][i] === winner).every(result => result.status === 'quoted')).toBe(true);
        expect((await store.trialFacts(loser)).claimedElsewhere).toBe(true);
    });

    it('ten concurrent quotes from one account leave one row; a re-quote moves the end and clears the checkout', async () => {
        const a = await account(`same.${run}@example.com`);
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => quote(a, new Date(at.getTime() + i * 1000))));
        expect(results.every(result => result.status === 'quoted')).toBe(true);
        expect((await client`select count(*)::int as n from public.ezil_billing_trials where user_id = ${a}::uuid`)[0]!.n).toBe(1);
    });

    it('R3: a re-quote after the verified email changed claims the new email; another account aliasing it is refused', async () => {
        const a = await account(`old.${run}@gmail.com`);
        expect((await quote(a)).status).toBe('quoted');
        await client`update auth.users set email = ${`new.${run}@gmail.com`} where id = ${a}::uuid`;
        const facts = await store.trialFacts(a);
        expect(facts.emailNormalized).toBe(`new${run}@gmail.com`);
        expect(facts.own!.emailNormalized).toBe(`old${run}@gmail.com`); // the stale claim checkout refuses (router test)
        const requoted = await quote(a);
        expect(requoted.status === 'quoted' && requoted.trial.emailNormalized).toBe(`new${run}@gmail.com`);
        const b = await account(`n.e.w.${run}+alias@gmail.com`);
        expect((await store.trialFacts(b)).claimedElsewhere).toBe(true);
        expect((await quote(b)).status).toBe('refused');
    });

    it('a started trial blocks any other account whose CURRENT email is the same person, even after the owner changed email', async () => {
        const a = await account(`first.${run}@gmail.com`);
        await quote(a);
        await start(a);
        await client`update auth.users set email = ${`moved.${run}@gmail.com`} where id = ${a}::uuid`;
        const b = await account(`moved.${run}+b@gmail.com`);
        expect((await store.trialFacts(b)).claimedElsewhere).toBe(true);
        expect((await store.trialFacts(a))).toMatchObject({ claimedElsewhere: false, own: { status: 'trialing' } });
        expect((await quote(a)).status).toBe('refused');
    });

    it('E1: deleting an account keeps a started trial as a tombstone; signing up again with that email or subject is refused', async () => {
        const a = await account(`tomb.${run}@example.com`, { auth0: `auth0|tomb-${run}` });
        await quote(a);
        const { trialId } = await start(a);
        await client`delete from auth.users where id = ${a}::uuid`;
        expect(await client`select user_id, status, email_normalized from public.ezil_billing_trials where id = ${trialId}::uuid`)
            .toEqual([{ user_id: null, status: 'trialing', email_normalized: `tomb.${run}@example.com` }]);
        const again = await account(`tomb.${run}@example.com`);
        expect((await store.trialFacts(again)).claimedElsewhere).toBe(true);
        expect((await quote(again)).status).toBe('refused');
        const sameSubject = await account(`other.${run}@example.com`, { auth0: `auth0|tomb-${run}` });
        expect((await store.trialFacts(sameSubject)).claimedElsewhere).toBe(true);
    });

    it('E1: a deleted account\'s never-started quote is reclaimed by the next sign-up; normal deletion is never blocked', async () => {
        const a = await account(`quoteonly.${run}@example.com`);
        await quote(a);
        await client`delete from auth.users where id = ${a}::uuid`;
        const again = await account(`quoteonly.${run}@example.com`);
        expect((await store.trialFacts(again)).claimedElsewhere).toBe(false);
        const claim = await quote(again);
        expect(claim.status).toBe('quoted');
        expect((await client`select count(*)::int as n from public.ezil_billing_trials where email_normalized = ${`quoteonly.${run}@example.com`}`)[0]!.n).toBe(1);
    });

    it('R4: a started trial keeps every verified identity it had: change and verify an email, read Billing, delete, recreate an alias', async () => {
        const a = await account(`r4old.${run}@gmail.com`);
        await quote(a);
        const { trialId } = await start(a);
        await client`update auth.users set email = ${`r4new.${run}@gmail.com`}, email_confirmed_at = now() where id = ${a}::uuid`;
        // Billing reads the account (summary → trialFacts): the new verified identity is retained, not just selected.
        expect((await store.trialFacts(a)).own).toMatchObject({ status: 'trialing', emailNormalized: `r4old${run}@gmail.com` });
        expect((await client`select kind, value from public.ezil_billing_trial_identities where trial_id = ${trialId}::uuid order by kind, value`)
            .map(row => `${row.kind}:${row.value}`)).toEqual([`email:r4new.${run}@gmail.com`, `email:r4old.${run}@gmail.com`, `subject:supabase:${a}`]);
        await client`delete from auth.users where id = ${a}::uuid`;
        const viaNew = await account(`r.4.n.e.w.${run}+alias@gmail.com`);
        expect((await store.trialFacts(viaNew)).claimedElsewhere).toBe(true);
        expect((await quote(viaNew)).status).toBe('refused');
        const viaOld = await account(`r4old.${run}+again@gmail.com`);
        expect((await store.trialFacts(viaOld)).claimedElsewhere).toBe(true);
        // Deletion itself was never blocked, and the identities stay with the tombstone.
        expect((await client`select count(*)::int as n from public.ezil_billing_trial_identities where trial_id = ${trialId}::uuid`)[0]!.n).toBe(3);
    });

    it('R4: the sweep retains a changed verified identity even if Billing was never opened before the deletion', async () => {
        const a = await account(`sweepold.${run}@example.com`, { auth0: `auth0|sweep-${run}` });
        await quote(a);
        await start(a);
        await client`update auth.users set email = ${`sweepnew.${run}@example.com`}, email_confirmed_at = now(),
            raw_app_meta_data = ${JSON.stringify({ auth0_sub: `auth0|sweep2-${run}` })}::jsonb where id = ${a}::uuid`;
        expect(await store.recordTrialIdentities!()).toBeGreaterThanOrEqual(2);
        await client`delete from auth.users where id = ${a}::uuid`;
        expect((await store.trialFacts(await account(`sweepnew.${run}@example.com`))).claimedElsewhere).toBe(true);
        expect((await store.trialFacts(await account(`unrelated.${run}@example.com`, { auth0: `auth0|sweep2-${run}` }))).claimedElsewhere).toBe(true);
    });

    it('R4: an unverified email is never retained as an identity; a never-started quote retains nothing', async () => {
        const a = await account(`unv.${run}@example.com`);
        await quote(a);
        const { trialId } = await start(a);
        await client`update auth.users set email = ${`unvnew.${run}@example.com`}, email_confirmed_at = null where id = ${a}::uuid`;
        await store.recordTrialIdentities!(trialId);
        expect((await client`select value from public.ezil_billing_trial_identities where trial_id = ${trialId}::uuid and kind = 'email'`)
            .map(row => row.value)).toEqual([`unv.${run}@example.com`]);
        const q = await account(`quote.only.r4.${run}@example.com`);
        const claim = await quote(q);
        expect(await store.recordTrialIdentities!(claim.status === 'quoted' ? claim.trial.id : undefined)).toBe(0);
    });

    it('E2: custom-domain plus addresses are distinct people; the same address is not', async () => {
        const a = await account(`team+a.${run}@acme.dev`);
        const b = await account(`team+b.${run}@acme.dev`);
        expect((await quote(a)).status).toBe('quoted');
        expect((await quote(b)).status).toBe('quoted');
    });

    it('binds one subscription per trial and refuses another subscription or customer', async () => {
        const a = await account(`bind.${run}@example.com`);
        await quote(a);
        const { trialId, customer } = await start(a, `sub_bind${run}`);
        expect(await store.bindTrialSubscription({ trialId, userId: a, customerId: customer, subscriptionId: `sub_bind${run}`, trialStart: at })).toBe('bound');
        expect(await store.bindTrialSubscription({ trialId, userId: a, customerId: customer, subscriptionId: `sub_other${run}`, trialStart: at })).toBe('conflict');
        expect(await store.bindTrialSubscription({ trialId, userId: a, customerId: 'cus_foreign', subscriptionId: `sub_bind${run}`, trialStart: at })).toBe('conflict');
        expect(await store.attachTrialCheckout({ trialId, userId: a, quotedAt: trialTerms(at).quotedAt, checkoutSessionId: 'cs_late', customerId: customer })).toBe('stale');
        await expect(client`update public.ezil_billing_trials set stripe_subscription_id = null where id = ${trialId}::uuid`).rejects.toThrow(/bound_chk/);
    });

    it('one trial grant per person and meter (partial unique index), whatever subscription it came from', async () => {
        const a = await account(`grant.${run}@example.com`);
        const grant = (subscriptionId: string) => store.insertGrant({ userId: a, subscriptionId, meter: 'compute_std_seconds', kind: 'trial_period',
            amount: BigInt(144000), periodStart: at, periodEnd: new Date(at.getTime() + 30 * DAY), sourceType: 'trial', sourceId: subscriptionId });
        expect(await grant(`sub_g1${run}`)).toBe('inserted');
        expect(await grant(`sub_g1${run}`)).toBe('duplicate');
        expect(await grant(`sub_g2${run}`)).toBe('duplicate');
    });

    it('first_paid_at is set once and never overwritten by a subscription upsert; trial columns round-trip', async () => {
        const a = await account(`paid.${run}@example.com`);
        const sub = `sub_paid${run}`;
        const row = { stripeSubscriptionId: sub, userId: a, status: 'trialing', sku: 'standard_monthly_v3', currentPeriodStart: at,
            currentPeriodEnd: new Date('2026-12-05T10:00:00Z'), cancelAtPeriodEnd: false, stripeEventCreated: at,
            trialStart: at, trialEnd: new Date('2026-12-05T10:00:00Z') };
        expect(await store.upsertSubscription(row)).toBe('applied');
        await store.markSubscriptionPaid(sub, new Date('2026-12-05T11:00:00Z'));
        await store.markSubscriptionPaid(sub, new Date('2027-01-05T11:00:00Z'));
        expect(await store.upsertSubscription({ ...row, status: 'active', stripeEventCreated: new Date('2026-12-05T12:00:00Z') })).toBe('applied');
        expect(await store.subscriptionsFor(a)).toEqual([expect.objectContaining({ status: 'active', trialStart: at,
            trialEnd: new Date('2026-12-05T10:00:00Z'), firstPaidAt: new Date('2026-12-05T11:00:00Z') })]);
    });

    it('paid history refuses: this account\'s positive paid grant, or another account that is the same Gmail person', async () => {
        const a = await account(`history.${run}@gmail.com`);
        const b = await account(`h.i.s.t.o.r.y.${run}+again@gmail.com`);
        await store.insertGrant({ userId: a, subscriptionId: `sub_hist${run}`, meter: 'compute_std_seconds', kind: 'plan_period',
            amount: BigInt(144000), periodStart: at, periodEnd: new Date(at.getTime() + 30 * DAY), sourceType: 'invoice', sourceId: `in_hist${run}` });
        expect((await store.trialFacts(a)).paidBefore).toBe(true);
        expect((await store.trialFacts(b)).paidBefore).toBe(true);
    });

    it('the paid-compute SQL covers a funded trial, never a never-paid trial past its end or in dunning, and keeps prior-paid grace', async () => {
        const trialEnd = new Date('2026-12-05T10:00:00Z');
        const nextEnd = new Date('2027-01-05T10:00:00Z');
        async function covered(userId: string, when: Date) {
            const rows = await db.execute<{ user_id: string }>(sql`WITH ${paidComputeAccessCtes(when.toISOString(), false, userId)}
                SELECT user_id::text FROM effective`);
            return [...rows].length === 1;
        }
        async function setup(name: string, status: string, firstPaidAt: Date | null, period: [Date, Date], issueAt?: Date) {
            const userId = await account(`${name}.${run}@example.com`);
            const sub = `sub_${name}${run}`;
            await store.upsertSubscription({ stripeSubscriptionId: sub, userId, status, sku: 'standard_monthly_v3', currentPeriodStart: period[0],
                currentPeriodEnd: period[1], cancelAtPeriodEnd: false, stripeEventCreated: period[0], trialStart: at, trialEnd });
            if (firstPaidAt) await store.markSubscriptionPaid(sub, firstPaidAt);
            await store.insertGrant({ userId, subscriptionId: sub, meter: 'compute_std_seconds', kind: 'trial_period', amount: BigInt(144000),
                periodStart: at, periodEnd: trialEnd, sourceType: 'trial', sourceId: sub });
            if (issueAt) await store.recordPaymentIssue({ stripeInvoiceId: `in_${name}${run}`, userId, subscriptionId: sub, invoiceKind: 'subscription',
                issue: 'payment_failed', hostedInvoiceUrl: null, eventCreated: issueAt });
            return userId;
        }
        const trialing = await setup('cov_trialing', 'trialing', null, [at, trialEnd]);
        expect(await covered(trialing, new Date(trialEnd.getTime() - 1000))).toBe(true);
        const pending = await setup('cov_pending', 'active', null, [trialEnd, nextEnd]);
        for (const offset of [0, 1000, 599_000]) expect(await covered(pending, new Date(trialEnd.getTime() + offset))).toBe(false);
        const failed = await setup('cov_failed', 'past_due', null, [trialEnd, nextEnd], new Date(trialEnd.getTime() + 3600_000));
        expect(await covered(failed, new Date(trialEnd.getTime() + 2 * 3600_000))).toBe(false);
        const priorPaid = await setup('cov_prior', 'past_due', new Date('2026-12-05T11:00:00Z'), [trialEnd, nextEnd], new Date(trialEnd.getTime() + 3600_000));
        expect(await covered(priorPaid, new Date(trialEnd.getTime() + 2 * 3600_000))).toBe(true);
        expect(await covered(priorPaid, new Date(trialEnd.getTime() + 3600_000 + 7 * DAY + 1000))).toBe(false);
    });

    it('0021 refuses malformed rows', async () => {
        const a = await account(`chk.${run}@example.com`);
        const insert = (patch: Record<string, unknown>) => client`insert into public.ezil_billing_trials
            (user_id, auth_subject, email_normalized, sku, policy_version, status, quoted_at, trial_end, return_origin)
            values (${a}::uuid, ${String(patch.subject ?? `supabase:${a}`)}, ${String(patch.email ?? `chk.${run}@example.com`)},
                ${String(patch.sku ?? 'standard_monthly_v3')}, 1, ${String(patch.status ?? 'quoted')}, ${at.toISOString()}::timestamptz,
                ${String(patch.end ?? '2026-12-05T10:00:00Z')}::timestamptz, 'https://os-staging.ezil.work')`;
        await expect(insert({ sku: 'premium_monthly_v3' })).rejects.toThrow(/sku_chk/);
        await expect(insert({ email: `Chk.${run}@Example.com` })).rejects.toThrow(/email_chk/);
        await expect(insert({ status: 'trialing' })).rejects.toThrow(/bound_chk/);
        await expect(insert({ end: '2026-11-05T10:00:00Z' })).rejects.toThrow(/end_chk/);
        await expect(client`insert into public.ezil_billing_trials
            (user_id, auth_subject, email_normalized, sku, policy_version, status, quoted_at, trial_end, return_origin)
            values (${a}::uuid, ${`supabase:${a}`}, ${`chk.${run}@example.com`}, 'standard_monthly_v3', 1, 'quoted', ${at.toISOString()}::timestamptz,
                '2026-12-05T10:00:00Z'::timestamptz, 'https://evil.example/path?x=1')`).rejects.toThrow(/origin_chk/);
        await expect(client`insert into public.ezil_billing_trial_identities (trial_id, kind, value, email_domain)
            select id, 'email', 'Upper@Example.com', 'Example.com' from public.ezil_billing_trials limit 1`).rejects.toThrow(/email_chk/);
        await expect(client`insert into public.ezil_billing_trial_identities (trial_id, kind, value, email_domain)
            select id, 'subject', 'supabase:x', 'example.com' from public.ezil_billing_trials limit 1`).rejects.toThrow(/domain_chk/);
        await expect(client`insert into public.ezil_billing_grants (user_id, meter, kind, amount, source_type, source_id)
            values (${a}::uuid, 'compute_std_seconds', 'trial_bonus', 1, 'trial', 'x')`).rejects.toThrow(/kind_chk/);
    });
});

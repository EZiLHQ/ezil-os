/**
 * Sponsor entry to the SAME Standard trial, through the real `claimTrialQuote` / `bindTrialSubscription` against the synthetic fixture
 * (sponsor-fixture.ts) on a DISPOSABLE Postgres. Committed rows under fresh ids (the claims race across connections); every account is
 * removed at the end. Skipped without BILLING_TEST_DATABASE_URL. No real database, Stripe call or grant is involved.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { createBillingStore } from '../store';
import { bootstrapSponsorFixture } from './sponsor-fixture';
import { hasTrials, type SponsorQuoteInput, type TrialStore } from './trial';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

type Database = typeof import('@/server/db').db;
const run = randomUUID().slice(0, 8);
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const quotedAt = new Date('2026-11-12T10:00:00Z'), trialEnd = new Date('2026-12-12T10:00:00Z');
const startAt = new Date('2026-11-12T10:05:00Z');

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('sponsor entry to the Standard trial (real store, synthetic fixture)', () => {
    let client: ReturnType<typeof postgres>;
    let store: TrialStore;
    const users: string[] = [];
    beforeAll(async () => {
        await bootstrapSponsorFixture(process.env.BILLING_TEST_DATABASE_URL!);
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 12, prepare: false, onnotice: () => undefined });
        const created = createBillingStore(drizzle(client, { schema }) as unknown as Database);
        if (!hasTrials(created)) throw new Error('the store must implement the trial port');
        store = created;
    });
    afterAll(async () => {
        if (users.length) await client`delete from auth.users where id = any(${users}::uuid[])`;
        await client?.end();
    });

    async function account(email: string) {
        const id = randomUUID(); users.push(id);
        await client`insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data) values (${id}::uuid, ${email}, now(), '{}'::jsonb)`;
        return id;
    }
    // one stable account key per user, like accountKeyFor()
    const keys = new Map<string, string>();
    const sponsor = (userId: string, campaignId = 'test-campaign-a', configSha256 = HASH_A): SponsorQuoteInput => {
        if (!keys.has(userId)) keys.set(userId, randomUUID());
        return { accountKey: keys.get(userId)!, campaignId, partnerId: `partner-${campaignId}`, configSha256 };
    };
    const quote = (userId: string, email: string, over: { sponsor?: SponsorQuoteInput; at?: Date } = {}) => store.claimTrialQuote({
        userId, authSubject: `supabase:${userId}`, emailNormalized: email, quotedAt: over.at ?? quotedAt, trialEnd, returnOrigin: 'https://os-staging.ezil.work',
        ...(over.sponsor ? { sponsor: over.sponsor } : {}) });
    const trialOf = async (userId: string) => (await client`select id::text, status, stripe_subscription_id, quoted_at from public.ezil_billing_trials where user_id = ${userId}::uuid`)[0]!;
    const linkOf = async (trialId: string) => (await client`select campaign_id, config_sha256, claimed_at, stripe_subscription_id, quoted_at from public.ezil_sponsor_trial_claims where trial_id = ${trialId}::uuid`)[0];
    const bind = (trialId: string, userId: string, subscriptionId: string, meta: { campaignId: string; configSha256: string } | null) =>
        store.bindTrialSubscription({ trialId, userId, customerId: 'cus_fixture1', subscriptionId, trialStart: startAt, sponsor: meta });

    it('a public quote is unchanged: no attribution, no linkage, no sponsor row of any kind', async () => {
        const u = await account(`pub.${run}@example.com`);
        expect((await quote(u, `pub.${run}@example.com`)).status).toBe('quoted');
        expect(await linkOf((await trialOf(u)).id)).toBeUndefined();
        expect((await bind((await trialOf(u)).id, u, `sub_pub${run}`, null))).toBe('bound');
        expect((await client`select count(*)::int as n from public.ezil_sponsor_trial_claims where trial_id = ${(await trialOf(u)).id}::uuid`)[0]!.n).toBe(0);
    });

    it('a sponsor quote records the attribution (not a signup) and freezes the campaign on the one trial row; a re-quote re-freezes it', async () => {
        const u = await account(`sp1.${run}@example.com`);
        const s = sponsor(u);
        expect((await quote(u, `sp1.${run}@example.com`, { sponsor: s })).status).toBe('quoted');
        const trial = await trialOf(u);
        expect(await linkOf(trial.id)).toMatchObject({ campaign_id: 'test-campaign-a', config_sha256: HASH_A, claimed_at: null, stripe_subscription_id: null });
        const [attr] = await client`select campaign_id, signed_up_at from public.ezil_sponsor_attributions where account_key = ${s.accountKey}::uuid`;
        expect(attr).toMatchObject({ campaign_id: 'test-campaign-a', signed_up_at: null });   // an existing account never becomes a signup
        const later = new Date(quotedAt.getTime() + 60_000);
        expect((await quote(u, `sp1.${run}@example.com`, { sponsor: sponsor(u, 'test-campaign-a', HASH_B), at: later })).status).toBe('quoted');
        expect(await linkOf(trial.id)).toMatchObject({ config_sha256: HASH_B, claimed_at: null });
        expect((await client`select count(*)::int as n from public.ezil_billing_trials where user_id = ${u}::uuid`)[0]!.n).toBe(1);
    });

    it('a different campaign for the same account is refused, rolled back, and the first attribution is kept', async () => {
        const u = await account(`sp2.${run}@example.com`);
        expect((await quote(u, `sp2.${run}@example.com`, { sponsor: sponsor(u, 'test-campaign-a') })).status).toBe('quoted');
        const before = await trialOf(u);
        const refused = await quote(u, `sp2.${run}@example.com`, { sponsor: sponsor(u, 'test-campaign-b'), at: new Date(quotedAt.getTime() + 90_000) });
        expect(refused).toEqual({ status: 'refused', reason: 'sponsor_conflict' });
        expect(new Date((await trialOf(u)).quoted_at as string).getTime()).toBe(new Date(before.quoted_at as string).getTime());   // nothing moved
        expect((await linkOf(before.id))!.campaign_id).toBe('test-campaign-a');
        expect((await client`select campaign_id from public.ezil_sponsor_attributions where account_key = ${keys.get(u)!}::uuid`)[0]!.campaign_id).toBe('test-campaign-a');
    });

    it('a public re-quote never strips an existing sponsor linkage: legacy mode leaves it untouched, keep mode follows the new quote time', async () => {
        const u = await account(`sp3.${run}@example.com`);
        await quote(u, `sp3.${run}@example.com`, { sponsor: sponsor(u) });
        const later = new Date(quotedAt.getTime() + 120_000);
        // legacy/off (no mode) issues no sponsor SQL and leaves the linkage exactly as it was; 'keep' follows the new quote time
        expect((await quote(u, `sp3.${run}@example.com`, { at: later })).status).toBe('quoted');
        expect(new Date((await linkOf((await trialOf(u)).id))!.quoted_at as string).getTime()).toBe(quotedAt.getTime());
        expect((await store.claimTrialQuote({ userId: u, authSubject: `supabase:${u}`, emailNormalized: `sp3.${run}@example.com`, quotedAt: later, trialEnd,
            returnOrigin: 'https://os-staging.ezil.work', publicSponsorMode: 'keep' })).status).toBe('quoted');
        const link = await linkOf((await trialOf(u)).id);
        expect(link).toMatchObject({ campaign_id: 'test-campaign-a', claimed_at: null });
        expect(new Date(link!.quoted_at as string).getTime()).toBe(later.getTime());
    });

    it('an explicit public re-quote with release drops the UNCLAIMED linkage atomically, keeps the attribution, and the trial then binds as a plain public trial', async () => {
        const u = await account(`rel.${run}@example.com`);
        const s = sponsor(u);
        await quote(u, `rel.${run}@example.com`, { sponsor: s });
        const trial = await trialOf(u);
        expect(await linkOf(trial.id)).toBeDefined();
        const later = new Date(quotedAt.getTime() + 180_000);
        expect((await store.claimTrialQuote({ userId: u, authSubject: `supabase:${u}`, emailNormalized: `rel.${run}@example.com`, quotedAt: later, trialEnd,
            returnOrigin: 'https://os-staging.ezil.work', publicSponsorMode: 'release' })).status).toBe('quoted');
        expect(await linkOf(trial.id)).toBeUndefined();
        expect((await client`select count(*)::int as n from public.ezil_sponsor_attributions where account_key = ${s.accountKey}::uuid`)[0]!.n).toBe(1);
        expect(await bind(trial.id, u, `sub_rel${run}`, null)).toBe('bound');
        expect((await client`select count(*)::int as n from public.ezil_sponsor_trial_claims where account_key = ${s.accountKey}::uuid and claimed_at is not null`)[0]!.n).toBe(0);
    });

    it('binding sets claimed_at and the subscription with the trial binding, once; a replay is idempotent; counts distinct claims', async () => {
        const u = await account(`sp4.${run}@example.com`);
        const s = sponsor(u);
        await quote(u, `sp4.${run}@example.com`, { sponsor: s });
        const trial = await trialOf(u);
        const meta = { campaignId: 'test-campaign-a', configSha256: HASH_A };
        expect(await bind(trial.id, u, `sub_sp4${run}`, meta)).toBe('bound');
        expect(await linkOf(trial.id)).toMatchObject({ stripe_subscription_id: `sub_sp4${run}` });
        expect((await linkOf(trial.id))!.claimed_at).not.toBeNull();
        expect((await trialOf(u)).status).toBe('trialing');
        expect(await bind(trial.id, u, `sub_sp4${run}`, meta)).toBe('bound');   // webhook replay
        expect((await client`select count(*)::int as n from public.ezil_sponsor_trial_claims where account_key = ${s.accountKey}::uuid and claimed_at is not null`)[0]!.n).toBe(1);
    });

    it('a mismatch rolls the binding back: wrong config, missing metadata, metadata without a linkage, or a different campaign', async () => {
        const cases: [string, { campaignId: string; configSha256: string } | null][] = [
            ['wrong config', { campaignId: 'test-campaign-a', configSha256: HASH_B }], ['no metadata', null], ['other campaign', { campaignId: 'test-campaign-b', configSha256: HASH_A }]];
        for (const [name, meta] of cases) {
            const u = await account(`mm.${name.replace(/\W/g, '')}.${run}@example.com`);
            await quote(u, `mm.${name.replace(/\W/g, '')}.${run}@example.com`, { sponsor: sponsor(u) });
            const trial = await trialOf(u);
            expect(await bind(trial.id, u, `sub_mm${name.length}${run}`, meta), name).toBe('sponsor_mismatch');
            expect((await trialOf(u)).stripe_subscription_id, name).toBeNull();                        // not bound
            expect((await linkOf(trial.id))!.claimed_at, name).toBeNull();                            // not claimed
        }
        const pub = await account(`mmpub.${run}@example.com`);
        await quote(pub, `mmpub.${run}@example.com`);
        expect(await bind((await trialOf(pub)).id, pub, `sub_mmpub${run}`, { campaignId: 'test-campaign-a', configSha256: HASH_A })).toBe('sponsor_mismatch');
        expect((await trialOf(pub)).stripe_subscription_id).toBeNull();
    });

    it('concurrent quotes: one account racing two campaigns keeps one attribution; the same person via sponsor and public gets one trial', async () => {
        const u = await account(`race1.${run}@example.com`);
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => quote(u, `race1.${run}@example.com`, { sponsor: sponsor(u, i % 2 ? 'test-campaign-b' : 'test-campaign-a'), at: new Date(quotedAt.getTime() + i * 1000) })));
        const winnerCampaign = (await client`select campaign_id from public.ezil_sponsor_attributions where account_key = ${keys.get(u)!}::uuid`).map(r => r.campaign_id);
        expect(winnerCampaign).toHaveLength(1);
        expect(results.filter(r => r.status === 'quoted').length + results.filter(r => r.status === 'refused').length).toBe(8);
        expect((await linkOf((await trialOf(u)).id))!.campaign_id).toBe(winnerCampaign[0]);
        expect((await client`select count(*)::int as n from public.ezil_billing_trials where user_id = ${u}::uuid`)[0]!.n).toBe(1);
        // the same Gmail person through two accounts, one sponsor and one public: exactly one trial claim, the loser leaves no attribution
        const a = await account(`rc.${run}@gmail.com`), b = await account(`r.c.${run}+x@googlemail.com`);
        const [ra, rb, rc, rd] = await Promise.all([quote(a, `rc${run}@gmail.com`, { sponsor: sponsor(a) }), quote(b, `rc${run}@gmail.com`), quote(a, `rc${run}@gmail.com`, { sponsor: sponsor(a) }), quote(b, `rc${run}@gmail.com`)]);
        const owners = new Set((await client`select user_id::text from public.ezil_billing_trials where email_normalized = ${`rc${run}@gmail.com`}`).map(r => r.user_id));
        expect(owners.size).toBe(1);
        const winner = [...owners][0]!, loser = winner === a ? b : a;
        expect([ra, rb, rc, rd].some(r => r.status === 'quoted')).toBe(true);
        if (loser === a) expect((await client`select count(*)::int as n from public.ezil_sponsor_attributions where account_key = ${keys.get(a)!}::uuid`)[0]!.n).toBe(0);
    });

    it('deleting the account keeps the attribution and a consumed claim (counts are durable); an unstarted quote may be reclaimed', async () => {
        const u = await account(`del.${run}@example.com`);
        const s = sponsor(u);
        await quote(u, `del.${run}@example.com`, { sponsor: s });
        const trial = await trialOf(u);
        await bind(trial.id, u, `sub_del${run}`, { campaignId: 'test-campaign-a', configSha256: HASH_A });
        await client`delete from auth.users where id = ${u}::uuid`;
        expect((await client`select user_id from public.ezil_billing_trials where id = ${trial.id}::uuid`)[0]!.user_id).toBeNull();      // tombstone
        expect((await linkOf(trial.id))!.claimed_at).not.toBeNull();
        expect((await client`select count(*)::int as n from public.ezil_sponsor_attributions where account_key = ${s.accountKey}::uuid`)[0]!.n).toBe(1);
    });
});

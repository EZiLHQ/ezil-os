/**
 * Compatibility: a database with ONLY the 0021 trial schema (the sponsor SQL NOT applied) must behave exactly as before for every legacy, public and
 * off-mode path, and every sponsor request must fail closed WITHOUT aborting a transaction. Uses its own throwaway database on the disposable server.
 * Skipped without BILLING_TEST_DATABASE_URL. No real database, Stripe call or grant is involved.
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
const DB = `sponsor_legacy_${run}`;
const quotedAt = new Date('2026-11-12T10:00:00Z'), trialEnd = new Date('2026-12-12T10:00:00Z'), startAt = new Date('2026-11-12T10:05:00Z');
const sponsor: SponsorQuoteInput = { accountKey: randomUUID(), campaignId: 'test-campaign-a', partnerId: 'test-partner-a', configSha256: 'a'.repeat(64) };

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('0021-only database (sponsor schema NOT applied)', () => {
    let admin: ReturnType<typeof postgres>, client: ReturnType<typeof postgres>, store: TrialStore, url: string;
    beforeAll(async () => {
        admin = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => undefined });
        await admin.unsafe(`create database ${DB}`);
        url = process.env.BILLING_TEST_DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`);
        await bootstrapSponsorFixture(url, { applySponsor: false });
        client = postgres(url, { max: 6, prepare: false, onnotice: () => undefined });
        const created = createBillingStore(drizzle(client, { schema }) as unknown as Database);
        if (!hasTrials(created)) throw new Error('trial port');
        store = created;
    });
    afterAll(async () => { await client?.end(); await admin?.unsafe(`drop database if exists ${DB}`); await admin?.end(); });

    async function account(email: string) {
        const id = randomUUID();
        await client`insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data) values (${id}::uuid, ${email}, now(), '{}'::jsonb)`;
        return id;
    }
    const quote = (userId: string, email: string, extra: Record<string, unknown> = {}) => store.claimTrialQuote({ userId, authSubject: `supabase:${userId}`, emailNormalized: email,
        quotedAt, trialEnd, returnOrigin: 'https://os-staging.ezil.work', ...extra } as Parameters<TrialStore['claimTrialQuote']>[0]);
    const row = async (userId: string) => (await client`select id::text, status, stripe_subscription_id from public.ezil_billing_trials where user_id = ${userId}::uuid`)[0];

    it('the sponsor tables really are absent', async () => {
        expect((await client`select to_regclass('public.ezil_sponsor_trial_claims') as t`)[0]!.t).toBeNull();
    });

    it('legacy, off-mode and public quote, re-quote, release request and bind all work and issue no sponsor SQL', async () => {
        const u = await account(`legacy.${run}@example.com`);
        expect((await quote(u, `legacy.${run}@example.com`)).status).toBe('quoted');
        expect((await quote(u, `legacy.${run}@example.com`, { publicSponsorMode: 'release' })).status).toBe('quoted');   // the router's public quote
        expect((await quote(u, `legacy.${run}@example.com`, { publicSponsorMode: 'keep' })).status).toBe('quoted');
        const trial = (await row(u))!;
        expect(await store.bindTrialSubscription({ trialId: trial.id, userId: u, customerId: 'cus_legacy1', subscriptionId: `sub_leg${run}`, trialStart: startAt })).toBe('bound');          // legacy caller
        expect((await row(u))!.status).toBe('trialing');
        const w = await account(`legacy2.${run}@example.com`);
        await quote(w, `legacy2.${run}@example.com`);
        expect(await store.bindTrialSubscription({ trialId: (await row(w))!.id, userId: w, customerId: 'cus_legacy2', subscriptionId: `sub_leg2${run}`, trialStart: startAt, sponsor: null })).toBe('bound');   // the processor's always-null
        expect((await row(w))!.stripe_subscription_id).toBe(`sub_leg2${run}`);
    });

    it('a sponsor quote fails closed (sponsor_unavailable), changes nothing, and does not poison the connection pool', async () => {
        const u = await account(`closed.${run}@example.com`);
        expect(await quote(u, `closed.${run}@example.com`, { sponsor })).toEqual({ status: 'refused', reason: 'sponsor_unavailable' });
        expect(await row(u)).toBeUndefined();                                                      // no trial row was created
        expect((await quote(u, `closed.${run}@example.com`)).status).toBe('quoted');               // a public quote right after still works
        expect(await quote(u, `closed.${run}@example.com`, { sponsor })).toEqual({ status: 'refused', reason: 'sponsor_unavailable' });
        expect((await row(u))!.status).toBe('quoted');                                             // the existing public quote is untouched
    });

    it('sponsor metadata at bind with no schema fails closed to review and binds nothing; reads answer "none" without raising', async () => {
        const u = await account(`bindclosed.${run}@example.com`);
        await quote(u, `bindclosed.${run}@example.com`);
        const trial = (await row(u))!;
        expect(await store.bindTrialSubscription({ trialId: trial.id, userId: u, customerId: 'cus_bc', subscriptionId: `sub_bc${run}`, trialStart: startAt,
            sponsor: { campaignId: 'test-campaign-a', configSha256: 'a'.repeat(64) } })).toBe('sponsor_mismatch');
        expect((await row(u))!.stripe_subscription_id).toBeNull();
        expect(await store.sponsorAttributionFor!(randomUUID())).toBeNull();
        expect(await store.sponsorLinkageFor!(trial.id)).toBeNull();
        expect(await store.bindTrialSubscription({ trialId: trial.id, userId: u, customerId: 'cus_bc', subscriptionId: `sub_bc${run}`, trialStart: startAt, sponsor: null })).toBe('bound');
    });
});

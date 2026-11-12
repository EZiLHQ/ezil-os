/** Actual SQL tests run only against the explicitly supplied, disposable auth_sponsor_* fixture. No application DB URL is read. */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/server/db', () => ({ get db() { return holder.db; } }));
import type { SqlRunner } from '@/server/billing/v3/sponsor-store';
import { bootstrapSponsorFixture } from '@/server/billing/v3/sponsor-fixture';
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';
import { readSponsorRuntime } from '@/server/billing/v3/sponsor-runtime';
import { materializeSponsorAttribution, sponsorCreationHint, sponsorFromLink, SPONSOR_CREATION_METADATA } from './sponsor';
import { recordSponsorAttribution } from './sponsor-attribution';

const url = process.env.AUTH_SPONSOR_TEST_DATABASE_URL;
const token = 't'.repeat(43), key = 'synthetic-auth-pg-key-'.repeat(3);
describe.skipIf(!url)('sponsor auth attribution (actual disposable PostgreSQL)', () => {
    let client: ReturnType<typeof postgres>;
    let database: SqlRunner;
    beforeAll(async () => {
        const target = new URL(url!);
        if (target.hostname !== '127.0.0.1' || target.port !== '55443' || !/^auth_sponsor_[a-z0-9_]+$/.test(target.pathname.slice(1))) throw new Error('explicit disposable fixture required');
        vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key);
        const document = JSON.stringify({ v: 1, campaigns: ['fixture-a', 'fixture-b'].map((campaignId, i) => ({ campaignId, partnerId: 'fixture-partner', version: 1, enabled: true,
            startsAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', tokenSha256: hashSponsorToken(i ? 'b'.repeat(43) : token) })) });
        vi.stubEnv('SPONSOR_REGISTRY', document); vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(document, key));
        await bootstrapSponsorFixture(url!, { applySponsor: false });
        client = postgres(url!, { max: 8, prepare: false, onnotice: () => undefined });
        database = drizzle(client) as unknown as SqlRunner; holder.db = database;
    });
    afterAll(async () => { vi.unstubAllEnvs(); await client?.end(); });
    const campaign = () => sponsorFromLink(token)!;
    const accountKey = (id: string) => readSponsorRuntime().accountKey(id)!;
    const accepted = async (id: string) => (await client`select * from public.ezil_sponsor_attributions where account_key = ${accountKey(id)}::uuid`)[0];
    async function account() {
        const id = randomUUID(), email = `${randomUUID()}@example.invalid`;
        await client`insert into auth.users (id,email,email_confirmed_at,raw_app_meta_data) values (${id}::uuid, ${email}, now(), '{}'::jsonb)`;
        return id;
    }
    it('0021-only schema refuses safely and preserves connection; then applies only the two-table synthetic fixture', async () => {
        expect(await recordSponsorAttribution(database, { accountKey: randomUUID(), campaign: campaign(), signedUpAt: null })).toBe('unavailable');
        expect((await client`select 1 as n`)[0]!.n).toBe(1);
        await bootstrapSponsorFixture(url!);
        // New runner avoids the intentional 15-second negative readiness cache.
        database = drizzle(client) as unknown as SqlRunner; holder.db = database;
    });
    it('existing login is account attribution only: no signup or claim counted', async () => {
        const id = await account();
        await materializeSponsorAttribution({ userId: id, verifiedSubject: 'auth0|existing', metadata: { auth0_sub: 'auth0|existing' }, campaign: campaign() });
        expect((await accepted(id))!.signed_up_at).toBeNull();
        expect((await client`select count(*)::int as n from public.ezil_sponsor_trial_claims`)[0]!.n).toBe(0);
    });
    it('new signup recovery and concurrent replay count one actual creation with immutable original time', async () => {
        const id = await account(), subject = `auth0|${id}`;
        const hint = sponsorCreationHint(campaign(), id, subject);
        const input = { userId: id, verifiedSubject: subject, metadata: { auth0_sub: subject, [SPONSOR_CREATION_METADATA]: hint } };
        await Promise.all(Array.from({ length: 8 }, () => materializeSponsorAttribution(input)));
        const first = await accepted(id);
        expect(first!.signed_up_at).not.toBeNull();
        await materializeSponsorAttribution(input);
        expect((await accepted(id))!.signed_up_at).toEqual(first!.signed_up_at);
        expect((await client`select count(*)::int as n from public.ezil_sponsor_attributions where account_key = ${accountKey(id)}::uuid and signed_up_at is not null`)[0]!.n).toBe(1);
        expect((await client`select count(*)::int as n from public.ezil_sponsor_trial_claims`)[0]!.n).toBe(0);
    });
    it('cross-account and wrong verified subject cannot reuse a creation hint or create attribution', async () => {
        const source = await account(), target = await account(), subject = 'auth0|source';
        const hint = sponsorCreationHint(campaign(), source, subject);
        await materializeSponsorAttribution({ userId: target, verifiedSubject: subject, metadata: { auth0_sub: subject, [SPONSOR_CREATION_METADATA]: hint } });
        await materializeSponsorAttribution({ userId: source, verifiedSubject: 'auth0|other', metadata: { auth0_sub: subject, [SPONSOR_CREATION_METADATA]: hint }, campaign: campaign() });
        expect(await accepted(source)).toBeUndefined(); expect(await accepted(target)).toBeUndefined();
    });
    it('competing campaigns preserve the first attribution and cannot acquire signup credit under another campaign', async () => {
        const id = await account(), c = campaign(), other = sponsorFromLink('b'.repeat(43))!;
        await recordSponsorAttribution(database, { accountKey: accountKey(id), campaign: c, signedUpAt: null });
        expect(await recordSponsorAttribution(database, { accountKey: accountKey(id), campaign: other, signedUpAt: new Date() })).toBe('other_campaign');
        expect(await accepted(id)).toMatchObject({ campaign_id: c.campaignId, signed_up_at: null });
        const raceId = await account();
        const results = await Promise.all([c, other].map(value => recordSponsorAttribution(database, { accountKey: accountKey(raceId), campaign: value, signedUpAt: null })));
        expect(results.sort()).toEqual(['other_campaign', 'same']);
        expect((await client`select count(*)::int as n from public.ezil_sponsor_attributions where account_key = ${accountKey(raceId)}::uuid`)[0]!.n).toBe(1);
    });
});

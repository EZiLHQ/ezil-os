/** Actual operator SQL against a fresh, owned sponsor_operator_* database on the explicitly supplied disposable fixture only. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sponsorReport } from '../../../../scripts/sponsor-operator';
import { bootstrapSponsorFixture } from './sponsor-fixture';

const baseUrl = process.env.BILLING_TEST_DATABASE_URL;
const name = `sponsor_operator_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!baseUrl)('operator sponsor counts (actual disposable PostgreSQL)', () => {
    let admin: ReturnType<typeof postgres>, client: ReturnType<typeof postgres>, url: string;
    let pins: { targetId: string; database: string; user: string };
    const campaign = 'fixture-report-campaign', historical = 'fixture-report-historical', partner = 'fixture-report-partner';
    const hash = 'a'.repeat(64);
    beforeAll(async () => {
        const target = new URL(baseUrl!);
        if (target.hostname !== '127.0.0.1' || target.port !== '55443' || !/^sponsor_[a-z0-9_]+$/.test(target.pathname.slice(1))) throw new Error('explicit disposable fixture required');
        admin = postgres(baseUrl!, { max: 1, prepare: false, onnotice: () => undefined });
        await admin.unsafe(`create database ${name}`);
        target.pathname = `/${name}`; url = target.href;
        client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
        const [identity] = await client`select system_identifier::text as id, current_user as username from pg_control_system()`;
        pins = { targetId: identity!.id, database: name, user: identity!.username };
    });
    afterAll(async () => {
        await client?.end();
        if (admin) { await admin.unsafe(`drop database if exists ${name}`); await admin.end(); }
    });
    const report = (period = {}) => sponsorReport({ ...pins, ...period }, { SPONSOR_REPORT_DATABASE_URL: url });
    async function attribution(campaignId: string, accepted: string, signup: string | null) {
        const key = randomUUID();
        await client`insert into public.ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256, accepted_at, signed_up_at)
            values (${key}::uuid, ${campaignId}, ${partner}, ${hash}, ${accepted}::timestamptz, ${signup}::timestamptz)`;
        return key;
    }
    async function trial(key: string, campaignId: string, quoted: string, claimed: string | null) {
        const id = randomUUID(), subscription = claimed ? `sub_${id.replaceAll('-', '')}` : null;
        const subject = `supabase:${id}`, email = `${id}@example.invalid`;
        await client`insert into public.ezil_billing_trials (id, user_id, auth_subject, email_normalized, sku, policy_version, status,
            quoted_at, trial_end, return_origin, stripe_subscription_id)
            values (${id}::uuid, null, ${subject}, ${email}, 'standard_monthly_v3', 1, ${claimed ? 'canceled' : 'quoted'},
                ${quoted}::timestamptz, '2027-01-01T00:00:00Z', 'https://os-staging.ezil.work', ${subscription})`;
        await client`insert into public.ezil_sponsor_trial_claims (trial_id, account_key, campaign_id, partner_id, config_sha256, quoted_at, claimed_at, stripe_subscription_id)
            values (${id}::uuid, ${key}::uuid, ${campaignId}, ${partner}, ${hash}, ${quoted}::timestamptz, ${claimed}::timestamptz, ${subscription})`;
    }
    it('refuses an absent schema before reading counts; prepares only the disposable synthetic fixture', async () => {
        await expect(report()).rejects.toThrow('report_schema_unavailable');
        await bootstrapSponsorFixture(url);
        const a = await attribution(campaign, '2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z');
        const b = await attribution(campaign, '2026-11-03T00:00:00Z', null);
        const c = await attribution(campaign, '2026-11-03T00:00:00Z', '2026-12-02T00:00:00Z');
        const d = await attribution(historical, '2026-11-03T00:00:00Z', null);
        await trial(a, campaign, '2026-11-03T00:00:00Z', '2026-11-04T00:00:00Z');
        await trial(a, campaign, '2026-10-31T00:00:00Z', null);
        await trial(b, campaign, '2026-11-03T00:00:00Z', null);
        await trial(c, campaign, '2026-11-30T00:00:00Z', '2026-12-03T00:00:00Z');
        await trial(d, historical, '2026-11-03T00:00:00Z', '2026-11-04T00:00:00Z');
    });
    it('returns independent lifetime counts and partner totals without join fanout, preserving canceled/historical claims', async () => {
        const value = await report();
        expect(value.campaigns).toContainEqual({ partnerId: partner, campaignId: campaign, attributedAccounts: '3', newSignups: '2', quotedTrials: '4', claimedTrials: '2' });
        expect(value.campaigns).toContainEqual({ partnerId: partner, campaignId: historical, attributedAccounts: '1', newSignups: '0', quotedTrials: '1', claimedTrials: '1' });
        expect(value.partners).toEqual([{ partnerId: partner, attributedAccounts: '4', newSignups: '2', quotedTrials: '5', claimedTrials: '3' }]);
        expect(JSON.stringify(value)).not.toMatch(/account_key|stripe_subscription_id|postgres:|sub_|example.invalid/);
    });
    it('uses each metric timestamp for a half-open report period', async () => {
        const value = await report({ from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' });
        expect(value.campaigns).toContainEqual({ partnerId: partner, campaignId: campaign, attributedAccounts: '2', newSignups: '1', quotedTrials: '3', claimedTrials: '1' });
        expect(value.partners).toEqual([{ partnerId: partner, attributedAccounts: '3', newSignups: '1', quotedTrials: '4', claimedTrials: '2' }]);
    });
    it('rejects a wrong target before aggregates and repeated reports leave all persisted counts unchanged', async () => {
        await expect(sponsorReport({ ...pins, targetId: '0' }, { SPONSOR_REPORT_DATABASE_URL: url })).rejects.toThrow('report_target_mismatch');
        const before = (await client`select count(*)::int as attributions from public.ezil_sponsor_attributions`)[0];
        await report(); await report();
        expect((await client`select count(*)::int as attributions from public.ezil_sponsor_attributions`)[0]).toEqual(before);
    });
});

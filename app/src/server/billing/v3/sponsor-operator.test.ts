import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    includeConfiguredCampaigns, issueSponsor, parseSponsorOperatorArgs, partnerTotals, readSponsorBundle, runSponsorOperator, signReviewedSponsor,
    sponsorReport, SPONSOR_REPORT_SQL, writeSponsorBundle,
} from '../../../../scripts/sponsor-operator';
import { hashSponsorToken, resolveByToken } from './sponsor';

const KEY = 'synthetic-operator-test-key-'.repeat(3);
const base = { campaignId: 'fixture-campaign-a', partnerId: 'fixture-partner-a', startsAt: '2026-11-01T00:00:00Z',
    expiresAt: '2026-12-01T00:00:00Z', origin: 'https://os-staging.ezil.work' };
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'sponsor-operator-test-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('offline unique sponsor link preparation', () => {
    it('uses 32 random bytes per reusable link, distinct per campaign/partner, with only hashes in signed registry', () => {
        const a = issueSponsor(base, KEY);
        const b = issueSponsor({ ...base, campaignId: 'fixture-campaign-b', partnerId: 'fixture-partner-b' }, KEY);
        const tokenA = new URL(a.link.url).pathname.split('/').at(-1)!;
        const tokenB = new URL(b.link.url).pathname.split('/').at(-1)!;
        expect(Buffer.from(tokenA, 'base64url')).toHaveLength(32);
        expect(tokenA).not.toBe(tokenB); expect(a.bundle.document).not.toContain(tokenA);
        expect(resolveByToken(a.bundle.registry, tokenA)).toMatchObject({ campaignId: base.campaignId, partnerId: base.partnerId, enabled: false });
        expect(a.bundle.entries[0].tokenSha256).toBe(hashSponsorToken(tokenA));
    });
    it('writes a new private bundle without overwrite, keys, master flag or stdout invitation URL', async () => {
        const output = join(directory, 'bundle');
        const result = await runSponsorOperator(['issue', '--campaign-id', base.campaignId, '--partner-id', base.partnerId,
            '--starts-at', base.startsAt, '--expires-at', base.expiresAt, '--origin', base.origin, '--out-dir', output], { SPONSOR_REGISTRY_KEY: KEY });
        expect(statSync(output).mode & 0o777).toBe(0o700);
        for (const file of ['registry.json', 'registry.sig', 'runtime-config.json', 'invitation.private.json']) expect(statSync(join(output, file)).mode & 0o777).toBe(0o600);
        const invitation = JSON.parse(readFileSync(join(output, 'invitation.private.json'), 'utf8'));
        const runtime = JSON.parse(readFileSync(join(output, 'runtime-config.json'), 'utf8'));
        expect(Object.keys(runtime).sort()).toEqual(['SPONSOR_REGISTRY', 'SPONSOR_REGISTRY_SIG']);
        expect(JSON.stringify(result)).not.toContain(invitation.url); expect(JSON.stringify(result)).not.toContain(KEY);
        expect(readSponsorBundle(output, KEY).entries[0].enabled).toBe(false);
        expect(() => writeSponsorBundle(output, issueSponsor(base, KEY).bundle)).toThrow('output_directory_must_be_new');
    });
    it('appends to an authenticated prior registry without changing previous campaigns or revealing previous tokens', () => {
        const prior = issueSponsor(base, KEY), priorDir = join(directory, 'prior');
        writeSponsorBundle(priorDir, prior.bundle, prior.link);
        const next = issueSponsor({ ...base, campaignId: 'fixture-campaign-b', partnerId: 'fixture-partner-b', previousDirectory: priorDir }, KEY);
        expect(next.bundle.entries[0]).toEqual(prior.bundle.entries[0]);
        expect(next.bundle.registry.size).toBe(2);
        expect(next.bundle.registry.get(base.campaignId)?.configSha256).toBe(prior.bundle.registry.get(base.campaignId)?.configSha256);
        expect(() => issueSponsor({ ...base, previousDirectory: priorDir }, KEY)).toThrow('campaign_already_exists');
        expect(() => readSponsorBundle(priorDir, 'wrong-key-'.repeat(8))).toThrow('registry_invalid');
    });
    it('retries token collisions and refuses exhausted collisions or an undersized entropy source', () => {
        const bytes = Buffer.alloc(32, 7), prior = issueSponsor(base, KEY, () => bytes), priorDir = join(directory, 'prior');
        writeSponsorBundle(priorDir, prior.bundle);
        const options = { ...base, campaignId: 'fixture-campaign-b', previousDirectory: priorDir };
        const random = vi.fn().mockReturnValueOnce(bytes).mockReturnValue(Buffer.alloc(32, 8));
        expect(issueSponsor(options, KEY, random).bundle.registry.size).toBe(2); expect(random).toHaveBeenCalledTimes(2);
        expect(() => issueSponsor(options, KEY, () => bytes)).toThrow('token_generation_collision');
        expect(() => issueSponsor(base, KEY, () => Buffer.alloc(31))).toThrow('token_entropy_source_invalid');
    });
    it.each([
        { campaignId: 'x' }, { partnerId: 'Uppercase' }, { origin: 'https://evil.example' },
        { expiresAt: '2026-10-01T00:00:00Z' }, { startsAt: 'not-a-date' },
    ])('refuses invalid IDs, origin or campaign windows (%j)', over => {
        expect(() => issueSponsor({ ...base, ...over }, KEY)).toThrow();
    });
    it('signs reviewed enabling only as a version advance, without rewriting partner or token identity', () => {
        const initial = issueSponsor(base, KEY).bundle;
        const edited = (over: Record<string, unknown>) => JSON.stringify({ v: 1, campaigns: [{ ...initial.entries[0], ...over }] });
        expect(() => signReviewedSponsor(edited({ enabled: true }), initial, KEY)).toThrow('campaign_version_must_advance');
        const next = signReviewedSponsor(edited({ enabled: true, version: 2 }), initial, KEY);
        expect(next.registry.get(base.campaignId)?.enabled).toBe(true);
        expect(() => signReviewedSponsor(edited({ version: 2, partnerId: 'fixture-other' }), initial, KEY)).toThrow('campaign_identity_changed');
        expect(() => signReviewedSponsor(edited({ version: 2, tokenSha256: 'a'.repeat(64) }), initial, KEY)).toThrow('campaign_identity_changed');
        expect(() => signReviewedSponsor(edited({ campaignId: 'fixture-unissued' }), initial, KEY)).toThrow('new_campaign_requires_issue');
        expect(() => signReviewedSponsor(edited({ version: 0 }), initial, KEY)).toThrow('registry_invalid');
    });
    it('sign mode produces config-only files and leaves private invitation in its original bundle', async () => {
        const initial = issueSponsor(base, KEY), prior = join(directory, 'prior'), reviewed = join(directory, 'reviewed.json'), output = join(directory, 'signed');
        writeSponsorBundle(prior, initial.bundle, initial.link);
        writeFileSync(reviewed, JSON.stringify({ v: 1, campaigns: [{ ...initial.bundle.entries[0], enabled: true, version: 2 }] }));
        await runSponsorOperator(['sign', '--registry', reviewed, '--previous-dir', prior, '--out-dir', output], { SPONSOR_REGISTRY_KEY: KEY });
        expect(readSponsorBundle(output, KEY).entries[0]).toMatchObject({ enabled: true, version: 2 });
        expect(() => readFileSync(join(output, 'invitation.private.json'))).toThrow();
        expect(readFileSync(join(prior, 'invitation.private.json'), 'utf8')).toContain(initial.link.url);
    });
    it('requires explicit arguments and keys; help has no configuration or database side effects', async () => {
        expect(parseSponsorOperatorArgs([]).command).toBe('help');
        expect(() => parseSponsorOperatorArgs(['stats'])).toThrow('usage_required_flag_missing');
        expect(() => parseSponsorOperatorArgs(['stats', '--target-id', '1', '--target-id', '2'])).toThrow('usage_unknown_or_duplicate_flag');
        expect(() => parseSponsorOperatorArgs(['issue', '--activate'])).toThrow('usage_unknown_or_duplicate_flag');
        expect(() => parseSponsorOperatorArgs(['apply'])).toThrow('usage_unknown_command');
        expect(await runSponsorOperator([], {})).toMatchObject({ code: 'help' });
        await expect(runSponsorOperator(['sign', '--registry', 'unused', '--previous-dir', 'unused', '--out-dir', 'unused'], {})).rejects.toThrow('registry_key_missing_or_short');
    });
});

describe('target-pinned service-only read-only sponsor aggregates', () => {
    const pins = { targetId: '123456789', database: 'auth_sponsor_fixture', user: 'fixture_service' };
    const env = { SPONSOR_REPORT_DATABASE_URL: 'postgres://fixture:synthetic-secret@127.0.0.1:55443/auth_sponsor_fixture' };
    function connection(over: { target?: Record<string, unknown>; ready?: boolean; allowed?: boolean; rows?: Record<string, unknown>[]; failure?: Error } = {}) {
        const queries: { query: string; values?: unknown[] }[] = [];
        const tx = { unsafe: vi.fn(async (query: string, values?: unknown[]) => {
            queries.push({ query, values });
            if (query.includes('pg_control_system')) return [{ target_id: pins.targetId, database: pins.database, db_user: pins.user,
                session_user: pins.user, read_only: 'on', snapshot_at: '2026-11-11 12:00:00+00', ...over.target }];
            if (query.includes("to_regclass('public.ezil_sponsor_attributions')")) return [{ ready: over.ready ?? true }];
            if (query.includes('has_table_privilege')) return [{ allowed: over.allowed ?? true }];
            if (query === SPONSOR_REPORT_SQL) {
                if (over.failure) throw over.failure;
                return over.rows ?? [{ campaign_id: 'fixture-revoked', partner_id: 'fixture-partner', attributed_accounts: '4', new_signups: '1', quoted_trials: '5', claimed_trials: '3',
                    account_key: 'never-output-this', stripe_subscription_id: 'never-output-this' }];
            }
            if (query.startsWith('set local ')) return [];
            throw new Error('Unexpected SQL');
        }) };
        const db = { begin: vi.fn(async (mode: string, callback: (tx: unknown) => unknown) => callback(tx)), end: vi.fn() };
        return { connect: vi.fn(() => db) as unknown as typeof postgres, db, tx, queries };
    }
    it('independently reports existing attribution, genuine signup and actual claimed trial totals, including unlisted/revoked campaigns', async () => {
        const mock = connection();
        const report = await sponsorReport(pins, env, mock.connect);
        expect(mock.db.begin.mock.calls[0][0]).toBe('read only');
        expect(report.campaigns).toEqual([{ partnerId: 'fixture-partner', campaignId: 'fixture-revoked',
            attributedAccounts: '4', newSignups: '1', quotedTrials: '5', claimedTrials: '3' }]);
        expect(JSON.stringify(report)).not.toMatch(/never-output-this|synthetic-secret|postgres:\/\//);
        expect(mock.db.end).toHaveBeenCalledWith({ timeout: 1 });
        expect(mock.queries.some(({ query }) => /\b(insert|update|delete|create|alter|drop|grant|revoke)\b/i.test(query))).toBe(false);
    });
    it('preaggregates each table before joining, counts distinct signup accounts and claimed trial IDs by their own event times', async () => {
        const mock = connection(), period = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' };
        await sponsorReport({ ...pins, ...period }, env, mock.connect);
        expect(mock.queries.find(({ query }) => query === SPONSOR_REPORT_SQL)?.values).toEqual([period.from, period.to]);
        expect(SPONSOR_REPORT_SQL).toMatch(/count\(distinct account_key\) filter \(where signed_up_at is not null/);
        expect(SPONSOR_REPORT_SQL).toMatch(/count\(distinct trial_id\) filter \(where claimed_at is not null and stripe_subscription_id is not null/);
        expect(SPONSOR_REPORT_SQL.match(/group by partner_id, campaign_id/g)).toHaveLength(2);
        expect(SPONSOR_REPORT_SQL).toContain('full outer join trials');
        expect(SPONSOR_REPORT_SQL).toContain('signed_up_at >= $1::timestamptz');
        expect(SPONSOR_REPORT_SQL).toContain('claimed_at < $2::timestamptz');
    });
    it.each([
        { target_id: 'other' }, { database: 'wrong_database' }, { db_user: 'wrong_user' }, { session_user: 'wrong_user' }, { read_only: 'off' },
    ])('refuses a wrong explicit target before reading sponsor rows (%j)', async target => {
        const mock = connection({ target });
        await expect(sponsorReport(pins, env, mock.connect)).rejects.toThrow('report_target_mismatch');
        expect(mock.queries.some(({ query }) => query === SPONSOR_REPORT_SQL)).toBe(false);
        expect(mock.db.end).toHaveBeenCalled();
    });
    it('refuses missing schema and filtered RLS access instead of showing misleading zero counts', async () => {
        for (const [over, code] of [[{ ready: false }, 'report_schema_unavailable'], [{ allowed: false }, 'report_full_service_access_required']] as const) {
            const mock = connection(over);
            await expect(sponsorReport(pins, env, mock.connect)).rejects.toThrow(code);
            expect(mock.queries.some(({ query }) => query === SPONSOR_REPORT_SQL)).toBe(false);
        }
    });
    it('keeps bigint counts exact and refuses malformed counts without exposing provider/DB details', async () => {
        const rows = [{ campaign_id: 'fixture-campaign', partner_id: 'fixture-partner', attributed_accounts: '9007199254740993', new_signups: '0', quoted_trials: '0', claimed_trials: '0' }];
        const large = connection({ rows });
        expect((await sponsorReport(pins, env, large.connect)).campaigns[0].attributedAccounts).toBe('9007199254740993');
        const bad = connection({ rows: [{ ...rows[0], claimed_trials: '-1' }] });
        await expect(sponsorReport(pins, env, bad.connect)).rejects.toThrow('report_invalid_count');
        const failure = connection({ failure: new Error(env.SPONSOR_REPORT_DATABASE_URL) });
        await expect(sponsorReport(pins, env, failure.connect)).rejects.toThrow(/^report_unavailable$/);
    });
    it('adds unused configured campaigns as zero while retaining historical campaigns and exact partner totals', () => {
        const configured = issueSponsor(base, KEY).bundle.registry;
        const historical = { partnerId: base.partnerId, campaignId: 'fixture-historical', attributedAccounts: '9007199254740993', newSignups: '1', quotedTrials: '2', claimedTrials: '1' };
        const rows = includeConfiguredCampaigns([historical], configured);
        expect(rows).toContainEqual(historical);
        expect(rows).toContainEqual({ partnerId: base.partnerId, campaignId: base.campaignId, attributedAccounts: '0', newSignups: '0', quotedTrials: '0', claimedTrials: '0' });
        expect(partnerTotals([...rows, { ...historical, campaignId: 'fixture-another', attributedAccounts: '2', claimedTrials: '2' }])[0]).toMatchObject({
            attributedAccounts: '9007199254740995', newSignups: '2', quotedTrials: '4', claimedTrials: '3' });
    });
    it('requires explicit pins, report-only URL and valid half-open period before connecting', async () => {
        const mock = connection();
        await expect(sponsorReport({ ...pins, targetId: '' }, env, mock.connect)).rejects.toThrow('report_target_pins_required');
        await expect(sponsorReport(pins, { SUPABASE_DATABASE_URL: env.SPONSOR_REPORT_DATABASE_URL }, mock.connect)).rejects.toThrow('report_database_url_missing_or_invalid');
        await expect(sponsorReport({ ...pins, from: '2026-11-01T00:00:00Z' }, env, mock.connect)).rejects.toThrow('report_period_invalid');
        await expect(sponsorReport({ ...pins, from: '2026-12-01', to: '2026-11-01' }, env, mock.connect)).rejects.toThrow('report_period_invalid');
        expect(mock.connect).not.toHaveBeenCalled();
    });
});

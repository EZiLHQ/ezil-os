#!/usr/bin/env bun
/**
 * Offline sponsor registry preparation and target-pinned READ ONLY aggregate reporting.
 * Run with bun --no-env-file scripts/sponsor-operator.ts; no .env is loaded by this tool.
 * Never prints keys, raw tokens, invitation URLs, account keys, user identities or database URLs.
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { z } from 'zod';
import { hashSponsorToken, parseSponsorRegistry, signSponsorRegistry, type SponsorRegistry } from '../src/server/billing/v3/sponsor';
import { OWNED_APP_ORIGINS } from '../src/utils/forwarded';

type Environment = Record<string, string | undefined>;
type Entry = { campaignId: string; partnerId: string; version: number; enabled: boolean; startsAt: string; expiresAt: string; tokenSha256: string };
type Document = { v: 1; campaigns: Entry[] };
type Bundle = { document: string; signature: string; entries: Entry[]; registry: SponsorRegistry };
export class SponsorOperatorRefusal extends Error {
    constructor(readonly code: string) { super(code); }
}
const refuse = (code: string): never => { throw new SponsorOperatorRefusal(code); };
const keyFor = (env: Environment): string => {
    const key = env.SPONSOR_REGISTRY_KEY;
    return key && key.length >= 32 ? key : refuse('registry_key_missing_or_short');
};
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const MAX_DOCUMENT_BYTES = 256 * 1024;

function readBounded(file: string): string {
    try {
        if (!statSync(file).isFile() || statSync(file).size > MAX_DOCUMENT_BYTES) return refuse('input_file_invalid');
        return readFileSync(file, 'utf8');
    } catch (error) {
        if (error instanceof SponsorOperatorRefusal) throw error;
        return refuse('input_file_unreadable');
    }
}
function inspect(document: string, signature: string, key: string): Bundle {
    if (Buffer.byteLength(document) > MAX_DOCUMENT_BYTES) return refuse('registry_invalid');
    const registry = parseSponsorRegistry({ document, signature, key });
    if (registry.size === 0) return refuse('registry_invalid');
    const entries = (JSON.parse(document) as Document).campaigns;
    return { document, signature, entries, registry };
}
export function readSponsorBundle(directory: string, key: string): Bundle {
    return inspect(readBounded(join(directory, 'registry.json')), readBounded(join(directory, 'registry.sig')).trim(), key);
}

/** Prepares files only. It never sets SPONSOR_TRIALS_ENABLED or supplies either runtime key. */
export function writeSponsorBundle(directory: string, bundle: Bundle, link?: { campaignId: string; partnerId: string; url: string }): void {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch { return refuse('output_directory_must_be_new'); }
    const files: Record<string, string> = {
        'registry.json': bundle.document,
        'registry.sig': bundle.signature + '\n',
        'runtime-config.json': JSON.stringify({ SPONSOR_REGISTRY: bundle.document, SPONSOR_REGISTRY_SIG: bundle.signature }, null, 2) + '\n',
    };
    if (link) files['invitation.private.json'] = JSON.stringify(link, null, 2) + '\n';
    try {
        for (const [name, value] of Object.entries(files)) writeFileSync(join(directory, name), value, { flag: 'wx', mode: 0o600 });
    } catch { return refuse('private_bundle_write_failed'); }
}

export interface IssueOptions { campaignId: string; partnerId: string; startsAt: string; expiresAt: string; origin: string; previousDirectory?: string }
export function issueSponsor(options: IssueOptions, key: string, random: () => Buffer = () => randomBytes(32)): { bundle: Bundle; link: { campaignId: string; partnerId: string; url: string } } {
    if (!ID.test(options.campaignId) || !ID.test(options.partnerId)) return refuse('campaign_or_partner_id_invalid');
    if (!(OWNED_APP_ORIGINS as readonly string[]).includes(options.origin)) return refuse('origin_not_owned');
    const prior = options.previousDirectory ? readSponsorBundle(options.previousDirectory, key).entries : [];
    if (prior.some(entry => entry.campaignId === options.campaignId)) return refuse('campaign_already_exists');
    if (prior.length >= 500) return refuse('registry_campaign_limit');
    let token = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const bytes = random();
        if (bytes.length !== 32) return refuse('token_entropy_source_invalid');
        const candidate = bytes.toString('base64url');
        if (!prior.some(entry => entry.tokenSha256 === hashSponsorToken(candidate))) { token = candidate; break; }
    }
    if (!token) return refuse('token_generation_collision');
    const entry: Entry = { campaignId: options.campaignId, partnerId: options.partnerId, version: 1, enabled: false,
        startsAt: options.startsAt, expiresAt: options.expiresAt, tokenSha256: hashSponsorToken(token) };
    const document = JSON.stringify({ v: 1, campaigns: [...prior, entry] });
    const bundle = inspect(document, signSponsorRegistry(document, key), key);
    return { bundle, link: { campaignId: entry.campaignId, partnerId: entry.partnerId, url: `${options.origin}/sponsor/${token}` } };
}

/** Sign a reviewed edit offline; changed config must advance version. New campaigns come through issue. */
export function signReviewedSponsor(document: string, previous: Bundle, key: string): Bundle {
    const next = inspect(document, signSponsorRegistry(document, key), key);
    for (const [id, campaign] of next.registry) {
        const before = previous.registry.get(id);
        if (!before) return refuse('new_campaign_requires_issue');
        if (campaign.partnerId !== before.partnerId || campaign.tokenSha256 !== before.tokenSha256) return refuse('campaign_identity_changed');
        if (campaign.version < before.version || (campaign.version === before.version && campaign.configSha256 !== before.configSha256)) return refuse('campaign_version_must_advance');
    }
    return next;
}

export const SPONSOR_REPORT_SQL = `
with attributions as (
    select partner_id, campaign_id,
        count(distinct account_key) filter (where ($1::timestamptz is null or accepted_at >= $1::timestamptz)
            and ($2::timestamptz is null or accepted_at < $2::timestamptz))::text as attributed_accounts,
        count(distinct account_key) filter (where signed_up_at is not null
            and ($1::timestamptz is null or signed_up_at >= $1::timestamptz)
            and ($2::timestamptz is null or signed_up_at < $2::timestamptz))::text as new_signups
    from public.ezil_sponsor_attributions group by partner_id, campaign_id
), trials as (
    select partner_id, campaign_id,
        count(distinct trial_id) filter (where ($1::timestamptz is null or quoted_at >= $1::timestamptz)
            and ($2::timestamptz is null or quoted_at < $2::timestamptz))::text as quoted_trials,
        count(distinct trial_id) filter (where claimed_at is not null and stripe_subscription_id is not null
            and ($1::timestamptz is null or claimed_at >= $1::timestamptz)
            and ($2::timestamptz is null or claimed_at < $2::timestamptz))::text as claimed_trials
    from public.ezil_sponsor_trial_claims group by partner_id, campaign_id
)
select coalesce(a.partner_id, t.partner_id) as partner_id, coalesce(a.campaign_id, t.campaign_id) as campaign_id,
    coalesce(a.attributed_accounts, '0') as attributed_accounts, coalesce(a.new_signups, '0') as new_signups,
    coalesce(t.quoted_trials, '0') as quoted_trials, coalesce(t.claimed_trials, '0') as claimed_trials
from attributions a full outer join trials t using (partner_id, campaign_id)
order by partner_id, campaign_id`;

const reportInstant = z.string().datetime({ offset: true });

export interface ReportOptions { targetId: string; database: string; user: string; from?: string; to?: string }
const countText = (value: unknown): string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? value : refuse('report_invalid_count');
export async function sponsorReport(options: ReportOptions, env: Environment, connect: typeof postgres = postgres) {
    if (!/^[0-9]+$/.test(options.targetId) || !options.database || !options.user) return refuse('report_target_pins_required');
    if (Boolean(options.from) !== Boolean(options.to)
        || (options.from && options.to && (!reportInstant.safeParse(options.from).success || !reportInstant.safeParse(options.to).success || Date.parse(options.from) >= Date.parse(options.to)))) return refuse('report_period_invalid');
    const url = env.SPONSOR_REPORT_DATABASE_URL;
    try { if (!url || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) return refuse('report_database_url_missing_or_invalid'); }
    catch { return refuse('report_database_url_missing_or_invalid'); }
    const db = connect(url!, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 1, onnotice: () => undefined });
    try {
        return await db.begin('read only', async tx => {
            await tx.unsafe("set local search_path = pg_catalog");
            await tx.unsafe("set local statement_timeout = '5s'");
            await tx.unsafe("set local idle_in_transaction_session_timeout = '5s'");
            const [target] = await tx.unsafe(`select system_identifier::text as target_id, current_database() as database,
                current_user as db_user, session_user as session_user, current_setting('transaction_read_only') as read_only,
                transaction_timestamp()::text as snapshot_at from pg_catalog.pg_control_system()`);
            if (!target || target.target_id !== options.targetId || target.database !== options.database
                || target.db_user !== options.user || target.session_user !== options.user || target.read_only !== 'on') return refuse('report_target_mismatch');
            const [schema] = await tx.unsafe(`select (to_regclass('public.ezil_sponsor_attributions') is not null
                and to_regclass('public.ezil_sponsor_trial_claims') is not null
                and to_regprocedure('public.ezil_sponsor_attribution_guard()') is not null
                and to_regprocedure('public.ezil_sponsor_trial_claim_guard()') is not null) as ready`);
            if (schema?.ready !== true) return refuse('report_schema_unavailable');
            // Never silently report a filtered RLS subset as the campaign totals.
            const [access] = await tx.unsafe(`select (count(*) = 2 and bool_and(
                has_table_privilege(current_user, c.oid, 'SELECT')
                and (r.rolsuper or r.rolbypassrls or (c.relowner = r.oid and not c.relforcerowsecurity)))) as allowed
                from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                cross join pg_catalog.pg_roles r
                where n.nspname = 'public' and c.relname in ('ezil_sponsor_attributions','ezil_sponsor_trial_claims')
                    and r.rolname = current_user`);
            if (access?.allowed !== true) return refuse('report_full_service_access_required');
            const rows = await tx.unsafe(SPONSOR_REPORT_SQL, [options.from ?? null, options.to ?? null]);
            const campaigns = rows.map(row => {
                if (typeof row.partner_id !== 'string' || !ID.test(row.partner_id) || typeof row.campaign_id !== 'string' || !ID.test(row.campaign_id)) return refuse('report_invalid_campaign');
                return { partnerId: row.partner_id, campaignId: row.campaign_id, attributedAccounts: countText(row.attributed_accounts),
                    newSignups: countText(row.new_signups), quotedTrials: countText(row.quoted_trials), claimedTrials: countText(row.claimed_trials) };
            });
            return { version: 1, targetId: options.targetId, database: options.database, user: options.user,
                snapshotAt: target.snapshot_at, fromInclusive: options.from ?? null, toExclusive: options.to ?? null, campaigns, partners: partnerTotals(campaigns) };
        });
    } catch (error) {
        if (error instanceof SponsorOperatorRefusal) throw error;
        return refuse('report_unavailable');
    } finally { await db.end({ timeout: 1 }); }
}

type CampaignCounts = { partnerId: string; campaignId: string; attributedAccounts: string; newSignups: string; quotedTrials: string; claimedTrials: string };
export function partnerTotals(campaigns: readonly CampaignCounts[]) {
    const totals = new Map<string, Omit<CampaignCounts, 'campaignId'>>();
    for (const campaign of campaigns) {
        const total = totals.get(campaign.partnerId) ?? { partnerId: campaign.partnerId, attributedAccounts: '0', newSignups: '0', quotedTrials: '0', claimedTrials: '0' };
        for (const key of ['attributedAccounts', 'newSignups', 'quotedTrials', 'claimedTrials'] as const) total[key] = (BigInt(total[key]) + BigInt(campaign[key])).toString();
        totals.set(campaign.partnerId, total);
    }
    return [...totals.values()].sort((a, b) => a.partnerId.localeCompare(b.partnerId));
}
export function includeConfiguredCampaigns(campaigns: readonly CampaignCounts[], registry: SponsorRegistry): CampaignCounts[] {
    const rows = [...campaigns];
    const present = new Set(rows.map(row => `${row.partnerId}|${row.campaignId}`));
    for (const campaign of registry.values()) if (!present.has(`${campaign.partnerId}|${campaign.campaignId}`)) {
        rows.push({ partnerId: campaign.partnerId, campaignId: campaign.campaignId, attributedAccounts: '0', newSignups: '0', quotedTrials: '0', claimedTrials: '0' });
    }
    return rows.sort((a, b) => a.partnerId.localeCompare(b.partnerId) || a.campaignId.localeCompare(b.campaignId));
}

const FLAGS: Record<string, readonly string[]> = {
    issue: ['--campaign-id', '--partner-id', '--starts-at', '--expires-at', '--origin', '--out-dir', '--previous-dir'],
    sign: ['--registry', '--previous-dir', '--out-dir'],
    stats: ['--target-id', '--database', '--user', '--from', '--to', '--registry-dir'],
};
export function parseSponsorOperatorArgs(argv: string[]): { command: string; flags: Record<string, string> } {
    const [command = 'help', ...rest] = argv;
    if (command === 'help' && rest.length === 0) return { command, flags: {} };
    if (!Object.hasOwn(FLAGS, command)) return refuse('usage_unknown_command');
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i], value = rest[i + 1];
        if (!FLAGS[command].includes(flag) || Object.hasOwn(flags, flag)) return refuse('usage_unknown_or_duplicate_flag');
        if (!value || value.startsWith('--')) return refuse('usage_missing_value');
        flags[flag] = value;
    }
    const required = command === 'issue' ? FLAGS.issue.filter(flag => flag !== '--previous-dir')
        : command === 'sign' ? FLAGS.sign : ['--target-id', '--database', '--user'];
    if (required.some(flag => !flags[flag])) return refuse('usage_required_flag_missing');
    return { command, flags };
}

export const SPONSOR_OPERATOR_HELP = `Source-only sponsor operator commands (nothing activates or applies schema):
  issue --campaign-id ID --partner-id ID --starts-at ISO --expires-at ISO --origin OWNED_ORIGIN --out-dir NEW_PRIVATE_DIR [--previous-dir SIGNED_BUNDLE]
  sign --registry REVIEWED_JSON --previous-dir SIGNED_BUNDLE --out-dir NEW_PRIVATE_DIR
  stats --target-id CLUSTER_DIGITS --database DATABASE --user SERVICE_USER [--from ISO --to ISO] [--registry-dir SIGNED_BUNDLE]

issue/sign require exported SPONSOR_REGISTRY_KEY (32+ characters).
stats requires exported SPONSOR_REPORT_DATABASE_URL and uses a read-only transaction.
Run with bun --no-env-file scripts/sponsor-operator.ts. Read docs/billing/SPONSOR-OPERATIONS.md first.
Raw invitation URLs are written ONLY to invitation.private.json; stdout never contains them.
`;

export async function runSponsorOperator(argv: string[], env: Environment = process.env): Promise<unknown> {
    const { command, flags } = parseSponsorOperatorArgs(argv);
    if (command === 'help') return { code: 'help', text: SPONSOR_OPERATOR_HELP };
    if (command === 'stats') {
        const configured = flags['--registry-dir'] ? readSponsorBundle(flags['--registry-dir'], keyFor(env)) : null;
        const report = await sponsorReport({ targetId: flags['--target-id'], database: flags['--database'], user: flags['--user'],
            ...(flags['--from'] ? { from: flags['--from'] } : {}), ...(flags['--to'] ? { to: flags['--to'] } : {}) }, env);
        if (!configured) return report;
        const campaigns = includeConfiguredCampaigns(report.campaigns, configured.registry);
        return { ...report, registrySha256: sha256(configured.document), campaigns, partners: partnerTotals(campaigns) };
    }
    const key = keyFor(env);
    if (command === 'issue') {
        const result = issueSponsor({ campaignId: flags['--campaign-id'], partnerId: flags['--partner-id'], startsAt: flags['--starts-at'],
            expiresAt: flags['--expires-at'], origin: flags['--origin'], ...(flags['--previous-dir'] ? { previousDirectory: flags['--previous-dir'] } : {}) }, key);
        writeSponsorBundle(flags['--out-dir'], result.bundle, result.link);
        return { code: 'disabled_invitation_prepared', campaignId: result.link.campaignId, partnerId: result.link.partnerId, registrySha256: sha256(result.bundle.document) };
    }
    const previous = readSponsorBundle(flags['--previous-dir'], key);
    const bundle = signReviewedSponsor(readBounded(flags['--registry']), previous, key);
    writeSponsorBundle(flags['--out-dir'], bundle);
    return { code: 'reviewed_registry_signed_offline', registrySha256: sha256(bundle.document), campaigns: bundle.registry.size };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    runSponsorOperator(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); }, error => {
        console.error(JSON.stringify({ code: error instanceof SponsorOperatorRefusal ? error.code : 'sponsor_operator_failed' }));
        process.exitCode = 1;
    });
}

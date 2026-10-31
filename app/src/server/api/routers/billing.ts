import { TRPCError } from '@trpc/server';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { checkoutAvailable } from '@/server/billing/config';
import { aiPackCheckoutEligible, CUSTOM_TOPUP, customTopupPack } from '@/server/billing/catalog';
import { enqueueFreeAiCredits, readAiAccount, type BillingSummaryWithAi } from '@/server/billing/ai-balance';
import { lookupAiAccount, missingAiAccountView } from '@/server/billing/ai-credit-outbox-store';
import { readAiUsage } from '@/server/billing/ai-usage';
import { readAiLimits } from '@/server/billing/ai-limits';
import { getBillingDeps } from '@/server/billing/deps';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, PaymentIssueRow, StripeApi, StripeCheckoutSession } from '@/server/billing/ports';
import { billingReturnOrigin } from '@/server/billing/return-origin';
import { readStripePacks } from '@/server/billing/stripe/packs';
import { BillingProviderError } from '@/server/billing/stripe/client';
import { planFromSubscriptions as legacyPlanFromSubscriptions } from '@/server/billing/v2/catalog';
import { operatorGrantedSubscription, planFromSubscriptions, upgradeGrantSeconds } from '@/server/billing/v3/catalog';
import { buildSummaryV3, computePlanV3, DISK_FALLBACK_GIB, type ReverseMoveSummaryInput } from '@/server/billing/v3/summary';
import { deriveStanding } from '@/server/billing/v3/standing';
import { buildUsageV3 } from '@/server/billing/v3/usage';
import type { BillingSummaryV3, SelectMachineOutputV3 } from '@/server/billing/v3/contract';
import {
    CATALOG_V2, SIZES, OVERAGE_CENTS_PER_STD_HOUR, OVERAGE_MAX_CAP_CENTS, OVERAGE_TERMS_VERSION,
    type SizeCode,
    type BillingErrorCode, type BillingInvoiceDTO, type CheckoutStartDTO,
    type CheckoutStatusDTO, type ConfirmUpgradeOutput, type PreviewUpgradeOutput, type ScheduleDowngradeOutput,
    type CancelAtPeriodEndOutput, type SetOverageOutput, type SelectSizeOutput,
} from '@/server/billing/v2/contract';
import { buildSummaryV2, hasOveragePaymentFailure, summaryMeters } from '@/server/billing/v2/summary';
import type { ReverseMovePlacementView } from '@/server/lib/compute/provider-reverse';
import { epochSeconds, isoSeconds } from '@/server/billing/v2/time';

import { createTRPCRouter, protectedProcedure } from '../trpc';

/** All router domain failures use the pinned UI vocabulary. */
function billingError(code: BillingErrorCode, trpcCode: TRPCError['code']): TRPCError {
    return new TRPCError({ code: trpcCode, message: code });
}

function configuredStripe(deps: BillingDeps): StripeApi {
    if (!checkoutAvailable(deps.config) || !deps.stripe) {
        throw billingError('billing_not_configured', 'PRECONDITION_FAILED');
    }
    return deps.stripe;
}

async function stripeCall<T>(call: () => Promise<T>, disallowed?: 'upgrade_not_allowed' | 'downgrade_not_allowed'): Promise<T> {
    try {
        return await call();
    } catch (error) {
        if (disallowed && error instanceof BillingProviderError
            && (error.code === 'preview_expired' || error.code === 'invalid_subscription_state')) {
            throw billingError(disallowed, 'PRECONDITION_FAILED');
        }
        console.error('Billing Stripe unavailable');
        throw billingError('stripe_unavailable', 'INTERNAL_SERVER_ERROR');
    }
}

async function currentPlan(deps: BillingDeps, userId: string) {
    const [subs, userCreatedAt, changes] = await Promise.all([
        deps.store.subscriptionsFor(userId), deps.store.userCreatedAt(userId), deps.store.openPlanChanges(userId),
    ]);
    const plan = planFromSubscriptions({ subs, now: deps.now(), userCreatedAt });
    return { plan, subs, userCreatedAt, changes: changes.filter(change => change.subscriptionId === plan.subscriptionId) };
}

function paidSubscription(plan: { subscriptionId: string | null; planActive: boolean }): string {
    if (!plan.subscriptionId || !plan.planActive) throw billingError('not_subscribed', 'PRECONDITION_FAILED');
    return plan.subscriptionId;
}

async function ownedSubscription(deps: BillingDeps, stripe: StripeApi, userId: string, subscriptionId: string,
    disallowed?: 'upgrade_not_allowed' | 'downgrade_not_allowed') {
    // Promotion review: an operator-granted plan has no Stripe subscription to read or change (the summary
    // offers no action for it; this refuses a direct call before any Stripe request or store write).
    if (operatorGrantedSubscription(subscriptionId)) throw billingError(disallowed ?? 'not_subscribed', 'PRECONDITION_FAILED');
    const subscription = await stripeCall(() => stripe.retrieveSubscription(subscriptionId), disallowed);
    const customer = await deps.store.stripeCustomerFor(userId);
    if (subscription.customer !== customer) throw billingError('customer_conflict', 'CONFLICT');
    return subscription;
}

/** The only subscription statuses Stripe never bills again; any other (or an unknown) status is a live subscription. */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/**
 * Promotion review (double subscription): the local plan lags Stripe until the webhook lands, and every
 * Checkout Session has its own idempotency key, so two windows (or one slow webhook) could each pay for a
 * plan. Before a subscription Checkout for an existing customer: expire that customer's other open
 * subscription-mode sessions (only the new one can then be paid), THEN ask Stripe for a live subscription
 * (one completed before the expiry is listed; one completing during it makes the expiry fail). Any Stripe
 * failure refuses (`stripe_unavailable`); a live subscription refuses `already_subscribed`. Fail-closed.
 */
async function refuseLiveStripeSubscription(stripe: StripeApi, customerId: string): Promise<void> {
    const subscriptions = await stripeCall(async () => {
        const open = await stripe.listOpenCheckoutSessions(customerId);
        for (const session of open) {
            if (session.mode === 'subscription') await stripe.expireCheckoutSession(session.id);
        }
        return stripe.listCustomerSubscriptions(customerId);
    });
    // Decided outside stripeCall, which would turn this refusal into stripe_unavailable.
    if (subscriptions.some(subscription => !ENDED_SUBSCRIPTION_STATUSES.has(subscription.status))) {
        throw billingError('already_subscribed', 'CONFLICT');
    }
}

async function upgradeContext(deps: BillingDeps, stripe: StripeApi, userId: string, toSku: string) {
    if (toSku !== 'premium_monthly_v3') throw billingError('unknown_sku', 'BAD_REQUEST');
    const { plan, changes } = await currentPlan(deps, userId);
    const subscriptionId = paidSubscription(plan);
    if (plan.sku !== 'standard_monthly_v3' || plan.status !== 'active') {
        throw billingError('upgrade_not_allowed', 'PRECONDITION_FAILED');
    }
    if (changes.some(change => change.kind === 'upgrade')) throw billingError('upgrade_pending', 'CONFLICT');
    if (changes.some(change => change.kind === 'downgrade')) throw billingError('upgrade_not_allowed', 'PRECONDITION_FAILED');
    const subscription = await ownedSubscription(deps, stripe, userId, subscriptionId, 'upgrade_not_allowed');
    if (subscription.scheduleId !== null) throw billingError('upgrade_not_allowed', 'PRECONDITION_FAILED');
    return { plan, subscriptionId };
}

/** Stored receipts split the Gateway balance by bucket; unreadable receipts fall back to the total. */
async function aiReceipts(deps: BillingDeps, userId: string) {
    try {
        return await deps.aiCredits?.receiptsFor?.(userId) ?? null;
    } catch {
        console.warn('[billing.ai] receipts unavailable');
        return null;
    }
}

type PlacementProvider = 'aws-ec2' | 'cloudflare' | null;
type AiMemberLookup = (db: { execute(query: SQL): Promise<unknown> }, userId: string) => Promise<string | null>;
type AiEnrollmentState = BillingSummaryV3['ai']['enrollment'];

/** EZiL ID sign-in page that returns to the desktop; the `needs_ezil_id` CTA. */
export const EZIL_ID_SIGN_IN_URL = '/auth/auth0/login?returnUrl=/os';

/**
 * Round 5 D1: whether this account can receive AI credits, from the Works member row and the stored
 * EZiL ID subject (never the Gateway): a member is `enrolled`; a linked subject without a member is
 * `activating` (the outbox drain enrolls it); otherwise `needs_ezil_id`. A database without the Works
 * member view (enrollment does not apply there) or a lookup failure keeps the `enrolled` default
 * (no false CTA, top-up unchanged); only the failure logs a fixed warning.
 */
async function aiEnrollmentOf(lookup: AiMemberLookup, db: { execute(query: SQL): Promise<unknown> },
    user: { id: string; app_metadata?: Record<string, unknown> | null }): Promise<AiEnrollmentState> {
    try {
        if (await lookup(db, user.id)) return 'enrolled';
    } catch (error) {
        if (!missingAiAccountView(error)) console.warn('[billing.ai] enrollment state unavailable');
        return 'enrolled';
    }
    const sub = user.app_metadata?.auth0_sub;
    return typeof sub === 'string' && sub.length > 0 ? 'activating' : 'needs_ezil_id';
}

/** The EZiL ID link when EZiL ID sign-in is configured (lazy: auth0.ts is server-only). */
async function ezilIdSignInUrl(): Promise<string | null> {
    try {
        const { auth0Enabled } = await import('@/server/auth/auth0');
        return auth0Enabled() ? EZIL_ID_SIGN_IN_URL : null;
    } catch {
        return null;
    }
}

/** Round 5 D3: one aws-ec2 computer's data volume, for its real size. */
export interface AwsVolumeRef { computerId: string; region: string; volumeId: string }
/**
 * Round 4 provider (standing) plus, round 5 D3, the user's aws-ec2 data volumes (real disk size), plus,
 * round 6 (R4-02), the metered size every aws-ec2 placement is on; omitted when there is none, any type is
 * unreadable or unlisted, or they differ.
 */
export interface UserPlacement {
    provider: PlacementProvider; awsVolumes: AwsVolumeRef[]; awsSize?: SizeCode;
    /**
     * Phase B (REVERSE-MOVE-CONTRACT §6.1.1): the live computers this read already lists, each with its provider and, for an
     * aws-ec2 one, the placement record it already reads (null when that read threw, as for the volume). Omitted by
     * injected doubles and with placement reads off: then there is no move computer.
     */
    computers?: { computerId: string; provider: string | null; placement: ReverseMovePlacementView | null }[];
}
type DbReader = { execute(query: SQL): Promise<unknown> };

/**
 * Round 4: where the user's files are, for the computer's standing. Any aws-ec2 placement among the user's
 * LIVE computers counts (a user may have two). Read-only, through the placement module's own readers (only
 * placement.ts names the placement table); provider null with placement reads off, without the placement
 * table (billing-only databases) or on any read error: the summary never fails on it.
 * Round 5 D3: each aws-ec2 placement's {region, volumeId}, from the placement module's full read
 * (owner-checked). That read is separate: when it fails the provider stands and only the volume is missing.
 * Round 6 (R4-02): the same read gives each placement's instance type, metered as the start gate meters it.
 */
export async function userPlacement(db: DbReader, userId: string): Promise<UserPlacement> {
    try {
        const [{ isPlacementReadEnabled, meteredSizeForInstanceType }, { readPlacement, readPlacementProvider }, { computers: computersTable },
            { reversePlacementView }] = await Promise.all([
            import('@/server/lib/compute/aws-config'), import('@/server/lib/compute/placement'), import('@/server/db/schema'),
            import('@/server/lib/compute/provider-reverse')]);
        // Phase B (§6.1.1 rule 4): with placement reads off there are no computer ids, so there is no move computer.
        if (!isPlacementReadEnabled()) return { provider: null, awsVolumes: [], computers: [] };
        const result = await db.execute(sql`/* billing:live-computers */ SELECT ${computersTable.id}::text AS id FROM ${computersTable}
            WHERE ${computersTable.userId} = ${userId}::uuid AND ${computersTable.deletedAt} IS NULL`);
        const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[];
        const ids = rows.map(row => row.id).filter((id): id is string => typeof id === 'string');
        const providers = await Promise.all(ids.map(id => readPlacementProvider(db, id)));
        const provider = providers.includes('aws-ec2') ? 'aws-ec2' : providers.some(p => p !== null) ? 'cloudflare' : null;
        const awsVolumes: AwsVolumeRef[] = [];
        const awsSizes: (SizeCode | null)[] = [];
        // Phase B (§6.1.1): no new placement query; the records read below, for the summary's move computer.
        const computers: NonNullable<UserPlacement['computers']> = ids.map((computerId, index) => ({ computerId: computerId.toLowerCase(),
            provider: providers[index] ?? null,
            placement: providers[index] === 'cloudflare' ? { provider: 'cloudflare' as const, state: null, leaseEpoch: null, lifecycleJobId: null, instanceType: null } : null }));
        for (const [index, id] of ids.entries()) {
            if (providers[index] !== 'aws-ec2') continue;
            try {
                const { record } = await readPlacement(db, id, userId);
                if (record?.provider === 'aws-ec2' && record.region && record.volumeId)
                    awsVolumes.push({ computerId: record.computerId, region: record.region, volumeId: record.volumeId });
                awsSizes.push(record?.provider === 'aws-ec2' ? meteredSizeForInstanceType(record.instanceType) : null);
                computers[index]!.placement = record?.provider === 'aws-ec2' ? reversePlacementView(record) : null;
            } catch {
                console.warn('[billing.summary] volume placement unavailable');
                awsSizes.push(null);
            }
        }
        const awsSize = awsSizes[0] ?? null;
        return { provider, awsVolumes, ...(awsSize !== null && awsSizes.every(size => size === awsSize) ? { awsSize } : {}), computers };
    } catch {
        console.warn('[billing.summary] placement unavailable');
        return { provider: null, awsVolumes: [] };
    }
}

/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md §6.1.1): the summary's move computer and its newest reverse row, from the
 * live computers `userPlacement` already read (no new placement query, no new store method). First match wins:
 * 1. the computer whose newest row HOLDS (in flight or `failed_needs_operator`; a holding row is always the newest);
 * 2. else the user's aws-ec2 computer (a Free user holds at most one; with several, the lowest id);
 * 3. else the computer whose newest row is terminal and visible (24 h, DB clock), the most recent: after a commit;
 * 4. else none (no keys' worth of move: `reverseMove` null, `moveOnOpen` and `moveAvailable` false).
 * 🔴 Probes 0012 first: a database without it (production today) gives `undefined`, today's summary exactly. Any read that
 * fails gives `undefined` too: no move action is ever shown from a read that did not complete.
 */
export async function reverseMoveSummaryInput(db: DbReader, placement: UserPlacement, user: { id: string; email?: unknown },
    isOperator: (email: string) => boolean | Promise<boolean>, env: Record<string, string | undefined> = process.env)
    : Promise<ReverseMoveSummaryInput | undefined> {
    const computers = placement.computers;
    if (!computers) return undefined;
    try {
        const [{ createProviderReverseStore, REVERSE_MOVE_HOLDING, reverseMovesTablePresent }, { reverseFounderOwned, reverseMoveVisible },
            { readAwsAdmissionConfig }] = await Promise.all([
            import('@/server/lib/compute/provider-reverse-store'), import('@/server/lib/compute/provider-reverse'), import('@/server/lib/compute/aws-config')]);
        const executor = db as unknown as Parameters<typeof reverseMovesTablePresent>[0];
        if (!(await reverseMovesTablePresent(executor))) return undefined;
        const store = createProviderReverseStore(executor);
        const userId = user.id.toLowerCase();
        const newest = await Promise.all(computers.map(c => store.readByComputer(c.computerId)));
        // Another owner's row (a re-keyed computer) is never this user's move.
        const entries = computers.map((c, i) => ({ ...c, row: newest[i]?.userId === userId ? newest[i]! : null }));
        const holding = entries.find(e => e.row && REVERSE_MOVE_HOLDING.includes(e.row.state));
        const aws = entries.filter(e => e.provider === 'aws-ec2').sort((a, b) => a.computerId < b.computerId ? -1 : a.computerId > b.computerId ? 1 : 0)[0];
        const ended = entries.filter(e => e.row && !REVERSE_MOVE_HOLDING.includes(e.row.state) && reverseMoveVisible(e.row))
            .sort((a, b) => a.row!.ages.stateEntered - b.row!.ages.stateEntered)[0];
        const pick = holding ?? aws ?? ended ?? null;
        const config = readAwsAdmissionConfig(env);
        return {
            tablePresent: true, row: pick?.row ?? null, placement: pick?.placement ?? null,
            awsEnabled: config.enabled, killSwitchOn: config.enabled && config.killSwitch,
            founderOwned: await reverseFounderOwned(user.email, isOperator),
        };
    } catch {
        console.warn('[billing.summary] reverse move unavailable');
        return undefined;
    }
}

/** Round 4 reader kept for its callers: the provider only. */
export async function userPlacementProvider(db: DbReader, userId: string): Promise<PlacementProvider> {
    return (await userPlacement(db, userId)).provider;
}

/** Round 5 D3: a cached volume size lasts at most 5 minutes (a volume only changes size through a grow, Phase B). */
const VOLUME_SIZE_TTL_MS = 5 * 60_000;
/** Bounded: one entry per AWS computer read recently on this instance; the oldest goes first. */
const VOLUME_SIZE_MAX_ENTRIES = 512;
/** The summary never waits on EC2 for longer than this; slower reads fall back to the 50 GiB figure. */
const VOLUME_SIZE_TIMEOUT_MS = 2_000;
/**
 * An unreadable volume (error, throttle, unknown, timeout) is held as unreadable this long, so a throttled
 * EC2 is not re-asked on every summary: DescribeVolumes shares its rate limit with the admission-lock
 * attachment check (aws-ec2.ts), whose failure sends a warm pool adopt down the cold path.
 */
const VOLUME_SIZE_NEGATIVE_TTL_MS = 30_000;

type VolumeDescribe = (region: string, volumeId: string) => Promise<{ sizeGiB?: number } | null>;

/**
 * Round 5 D3: the data volume's real size in GiB (EC2 DescribeVolumes), cached per volume in a bounded map:
 * a size for at most 5 minutes, an unreadable answer (error, missing size, unknown volume, timeout) as null
 * for 30 s. Concurrent reads of one volume share one call, and a call that outlives the timeout still fills
 * the cache when it lands. The caller shows the fallback for null, never a guess.
 */
export function createVolumeSizeReader(describe: VolumeDescribe, options: { now?: () => number; ttlMs?: number;
    negativeTtlMs?: number; maxEntries?: number; timeoutMs?: number } = {}): (volume: AwsVolumeRef) => Promise<number | null> {
    const now = options.now ?? Date.now, ttlMs = Math.min(options.ttlMs ?? VOLUME_SIZE_TTL_MS, VOLUME_SIZE_TTL_MS);
    const negativeTtlMs = Math.min(options.negativeTtlMs ?? VOLUME_SIZE_NEGATIVE_TTL_MS, ttlMs);
    const maxEntries = options.maxEntries ?? VOLUME_SIZE_MAX_ENTRIES, timeoutMs = options.timeoutMs ?? VOLUME_SIZE_TIMEOUT_MS;
    const cache = new Map<string, { sizeGiB: number | null; at: number }>();
    /** One in-flight call per volume; a call stuck past the negative TTL is replaced (bounded with the cache). */
    const pending = new Map<string, { promise: Promise<number | null>; at: number }>();
    const store = (key: string, sizeGiB: number | null) => {
        cache.delete(key);
        while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
        cache.set(key, { sizeGiB, at: now() });
    };
    return async ({ region, volumeId }) => {
        const key = `${region}:${volumeId}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at <= (hit.sizeGiB === null ? negativeTtlMs : ttlMs)) return hit.sizeGiB;
        let inflight = pending.get(key);
        if (!inflight || now() - inflight.at > negativeTtlMs) {
            const call = { at: now() } as { promise: Promise<number | null>; at: number };
            call.promise = (async () => {
                try {
                    const sizeGiB = (await describe(region, volumeId))?.sizeGiB;
                    return typeof sizeGiB === 'number' && Number.isInteger(sizeGiB) && sizeGiB >= 1 ? sizeGiB : null;
                } catch {
                    return null;
                }
            })().then(sizeGiB => {
                if (pending.get(key) === call) pending.delete(key);
                store(key, sizeGiB);
                return sizeGiB;
            });
            while (!pending.has(key) && pending.size >= maxEntries) pending.delete(pending.keys().next().value!);
            pending.set(key, call);
            inflight = call;
        }
        const call = inflight;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([call.promise, new Promise<null>(resolve => {
                timer = setTimeout(() => {
                    // Still in flight: unreadable for now; the late answer overwrites this when it lands.
                    if (pending.get(key) === call) store(key, null);
                    resolve(null);
                }, timeoutMs);
            })]);
        } finally {
            clearTimeout(timer);
        }
    };
}

/** The app's own EC2 reader (the same collaborators the compute provider uses); nothing with AWS off. */
const defaultVolumeSize = createVolumeSizeReader(async (region, volumeId) => {
    const { sharedAwsSdkCollaborators } = await import('@/server/lib/compute/aws-clients');
    return await sharedAwsSdkCollaborators(process.env).describer?.describeVolume(region, volumeId) ?? null;
});

/**
 * Round 5 D3: the smallest size among `volumes` (never overclaim). An unreadable volume beside a readable one
 * counts as the fallback (it may be a 50 GiB volume); null when none is readable (the summary's fallback).
 */
async function readVolumeGiB(volumes: readonly AwsVolumeRef[], read: (volume: AwsVolumeRef) => Promise<number | null>): Promise<number | null> {
    const sizes = await Promise.all(volumes.map(volume => read(volume).catch(() => null)));
    if (!sizes.some(size => typeof size === 'number')) return null;
    return Math.min(...sizes.map(size => typeof size === 'number' ? size : DISK_FALLBACK_GIB));
}

type StoredEpochs = Awaited<ReturnType<BillingDeps['store']['epochsFor']>>;

/**
 * Round 6 review (dunning into the hold): a paid subscription without paid access rates the computer on Free's
 * calendar month (summary.ts `computePlanV3`), which can start before the unpaid period; the epochs are then
 * re-read from the month's start, as the start gate does (compute-access.ts loadComputeBillingState).
 */
async function computeWindowEpochs(deps: BillingDeps, userId: string, epochs: StoredEpochs, input: {
    subs: SubscriptionRow[]; paymentIssues: PaymentIssueRow[]; now: Date; userCreatedAt: Date | null }): Promise<StoredEpochs> {
    const plan = planFromSubscriptions(input);
    const { standing } = deriveStanding({ subscriptions: input.subs, paymentIssues: input.paymentIssues, placementProvider: null, now: input.now });
    const rated = computePlanV3(plan, standing, input);
    return Date.parse(rated.window.start) < Date.parse(plan.window.start) ? deps.store.epochsFor(userId, new Date(rated.window.start)) : epochs;
}

/** Injecting the ports keeps session authorization real while tests replace billing effects. */
/** The operator gate reuses the `/admin/telemetry` allow-list (`TELEMETRY_ADMIN_EMAILS`, fail-closed); no new env. */
async function telemetryOperator(email: string | null | undefined): Promise<boolean> {
    const [{ env }, { isTelemetryAdmin }] = await Promise.all([import('@/env'), import('@/server/telemetry/admin')]);
    return isTelemetryAdmin(email, env.TELEMETRY_ADMIN_EMAILS);
}

export function createBillingRouter(getDeps: () => BillingDeps,
    options: { isOperator?: (email: string | null | undefined) => boolean | Promise<boolean>;
        /** Round 4 (provider only); superseded by `placement`, kept for callers that inject it. */
        placementProvider?: (db: DbReader, userId: string) => Promise<PlacementProvider>;
        /** Round 5 D3: provider plus the user's aws-ec2 volumes. */
        placement?: (db: DbReader, userId: string) => Promise<UserPlacement>;
        /** Round 5 D3: a volume's real size in GiB, null when unreadable. */
        volumeGiB?: (volume: AwsVolumeRef) => Promise<number | null>;
        /** Round 5 D1: the AI member public id (default: `lookupAiAccount` on ctx.db, on the funding URL's member contract). */
        aiMember?: AiMemberLookup } = {}) {
    const isOperator = options.isOperator ?? telemetryOperator;
    const aiMember: AiMemberLookup = options.aiMember
        ?? ((db, userId) => lookupAiAccount(db as Parameters<typeof lookupAiAccount>[0], userId, getDeps().config.fundingUrl,
            { strict: true }));
    const legacyPlacement = options.placementProvider;
    const placementOf = options.placement ?? (legacyPlacement
        ? async (db: DbReader, userId: string): Promise<UserPlacement> => ({ provider: await legacyPlacement(db, userId), awsVolumes: [] })
        : userPlacement);
    const volumeSize = options.volumeGiB ?? defaultVolumeSize;
    /** Never throws: an unreadable placement is no provider and no volume (fallback disk). */
    const placementAndVolume = async (db: DbReader, userId: string, computerId?: string) => {
        let placement: UserPlacement;
        try {
            placement = await placementOf(db, userId);
        } catch {
            console.warn('[billing.summary] placement unavailable');
            placement = { provider: null, awsVolumes: [] };
        }
        const volumes = computerId ? placement.awsVolumes.filter(volume => volume.computerId === computerId.toLowerCase()) : placement.awsVolumes;
        return { provider: placement.provider, volumeGiB: await readVolumeGiB(volumes, volumeSize), awsSize: placement.awsSize ?? null, placement };
    };
    return createTRPCRouter({
        usage: protectedProcedure.input(z.object({ computerId: z.string().uuid().optional() }).optional()).query(async ({ ctx, input }) => {
            const deps = getDeps();
            if (!deps.config.tabEnabled) return { enabled: false as const };
            if (input?.computerId && await deps.store.computerOwner(input.computerId) !== ctx.user.id)
                throw new TRPCError({ code: 'NOT_FOUND' });
            const now = deps.now();
            const [subs, userCreatedAt] = await Promise.all([
                deps.store.subscriptionsFor(ctx.user.id), deps.store.userCreatedAt(ctx.user.id),
            ]);
            const plan = planFromSubscriptions({ subs, userCreatedAt, now });
            const window = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
            // Round 6 (R1-07/R1-09): the placement provider and open payment issues give usage the summary's
            // standing, so under the D16 hold both show the held AWS computer and its disk.
            const [periodEpochs, grants, storage, consent, overageInvoices, sizePreference, placement, paymentIssues] = await Promise.all([
                deps.store.epochsFor(ctx.user.id, window.start),
                deps.store.grantsForPeriod(ctx.user.id, window, summaryMeters(plan.family)),
                deps.store.latestStorageFor(ctx.user.id),
                plan.subscriptionId === null ? null : deps.store.latestConsent(ctx.user.id, plan.subscriptionId),
                deps.store.overageInvoicesFor(ctx.user.id),
                deps.store.sizePreference(ctx.user.id),
                placementAndVolume(ctx.db, ctx.user.id, input?.computerId),
                deps.store.openPaymentIssues(ctx.user.id),
            ]);
            const epochs = await computeWindowEpochs(deps, ctx.user.id, periodEpochs, { subs, paymentIssues, now, userCreatedAt });
            return buildUsageV3({ config: deps.config, now, subs, userCreatedAt, epochs, grants, storage,
                consent, overageInvoices, planChanges: [], paymentIssues, sizePreference,
                hasCustomer: false, computerId: input?.computerId, volumeGiB: placement.volumeGiB, placementProvider: placement.provider });
        }),
        summary: protectedProcedure.query(async ({ ctx, signal }): Promise<BillingSummaryWithAi | { enabled: false }> => {
            const deps = getDeps();
            if (!deps.config.tabEnabled) return { enabled: false };
            const aiRead = readAiAccount({ config: deps.config, userId: ctx.user.id, headers: ctx.headers, signal });
            const now = deps.now();
            const [subs, userCreatedAt, planChanges] = await Promise.all([
                deps.store.subscriptionsFor(ctx.user.id),
                deps.store.userCreatedAt(ctx.user.id),
                deps.store.openPlanChanges(ctx.user.id),
            ]);
            const plan = planFromSubscriptions({ subs, now, userCreatedAt });
            const window = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
            const [periodEpochs, grants, consent, paymentIssues, storage, sizePreference, customer, overageInvoices, packs, placement,
                enrollmentState, ezilIdUrl] = await Promise.all([
                deps.store.epochsFor(ctx.user.id, window.start),
                deps.store.grantsForPeriod(ctx.user.id, window, summaryMeters(plan.family)),
                plan.subscriptionId === null ? null : deps.store.latestConsent(ctx.user.id, plan.subscriptionId),
                deps.store.openPaymentIssues(ctx.user.id),
                deps.store.latestStorageFor(ctx.user.id),
                deps.store.sizePreference(ctx.user.id),
                deps.store.stripeCustomerFor(ctx.user.id),
                deps.store.overageInvoicesFor(ctx.user.id),
                readStripePacks(deps.stripe),
                placementAndVolume(ctx.db, ctx.user.id),
                aiEnrollmentOf(aiMember, ctx.db, ctx.user),
                ezilIdSignInUrl(),
            ]);
            const epochs = await computeWindowEpochs(deps, ctx.user.id, periodEpochs, { subs, paymentIssues, now, userCreatedAt });
            // Phase B (§6.1.1): the move computer's reverse row; undefined (today's summary) without 0012 or on any failed read.
            const reverseMove = await reverseMoveSummaryInput(ctx.db, placement.placement, ctx.user,
                email => isOperator(email));
            let renewal = null;
            if (plan.renewsAt && plan.subscriptionId && !operatorGrantedSubscription(plan.subscriptionId) && customer && deps.stripe?.previewRenewal) {
                try {
                    await ownedSubscription(deps, deps.stripe, ctx.user.id, plan.subscriptionId);
                    const next = await deps.stripe.previewRenewal(plan.subscriptionId);
                    renewal = next ? { at: isoSeconds(epochSeconds(next.at)), amountCents: next.amountCents } : null;
                } catch {
                    // Billing remains readable if Stripe cannot preview the next invoice.
                    console.error('Billing renewal preview unavailable');
                }
            }
            await enqueueFreeAiCredits(deps.store, ctx.user.id, plan.sku, now);
            const [{ gatewayGrants, ...ai }, receipts] = await Promise.all([aiRead, aiReceipts(deps, ctx.user.id)]);
            const summary = buildSummaryV3({
                config: deps.config, now, userCreatedAt, subs, epochs, grants, consent, planChanges, paymentIssues,
                storage, sizePreference, hasCustomer: customer !== null, overageInvoices, renewal, packs, stripeAvailable: deps.stripe !== null,
                ai: { receipts, gatewayGrants, balanceMicro: ai.balanceMicro }, placementProvider: placement.provider,
                volumeGiB: placement.volumeGiB, awsSize: placement.awsSize, enrollment: { state: enrollmentState, ezilIdUrl },
                ...(reverseMove ? { reverseMove } : {}),
            });
            // Round 3: low/exhausted against this period's plan credits (summary.ts aiCreditBuckets), not the catalog total.
            ai.balanceState = summary.ai.state;
            return { ...summary, ai: { ...summary.ai, ...ai,
                // Older consumers cannot describe a pause. They must not call it healthy or exhausted.
                state: ai.spendingState === 'available' ? ai.balanceState : 'unavailable' } };
        }),

        aiUsage: protectedProcedure.input(z.object({
            limit: z.number().int().min(1).max(50).default(20),
            before: z.string().datetime({ offset: true }).optional(),
        }).strict().default({ limit: 20 })).query(async ({ ctx, input, signal }) => {
            const deps = getDeps();
            if (!deps.config.tabEnabled) return { state: 'unavailable' as const, recentUsage: null };
            return readAiUsage({ config: deps.config, userId: ctx.user.id, headers: ctx.headers, signal }, input);
        }),

        aiLimits: protectedProcedure.query(async ({ ctx, signal }) => {
            const deps = getDeps();
            if (!deps.config.tabEnabled) return { state: 'unavailable' as const, limits: null };
            return readAiLimits({ config: deps.config, userId: ctx.user.id, headers: ctx.headers, signal });
        }),

        createCheckout: protectedProcedure.input(z.object({ sku: z.enum(['standard_monthly_v3', 'premium_monthly_v3']) })).mutation(async ({ ctx, input }): Promise<CheckoutStartDTO> => {
            const deps = getDeps();
            const stripe = configuredStripe(deps);
            const { plan } = await currentPlan(deps, ctx.user.id);
            if (plan.family !== 'free') throw billingError('already_subscribed', 'CONFLICT');

            let customerId = await deps.store.stripeCustomerFor(ctx.user.id);
            if (customerId) {
                await refuseLiveStripeSubscription(stripe, customerId);
            } else {
                // A customer created here has no subscription and no earlier Checkout Session to expire.
                const customer = await stripeCall(() => stripe.createCustomer({
                    userId: ctx.user.id,
                    email: ctx.user.email ?? null,
                    idempotencyKey: `customer:${ctx.user.id}`,
                }));
                const linked = await deps.store.linkCustomer(ctx.user.id, customer.id);
                if (linked === 'conflict') throw billingError('customer_conflict', 'CONFLICT');
                customerId = customer.id;
            }
            const origin = billingReturnOrigin(ctx.headers);
            const publishableKey = deps.config.stripePublishableKey;
            const returnUrl = `${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}`;
            const session = await stripeCall(() => stripe.createCheckoutSession({
                customerId,
                userId: ctx.user.id,
                sku: input.sku,
                uiMode: publishableKey ? 'embedded' : 'hosted',
                automaticTax: deps.config.automaticTaxEnabled,
                adaptivePricing: deps.config.adaptivePricingEnabled,
                managedPayments: deps.config.managedPaymentsEnabled,
                returnUrl,
                successUrl: returnUrl,
                cancelUrl: `${origin}/os`,
                idempotencyKey: `checkout:${ctx.user.id}:${input.sku}:${crypto.randomUUID()}`,
            }));
            if (publishableKey) {
                if (!session.clientSecret) throw billingError('stripe_unavailable', 'INTERNAL_SERVER_ERROR');
                return { mode: 'embedded', sessionId: session.id, clientSecret: session.clientSecret, publishableKey };
            }
            if (!session.url) throw billingError('stripe_unavailable', 'INTERNAL_SERVER_ERROR');
            return { mode: 'redirect', sessionId: session.id, url: session.url };
        }),

        createTopupCheckout: protectedProcedure.input(z.union([
            z.object({ sku: z.string() }).strict(),
            z.object({ customAmountCents: z.number().int().min(CUSTOM_TOPUP.minCents).max(CUSTOM_TOPUP.maxCents).multipleOf(100) }).strict(),
        ])).mutation(async ({ ctx, input }): Promise<{ sessionId: string; clientSecret: string; publishableKey: string }> => {
            const deps = getDeps();
            const stripe = configuredStripe(deps);
            const publishableKey = deps.config.stripePublishableKey;
            if (!publishableKey) throw billingError('billing_not_configured', 'PRECONDITION_FAILED');
            // Round 5 D1: credits bought before enrollment would only wait; same rule as summary actions.topup.
            if (await aiEnrollmentOf(aiMember, ctx.db, ctx.user) !== 'enrolled') {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'ai_enrollment_required' });
            }
            const pack = 'sku' in input ? (await readStripePacks(stripe)).find(pack => pack.sku === input.sku) : customTopupPack(input.customAmountCents);
            if (!aiPackCheckoutEligible(pack)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown_pack' });

            let customerId = await deps.store.stripeCustomerFor(ctx.user.id);
            if (!customerId) {
                const customer = await stripeCall(() => stripe.createCustomer({
                    userId: ctx.user.id, email: ctx.user.email ?? null, idempotencyKey: `customer:${ctx.user.id}`,
                }));
                const linked = await deps.store.linkCustomer(ctx.user.id, customer.id);
                if (linked === 'conflict') throw billingError('customer_conflict', 'CONFLICT');
                customerId = customer.id;
            }
            const origin = billingReturnOrigin(ctx.headers);
            const returnUrl = `${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}`;
            const session = await stripeCall(() => stripe.createCheckoutSession({
                customerId, userId: ctx.user.id, sku: pack.sku,
                ...('customAmountCents' in input ? { customAmountCents: input.customAmountCents } : {}),
                uiMode: 'embedded', automaticTax: deps.config.automaticTaxEnabled, adaptivePricing: false,
                managedPayments: deps.config.managedPaymentsEnabled,
                returnUrl, successUrl: returnUrl, cancelUrl: `${origin}/os`,
                idempotencyKey: `checkout:${ctx.user.id}:${pack.sku}:${crypto.randomUUID()}`,
            }));
            if (!session.clientSecret) throw billingError('stripe_unavailable', 'INTERNAL_SERVER_ERROR');
            return { sessionId: session.id, clientSecret: session.clientSecret, publishableKey };
        }),

        previewUpgrade: protectedProcedure.input(z.object({ toSku: z.string() }))
            .mutation(async ({ ctx, input }): Promise<Omit<PreviewUpgradeOutput, 'toSku'> & { toSku: 'premium_monthly_v3' }> => {
                const deps = getDeps();
                const stripe = configuredStripe(deps);
                const { subscriptionId } = await upgradeContext(deps, stripe, ctx.user.id, input.toSku);
                const prorationDate = epochSeconds(deps.now());
                const preview = await stripeCall(() => stripe.previewUpgrade({
                    subscriptionId, toSku: 'premium_monthly_v3', prorationDate,
                }), 'upgrade_not_allowed');
                const periodStart = isoSeconds(epochSeconds(preview.periodStart));
                const periodEnd = isoSeconds(epochSeconds(preview.periodEnd));
                return {
                    toSku: 'premium_monthly_v3', prorationDate, amountDueCents: preview.amountDueCents,
                    currency: 'usd', lines: preview.lines, periodEnd,
                    grantStdSeconds: upgradeGrantSeconds({
                        periodStart, periodEnd, effectiveAt: isoSeconds(prorationDate) }),
                };
            }),

        confirmUpgrade: protectedProcedure.input(z.object({ toSku: z.string(), prorationDate: z.number().int() }))
            .mutation(async ({ ctx, input }): Promise<ConfirmUpgradeOutput> => {
                const deps = getDeps();
                const stripe = configuredStripe(deps);
                const { subscriptionId } = await upgradeContext(deps, stripe, ctx.user.id, input.toSku);
                const change = { userId: ctx.user.id, subscriptionId, kind: 'upgrade' as const };
                const inserted = await deps.store.recordPlanChange({
                    ...change, fromSku: 'standard_monthly_v3', toSku: 'premium_monthly_v3', state: 'pending',
                    stripeInvoiceId: null, stripeScheduleId: null, hostedInvoiceUrl: null, effectiveAt: null, expiresAt: null,
                });
                if (inserted === 'exists') throw billingError('upgrade_pending', 'CONFLICT');
                const result = await stripeCall(async () => {
                    try {
                        return await stripe.confirmUpgrade({ subscriptionId, toSku: 'premium_monthly_v3',
                            prorationDate: input.prorationDate, now: deps.now(),
                            idempotencyKey: `upgrade:${subscriptionId}:${input.prorationDate}` });
                    } catch (error) {
                        await deps.store.setPlanChangeState({ ...change, state: 'canceled' });
                        throw error;
                    }
                }, 'upgrade_not_allowed');
                await deps.store.setPlanChangeState({
                    ...change, state: result.status, stripeInvoiceId: result.invoiceId,
                    hostedInvoiceUrl: result.hostedInvoiceUrl, expiresAt: result.expiresAt,
                    ...(result.status === 'applied' ? { effectiveAt: new Date(input.prorationDate * 1000) } : {}),
                });
                return { ...result, expiresAt: result.expiresAt === null ? null : isoSeconds(epochSeconds(result.expiresAt)) };
            }),

        scheduleDowngrade: protectedProcedure.input(z.object({ toSku: z.string() }))
            .mutation(async ({ ctx, input }): Promise<ScheduleDowngradeOutput> => {
                const deps = getDeps();
                const stripe = configuredStripe(deps);
                if (input.toSku !== 'standard_monthly_v3') throw billingError('unknown_sku', 'BAD_REQUEST');
                const { plan, changes } = await currentPlan(deps, ctx.user.id);
                const subscriptionId = paidSubscription(plan);
                await ownedSubscription(deps, stripe, ctx.user.id, subscriptionId, 'downgrade_not_allowed');
                if (plan.sku !== 'premium_monthly_v3' || plan.status !== 'active'
                    || changes.some(change => change.kind === 'downgrade')) {
                    throw billingError('downgrade_not_allowed', 'PRECONDITION_FAILED');
                }
                const result = await stripeCall(() => stripe.scheduleDowngrade({
                    subscriptionId, toSku: 'standard_monthly_v3',
                    idempotencyKey: `downgrade:${subscriptionId}:${epochSeconds(plan.window.end)}`,
                }), 'downgrade_not_allowed');
                await deps.store.recordPlanChange({
                    userId: ctx.user.id, subscriptionId, kind: 'downgrade', fromSku: 'premium_monthly_v3',
                    toSku: 'standard_monthly_v3', state: 'scheduled', stripeScheduleId: result.scheduleId,
                    effectiveAt: result.effectiveAt, stripeInvoiceId: null, hostedInvoiceUrl: null, expiresAt: null,
                });
                return { effectiveAt: isoSeconds(epochSeconds(result.effectiveAt)) };
            }),

        cancelAtPeriodEnd: protectedProcedure.input(z.object({ cancel: z.boolean() }))
            .mutation(async ({ ctx, input }): Promise<CancelAtPeriodEndOutput> => {
                const deps = getDeps();
                const stripe = configuredStripe(deps);
                const { plan, changes } = await currentPlan(deps, ctx.user.id);
                const subscriptionId = paidSubscription(plan);
                if (changes.some(change => change.kind === 'upgrade')) throw billingError('upgrade_pending', 'CONFLICT');
                const downgrade = changes.find(change => change.kind === 'downgrade' && change.state === 'scheduled');
                if (input.cancel && downgrade?.stripeScheduleId) {
                    await ownedSubscription(deps, stripe, ctx.user.id, subscriptionId);
                    await stripeCall(() => stripe.cancelScheduledChange({ scheduleId: downgrade.stripeScheduleId! }));
                    await deps.store.setPlanChangeState({ userId: ctx.user.id, subscriptionId, kind: 'downgrade', state: 'canceled' });
                }
                await ownedSubscription(deps, stripe, ctx.user.id, subscriptionId);
                const result = await stripeCall(() => stripe.setCancelAtPeriodEnd({
                    subscriptionId, cancel: input.cancel,
                    idempotencyKey: `cancel:${subscriptionId}:${input.cancel}:${epochSeconds(deps.now())}`,
                }));
                return { cancelsAt: result.cancelsAt === null ? null : isoSeconds(epochSeconds(result.cancelsAt)) };
            }),

        setOverage: protectedProcedure.input(z.object({ enabled: z.boolean(), capCents: z.number(), termsVersion: z.string() }))
            .mutation(async ({ ctx, input }): Promise<SetOverageOutput> => {
                const deps = getDeps();
                configuredStripe(deps);
                const current = await currentPlan(deps, ctx.user.id);
                if (current.plan.sku !== 'legacy' && !(current.plan.sku === 'free_v3'
                    && current.subs.some(sub => sub.sku === 'compute_monthly_v2'))) {
                    throw billingError('upgrade_not_allowed', 'PRECONDITION_FAILED');
                }
                if (input.termsVersion !== OVERAGE_TERMS_VERSION) throw billingError('terms_version_mismatch', 'BAD_REQUEST');
                if (!Number.isInteger(input.capCents) || input.capCents < 0 || input.capCents > OVERAGE_MAX_CAP_CENTS
                    || input.capCents % 100 !== 0) throw billingError('cap_out_of_range', 'BAD_REQUEST');
                const { subs, userCreatedAt, changes } = current;
                const plan = current.plan.legacy ?? legacyPlanFromSubscriptions({ subs, userCreatedAt, now: deps.now() });
                // Opt-out depends on ownership, even when the subscription no longer supplies a current plan.
                const ownedCompute = subs.filter(sub => sub.sku === 'compute_monthly_v2')
                    .sort((a, b) => (b.currentPeriodEnd?.getTime() ?? 0) - (a.currentPeriodEnd?.getTime() ?? 0));
                const subscriptionId = input.enabled ? paidSubscription(plan)
                    : (ownedCompute.find(sub => sub.stripeSubscriptionId === plan.subscriptionId) ?? ownedCompute[0])?.stripeSubscriptionId;
                if (!subscriptionId || (input.enabled && (plan.sku !== 'compute_monthly_v2' || plan.status !== 'active'))) {
                    throw billingError('not_subscribed', 'PRECONDITION_FAILED');
                }
                const [paymentIssues, overageInvoices] = await Promise.all([
                    deps.store.openPaymentIssues(ctx.user.id), deps.store.overageInvoicesFor(ctx.user.id),
                ]);
                // The pinned vocabulary has no overage-payment refusal: not_subscribed
                // means overage cannot be enabled until this subscription's issue is repaired.
                if (input.enabled && (hasOveragePaymentFailure(subscriptionId, paymentIssues, overageInvoices)
                    || paymentIssues.some(issue => issue.subscriptionId === subscriptionId
                        && issue.invoiceKind === 'overage' && issue.resolvedAt === null))) {
                    throw billingError('not_subscribed', 'PRECONDITION_FAILED');
                }
                const now = deps.now();
                const recorded = await deps.store.recordConsent({ userId: ctx.user.id, subscriptionId, ...input,
                    catalogVersion: 2, rateCentsPerStdHour: OVERAGE_CENTS_PER_STD_HOUR, actor: ctx.user.id, acceptedAt: now });
                if (!input.enabled) {
                    const policy = CATALOG_V2.compute_monthly_v2.overage!;
                    const paymentFailed = hasOveragePaymentFailure(subscriptionId, paymentIssues, overageInvoices);
                    return {
                        available: plan.subscriptionId === subscriptionId && plan.planActive && !paymentFailed,
                        enabled: false, capCents: recorded.capCents, defaultCapCents: policy.defaultCapCents,
                        maxCapCents: policy.maxCapCents, centsPerStdHour: policy.centsPerStdHour, accruedCents: 0,
                        termsVersion: OVERAGE_TERMS_VERSION, acceptedVersion: recorded.termsVersion,
                        acceptedAt: isoSeconds(epochSeconds(recorded.acceptedAt)), pausedReason: paymentFailed ? 'payment_failed' : null,
                    };
                }
                const window = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
                const [epochs, grants, consent, storage, sizePreference, customer] = await Promise.all([
                    deps.store.epochsFor(ctx.user.id, window.start),
                    deps.store.grantsForPeriod(ctx.user.id, window, summaryMeters(plan.family)),
                    deps.store.latestConsent(ctx.user.id, subscriptionId), deps.store.latestStorageFor(ctx.user.id),
                    deps.store.sizePreference(ctx.user.id), deps.store.stripeCustomerFor(ctx.user.id),
                ]);
                return buildSummaryV2({ config: deps.config, now, userCreatedAt, subs, epochs, grants, consent,
                    planChanges: changes, paymentIssues, overageInvoices, storage, sizePreference, hasCustomer: customer !== null }).overage!;
            }),

        selectMachine: protectedProcedure.input(z.object({ size: z.custom<SizeCode>(
            value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(SIZES, value),
            { message: 'size_not_allowed' },
        ) })).mutation(async ({ ctx, input }): Promise<SelectMachineOutputV3> => {
            const deps = getDeps();
            const { plan } = await currentPlan(deps, ctx.user.id);
            if (plan.sku !== 'premium_monthly_v3' || plan.status !== 'active'
                || !plan.offer.machineChoice.includes(input.size)) {
                throw billingError('size_not_allowed', 'BAD_REQUEST');
            }
            await deps.store.setSizePreference(ctx.user.id, input.size);
            return { size: input.size, effective: 'next_open' };
        }),

        selectSize: protectedProcedure.input(z.object({ size: z.string() }))
            .mutation(async ({ ctx, input }): Promise<SelectSizeOutput> => {
                const deps = getDeps();
                configuredStripe(deps);
                const { plan } = await currentPlan(deps, ctx.user.id);
                // v3 plans choose through selectMachine; only legacy v2 offers use this.
                if (plan.sku !== 'legacy') throw billingError('upgrade_not_allowed', 'PRECONDITION_FAILED');
                const size = plan.offer.sizes.find(size => size === input.size);
                if (!size) throw billingError('size_not_allowed', 'BAD_REQUEST');
                await deps.store.setSizePreference(ctx.user.id, size);
                return { selectedSize: size };
            }),

        history: protectedProcedure.query(async ({ ctx }): Promise<BillingInvoiceDTO[]> => {
            const deps = getDeps();
            if (!checkoutAvailable(deps.config) || !deps.stripe) return [];
            try {
                const customerId = await deps.store.stripeCustomerFor(ctx.user.id);
                if (!customerId) return [];
                const invoices = await deps.stripe.listInvoices(customerId, 12);
                return invoices.sort((a, b) => b.created.getTime() - a.created.getTime()).slice(0, 12).map(invoice => ({
                    id: invoice.id,
                    number: invoice.number,
                    status: invoice.status,
                    kind: invoice.metadataKind === 'overage' ? 'overage'
                        : invoice.billingReason?.startsWith('subscription') ? 'subscription' : 'other',
                    amountPaidCents: invoice.amountPaidCents,
                    amountDueCents: invoice.amountDueCents,
                    currency: invoice.currency,
                    created: invoice.created.toISOString(),
                    url: invoice.hostedInvoiceUrl,
                    description: invoice.description,
                }));
            } catch {
                // Provider failures must not hide usage; error bodies can contain billing data.
                console.error('Billing invoice history unavailable');
                return [];
            }
        }),

        portal: protectedProcedure.mutation(async ({ ctx }) => {
            const deps = getDeps();
            const stripe = configuredStripe(deps);
            const customerId = await deps.store.stripeCustomerFor(ctx.user.id);
            if (!customerId) throw billingError('not_subscribed', 'PRECONDITION_FAILED');
            const { plan } = await currentPlan(deps, ctx.user.id);
            if (plan.subscriptionId) await ownedSubscription(deps, stripe, ctx.user.id, plan.subscriptionId);
            return stripeCall(() => stripe.createPortalSession({ customerId, returnUrl: `${billingReturnOrigin(ctx.headers)}/os` }));
        }),

        checkoutStatus: protectedProcedure.input(z.object({ sessionId: z.string() }))
            .query(async ({ ctx, input }): Promise<{ status: CheckoutStatusDTO; paymentStatus: StripeCheckoutSession['paymentStatus'] | null; sku: string | null }> => {
                const deps = getDeps();
                const stripe = configuredStripe(deps);
                if (!/^cs_[A-Za-z0-9_]+$/.test(input.sessionId)) throw billingError('not_subscribed', 'BAD_REQUEST');
                const session = await stripeCall(() => stripe.retrieveCheckoutSession(input.sessionId));
                if (session.clientReferenceId !== ctx.user.id) throw billingError('not_subscribed', 'NOT_FOUND');
                // Completing Checkout can precede settlement for bank payments.
                // Missing or unrecognized payment state must not imply receipt.
                const paymentStatus = session.paymentStatus === 'paid' || session.paymentStatus === 'unpaid'
                    || session.paymentStatus === 'no_payment_required' ? session.paymentStatus : null;
                const sku = typeof session.sku === 'string' && session.sku.trim() ? session.sku : null;
                return { status: session.status === 'open' ? 'pending' : session.status, paymentStatus, sku };
            }),

        /**
         * Round 3 D5, operator only (NOT_FOUND to everyone else): reset failed, still-deliverable
         * AI grants to retry. Dry run unless `apply: true`; every decision is logged.
         */
        requeueAiCredits: protectedProcedure.input(z.object({
            eventKeys: z.array(z.string().min(1).max(200)).max(200).optional(),
            userId: z.string().uuid().optional(),
            apply: z.boolean().default(false),
        }).strict().refine(value => (value.eventKeys?.length ?? 0) > 0 || value.userId !== undefined))
            .mutation(async ({ ctx, input }) => {
                let allowed = false;
                try { allowed = await isOperator(ctx.user.email); } catch { allowed = false; }
                if (!allowed) throw new TRPCError({ code: 'NOT_FOUND' });
                const deps = getDeps();
                if (!deps.aiCredits?.requeueFailed) throw billingError('billing_not_configured', 'PRECONDITION_FAILED');
                const result = await deps.aiCredits.requeueFailed({ eventKeys: input.eventKeys, userId: input.userId,
                    apply: input.apply, now: deps.now().getTime() });
                console.info(JSON.stringify({ event: 'ai-outbox-requeue-run', operator: ctx.user.id, dryRun: result.dryRun,
                    selected: result.selected, eligible: result.eligible, requeued: result.requeued }));
                return result;
            }),
    });
}

export const billingRouter = createBillingRouter(() => getBillingDeps());
export default billingRouter;

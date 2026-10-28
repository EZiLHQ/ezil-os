import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { checkoutAvailable } from '@/server/billing/config';
import { aiPackCheckoutEligible, CUSTOM_TOPUP, customTopupPack } from '@/server/billing/catalog';
import { enqueueFreeAiCredits, readAiAccount, type BillingSummaryWithAi } from '@/server/billing/ai-balance';
import { readAiUsage } from '@/server/billing/ai-usage';
import { readAiLimits } from '@/server/billing/ai-limits';
import { getBillingDeps } from '@/server/billing/deps';
import type { BillingDeps, StripeApi, StripeCheckoutSession } from '@/server/billing/ports';
import { billingReturnOrigin } from '@/server/billing/return-origin';
import { readStripePacks } from '@/server/billing/stripe/packs';
import { BillingProviderError } from '@/server/billing/stripe/client';
import { planFromSubscriptions as legacyPlanFromSubscriptions } from '@/server/billing/v2/catalog';
import { planFromSubscriptions, upgradeGrantSeconds } from '@/server/billing/v3/catalog';
import { buildSummaryV3 } from '@/server/billing/v3/summary';
import { buildUsageV3 } from '@/server/billing/v3/usage';
import type { SelectMachineOutputV3 } from '@/server/billing/v3/contract';
import {
    CATALOG_V2, SIZES, OVERAGE_CENTS_PER_STD_HOUR, OVERAGE_MAX_CAP_CENTS, OVERAGE_TERMS_VERSION,
    type SizeCode,
    type BillingErrorCode, type BillingInvoiceDTO, type CheckoutStartDTO,
    type CheckoutStatusDTO, type ConfirmUpgradeOutput, type PreviewUpgradeOutput, type ScheduleDowngradeOutput,
    type CancelAtPeriodEndOutput, type SetOverageOutput, type SelectSizeOutput,
} from '@/server/billing/v2/contract';
import { buildSummaryV2, hasOveragePaymentFailure, summaryMeters } from '@/server/billing/v2/summary';
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
    const subscription = await stripeCall(() => stripe.retrieveSubscription(subscriptionId), disallowed);
    const customer = await deps.store.stripeCustomerFor(userId);
    if (subscription.customer !== customer) throw billingError('customer_conflict', 'CONFLICT');
    return subscription;
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

/** Injecting the ports keeps session authorization real while tests replace billing effects. */
/** The operator gate reuses the `/admin/telemetry` allow-list (`TELEMETRY_ADMIN_EMAILS`, fail-closed); no new env. */
async function telemetryOperator(email: string | null | undefined): Promise<boolean> {
    const [{ env }, { isTelemetryAdmin }] = await Promise.all([import('@/env'), import('@/server/telemetry/admin')]);
    return isTelemetryAdmin(email, env.TELEMETRY_ADMIN_EMAILS);
}

export function createBillingRouter(getDeps: () => BillingDeps,
    options: { isOperator?: (email: string | null | undefined) => boolean | Promise<boolean> } = {}) {
    const isOperator = options.isOperator ?? telemetryOperator;
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
            const [epochs, grants, storage, consent, overageInvoices, sizePreference] = await Promise.all([
                deps.store.epochsFor(ctx.user.id, window.start),
                deps.store.grantsForPeriod(ctx.user.id, window, summaryMeters(plan.family)),
                deps.store.latestStorageFor(ctx.user.id),
                plan.subscriptionId === null ? null : deps.store.latestConsent(ctx.user.id, plan.subscriptionId),
                deps.store.overageInvoicesFor(ctx.user.id),
                deps.store.sizePreference(ctx.user.id),
            ]);
            return buildUsageV3({ config: deps.config, now, subs, userCreatedAt, epochs, grants, storage,
                consent, overageInvoices, planChanges: [], paymentIssues: [], sizePreference,
                hasCustomer: false, computerId: input?.computerId });
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
            const [epochs, grants, consent, paymentIssues, storage, sizePreference, customer, overageInvoices, packs] = await Promise.all([
                deps.store.epochsFor(ctx.user.id, window.start),
                deps.store.grantsForPeriod(ctx.user.id, window, summaryMeters(plan.family)),
                plan.subscriptionId === null ? null : deps.store.latestConsent(ctx.user.id, plan.subscriptionId),
                deps.store.openPaymentIssues(ctx.user.id),
                deps.store.latestStorageFor(ctx.user.id),
                deps.store.sizePreference(ctx.user.id),
                deps.store.stripeCustomerFor(ctx.user.id),
                deps.store.overageInvoicesFor(ctx.user.id),
                readStripePacks(deps.stripe),
            ]);
            let renewal = null;
            if (plan.renewsAt && plan.subscriptionId && customer && deps.stripe?.previewRenewal) {
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
                ai: { receipts, gatewayGrants, balanceMicro: ai.balanceMicro },
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
            if (!customerId) {
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

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { findPack, PRO_PLAN } from '@/server/billing/catalog';
import { checkoutAvailable } from '@/server/billing/config';
import { getBillingDeps } from '@/server/billing/deps';
import type { BillingDeps } from '@/server/billing/ports';
import type { BillingInvoice, CheckoutStart, CheckoutStatus } from '@/server/billing/types';
import { planFromSubscriptions } from '@/server/billing/v2/catalog';
import type { BillingSummaryV2Result } from '@/server/billing/v2/contract';
import { buildSummaryV2, summaryMeters } from '@/server/billing/v2/summary';

import { createTRPCRouter, protectedProcedure } from '../trpc';

/** Only an HTTP origin belongs in Stripe's return URLs; absent headers use the public app. */
function requestOrigin(headers?: Headers): string {
    const origin = headers?.get('origin');
    if (origin) {
        try {
            const url = new URL(origin);
            if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
        } catch {
            // Non-browser callers may omit a usable Origin header.
        }
    }
    return 'https://os.ezil.org';
}

/** Injecting the ports keeps session authorization real while tests replace billing effects. */
export function createBillingRouter(getDeps: () => BillingDeps) {
    return createTRPCRouter({
        summary: protectedProcedure.query(async ({ ctx }): Promise<BillingSummaryV2Result> => {
            const deps = getDeps();
            if (!deps.config.tabEnabled) return { enabled: false };
            const now = deps.now();
            const [subs, userCreatedAt, planChanges] = await Promise.all([
                deps.store.subscriptionsFor(ctx.user.id),
                deps.store.userCreatedAt(ctx.user.id),
                deps.store.openPlanChanges(ctx.user.id),
            ]);
            const plan = planFromSubscriptions({ subs, now, userCreatedAt });
            const window = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
            const [epochs, grants, consent, paymentIssues, storage, sizePreference, customer] = await Promise.all([
                deps.store.epochsFor(ctx.user.id, window.start),
                deps.store.grantsForPeriod(ctx.user.id, window, summaryMeters(plan.family)),
                plan.subscriptionId === null ? null : deps.store.latestConsent(ctx.user.id, plan.subscriptionId),
                deps.store.openPaymentIssues(ctx.user.id),
                deps.store.latestStorageFor(ctx.user.id),
                deps.store.sizePreference(ctx.user.id),
                deps.store.stripeCustomerFor(ctx.user.id),
            ]);
            return buildSummaryV2({
                config: deps.config, now, userCreatedAt, subs, epochs, grants, consent, planChanges, paymentIssues,
                storage, sizePreference, hasCustomer: customer !== null,
            });
        }),

        createCheckout: protectedProcedure.input(z.object({ sku: z.string() })).mutation(async ({ ctx, input }): Promise<CheckoutStart> => {
            const deps = getDeps();
            if (!checkoutAvailable(deps.config) || !deps.stripe) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'billing_not_configured' });
            }
            if (findPack(input.sku)) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'ai_not_available' });
            }
            if (input.sku !== PRO_PLAN.sku) throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown_sku' });
            const subs = await deps.store.subscriptionsFor(ctx.user.id);
            const plan = planFromSubscriptions({ subs, now: deps.now(), userCreatedAt: null });
            if (plan.family !== 'free') throw new TRPCError({ code: 'CONFLICT', message: 'already_subscribed' });

            let customerId = await deps.store.stripeCustomerFor(ctx.user.id);
            if (!customerId) {
                const customer = await deps.stripe.createCustomer({
                    userId: ctx.user.id,
                    email: ctx.user.email ?? null,
                    idempotencyKey: `customer:${ctx.user.id}`,
                });
                const linked = await deps.store.linkCustomer(ctx.user.id, customer.id);
                if (linked === 'conflict') throw new TRPCError({ code: 'CONFLICT', message: 'customer_conflict' });
                customerId = customer.id;
            }
            const origin = requestOrigin(ctx.headers);
            const publishableKey = deps.config.stripePublishableKey;
            const returnUrl = `${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}`;
            const session = await deps.stripe.createCheckoutSession({
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
            });
            if (publishableKey) {
                if (!session.clientSecret) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'checkout_unavailable' });
                return { mode: 'embedded', sessionId: session.id, clientSecret: session.clientSecret, publishableKey };
            }
            if (!session.url) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'checkout_unavailable' });
            return { mode: 'redirect', sessionId: session.id, url: session.url };
        }),

        history: protectedProcedure.query(async ({ ctx }): Promise<BillingInvoice[]> => {
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
                    amountPaidCents: invoice.amountPaidCents,
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
            if (!checkoutAvailable(deps.config) || !deps.stripe) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'billing_not_configured' });
            }
            const customerId = await deps.store.stripeCustomerFor(ctx.user.id);
            if (!customerId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'customer_not_found' });
            return deps.stripe.createPortalSession({ customerId, returnUrl: `${requestOrigin(ctx.headers)}/os` });
        }),

        checkoutStatus: protectedProcedure.input(z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]+$/) }))
            .query(async ({ ctx, input }): Promise<{ status: CheckoutStatus }> => {
                const deps = getDeps();
                if (!checkoutAvailable(deps.config) || !deps.stripe) {
                    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'billing_not_configured' });
                }
                const session = await deps.stripe.retrieveCheckoutSession(input.sessionId);
                if (session.clientReferenceId !== ctx.user.id) throw new TRPCError({ code: 'NOT_FOUND' });
                return { status: session.status === 'open' ? 'pending' : session.status };
            }),
    });
}

export const billingRouter = createBillingRouter(() => getBillingDeps());
export default billingRouter;

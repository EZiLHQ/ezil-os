import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { findPack, PRO_PLAN } from '@/server/billing/catalog';
import { checkoutAvailable } from '@/server/billing/config';
import { getBillingDeps } from '@/server/billing/deps';
import { buildSummary, freeWindow, resolvePlan } from '@/server/billing/meters';
import type { BillingDeps } from '@/server/billing/ports';
import type { BillingSummary, CheckoutStatus } from '@/server/billing/types';

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
        summary: protectedProcedure.query(async ({ ctx }): Promise<BillingSummary> => {
            const deps = getDeps();
            if (!deps.config.tabEnabled) return { enabled: false };
            const now = deps.now();
            const subs = await deps.store.subscriptionsFor(ctx.user.id);
            const since = new Date(Math.min(freeWindow(now).start.getTime(), ...subs.flatMap(sub => (
                sub.currentPeriodStart ? [sub.currentPeriodStart.getTime()] : []
            ))));
            const [intervals, storage] = await Promise.all([
                deps.store.intervalsFor(ctx.user.id, since),
                deps.store.latestStorageFor(ctx.user.id),
            ]);
            return buildSummary({ config: deps.config, now, subs, intervals, storage });
        }),

        createCheckout: protectedProcedure.input(z.object({ sku: z.string() })).mutation(async ({ ctx, input }) => {
            const deps = getDeps();
            if (!checkoutAvailable(deps.config) || !deps.stripe) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'billing_not_configured' });
            }
            if (findPack(input.sku)) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'ai_not_available' });
            }
            if (input.sku !== PRO_PLAN.sku) throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown_sku' });
            const subs = await deps.store.subscriptionsFor(ctx.user.id);
            const plan = resolvePlan(subs.filter(sub => sub.sku === PRO_PLAN.sku), deps.now());
            if (plan.status !== 'free') throw new TRPCError({ code: 'CONFLICT', message: 'already_subscribed' });

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
            const session = await deps.stripe.createCheckoutSession({
                customerId,
                userId: ctx.user.id,
                sku: input.sku,
                successUrl: `${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
                cancelUrl: `${origin}/os`,
                idempotencyKey: `checkout:${ctx.user.id}:${input.sku}:${crypto.randomUUID()}`,
            });
            return { url: session.url };
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

import 'server-only';

import { db } from '@/server/db';

import { readBillingConfig, stripeMode } from './config';
import type { BillingDeps } from './ports';
import { createBillingStore } from './store';
import { createAiCreditOutboxStore } from './ai-credit-outbox-store';
import { createStripeClient } from './stripe/client';
import { createStripeUsageBilling } from './stripe/usage-billing';

let warnedStripeDisabled = false;

/**
 * The billing composition root: the one place the real database, the real
 * Stripe client and the environment meet. Routes and tRPC procedures take
 * `BillingDeps` as an argument everywhere else, so every test can pass fakes
 * and nothing below this file reads `process.env` or opens a connection.
 *
 * Built per call rather than cached: `readBillingConfig()` is a handful of
 * string comparisons, the store is a thin wrapper over the shared pool in
 * `@/server/db`, and a per-call build means a flag flipped on the hosting
 * platform takes effect on the next request without a cold start.
 */
export function getBillingDeps(): BillingDeps {
    const config = readBillingConfig();
    const mode = stripeMode(config);
    if (mode.mode === null && !warnedStripeDisabled) {
        warnedStripeDisabled = true;
        console.warn('[billing.config] stripe disabled', { reason: mode.reason });
    }
    const secretKey = mode.mode === null ? undefined : config.stripeSecret;
    return {
        config,
        store: createBillingStore(db),
        aiCredits: createAiCreditOutboxStore(db, config.fundingUrl),
        stripe: secretKey
            ? createStripeClient({ secretKey, priceProMonthly: config.stripePriceProMonthly })
            : null,
        usage: secretKey ? createStripeUsageBilling({ secretKey }) : null,
        now: () => new Date(),
    };
}

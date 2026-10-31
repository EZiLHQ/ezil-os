import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';

import { aiPackCheckoutEligible, CUSTOM_TOPUP_SKU, customTopupPack, findPack, MANAGED_PAYMENTS_TAX_CODE, PRO_PLAN } from '../catalog';
import type { StripeApi, StripeCheckoutSession, StripeInvoicePaymentState, StripePrice, StripeUpgradeResult, StripePackPrice, StripeProduct } from '../ports';
import { billingOfferByLookupKey as offerByLookupKey, billingOfferBySku as offerBySku } from '../v3/catalog';
import { readStripePacks, resetStripePackCachesForTests } from './packs';
import { CATALOG_V3 } from '../v3/contract';
import { CATALOG_V2 } from '../v2/contract';

const STRIPE_BASE_URL = 'https://api.stripe.com/v1';
/** Pin the response schema independently of the Stripe account's default version. */
export const STRIPE_API_VERSION = '2026-09-30.endive';
export const UPGRADE_PREVIEW_MAX_AGE_SECONDS = 900;
const CACHE_TTL_MS = 10 * 60 * 1000;

type CacheEntry<T> = { value: T; expiresAt: number };
const pricesByLookupKey = new Map<string, CacheEntry<StripePrice>>();
const lookupKeysByPriceId = new Map<string, CacheEntry<string | null>>();
const portalConfigurations = new Map<string, CacheEntry<string>>();

export function resetStripeCachesForTests(): void {
    resetStripePackCachesForTests();
    pricesByLookupKey.clear();
    lookupKeysByPriceId.clear();
    portalConfigurations.clear();
}

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | undefined {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry;
    cache.delete(key);
    return undefined;
}

function cacheValue<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export class BillingProviderError extends Error {
    constructor(public readonly code: 'price_not_found' | 'portal_configuration_missing' | 'preview_expired' | 'invalid_subscription_state') {
        super(code);
        this.name = 'BillingProviderError';
    }
}

type FormValue = string | number | boolean | undefined | FormValue[] | { [key: string]: FormValue };
type FormFields = { [key: string]: FormValue };
type StripeReference = string | { id: string } | null;
type Metadata = { sku?: string; kind?: string; credits?: string; ezil_credits?: string };
type Price = { id: string; product?: StripeReference; type?: string; lookup_key?: string | null; active?: boolean; unit_amount?: number | null; currency?: string; recurring?: object | null };

type ProductResponse = { id: string; active: boolean; default_price: StripeReference; metadata?: Record<string, string> };

function packPrice(price: Price): StripePackPrice {
    return { id: price.id, productId: referenceId(price.product), active: price.active === true,
        type: price.type ?? '', currency: price.currency ?? '', unitAmount: price.unit_amount ?? null };
}

function packProduct(product: ProductResponse): StripeProduct {
    return { id: product.id, active: product.active, defaultPrice: referenceId(product.default_price), metadata: product.metadata ?? {} };
}

interface SubscriptionItem {
    id?: string | null;
    price?: Price | null;
    current_period_start?: number | null;
    current_period_end?: number | null;
}

interface SubscriptionResponse {
    id: string;
    customer: StripeReference;
    status: string;
    cancel_at_period_end: boolean;
    current_period_start?: number | null;
    current_period_end?: number | null;
    items?: { data: SubscriptionItem[] };
    default_payment_method?: StripeReference;
    schedule?: StripeReference;
    latest_invoice?: string | InvoiceResponse | null;
    cancel_at?: number | null;
    pending_update?: { expires_at?: number | null } | null;
    metadata?: Metadata | null;
}

interface InvoiceLine {
    id: string;
    amount?: number;
    price?: Price | string | null;
    pricing?: { price_details?: { price?: Price | string | null } | null } | null;
    proration?: boolean;
    description?: string | null;
    type?: string;
    subscription?: StripeReference;
    parent?: {
        type?: string;
        subscription_item_details?: { subscription?: StripeReference; proration?: boolean } | null;
    } | null;
    period?: { start?: number | null; end?: number | null } | null;
}

export interface InvoiceResponse {
    id: string;
    customer: StripeReference;
    status: string;
    amount_due?: number;
    period_end?: number | null;
    next_payment_attempt?: number | null;
    currency?: string;
    billing_reason?: string | null;
    metadata?: Metadata | null;
    hosted_invoice_url?: string | null;
    subscription?: StripeReference;
    parent?: { subscription_details?: { subscription?: StripeReference } | null } | null;
    lines?: { data: InvoiceLine[] };
}

interface InvoiceSummaryResponse extends InvoiceResponse {
    number?: string | null;
    amount_paid: number;
    currency: string;
    created: number;
    hosted_invoice_url?: string | null;
    description?: string | null;
}

interface CheckoutResponse {
    id: string;
    customer?: StripeReference;
    client_reference_id?: string | null;
    mode: StripeCheckoutSession['mode'];
    status: StripeCheckoutSession['status'];
    payment_status: StripeCheckoutSession['paymentStatus'];
    payment_intent?: StripeReference;
    metadata?: Metadata | null;
    amount_total?: number | null;
    currency?: string | null;
}

interface ChargeResponse {
    id: string;
    customer?: StripeReference;
    payment_intent?: StripeReference;
    amount: number;
    amount_refunded: number;
    refunded: boolean;
}

/** Keep diagnostic fields separate from the status-only public error message. */
function scrub(text: string | null): string | null {
    if (text === null) return null;
    return text
        .replace(/authorization\s*:?\s*(bearer|basic)?\s*\S*/gi, '[redacted]')
        .replace(/\b(bearer|basic)\s+\S+/gi, '[redacted]')
        .replace(/\b(sk|rk|pk|whsec)_(test|live)?_?[A-Za-z0-9]+/g, '$1_[redacted]')
        .slice(0, 300);
}

export class StripeRequestError extends Error {
    public readonly param: string | null;
    public readonly detail: string | null;

    constructor(public status: number, public code: string | null, public type: string | null, param: string | null = null, detail: string | null = null) {
        const safeDetail = scrub(detail);
        super(`Stripe request failed (HTTP ${status})`);
        this.name = 'StripeRequestError';
        this.param = scrub(param);
        this.detail = safeDetail;
    }
}

/** Bracket notation preserves nested Stripe parameters, including indexed line items. */
function formBody(fields: FormFields): URLSearchParams {
    const body = new URLSearchParams();
    function append(key: string, value: FormValue): void {
        if (value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach((item, index) => append(`${key}[${index}]`, item));
        } else if (typeof value === 'object') {
            for (const [name, item] of Object.entries(value)) append(`${key}[${name}]`, item);
        } else {
            body.append(key, String(value));
        }
    }
    for (const [key, value] of Object.entries(fields)) append(key, value);
    return body;
}

function referenceId(value: StripeReference | undefined): string | null {
    return typeof value === 'string' ? value : value?.id ?? null;
}

function requiredCustomer(value: StripeReference): string {
    const id = referenceId(value);
    if (id === null) throw new TypeError('Stripe response is missing its customer');
    return id;
}

function date(value: number | null | undefined): Date | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    const result = new Date(value * 1000);
    return Number.isFinite(result.getTime()) ? result : null;
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function lineSubscription(line: InvoiceLine): string | null {
    return referenceId(line.subscription ?? line.parent?.subscription_item_details?.subscription);
}

export interface StripeClientOptions {
    secretKey: string;
    fetch?: typeof fetch;
    priceProMonthly?: string;
}

/** Shared transport: undefined fields mean GET, even an empty object means POST. */
export function createStripeRequest(opts: Pick<StripeClientOptions, 'secretKey' | 'fetch'>) {
    const fetcher = opts.fetch ?? globalThis.fetch;

    async function request<T>(path: string, fields?: FormFields, idempotencyKey?: string): Promise<T> {
        const headers = new Headers({
            Authorization: `Bearer ${opts.secretKey}`,
            'Stripe-Version': STRIPE_API_VERSION,
        });
        if (fields !== undefined) headers.set('Content-Type', 'application/x-www-form-urlencoded');
        if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
        const response = await fetcher(`${STRIPE_BASE_URL}${path}`, {
            method: fields === undefined ? 'GET' : 'POST',
            headers,
            body: fields === undefined ? undefined : formBody(fields),
        });
        if (!response.ok) {
            // A non-JSON upstream failure still has a useful HTTP status. Never
            // include its body, status text or request headers in the message.
            const payload: unknown = await response.json().catch(() => null);
            const error = record(record(payload).error);
            throw new StripeRequestError(
                response.status,
                typeof error.code === 'string' ? error.code : null,
                typeof error.type === 'string' ? error.type : null,
                typeof error.param === 'string' ? error.param : null,
                typeof error.message === 'string' ? error.message : null,
            );
        }
        return response.json() as Promise<T>;
    }

    return request;
}

export function createStripeClient(opts: StripeClientOptions): StripeApi {
    const request = createStripeRequest(opts);
    // A fingerprint scopes shared caches without retaining the secret in cache keys.
    const scope = createHash('sha256').update(opts.secretKey).digest('hex').slice(0, 32);

    async function listAll<T extends { id: string }>(path: string, params: Record<string, string> = {}): Promise<T[]> {
        const data: T[] = [];
        let cursor: string | undefined;
        do {
            const query = new URLSearchParams({ ...params, limit: '100', ...(cursor ? { starting_after: cursor } : {}) });
            const page = await request<{ data: T[]; has_more: boolean }>(`${path}?${query}`);
            data.push(...page.data);
            const next = page.data.at(-1)?.id;
            if (page.has_more && (!next || next === cursor)) throw new Error('Invalid Stripe pagination');
            cursor = page.has_more ? next : undefined;
        } while (cursor);
        return data;
    }

    async function resolvePrice(lookupKey: string): Promise<StripePrice> {
        const key = `${scope}:${lookupKey}`;
        const hit = cached(pricesByLookupKey, key);
        if (hit) return { ...hit.value };
        const query = new URLSearchParams({ 'lookup_keys[]': lookupKey, active: 'true', limit: '1' });
        const prices = await request<{ data?: Price[] }>(`/prices?${query}`);
        const price = prices.data?.find(item => item.lookup_key === lookupKey && item.active === true && item.id);
        if (!price) throw new BillingProviderError('price_not_found');
        const value = {
            id: price.id, lookupKey, unitAmount: price.unit_amount ?? null,
            currency: price.currency ?? 'usd', recurring: price.recurring != null,
        };
        cacheValue(pricesByLookupKey, key, value);
        cacheValue(lookupKeysByPriceId, `${scope}:${price.id}`, lookupKey);
        return { ...value };
    }

    async function resolvePortalConfiguration(): Promise<string> {
        const key = `${scope}:ezil_portal:v2`;
        const hit = cached(portalConfigurations, key);
        if (hit) return hit.value;
        const configurations = await request<{ data?: {
            id: string; active?: boolean; metadata?: { ezil_portal?: string };
            features?: { subscription_update?: { enabled?: boolean } };
        }[] }>('/billing_portal/configurations?limit=100');
        const config = configurations.data?.find(item => item.metadata?.ezil_portal === 'v2' && item.active !== false);
        if (!config?.id || config.features?.subscription_update?.enabled === true) {
            throw new BillingProviderError('portal_configuration_missing');
        }
        cacheValue(portalConfigurations, key, config.id);
        return config.id;
    }

    function planItem(subscription: SubscriptionResponse, lookupKey: string) {
        const items = subscription.items?.data ?? [];
        const item = items[0];
        if (items.length !== 1 || !item?.id || !item.price?.id || item.price.lookup_key !== lookupKey) {
            throw new BillingProviderError('invalid_subscription_state');
        }
        return { ...item, id: item.id, price: item.price };
    }

    async function latestInvoice(subscription: SubscriptionResponse): Promise<InvoiceResponse | null> {
        const invoice = subscription.latest_invoice;
        return typeof invoice === 'string'
            ? request<InvoiceResponse>(`/invoices/${encodeURIComponent(invoice)}`)
            : invoice ?? null;
    }

    async function retrieveInvoicePaymentState(invoiceId: string): Promise<StripeInvoicePaymentState> {
        const query = new URLSearchParams({ invoice: invoiceId, 'expand[]': 'data.payment.payment_intent' });
        const payments = await request<{ data?: { payment?: { payment_intent?: string | { id: string; status: string } | null } | null }[] }>(`/invoice_payments?${query}`);
        const states = new Set<StripeInvoicePaymentState>();
        for (const payment of payments.data ?? []) {
            const reference = payment.payment?.payment_intent;
            const intent = typeof reference === 'string'
                ? await request<{ status: string }>(`/payment_intents/${encodeURIComponent(reference)}`)
                : reference;
            switch (intent?.status) {
                case 'succeeded': return 'paid';
                case 'requires_action':
                case 'requires_confirmation': states.add('requires_action'); break;
                case 'processing': states.add('processing'); break;
                case 'requires_payment_method':
                case 'canceled': states.add('failed'); break;
            }
        }
        // A failed attempt must not hide another payment that needs authentication.
        return (['requires_action', 'processing', 'failed'] as const).find(state => states.has(state)) ?? 'none';
    }

    async function upgradeResult(subscription: SubscriptionResponse, invoice: InvoiceResponse | null): Promise<StripeUpgradeResult> {
        if (!invoice?.id) throw new BillingProviderError('invalid_subscription_state');
        let status: StripeUpgradeResult['status'] = 'payment_failed';
        if (invoice.status === 'paid' && !subscription.pending_update) {
            status = 'applied';
        } else if (await retrieveInvoicePaymentState(invoice.id) === 'requires_action') {
            status = 'requires_action';
        }
        return {
            status, invoiceId: invoice.id, hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
            expiresAt: date(subscription.pending_update?.expires_at),
        };
    }

    const client: StripeApi = {
        packCacheKey: scope,
        async listProducts() { return (await listAll<ProductResponse>('/products', { active: 'true' })).map(packProduct); },
        async retrieveProduct(id) { return packProduct(await request<ProductResponse>(`/products/${encodeURIComponent(id)}`)); },
        async retrievePackPrice(id) { return packPrice(await request<Price>(`/prices/${encodeURIComponent(id)}`)); },
        async retrieveCoupon(id) {
            try {
                const coupon = await request<{ id: string; valid: boolean; percent_off: number | null; amount_off: number | null }>(`/coupons/${encodeURIComponent(id)}`);
                return { id: coupon.id, valid: coupon.valid, percentOff: coupon.percent_off ?? null, amountOff: coupon.amount_off ?? null };
            } catch (error) {
                if (error instanceof StripeRequestError && error.status === 404) return null;
                throw error;
            }
        },
        async retrieveCheckoutLineItems(id) {
            return (await listAll<{ id: string; quantity: number | null; price: Price | null }>(`/checkout/sessions/${encodeURIComponent(id)}/line_items`))
                .map(line => ({ quantity: line.quantity, price: line.price ? packPrice(line.price) : null }));
        },
        resolvePrice,
        retrieveInvoicePaymentState,

        async previewRenewal(subscriptionId) {
            const invoice = await request<InvoiceResponse>('/invoices/create_preview', { subscription: subscriptionId });
            const at = date(invoice.next_payment_attempt ?? invoice.period_end);
            return at && Number.isSafeInteger(invoice.amount_due) ? { at, amountCents: Math.max(0, invoice.amount_due!) } : null;
        },

        async previewUpgrade(input) {
            const subscription = await request<SubscriptionResponse>(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`);
            const item = planItem(subscription, (input.toSku === 'premium_monthly_v3' ? CATALOG_V3.standard_monthly_v3 : CATALOG_V2.standard_monthly_v2).stripeLookupKey!);
            const periodStart = date(item.current_period_start);
            const periodEnd = date(item.current_period_end);
            if (!periodStart || !periodEnd || periodEnd <= periodStart) throw new BillingProviderError('invalid_subscription_state');
            const price = await resolvePrice(offerBySku(input.toSku)!.stripeLookupKey!);
            const invoice = await request<InvoiceResponse>('/invoices/create_preview', {
                subscription: input.subscriptionId,
                subscription_details: {
                    items: [{ id: item.id, price: price.id }],
                    proration_date: input.prorationDate,
                    proration_behavior: 'always_invoice',
                },
            });
            const allLines = invoice.lines?.data ?? [];
            const prorations = allLines.filter(line => line.parent?.subscription_item_details?.proration === true || line.proration === true);
            const lines = (prorations.length ? prorations : allLines).map(line => ({
                description: line.description ?? '',
                amountCents: Number.isSafeInteger(line.amount) ? line.amount! : 0,
            }));
            return {
                prorationDate: input.prorationDate,
                amountDueCents: Math.max(0, prorations.length ? lines.reduce((sum, line) => sum + line.amountCents, 0) : invoice.amount_due ?? 0),
                currency: invoice.currency ?? price.currency, lines, periodStart, periodEnd,
            };
        },

        async confirmUpgrade(input) {
            const nowSeconds = input.now.getTime() / 1000;
            if (!Number.isSafeInteger(input.prorationDate) || !Number.isFinite(nowSeconds)
                || nowSeconds - input.prorationDate > UPGRADE_PREVIEW_MAX_AGE_SECONDS || input.prorationDate > nowSeconds + 60) {
                throw new BillingProviderError('preview_expired');
            }
            const path = `/subscriptions/${encodeURIComponent(input.subscriptionId)}`;
            const subscription = await request<SubscriptionResponse>(path);
            const item = planItem(subscription, (input.toSku === 'premium_monthly_v3' ? CATALOG_V3.standard_monthly_v3 : CATALOG_V2.standard_monthly_v2).stripeLookupKey!);
            const price = await resolvePrice(offerBySku(input.toSku)!.stripeLookupKey!);
            let updated: SubscriptionResponse;
            try {
                updated = await request<SubscriptionResponse>(path, {
                    items: [{ id: item.id, price: price.id }],
                    payment_behavior: 'pending_if_incomplete',
                    proration_behavior: 'always_invoice',
                    proration_date: input.prorationDate,
                    'expand[]': 'latest_invoice',
                }, input.idempotencyKey);
            } catch (error) {
                if (!(error instanceof StripeRequestError) || error.status !== 402) throw error;
                updated = await request<SubscriptionResponse>(`${path}?expand[]=latest_invoice`);
                const invoice = await latestInvoice(updated);
                if (!updated.pending_update && invoice?.status !== 'open' && invoice?.status !== 'paid') throw error;
                return upgradeResult(updated, invoice);
            }
            return upgradeResult(updated, await latestInvoice(updated));
        },

        async scheduleDowngrade(input) {
            const subscription = await request<SubscriptionResponse>(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`);
            const item = planItem(subscription, (input.toSku === 'standard_monthly_v3' ? CATALOG_V3.premium_monthly_v3 : CATALOG_V2.compute_monthly_v2).stripeLookupKey!);
            if (subscription.schedule !== null) throw new BillingProviderError('invalid_subscription_state');
            const price = await resolvePrice(offerBySku(input.toSku)!.stripeLookupKey!);
            const schedule = await request<{ id: string; current_phase?: { start_date: number; end_date: number } | null }>(
                '/subscription_schedules', { from_subscription: input.subscriptionId }, `${input.idempotencyKey}:create`,
            );
            const phase = schedule.current_phase;
            const effectiveAt = date(phase?.end_date);
            if (!phase || !date(phase.start_date) || !effectiveAt || phase.end_date <= phase.start_date) {
                throw new BillingProviderError('invalid_subscription_state');
            }
            await request(`/subscription_schedules/${encodeURIComponent(schedule.id)}`, {
                end_behavior: 'release',
                metadata: { ezil_change: 'downgrade', to_sku: input.toSku },
                phases: [
                    { start_date: phase.start_date, end_date: phase.end_date, items: [{ price: item.price.id, quantity: 1 }] },
                    { items: [{ price: price.id, quantity: 1 }], proration_behavior: 'none', duration: { interval: 'month', interval_count: 1 } },
                ],
            }, `${input.idempotencyKey}:phases`);
            return { scheduleId: schedule.id, effectiveAt };
        },

        async cancelScheduledChange(input) {
            await request(`/subscription_schedules/${encodeURIComponent(input.scheduleId)}/release`, {});
        },

        async setCancelAtPeriodEnd(input) {
            const path = `/subscriptions/${encodeURIComponent(input.subscriptionId)}`;
            const subscription = await request<SubscriptionResponse>(path, {
                cancel_at_period_end: input.cancel,
            }, input.idempotencyKey);
            if (input.cancel) return { cancelsAt: date(subscription.cancel_at) ?? date(subscription.items?.data[0]?.current_period_end) };
            // Round 6 review (R4-04): retrieveSubscription reads a dated cancel (`cancel_at`, e.g. the Dashboard's
            // custom date) as a cancel at period end, so Billing offers Resume. Its flag is already false, so when
            // the answer still carries a cancel_at it is unset explicitly (Stripe's empty-string unset); a resume
            // that leaves one is refused, never reported as resumed.
            if (typeof subscription.cancel_at !== 'number') return { cancelsAt: null };
            const cleared = await request<SubscriptionResponse>(path, { cancel_at: '' }, `${input.idempotencyKey}:cancel_at`);
            if (typeof cleared.cancel_at === 'number') throw new BillingProviderError('invalid_subscription_state');
            return { cancelsAt: null };
        },

        async createCustomer(input) {
            const customer = await request<{ id: string }>('/customers', {
                // Informational only: ownership is resolved through the local customer table.
                metadata: { user_id: input.userId },
                email: input.email ?? undefined,
            }, input.idempotencyKey);
            return { id: customer.id };
        },

        async createCheckoutSession(input) {
            const stripePack = input.sku.startsWith('ai_pack_') && !findPack(input.sku)
                ? (await readStripePacks(client)).find(pack => pack.sku === input.sku) : undefined;
            const pack = input.sku === CUSTOM_TOPUP_SKU ? customTopupPack(input.customAmountCents ?? NaN)
                : stripePack ?? findPack(input.sku);
            // Refuse purchases we cannot fund, before price lookup or any Stripe request.
            if (pack !== undefined && !aiPackCheckoutEligible(pack)) {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'pack_credits_unset' });
            }
            const offer = offerBySku(input.sku);
            const lookupKey = offer?.sellable ? offer.stripeLookupKey : null;
            if (input.sku !== PRO_PLAN.sku && !lookupKey && pack === undefined) throw new Error('Unknown billing SKU');

            const metadata = { sku: input.sku,
                ...(input.sku === CUSTOM_TOPUP_SKU ? { credits: String(pack!.aiCredits) }
                    : stripePack ? { ezil_credits: String(stripePack.aiCredits) } : {}) };
            const fields: FormFields = {
                customer: input.customerId,
                client_reference_id: input.userId,
                metadata,
                // As merchant of record, Stripe controls tax, currency and
                // payment methods and rejects the corresponding seller fields.
                ...(input.managedPayments ? {
                    managed_payments: { enabled: true },
                } : {
                    // Stripe Tax adds address collection but collects only where
                    // EZiL LLC is registered: opt in after registration (§7).
                    ...(input.automaticTax ? {
                        automatic_tax: { enabled: true },
                        customer_update: { address: 'auto', name: 'auto' },
                    } : {}),
                    // Keep the USD summary and checkout aligned unless opted in.
                    adaptive_pricing: { enabled: input.adaptivePricing ? 'true' : 'false' },
                }),
                billing_address_collection: 'auto',
                saved_payment_method_options: { payment_method_save: 'enabled' },
                ...(input.uiMode === 'embedded' ? {
                    // `embedded_page` since Stripe's 2026-03-25 enum rename; the
                    // pinned API version rejects the old `embedded` value.
                    ui_mode: 'embedded_page',
                    return_url: input.returnUrl,
                    redirect_on_completion: 'if_required',
                } : {
                    success_url: input.successUrl,
                    cancel_url: input.cancelUrl,
                }),
            };
            if (lookupKey) {
                const price = await resolvePrice(lookupKey);
                fields.mode = 'subscription';
                fields.line_items = [{ quantity: 1, price: price.id }];
                fields.subscription_data = { metadata: { sku: input.sku, ezil_catalog: input.sku.endsWith('_v3') ? 'v3' : 'v2' } };
            } else if (input.sku === PRO_PLAN.sku) {
                fields.mode = 'subscription';
                fields.line_items = [{
                    quantity: 1,
                    ...(opts.priceProMonthly !== undefined ? { price: opts.priceProMonthly } : {
                        price_data: {
                            currency: PRO_PLAN.currency,
                            unit_amount: PRO_PLAN.unitAmountCents,
                            recurring: { interval: PRO_PLAN.interval },
                            tax_behavior: 'exclusive',
                            product_data: {
                                name: 'EZiL Pro',
                                ...(input.managedPayments ? { tax_code: MANAGED_PAYMENTS_TAX_CODE } : {}),
                            },
                        },
                    }),
                }];
                fields.subscription_data = { metadata: { sku: PRO_PLAN.sku } };
            } else if (pack !== undefined) {
                fields.mode = 'payment';
                if (stripePack?.couponId) fields.discounts = [{ coupon: stripePack.couponId }];
                fields.line_items = stripePack ? [{ price: stripePack.priceId, quantity: 1 }] : (pack.serviceFeeCents ? [
                    { name: 'AI credits', amount: pack.creditCents },
                    { name: 'Service fee', amount: pack.serviceFeeCents },
                ] : [{ name: 'AI credits', amount: pack.totalCents }]).map(item => ({
                    quantity: 1,
                    price_data: {
                        currency: 'usd',
                        unit_amount: item.amount,
                        tax_behavior: pack.serviceFeeCents ? 'exclusive' : 'inclusive',
                        product_data: {
                            name: item.name,
                            ...(input.managedPayments ? { tax_code: MANAGED_PAYMENTS_TAX_CODE } : {}),
                        },
                    },
                }));
                fields.payment_intent_data = { metadata };
            }
            const session = await request<{ id: string; url?: string | null; client_secret?: string | null }>(
                '/checkout/sessions', fields, input.idempotencyKey,
            );
            return { id: session.id, url: session.url ?? null, clientSecret: session.client_secret ?? null };
        },

        async listCustomerSubscriptions(customerId) {
            // `status=all`: the default list omits canceled ones only; the caller decides which statuses block.
            return (await listAll<{ id: string; status: string }>('/subscriptions', { customer: customerId, status: 'all' }))
                .map(subscription => ({ id: subscription.id, status: subscription.status }));
        },

        async listOpenCheckoutSessions(customerId) {
            return (await listAll<{ id: string; mode: string }>('/checkout/sessions', { customer: customerId, status: 'open' }))
                .map(session => ({ id: session.id, mode: session.mode }));
        },

        async expireCheckoutSession(id) {
            // An empty form makes this a POST (undefined fields mean GET).
            await request(`/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
        },

        async listInvoices(customerId, limit) {
            const query = new URLSearchParams({ customer: customerId, limit: String(limit) });
            const invoices = await request<{ data: InvoiceSummaryResponse[] }>(`/invoices?${query}`);
            return invoices.data.map(invoice => ({
                id: invoice.id,
                number: invoice.number ?? null,
                status: invoice.status,
                amountPaidCents: invoice.amount_paid,
                amountDueCents: invoice.amount_due ?? 0,
                metadataKind: invoice.metadata?.kind ?? null,
                billingReason: invoice.billing_reason ?? null,
                currency: invoice.currency,
                created: new Date(invoice.created * 1000),
                hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
                description: invoice.description ?? invoice.lines?.data[0]?.description ?? null,
            }));
        },

        async createPortalSession(input) {
            // The portal port has no retry key: each call creates a new short-lived session.
            const session = await request<{ url: string }>('/billing_portal/sessions', {
                customer: input.customerId,
                return_url: input.returnUrl,
                configuration: await resolvePortalConfiguration(),
            });
            return { url: session.url };
        },

        async retrieveSubscription(id) {
            const subscription = await request<SubscriptionResponse>(`/subscriptions/${encodeURIComponent(id)}`);
            const data = subscription.items?.data ?? [];
            const items = data.map(item => ({ id: item.id ?? null, priceId: referenceId(item.price), lookupKey: item.price?.lookup_key ?? null }));
            const metadataSku = subscription.metadata?.sku;
            const itemOffer = items.map(item => item.lookupKey ? offerByLookupKey(item.lookupKey) : undefined).find(Boolean);
            // Pending upgrades change the item Price without changing checkout metadata.
            // A v3 entitlement always requires its recognized line lookup key.
            const sku = itemOffer?.sku ?? (metadataSku && !metadataSku.endsWith('_v3') && offerBySku(metadataSku) ? metadataSku : null);
            const offer = sku ? offerBySku(sku) : undefined;
            const item = data.find(item => offer?.stripeLookupKey != null && item.price?.lookup_key === offer.stripeLookupKey) ?? data[0];
            const periodEnd = item?.current_period_end ?? subscription.current_period_end;
            // Round 6 (R4-04): a cancel scheduled as a date (`cancel_at`, e.g. the Dashboard's custom date) at or
            // before the period end ends the plan, so it is a cancel at period end (plan_ending), not a renewal.
            // A cancel_at earlier than the period end still shows the period end as the end date (no stored column;
            // a known gap until a later migration stores the dated cancel). Resume unsets it (setCancelAtPeriodEnd).
            const datedCancel = typeof subscription.cancel_at === 'number' && typeof periodEnd === 'number' && subscription.cancel_at <= periodEnd;
            return {
                id: subscription.id,
                customer: requiredCustomer(subscription.customer),
                status: subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end || datedCancel,
                currentPeriodStart: date(item?.current_period_start ?? subscription.current_period_start),
                currentPeriodEnd: date(periodEnd),
                sku,
                items,
                pendingUpdateExpiresAt: date(subscription.pending_update?.expires_at),
                defaultPaymentMethod: referenceId(subscription.default_payment_method),
                scheduleId: referenceId(subscription.schedule),
                latestInvoiceId: referenceId(subscription.latest_invoice),
            };
        },

        async retrieveInvoice(id) {
            const invoice = await request<InvoiceResponse>(`/invoices/${encodeURIComponent(id)}`);
            const subscriptionId = referenceId(invoice.subscription ?? invoice.parent?.subscription_details?.subscription);
            const lines = invoice.lines?.data ?? [];
            const priceFor = (line: InvoiceLine) => line.pricing?.price_details?.price ?? line.price;
            // Expanded keys need no request; reuse the account-scoped Price cache across requests.
            const lookupKeys = new Map<string, string | null>();
            for (const line of lines) {
                const price = priceFor(line);
                if (price && typeof price === 'object' && (typeof price.lookup_key === 'string' || price.lookup_key === null)) {
                    lookupKeys.set(price.id, price.lookup_key);
                }
            }
            const priceIds = new Set(lines.map(line => referenceId(priceFor(line))).filter((id): id is string => id !== null));
            await Promise.all([...priceIds].filter(id => !lookupKeys.has(id)).map(async id => {
                const key = `${scope}:${id}`;
                const hit = cached(lookupKeysByPriceId, key);
                if (hit) {
                    lookupKeys.set(id, hit.value);
                    return;
                }
                const price = await request<Price>(`/prices/${encodeURIComponent(id)}`);
                lookupKeys.set(id, price.lookup_key ?? null);
                cacheValue(lookupKeysByPriceId, key, price.lookup_key ?? null);
            }));
            // An invoice can start with a fee or adjustment. Only its subscription
            // line describes the entitlement window, never invoice.period_start/end.
            const line = subscriptionId === null ? undefined : (
                lines.find(item => lineSubscription(item) === subscriptionId)
                ?? lines.find(item => lineSubscription(item) === null && (
                    item.type === 'subscription' || item.parent?.type === 'subscription_item_details'
                ))
            );
            return {
                id: invoice.id,
                customer: requiredCustomer(invoice.customer),
                status: invoice.status,
                subscriptionId,
                billingReason: invoice.billing_reason ?? null,
                metadataKind: invoice.metadata?.kind ?? null,
                hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
                lines: lines.map(item => ({
                    id: item.id,
                    lookupKey: lookupKeys.get(referenceId(priceFor(item)) ?? '') ?? null,
                    subscriptionId: lineSubscription(item),
                    proration: (item.parent?.subscription_item_details?.proration ?? item.proration) === true,
                    amount: typeof item.amount === 'number' && Number.isSafeInteger(item.amount) ? item.amount : 0,
                    periodStart: date(item.period?.start),
                    periodEnd: date(item.period?.end),
                })),
                periodStart: date(line?.period?.start),
                periodEnd: date(line?.period?.end),
            };
        },

        async retrieveCheckoutSession(id) {
            const session = await request<CheckoutResponse>(`/checkout/sessions/${encodeURIComponent(id)}`);
            return {
                id: session.id,
                customer: referenceId(session.customer),
                clientReferenceId: session.client_reference_id ?? null,
                mode: session.mode,
                status: session.status,
                paymentStatus: session.payment_status,
                paymentIntentId: referenceId(session.payment_intent),
                sku: session.metadata?.sku ?? null,
                amountTotal: session.amount_total ?? null,
                currency: session.currency ?? null,
                metadataCredits: session.metadata?.sku === CUSTOM_TOPUP_SKU ? session.metadata?.credits ?? null : session.metadata?.ezil_credits ?? null,
            };
        },

        async retrieveCharge(id) {
            const charge = await request<ChargeResponse>(`/charges/${encodeURIComponent(id)}`);
            const paymentIntentId = referenceId(charge.payment_intent);
            // From API version 2025-03-31 a charge no longer names its invoice;
            // the Invoice Payments API maps the payment back to it. Without
            // this a refund of a subscription charge could not find the
            // period grant it has to revoke.
            let invoiceId: string | null = null;
            if (paymentIntentId !== null) {
                const query = `payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(paymentIntentId)}&limit=1`;
                const payments = await request<{ data?: Array<{ invoice?: unknown }> }>(`/invoice_payments?${query}`);
                invoiceId = referenceId(payments.data?.[0]?.invoice as StripeReference | undefined);
            }
            return {
                id: charge.id,
                customer: referenceId(charge.customer),
                invoiceId,
                paymentIntentId,
                amount: charge.amount,
                amountRefunded: charge.amount_refunded,
                refunded: charge.refunded,
            };
        },
    };
    return client;
}

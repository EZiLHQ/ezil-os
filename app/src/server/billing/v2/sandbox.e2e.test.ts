/**
 * Opt-in, REAL Stripe-signed deliveries forwarded by the lead's stripe-listen wrapper.
 * No event fabrication, signing, application env loading, or production deps import.
 * The disposable database must already have the billing v2 migrations installed.
 * Stripe's catalog and the v2 portal configuration must already exist in the sandbox.
 * Embedded Checkout is exercised only with the optional test publishable key.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, it, vi, type TestContext } from 'vitest';

import type { createTRPCContext } from '@/server/api/trpc';
import * as schema from '@/server/db/schema';
import {
    billingGrants, billingOverageConsents, billingOverageInvoices,
    billingPaymentIssues, billingPlanChanges, billingEvents,
} from '@/server/db/schema/billing';
import { computers } from '@/server/db/schema/computers';
import { readBillingConfig } from '../config';
import { handleStripeWebhook } from '../http/stripe-webhook';
import type { BillingDeps, BillingStore } from '../ports';
import { processStripeEvent } from '../processor';
import { createBillingStore } from '../store';
import { createStripeClient } from '../stripe/client';
import { createStripeUsageBilling } from '../stripe/usage-billing';
import { closePeriodAndInvoiceOverage } from './close-period';
import { CATALOG_V2, OVERAGE_PRICE_LOOKUP_KEY, OVERAGE_TERMS_VERSION, type SellableSku } from './contract';
import { upgradeGrantStdSeconds } from './rating';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({
    getBillingDeps: () => { throw new Error('Tests must inject billing ports'); },
}));

import { createBillingRouter } from '@/server/api/routers/billing';

const TEST_TIMEOUT = 15 * 60_000;
const HOOK_TIMEOUT = 5 * 60_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT, hookTimeout: HOOK_TIMEOUT, maxConcurrency: 4 });

// Read ONLY the wrapper's test inputs. In particular, never pass process.env to readBillingConfig.
const secretKey = process.env.STRIPE_E2E_SECRET ?? '';
const databaseUrl = process.env.BILLING_TEST_DATABASE_URL ?? '';
const webhookSecret = process.env.STRIPE_E2E_WEBHOOK_SECRET ?? '';
const forwardPort = process.env.STRIPE_E2E_FORWARD_PORT ?? '';
const publishableKey = process.env.STRIPE_E2E_PUBLISHABLE;
const extraReportPath = process.env.STRIPE_E2E_REPORT;
const enabled = process.env.STRIPE_E2E === '1' && /^(sk|rk)_test_/.test(secretKey)
    && Boolean(databaseUrl && webhookSecret && forwardPort);
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date().toISOString();
const reportPath = path.join(os.tmpdir(), 'ezil-billing-v2-sandbox-report.json');
const receiverUrl = `http://127.0.0.1:${forwardPort}/`;
const HOUR = 3600;
const STANDARD = 'standard_monthly_v2';
const COMPUTE = 'compute_monthly_v2';

type JsonObject = Record<string, unknown>;
type StripeObject = JsonObject & { id: string };
type Clock = { id: string; frozen_time: number; status: string };
type StripeList<T> = { data: T[]; has_more: boolean };
type Invoice = StripeObject & { status: string; amount_paid: number; total: number; metadata?: { kind?: string } };
type Subscription = StripeObject & { latest_invoice: string | Invoice | null };
type Tenant = { userId: string; customerId: string };
type Subscriber = Tenant & { subscriptionId: string; invoiceId: string; start: Date; end: Date };
type Snapshot = Awaited<ReturnType<typeof snapshotUsers>>;
type Capture = {
    id: string; type: string; objectId: string | null; rawBody: Buffer; signature: string | null;
    httpStatus: number; body: JsonObject;
};
type Scenario = {
    n: number; name: string; status: 'pending' | 'running' | 'passed' | 'failed'; error: string | null;
    clock: Clock | null; users: string[]; captures: Capture[]; db: Snapshot;
    controller: AbortController;
    stripe: {
        clock: string | null; customers: string[]; subscriptions: string[]; invoices: string[]; refunds: string[];
        paymentIntents: string[]; charges: string[]; checkoutSessions: string[];
    };
};

let pool: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let store: BillingStore;
let stripe: ReturnType<typeof createStripeClient>;
let usage: ReturnType<typeof createStripeUsageBilling>;
let webhookDeps: BillingDeps;
let server: ReturnType<typeof createServer> | undefined;
const prices = new Map<SellableSku, string>();
const scenarios: Scenario[] = [];
const knownIds = new Map<string, Scenario>();
const activeScenario = new AsyncLocalStorage<Scenario>();
const receiverTasks = new Set<Promise<void>>();
let reportWrites = Promise.resolve();

function object(value: unknown): JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
function idOf(value: unknown): string | null {
    return typeof value === 'string' ? value : typeof object(value).id === 'string' ? object(value).id as string : null;
}
function requiredId(value: unknown): string {
    const id = idOf(value);
    if (!id) throw new Error('Stripe response is missing an object ID');
    return id;
}
function safeError(error: unknown): string {
    let text = error instanceof Error ? error.message : 'Unknown failure';
    // Database errors and assertion messages may include values. Do not persist URLs or any secrets.
    for (const secret of [secretKey, webhookSecret, publishableKey, databaseUrl]) {
        if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redacted]')
        .replace(/\b(?:pi|seti|cs)_[A-Za-z0-9_]*_secret_[A-Za-z0-9_]+/g, '[redacted]')
        .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/g, '[url]')
        .replace(/[\r\n\t]/g, ' ').slice(0, 300);
}
function failScenario(s: Scenario, error: unknown): void {
    s.status = 'failed';
    s.error = [s.error, safeError(error)].filter(Boolean).join('; ').slice(0, 300);
}
function emptySnapshot() {
    return { grants: [], planChanges: [], paymentIssues: [], overageInvoices: [], consents: [] };
}

/** Learn references only from our setup responses or a relevant delivery, never from sandbox-wide lists. */
function learn(s: Scenario, value: unknown): void {
    if (typeof value === 'string') {
        const prefix = /^(cus|sub|in|pi|ch|re)_[A-Za-z0-9]+$/.exec(value)?.[1];
        if (!prefix) return;
        const previous = knownIds.get(value);
        if (previous && previous !== s) throw new Error('Stripe object crossed scenario boundaries');
        knownIds.set(value, s);
        const key = { cus: 'customers', sub: 'subscriptions', in: 'invoices', pi: 'paymentIntents', ch: 'charges', re: 'refunds' }[prefix] as
            'customers' | 'subscriptions' | 'invoices' | 'paymentIntents' | 'charges' | 'refunds';
        if (!s.stripe[key].includes(value)) s.stripe[key].push(value);
    } else if (Array.isArray(value)) {
        value.forEach(item => learn(s, item));
    } else if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(item => learn(s, item));
    }
}

class StripeSetupError extends Error {
    constructor(readonly status: number, code: unknown) {
        super(`Stripe HTTP ${status}; code=${typeof code === 'string' && /^[a-z0-9_]+$/.test(code) ? code : 'unknown'}`);
    }
}

/** Setup / inspection only; billing effects still use the unmodified product ports. */
async function stripeRequest<T = StripeObject>(method: 'GET' | 'POST' | 'DELETE', endpoint: string,
    fields?: Record<string, string>, owner = activeScenario.getStore()): Promise<T> {
    owner?.controller.signal.throwIfAborted();
    const response = await fetch(`https://api.stripe.com/v1${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2026-09-30.endive',
            'Content-Type': 'application/x-www-form-urlencoded' },
        body: fields ? new URLSearchParams(fields) : undefined,
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(owner ? [owner.controller.signal] : [])]),
    });
    if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        throw new StripeSetupError(response.status, object(object(payload).error).code);
    }
    const result = await response.json() as T;
    if (owner) learn(owner, result);
    return result;
}

class WaitTimeout extends Error {}
/** False/null/undefined means not ready; errors (including clock internal_failure) fail immediately. */
async function waitFor<T>(fn: () => Promise<T | false | null | undefined>,
    { timeoutMs = 120_000, label }: { timeoutMs?: number; label: string }): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const signal = activeScenario.getStore()?.controller.signal;
    while (true) {
        signal?.throwIfAborted();
        const value = await fn();
        if (value !== false && value !== null && value !== undefined) return value;
        if (Date.now() >= deadline) throw new WaitTimeout(`Timed out waiting for ${label}`);
        await delay(Math.min(1000, deadline - Date.now()), undefined, { signal });
    }
}

function billingConfig(key?: string) {
    return readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: secretKey,
        STRIPE_WEBHOOK_SECRET: webhookSecret, STRIPE_PUBLISHABLE_KEY: key });
}
function callerFor(s: Scenario, user: Tenant, key?: string) {
    const routerDeps: BillingDeps = { config: billingConfig(key), store, stripe, usage,
        now: () => new Date(s.clock!.frozen_time * 1000) };
    const ctx: Awaited<ReturnType<typeof createTRPCContext>> = {
        db,
        headers: new Headers({ origin: 'https://os.ezil.org' }),
        user: { id: user.userId, email: 'sandbox@example.org', aud: 'authenticated', app_metadata: {},
            user_metadata: {}, created_at: new Date(s.clock!.frozen_time * 1000).toISOString() },
    };
    return createBillingRouter(() => routerDeps).createCaller(ctx);
}

/** Exact bytes and Stripe's original header, including on retries. The suite never signs. */
async function deliver(capture: Capture): Promise<Response> {
    return handleStripeWebhook(new Request(receiverUrl, {
        method: 'POST', body: new Uint8Array(capture.rawBody),
        headers: capture.signature ? { 'stripe-signature': capture.signature } : {},
    }), webhookDeps, processStripeEvent);
}
async function replayCapture(capture: Capture, body = capture.rawBody, signature = capture.signature): Promise<Response> {
    return fetch(receiverUrl, { method: 'POST', body: new Uint8Array(body),
        headers: signature ? { 'stripe-signature': signature } : {}, signal: AbortSignal.timeout(30_000) });
}
function respond(res: ServerResponse, status: number, body: JsonObject): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/') { respond(res, 404, { ignored: true }); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    let envelope: JsonObject;
    try { envelope = object(JSON.parse(rawBody.toString('utf8'))); }
    catch { respond(res, 200, { ignored: true }); return; }
    const value = object(object(envelope.data).object);
    const s = ['customer', 'id', 'charge', 'payment_intent', 'invoice', 'subscription']
        .map(key => knownIds.get(idOf(value[key]) ?? '')).find(Boolean);
    if (!s) { respond(res, 200, { ignored: true }); return; }
    const header = req.headers['stripe-signature'];
    const capture: Capture = {
        id: typeof envelope.id === 'string' ? envelope.id : 'invalid',
        type: typeof envelope.type === 'string' ? envelope.type : 'invalid', objectId: idOf(value),
        rawBody, signature: Array.isArray(header) ? header.join(',') : header ?? null, httpStatus: 0, body: {},
    };
    s.captures.push(capture);
    // Learn only after verification, so the intentional bad-signature tests cannot expand our scope.
    for (let attempt = 0; attempt <= 5; attempt++) {
        const response = await deliver(capture);
        capture.httpStatus = response.status;
        capture.body = object(await response.json());
        if (response.status >= 200 && response.status < 300) learn(s, value);
        if (response.status < 500 || attempt === 5) break;
        await delay(3000); // Delivery retry backoff, not a state wait.
    }
    respond(res, capture.httpStatus, capture.body);
}

async function snapshotUsers(users: string[]) {
    if (!users.length || !db) return emptySnapshot();
    const [grants, planChanges, paymentIssues, overageInvoices, consents] = await Promise.all([
        db.select().from(billingGrants).where(inArray(billingGrants.userId, users)).orderBy(billingGrants.id),
        db.select().from(billingPlanChanges).where(inArray(billingPlanChanges.userId, users)).orderBy(billingPlanChanges.id),
        db.select().from(billingPaymentIssues).where(inArray(billingPaymentIssues.userId, users)).orderBy(billingPaymentIssues.stripeInvoiceId),
        db.select().from(billingOverageInvoices).where(inArray(billingOverageInvoices.userId, users)).orderBy(billingOverageInvoices.id),
        db.select().from(billingOverageConsents).where(inArray(billingOverageConsents.userId, users)).orderBy(billingOverageConsents.id),
    ]);
    return { grants, planChanges: planChanges.map(({ hostedInvoiceUrl: _url, ...row }) => row),
        paymentIssues: paymentIssues.map(({ hostedInvoiceUrl: _url, ...row }) => row), overageInvoices, consents };
}
async function collectSnapshot(s: Scenario): Promise<void> {
    try { s.db = await snapshotUsers(s.users); }
    catch (error) { failScenario(s, new Error(`Report snapshot failed: ${safeError(error)}`)); }
}
function writeReport(finishedAt: string | null = null): Promise<void> {
    // Serialize writes so concurrent scenarios cannot replace a newer report with an older snapshot.
    const work = reportWrites.catch(() => {}).then(async () => {
        const json = JSON.stringify({ runId, startedAt, finishedAt, scenarios: scenarios.map(s => ({
            n: s.n, name: s.name, status: s.status, error: s.error, stripe: s.stripe,
            events: s.captures.map(({ id, type, httpStatus }) => ({ id, type, httpStatus })), db: s.db,
        })) }, (key, value: unknown) => {
            if (/url|secret|signature|rawBody/i.test(key)) return undefined;
            return typeof value === 'bigint' ? value.toString() : value;
        }, 2);
        for (const destination of new Set([reportPath, ...(extraReportPath ? [extraReportPath] : [])])) {
            const temporary = `${destination}.${runId}.tmp`;
            await writeFile(temporary, json, { mode: 0o600 });
            await rename(temporary, destination);
        }
    });
    reportWrites = work;
    return work;
}

async function createClock(s: Scenario): Promise<void> {
    s.clock = await stripeRequest<Clock>('POST', '/test_helpers/test_clocks', {
        frozen_time: String(Math.floor(Date.now() / 1000)), name: `ezil-e2e-${runId}-s${s.n}`,
    });
    s.stripe.clock = s.clock.id;
}
async function advanceClock(s: Scenario, frozenTime: number): Promise<void> {
    await stripeRequest('POST', `/test_helpers/test_clocks/${s.clock!.id}/advance`, { frozen_time: String(frozenTime) });
    s.clock = await waitFor(async () => {
        const clock = await stripeRequest<Clock>('GET', `/test_helpers/test_clocks/${s.clock!.id}`);
        if (clock.status === 'internal_failure') throw new Error('Stripe test clock internal_failure');
        return clock.status === 'ready' && clock.frozen_time === frozenTime ? clock : null;
    }, { timeoutMs: 10 * 60_000, label: 'Stripe test clock ready' });
}
async function createTenant(s: Scenario, metadataUserId?: string): Promise<Tenant> {
    const userId = randomUUID();
    await pool`insert into auth.users (id, created_at) values
        (${userId}::uuid, ${new Date(s.clock!.frozen_time * 1000).toISOString()}::timestamptz)`;
    s.users.push(userId);
    const customer = await stripeRequest('POST', '/customers', {
        test_clock: s.clock!.id, 'metadata[ezil_e2e]': 'os-billing-v2', 'metadata[ezil_run]': runId,
        'metadata[user_id]': metadataUserId ?? userId,
    });
    if (await store.linkCustomer(userId, customer.id) !== 'linked') throw new Error('Could not link scenario customer');
    return { userId, customerId: customer.id };
}
async function setPaymentMethod(user: Tenant, token: 'visa' | 'declined' | '3ds'): Promise<string> {
    const tokens = token === 'declined' ? ['pm_card_chargeCustomerFail', 'pm_card_visa_chargeDeclined']
        : [token === 'visa' ? 'pm_card_visa' : 'pm_card_authenticationRequired'];
    let paymentMethod: StripeObject | undefined;
    for (const [index, candidate] of tokens.entries()) {
        try {
            paymentMethod = await stripeRequest('POST', `/payment_methods/${candidate}/attach`, { customer: user.customerId });
            break;
        } catch (error) {
            if (!(error instanceof StripeSetupError) || ![400, 402, 404].includes(error.status) || index === tokens.length - 1) throw error;
        }
    }
    if (!paymentMethod) throw new Error('No test payment method attached');
    await stripeRequest('POST', `/customers/${user.customerId}`, { 'invoice_settings[default_payment_method]': paymentMethod.id });
    return paymentMethod.id;
}
async function subscribe(s: Scenario, user: Tenant, sku: SellableSku = STANDARD,
    payment: 'visa' | 'declined' | '3ds' = 'visa'): Promise<Subscriber> {
    await setPaymentMethod(user, payment);
    let subscription: Subscription;
    try {
        subscription = await stripeRequest<Subscription>('POST', '/subscriptions', {
            customer: user.customerId, 'items[0][price]': prices.get(sku)!, payment_behavior: 'allow_incomplete',
            'metadata[sku]': sku, 'metadata[ezil_catalog]': 'v2', 'expand[]': 'latest_invoice',
        });
    } catch (error) {
        if (!(error instanceof StripeSetupError) || error.status !== 402) throw error;
        const list = await stripeRequest<StripeList<Subscription>>('GET', `/subscriptions?customer=${user.customerId}&status=all&limit=100`);
        if (list.data.length !== 1) throw new Error('Expected one subscription after HTTP 402');
        subscription = list.data[0];
    }
    learn(s, subscription);
    const current = await stripe.retrieveSubscription(subscription.id);
    learn(s, current);
    if (!current.currentPeriodStart || !current.currentPeriodEnd) throw new Error('Subscription has no billing period');
    const invoiceId = requiredId(subscription.latest_invoice ?? current.latestInvoiceId);
    learn(s, invoiceId);
    return { ...user, subscriptionId: subscription.id, invoiceId, start: current.currentPeriodStart, end: current.currentPeriodEnd };
}
async function grantsFor(user: Tenant) {
    return db.select().from(billingGrants).where(eq(billingGrants.userId, user.userId)).orderBy(billingGrants.id);
}
async function planChangesFor(user: Tenant) {
    const rows = await db.select().from(billingPlanChanges).where(eq(billingPlanChanges.userId, user.userId));
    return rows.map(({ hostedInvoiceUrl: _url, ...row }) => row);
}
async function subscriptionRow(user: Subscriber) {
    return (await store.subscriptionsFor(user.userId)).find(row => row.stripeSubscriptionId === user.subscriptionId);
}
async function waitForGrant(user: Subscriber, invoiceId = user.invoiceId) {
    return waitFor(async () => {
        const rows = (await grantsFor(user)).filter(row => row.subscriptionId === user.subscriptionId
            && row.sourceType === 'invoice' && row.sourceId === invoiceId);
        return rows.length ? rows : null;
    }, { label: 'invoice grant in database' });
}
async function waitForDelivery(s: Scenario, type: string, objectId: string) {
    return waitFor(async () => s.captures.find(c => c.type === type && c.objectId === objectId && c.httpStatus === 200),
        { label: `${type} delivery` });
}
async function paidSubscriber(s: Scenario, expect: TestContext['expect'], sku: SellableSku = STANDARD, user?: Tenant) {
    const subscription = await subscribe(s, user ?? await createTenant(s), sku);
    const grants = await waitForGrant(subscription);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ userId: subscription.userId, subscriptionId: subscription.subscriptionId,
        meter: 'compute_std_seconds', kind: 'plan_period', amount: BigInt(CATALOG_V2[sku].allowanceStdSeconds) });
    await waitFor(async () => (await subscriptionRow(subscription))?.status === 'active', { label: 'active subscription in database' });
    return subscription;
}
async function renew(s: Scenario, user: Subscriber): Promise<string> {
    await advanceClock(s, user.end.getTime() / 1000 + 2 * HOUR);
    await waitFor(async () => {
        const row = await subscriptionRow(user);
        return row?.currentPeriodStart && row.currentPeriodStart >= user.end;
    }, { label: 'renewed subscription period in database' });
    const current = await stripe.retrieveSubscription(user.subscriptionId);
    learn(s, current);
    if (!current.latestInvoiceId || current.latestInvoiceId === user.invoiceId) throw new Error('No new renewal invoice');
    return current.latestInvoiceId;
}
async function payInvoice(invoiceId: string, allowDecline = false): Promise<void> {
    try { await stripeRequest('POST', `/invoices/${invoiceId}/pay`, {}); }
    catch (error) {
        if (allowDecline && error instanceof StripeSetupError && error.status === 402) return;
        // A concurrent automatic payment can win the race with /pay.
        const current = await stripeRequest<Invoice>('GET', `/invoices/${invoiceId}`);
        if (current.status !== 'paid') throw error;
    }
}
async function invoicePaymentIntent(invoiceId: string): Promise<string> {
    const payments = await stripeRequest<StripeList<JsonObject>>('GET', `/invoice_payments?invoice=${invoiceId}&limit=100`);
    const payment = payments.data.find(row => idOf(object(row.payment).payment_intent));
    const intentId = requiredId(object(payment?.payment).payment_intent);
    await stripeRequest('GET', `/payment_intents/${intentId}`); // Learn the charge as well, before refund events arrive.
    return intentId;
}
async function seedOverage(s: Scenario, expect: TestContext['expect']) {
    const user = await paidSubscriber(s, expect, COMPUTE);
    const caller = callerFor(s, user);
    expect(await caller.setOverage({ enabled: true, capCents: 2500, termsVersion: OVERAGE_TERMS_VERSION }))
        .toMatchObject({ enabled: true, capCents: 2500 });
    const computerId = randomUUID();
    await db.insert(computers).values({ id: computerId, userId: user.userId, slot: 1 });
    const first = user.start.getTime() + HOUR * 1000;
    // 25 * 6h * weight 4 = 600 standard hours; 100 hours over the Compute allowance = 2500 cents.
    expect(first + 25 * 6 * HOUR * 1000).toBeLessThan(user.end.getTime());
    for (let index = 0; index < 25; index++) {
        const readyAt = new Date(first + index * 6 * HOUR * 1000);
        expect((await store.openEpoch({ userId: user.userId, computerId, subscriptionId: user.subscriptionId,
            size: 'cmp-8', readyAt })).status).toBe('opened');
        expect(await store.closeEpoch({ computerId, endedAt: new Date(readyAt.getTime() + 6 * HOUR * 1000), reason: 'session_max' })).toBe('closed');
    }
    const renewalId = await renew(s, user);
    await waitForGrant(user, renewalId); // Renewal MUST succeed with Visa before scenario 11 swaps the card.
    return { user, renewalId };
}
async function closeOverage(s: Scenario, user: Subscriber) {
    const result = await closePeriodAndInvoiceOverage({ store, usage }, {
        userId: user.userId, subscriptionId: user.subscriptionId, now: new Date(s.clock!.frozen_time * 1000),
    });
    if (result.status !== 'skipped') learn(s, result.invoiceId);
    return result;
}
async function customerOverageInvoices(user: Tenant, expect: TestContext['expect']) {
    const invoices = await stripeRequest<StripeList<Invoice>>('GET', `/invoices?customer=${user.customerId}&limit=100`);
    expect(invoices.has_more).toBe(false);
    return invoices.data.filter(row => row.metadata?.kind === 'overage').map(row => row.id);
}

function scenario(n: number, name: string, body: (s: Scenario, expect: TestContext['expect']) => Promise<void>): void {
    const s: Scenario = { n, name: `${n}. ${name}`, status: 'pending', error: null, clock: null, users: [], captures: [],
        db: emptySnapshot(), controller: new AbortController(),
        stripe: { clock: null, customers: [], subscriptions: [], invoices: [], refunds: [], paymentIntents: [], charges: [], checkoutSessions: [] } };
    scenarios.push(s);
    it(s.name, async ({ expect, onTestFailed }) => {
        onTestFailed(async result => {
            failScenario(s, new Error(result.task.result?.errors?.map(error => safeError(new Error(error.message))).join('; ') || 'Scenario failed'));
            s.controller.abort(new Error('Scenario failed'));
            await collectSnapshot(s);
            await writeReport();
        });
        await activeScenario.run(s, async () => {
            s.status = 'running';
            // Leave time for failure snapshots before Vitest's hard 15-minute limit.
            const deadline = setTimeout(() => s.controller.abort(new Error('Scenario deadline exceeded')), TEST_TIMEOUT - 30_000);
            try {
                await createClock(s);
                await body(s, expect);
                s.controller.signal.throwIfAborted();
                s.status = 'passed';
            } catch (error) {
                failScenario(s, error);
                // Do not let Vitest serialize provider diagnostics, request objects, secrets, or URLs.
                throw new Error(safeError(error));
            } finally {
                clearTimeout(deadline);
                await collectSnapshot(s);
                await writeReport();
            }
        });
    }, TEST_TIMEOUT);
}

(enabled ? describe.concurrent : describe.skip)('billing v2 real Stripe sandbox', () => {
    beforeAll(async () => {
        try {
            const port = Number(forwardPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid STRIPE_E2E_FORWARD_PORT');
            if (publishableKey && !publishableKey.startsWith('pk_test_')) throw new Error('STRIPE_E2E_PUBLISHABLE must be a test key');
            pool = postgres(databaseUrl, { max: 5, connect_timeout: 15, connection: { statement_timeout: 30_000 } });
            db = drizzle(pool, { schema });
            store = createBillingStore(db);
            stripe = createStripeClient({ secretKey });
            usage = createStripeUsageBilling({ secretKey });
            webhookDeps = { config: billingConfig(), store, stripe, usage, now: () => new Date() };
            server = createServer((req, res) => {
                const task = receive(req, res).catch(() => { if (!res.writableEnded) respond(res, 500, { error: 'receiver_failed' }); });
                receiverTasks.add(task);
                void task.finally(() => receiverTasks.delete(task));
            });
            await new Promise<void>((resolve, reject) => {
                server!.once('error', reject);
                server!.listen(port, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
            });
            // These are read-only catalog lookups; no scenario objects in beforeAll.
            const catalog = await Promise.all([stripe.resolvePrice(CATALOG_V2[STANDARD].stripeLookupKey!),
                stripe.resolvePrice(CATALOG_V2[COMPUTE].stripeLookupKey!), stripe.resolvePrice(OVERAGE_PRICE_LOOKUP_KEY)]);
            prices.set(STANDARD, catalog[0].id);
            prices.set(COMPUTE, catalog[1].id);
            await writeReport();
        } catch (error) {
            for (const s of scenarios) failScenario(s, error);
            await writeReport();
            throw new Error(safeError(error));
        }
    }, HOOK_TIMEOUT);

    afterEach(async ({ task }) => {
        const s = scenarios.find(item => item.name === task.name);
        if (s) {
            if (task.result?.state === 'fail') failScenario(s, new Error(task.result.errors?.map(e => e.message).join('; ') || 'Scenario failed'));
            await collectSnapshot(s);
            await writeReport();
            if (s.status === 'failed' && task.result?.state !== 'fail') throw new Error(s.error ?? 'Scenario report failed');
        }
    }, HOOK_TIMEOUT);

    afterAll(async () => {
        const errors: string[] = [];
        // Snapshot before clock deletion can emit subscription.deleted and change the observed state.
        for (const s of scenarios) await collectSnapshot(s);
        try { await writeReport(new Date().toISOString()); } catch (error) { errors.push(safeError(error)); }
        for (let offset = 0; offset < scenarios.length; offset += 4) {
            await Promise.all(scenarios.slice(offset, offset + 4).map(async s => {
                if (!s.stripe.clock) return;
                try {
                    // afterAll has no active scenario, so cleanup has no aborted scenario signal.
                    await stripeRequest('DELETE', `/test_helpers/test_clocks/${s.stripe.clock}`);
                } catch (error) { failScenario(s, new Error(`Clock cleanup failed: ${safeError(error)}`)); errors.push(safeError(error)); }
            }));
        }
        try {
            if (server?.listening) {
                const closed = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
                server.closeIdleConnections();
                await Promise.all([...receiverTasks]);
                server.closeAllConnections();
                await closed;
            }
        } catch (error) { errors.push(safeError(error)); }
        try { await pool?.end({ timeout: 10 }); } catch (error) { errors.push(safeError(error)); }
        try { await writeReport(new Date().toISOString()); } catch (error) { errors.push(safeError(error)); }
        // Append-only billing evidence and auth users are intentionally retained in the disposable DB.
        if (errors.length) throw new Error(errors.join('; ').slice(0, 300));
    }, HOOK_TIMEOUT);

    scenario(1, 'Standard subscribe, replay, Checkout and portal', async (s, expect) => {
        const user = await paidSubscriber(s, expect);
        const paid = await waitForDelivery(s, 'invoice.paid', user.invoiceId);
        const before = await grantsFor(user);
        const replay = await replayCapture(paid);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ duplicate: true });
        expect(await grantsFor(user)).toEqual(before);
        expect(before.filter(row => row.kind === 'plan_period' && row.subscriptionId === user.subscriptionId)).toHaveLength(1);

        const free = await createTenant(s); // Prelinked clock customer; the router must reuse it.
        const keys = publishableKey ? [publishableKey, undefined] : [undefined];
        for (const key of keys) {
            const result = await callerFor(s, free, key).createCheckout({ sku: STANDARD });
            s.stripe.checkoutSessions.push(result.sessionId);
            try {
                expect(result.mode).toBe(key ? 'embedded' : 'redirect');
                const session = await stripeRequest('GET', `/checkout/sessions/${result.sessionId}`);
                expect({ mode: session.mode, status: session.status, customer: idOf(session.customer) })
                    .toEqual({ mode: 'subscription', status: 'open', customer: free.customerId });
            } finally { await stripeRequest('POST', `/checkout/sessions/${result.sessionId}/expire`, {}); }
        }
        expect(await store.stripeCustomerFor(free.userId)).toBe(free.customerId);
        expect(await grantsFor(free)).toEqual([]);
        const caller = callerFor(s, user);
        expect(Boolean((await caller.portal()).url)).toBe(true); // Never put URLs in assertion diffs.
        const history = await caller.history();
        history.forEach(row => learn(s, row.id));
        expect(history.some(row => row.id === user.invoiceId && row.kind === 'subscription')).toBe(true);
    });

    scenario(2, 'declined first payment gives no allowance', async (s, expect) => {
        const user = await subscribe(s, await createTenant(s), STANDARD, 'declined');
        await waitFor(async () => (await subscriptionRow(user))?.status === 'incomplete', { label: 'incomplete subscription' });
        await waitFor(async () => (await store.openPaymentIssues(user.userId)).some(row => row.stripeInvoiceId === user.invoiceId),
            { label: 'first-payment issue in database' });
        expect(await grantsFor(user)).toEqual([]);
        expect((await subscriptionRow(user))?.status).toBe('incomplete');
    });

    scenario(3, '3DS records requires_action without allowance', async (s, expect) => {
        const user = await subscribe(s, await createTenant(s), STANDARD, '3ds');
        await waitFor(async () => (await store.openPaymentIssues(user.userId)).find(row => row.stripeInvoiceId === user.invoiceId && row.issue === 'requires_action'),
            { label: 'requires_action payment issue' });
        expect(await grantsFor(user)).toEqual([]);
    });

    scenario(4, 'successful renewal grants only the new period', async (s, expect) => {
        const user = await paidSubscriber(s, expect);
        const first = await grantsFor(user);
        const renewalId = await renew(s, user);
        const grants = await waitForGrant(user, renewalId);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ kind: 'plan_period', amount: BigInt(216000), periodStart: user.end });
        expect((await grantsFor(user)).filter(row => row.sourceId === user.invoiceId)).toEqual(first);
        expect((await grantsFor(user)).filter(row => row.kind === 'plan_period')).toHaveLength(2);
    });

    scenario(5, 'failed renewal recovers exactly once', async (s, expect) => {
        const user = await paidSubscriber(s, expect);
        const first = await grantsFor(user);
        await setPaymentMethod(user, 'declined');
        const renewalId = await renew(s, user);
        await waitFor(async () => (await subscriptionRow(user))?.status === 'past_due', { label: 'past_due renewal' });
        await waitFor(async () => (await store.openPaymentIssues(user.userId)).find(row => row.stripeInvoiceId === renewalId),
            { label: 'renewal payment issue' });
        expect(await grantsFor(user)).toEqual(first);
        await setPaymentMethod(user, 'visa');
        await payInvoice(renewalId);
        const grants = await waitForGrant(user, renewalId);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ kind: 'plan_period', amount: BigInt(216000), periodStart: user.end });
        await waitFor(async () => (await snapshotUsers([user.userId])).paymentIssues
            .some(row => row.stripeInvoiceId === renewalId && row.resolvedAt !== null), { label: 'resolved renewal issue' });
        const paid = await waitForDelivery(s, 'invoice.paid', renewalId);
        expect((await replayCapture(paid)).status).toBe(200);
        expect((await grantsFor(user)).filter(row => row.sourceId === renewalId)).toHaveLength(1);
        expect((await grantsFor(user)).filter(row => row.sourceId === user.invoiceId)).toEqual(first);
    });

    scenario(6, 'paid upgrade grants the prorated difference', async (s, expect) => {
        const user = await paidSubscriber(s, expect);
        await advanceClock(s, s.clock!.frozen_time + 10 * 24 * HOUR);
        const caller = callerFor(s, user);
        const preview = await caller.previewUpgrade({ toSku: COMPUTE });
        const result = await caller.confirmUpgrade({ toSku: COMPUTE, prorationDate: preview.prorationDate });
        learn(s, result.invoiceId);
        expect(result.status).toBe('applied');
        const grants = await waitForGrant(user, result.invoiceId);
        expect(grants).toHaveLength(1);
        expect(grants[0].kind).toBe('upgrade_prorated');
        expect(Math.abs(Number(grants[0].amount) - preview.grantStdSeconds)).toBeLessThanOrEqual(1);
        expect(Number(grants[0].amount)).toBe(upgradeGrantStdSeconds({ fromSku: STANDARD, toSku: COMPUTE,
            periodStart: user.start.toISOString(), periodEnd: user.end.toISOString(),
            effectiveAt: new Date(preview.prorationDate * 1000).toISOString() }));
        const invoice = await stripeRequest<Invoice>('GET', `/invoices/${result.invoiceId}`);
        expect(invoice.amount_paid).toBe(preview.amountDueCents);
        expect((await grantsFor(user)).filter(row => row.kind === 'plan_period')).toHaveLength(1);
        await waitFor(async () => (await planChangesFor(user)).some(row => row.kind === 'upgrade' && row.state === 'applied'),
            { label: 'applied upgrade' });
        expect(await caller.summary()).toMatchObject({ enabled: true, plan: { sku: COMPUTE } });
    });

    scenario(7, 'failed upgrade remains Standard and expires', async (s, expect) => {
        const user = await paidSubscriber(s, expect);
        const before = await grantsFor(user);
        await advanceClock(s, s.clock!.frozen_time + 10 * 24 * HOUR);
        await setPaymentMethod(user, 'declined');
        const caller = callerFor(s, user);
        const preview = await caller.previewUpgrade({ toSku: COMPUTE });
        const result = await caller.confirmUpgrade({ toSku: COMPUTE, prorationDate: preview.prorationDate });
        learn(s, result.invoiceId);
        expect(['payment_failed', 'requires_action']).toContain(result.status);
        expect(Boolean(result.expiresAt)).toBe(true);
        await waitFor(async () => (await store.openPaymentIssues(user.userId)).some(row => row.stripeInvoiceId === result.invoiceId),
            { label: 'failed upgrade issue from webhook' });
        expect(await grantsFor(user)).toEqual(before);
        expect(await caller.summary()).toMatchObject({ enabled: true, plan: { sku: STANDARD } });
        if (!result.expiresAt) throw new Error('Failed upgrade has no expiry');
        await advanceClock(s, Math.floor(new Date(result.expiresAt).getTime() / 1000) + 60);
        await waitFor(async () => (await planChangesFor(user)).some(row => row.kind === 'upgrade' && row.state === 'expired'),
            { label: 'expired pending upgrade' });
        expect((await grantsFor(user)).filter(row => row.kind === 'upgrade_prorated')).toEqual([]);
        expect(await caller.summary()).toMatchObject({ enabled: true, plan: { sku: STANDARD } });
    });

    scenario(8, 'scheduled downgrade grants Standard at renewal', async (s, expect) => {
        const user = await paidSubscriber(s, expect, COMPUTE);
        const caller = callerFor(s, user);
        await caller.scheduleDowngrade({ toSku: STANDARD });
        expect((await planChangesFor(user)).map(row => row.state)).toEqual(['scheduled']);
        const renewalId = await renew(s, user);
        const grants = await waitForGrant(user, renewalId);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ kind: 'plan_period', amount: BigInt(216000), periodStart: user.end });
        await waitFor(async () => (await planChangesFor(user)).some(row => row.kind === 'downgrade' && row.state === 'applied'),
            { label: 'applied downgrade' });
        expect(await caller.summary()).toMatchObject({ enabled: true, plan: { sku: STANDARD } });
    });

    scenario(9, 'cancel at period end and full refund revoke allowance', async (s, expect) => {
        const user = await paidSubscriber(s, expect);
        await callerFor(s, user).cancelAtPeriodEnd({ cancel: true });
        await waitFor(async () => (await subscriptionRow(user))?.cancelAtPeriodEnd === true, { label: 'cancelAtPeriodEnd from webhook' });
        const paymentIntent = await invoicePaymentIntent(user.invoiceId);
        const refund = await stripeRequest('POST', '/refunds', { payment_intent: paymentIntent });
        const revokes = await waitFor(async () => {
            const rows = (await grantsFor(user)).filter(row => row.sourceType === 'refund' && row.sourceId === refund.id);
            return rows.length ? rows : null;
        }, { label: 'refund revoke from webhook' });
        expect(revokes).toHaveLength(1);
        expect(revokes[0]).toMatchObject({ kind: 'revoke', amount: BigInt(-216000), subscriptionId: user.subscriptionId });
    });

    scenario(10, 'overage invoices 2500 cents once and never grants', async (s, expect) => {
        const { user } = await seedOverage(s, expect);
        const result = await closeOverage(s, user);
        expect(result.status).toBe('invoiced');
        if (result.status !== 'invoiced') throw new Error('Overage was not invoiced');
        try {
            await waitFor(async () => (await store.overageInvoiceByStripeId(result.invoiceId))?.status === 'paid',
                { timeoutMs: 30_000, label: 'automatic overage payment' });
        } catch (error) {
            if (!(error instanceof WaitTimeout)) throw error;
            await payInvoice(result.invoiceId);
        }
        await waitFor(async () => (await store.overageInvoiceByStripeId(result.invoiceId))?.status === 'paid',
            { label: 'paid overage row from webhook' });
        const invoice = await stripeRequest<Invoice>('GET', `/invoices/${result.invoiceId}`);
        expect({ kind: invoice.metadata?.kind, total: invoice.total }).toEqual({ kind: 'overage', total: 2500 });
        expect((await store.overageInvoiceByStripeId(result.invoiceId))?.cents).toBe(2500);
        expect((await grantsFor(user)).filter(row => row.sourceId === result.invoiceId)).toEqual([]);
        expect(await closeOverage(s, user)).toEqual({ status: 'exists', invoiceId: result.invoiceId });
        expect(await customerOverageInvoices(user, expect)).toEqual([result.invoiceId]);
    });

    scenario(11, 'overage failure disables consent without changing new allowance', async (s, expect) => {
        const { user, renewalId } = await seedOverage(s, expect);
        const before = (await grantsFor(user)).filter(row => row.sourceId === renewalId);
        expect(before).toHaveLength(1);
        expect(before[0].amount).toBe(BigInt(1800000));
        await setPaymentMethod(user, 'declined');
        const result = await closeOverage(s, user);
        expect(result.status).toBe('invoiced');
        if (result.status !== 'invoiced') throw new Error('Overage was not invoiced');
        await payInvoice(result.invoiceId, true);
        await waitFor(async () => (await store.overageInvoiceByStripeId(result.invoiceId))?.status === 'payment_failed',
            { label: 'failed overage row from webhook' });
        await waitFor(async () => {
            const consent = await store.latestConsent(user.userId, user.subscriptionId);
            return consent?.enabled === false && consent.actor === 'system:overage_payment_issue';
        }, { label: 'system disabled overage consent' });
        expect(await store.openPaymentIssues(user.userId)).toEqual([expect.objectContaining({
            stripeInvoiceId: result.invoiceId, invoiceKind: 'overage', issue: 'payment_failed', resolvedAt: null,
        })]);
        const invoice = await stripeRequest<Invoice>('GET', `/invoices/${result.invoiceId}`);
        expect({ kind: invoice.metadata?.kind, total: invoice.total }).toEqual({ kind: 'overage', total: 2500 });
        expect((await grantsFor(user)).filter(row => row.sourceId === result.invoiceId)).toEqual([]);
        expect((await grantsFor(user)).filter(row => row.sourceId === renewalId)).toEqual(before);
        expect(await callerFor(s, user).summary()).toMatchObject({ enabled: true, compute: { allowanceStdSeconds: 1800000 } });
        expect(await customerOverageInvoices(user, expect)).toEqual([result.invoiceId]);
    });

    scenario(12, 'tenant mapping wins over metadata and bad signatures are rejected', async (s, expect) => {
        const a = await paidSubscriber(s, expect);
        const beforeA = await snapshotUsers([a.userId]);
        const subscriptionsA = await store.subscriptionsFor(a.userId);
        const b = await paidSubscriber(s, expect, STANDARD, await createTenant(s, a.userId));
        expect(await snapshotUsers([a.userId])).toEqual(beforeA);
        expect(await store.subscriptionsFor(a.userId)).toEqual(subscriptionsA);
        expect((await grantsFor(a)).map(row => ({ userId: row.userId, subscriptionId: row.subscriptionId, amount: row.amount })))
            .toEqual([{ userId: a.userId, subscriptionId: a.subscriptionId, amount: BigInt(216000) }]);
        expect((await grantsFor(b)).map(row => ({ userId: row.userId, subscriptionId: row.subscriptionId, amount: row.amount })))
            .toEqual([{ userId: b.userId, subscriptionId: b.subscriptionId, amount: BigInt(216000) }]);
        const capture = await waitForDelivery(s, 'invoice.paid', b.invoiceId);
        const before = await snapshotUsers(s.users);
        const receiptBefore = await db.select().from(billingEvents).where(eq(billingEvents.eventId, capture.id));
        const tampered = Buffer.from(capture.rawBody);
        // Change exactly one ASCII byte in the event ID, preserving JSON and object relevance even if minified.
        const idOffset = tampered.indexOf(Buffer.from(capture.id));
        if (idOffset < 0) throw new Error('Captured event ID is missing from raw delivery');
        const changedByte = idOffset + capture.id.length - 1;
        tampered[changedByte] = tampered[changedByte] === 65 ? 66 : 65;
        const tamperedId = String(object(JSON.parse(tampered.toString('utf8'))).id);
        for (const input of [{ body: tampered, signature: capture.signature }, { body: capture.rawBody, signature: null }]) {
            const response = await replayCapture(capture, input.body, input.signature);
            expect(response.status).toBe(400);
        }
        expect(await snapshotUsers(s.users)).toEqual(before);
        expect(await db.select().from(billingEvents).where(eq(billingEvents.eventId, capture.id))).toEqual(receiptBefore);
        expect(await db.select().from(billingEvents).where(eq(billingEvents.eventId, tamperedId))).toEqual([]);
    });
});

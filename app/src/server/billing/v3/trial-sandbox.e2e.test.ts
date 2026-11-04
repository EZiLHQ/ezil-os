/**
 * Opt-in, REAL Stripe-signed lifecycle suite for the Standard one-calendar-month trial
 * (request standard-trial-01b28d18-20261105-v1). Mirrors ../v2/sandbox.e2e.test.ts and its safety rules.
 *
 * - Every delivery is signed by Stripe (`stripe listen`, started by the lead's wrapper) and forwarded to a local
 *   receiver that feeds the raw bytes and Stripe's header to the unmodified `handleStripeWebhook` under the listen
 *   secret. The suite never signs, re-signs or fabricates an event, loads no application env and imports no
 *   production deps. The only unsigned or altered requests are the labelled rejection controls.
 * - Signatures are checked against wall time, because Stripe signs with wall time. The processor's `deps.now`, the
 *   router's `now` and every reader's `now` are the scenario's Stripe test clock: its frozen time, moved to the advance
 *   target the moment the advance is requested, because deliveries arrive while the clock advances.
 * - A headless run cannot complete Checkout. Each trial calls the real `quoteTrial` and `createCheckout`, asserts the
 *   Checkout Session Stripe created and expires it, then starts the subscription with POST /v1/subscriptions from
 *   exactly `trialSubscriptionData()` (the builder Checkout's `subscription_data` uses), encoded by the product's own
 *   `createStripeRequest`, plus the v3 price item and a default payment method.
 * - The disposable database must already have the billing migrations through 0021. Its Supabase image's `auth.users`
 *   predates GoTrue's `email_confirmed_at`, `deleted_at` and `banned_until`; beforeAll adds them (IF NOT EXISTS)
 *   because the trial facts and the paid-compute SQL read them.
 * - The v3 Standard price (`ezil_standard_monthly_v3`) must already exist in the sandbox; the suite never creates one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { TRPCError } from '@trpc/server';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, it, vi, type TestContext } from 'vitest';

import type { createTRPCContext } from '@/server/api/trpc';
import * as schema from '@/server/db/schema';
import {
    billingEvents, billingGrants, billingOutbox, billingPaymentIssues, billingSubscriptions, billingTrials,
} from '@/server/db/schema/billing';
import { aiTopupOutboxItem, hasAiTopupReceipts } from '../ai-credits';
import type { BillingSummaryWithAi } from '../ai-balance';
import { customTopupPack } from '../catalog';
import { readBillingConfig } from '../config';
import { handleStripeWebhook } from '../http/stripe-webhook';
import type { BillingDeps, BillingStore } from '../ports';
import { processStripeEvent } from '../processor';
import { createBillingStore } from '../store';
import { createStripeClient, createStripeRequest, trialSubscriptionData } from '../stripe/client';
import type { StripeEventLike } from '../stripe/events';
import { createStripeUsageBilling } from '../stripe/usage-billing';
import { billingV2EntitlementReader } from '../v2/compute-access';
import { epochSeconds, isoSeconds } from '../v2/time';
import { CATALOG_V3 } from './contract';
import { normalizeEmail, TRIAL_SKU } from './trial';

const migrationCalls = vi.hoisted(() => [] as { userId: string; sku: string }[]);
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({
    getBillingDeps: () => { throw new Error('Tests must inject billing ports'); },
}));
// invoice.paid schedules the paid compute migration (processor → schedulePaidMigration). The suite never starts one:
// it would reach AWS. The scheduled call is recorded instead.
vi.mock('@/server/lib/compute/provider-migrate-runtime', () => ({
    startPaidMigration: vi.fn(async (userId: string, sku: string) => { migrationCalls.push({ userId, sku }); }),
}));

import { createBillingRouter } from '@/server/api/routers/billing';
import { readPaidPoolEligibility } from '@/server/lib/compute/ready-pool';

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
const runTag = runId.replace(/\W/g, '');
const startedAt = new Date().toISOString();
const REQUEST = 'standard-trial-01b28d18-20261105-v1';
const EXPECTED_ACCOUNT = 'acct_1Tu3KqFKwQk2o9PJ';
const EXPECTED_PRICE = 'price_1USjMBFKwQk2o9PJ1h5HugYp';
const reportDir = fileURLToPath(new URL('../../../../../artifacts/', import.meta.url));
const reportPath = `${reportDir}trial-signed-${runId}.json`;
const receiverUrl = `http://127.0.0.1:${forwardPort}/`;
const HOUR = 3600;
const DAY_MS = 86_400_000;
const TOLERANCE_SECONDS = 300;
const TRIAL_STD_SECONDS = 144_000;

type JsonObject = Record<string, unknown>;
type StripeObject = JsonObject & { id: string };
type Clock = { id: string; frozen_time: number; status: string };
type StripeList<T> = { data: T[]; has_more: boolean };
type Invoice = StripeObject & { status: string; total: number; amount_paid: number; billing_reason: string | null;
    lines?: StripeList<JsonObject & { period?: { start: number; end: number } }> };
type Subscription = StripeObject & { status: string; trial_start: number | null; trial_end: number | null;
    latest_invoice: string | Invoice | null; ended_at: number | null; cancel_at_period_end: boolean; cancel_at: number | null };
type Tenant = { userId: string; email: string; customerId: string | null };
type Linked = Tenant & { customerId: string };
type TrialSubscriber = Linked & {
    trialId: string; subscriptionId: string; zeroInvoiceId: string; paymentMethodId: string;
    trialStart: Date; trialEnd: Date; trialRoot: string;
};
type Capture = {
    seq: number; id: string; type: string; objectId: string | null; billingReason: string | null;
    rawBody: Buffer; signatureHeader: string | null; signedAt: number | null; httpStatus: number; body: JsonObject; held: boolean;
};
type DeliveryKind = 'stripe' | 'held' | 'replay' | 'control_unsigned' | 'control_forged';
type Delivery = {
    kind: DeliveryKind; eventId: string; type: string; objectId: string | null; httpStatus: number;
    /** 'verified': the handler accepted Stripe's signature under the listen secret; 'rejected'/'absent': it refused. */
    signature: 'verified' | 'rejected' | 'absent'; duplicate: boolean; outcome: string | null; error: string | null;
    /** Wall seconds since Stripe signed it (the `t=` of its header), when delivered. */
    ageSeconds: number | null; eventCreated: number | null; clockNow: number;
    /** 'cleanup': arrived after the scenario finished (for example while afterAll deletes the test clocks). */
    phase: 'scenario' | 'cleanup';
};
type Rerun = { eventId: string; type: string; outcome: string; clockNow: number; path: 'processor_rerun' };
type Snapshot = Awaited<ReturnType<typeof snapshotUsers>>;
type Scenario = {
    n: number; name: string; status: 'pending' | 'running' | 'passed' | 'failed'; error: string | null;
    clock: Clock | null; nowSec: number; users: string[]; captures: Capture[]; deliveries: Delivery[]; reruns: Rerun[];
    hold: ((capture: Capture) => boolean) | null; held: Capture[]; checks: JsonObject; db: Snapshot;
    controller: AbortController;
    stripe: {
        clock: string | null; customers: string[]; subscriptions: string[]; invoices: string[]; paymentIntents: string[];
        charges: string[]; refunds: string[]; checkoutSessions: string[]; paymentMethods: string[];
    };
};

let pool: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let store: BillingStore;
let stripe: ReturnType<typeof createStripeClient>;
let usage: ReturnType<typeof createStripeUsageBilling>;
let webhookDeps: BillingDeps;
let server: ReturnType<typeof createServer> | undefined;
let standardPrice = '';
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
    // Database errors and assertion messages may include values. Do not persist URLs, emails or any secrets.
    for (const secret of [secretKey, webhookSecret, publishableKey, databaseUrl]) {
        if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redacted]')
        .replace(/\b(?:pi|seti|cs)_[A-Za-z0-9_]*_secret_[A-Za-z0-9_]+/g, '[redacted]')
        .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/g, '[url]')
        .replace(/[^\s"'<>@]+@[^\s"'<>@]+\.[A-Za-z]+/g, '[email]')
        .replace(/[\r\n\t]/g, ' ').slice(0, 400);
}
function failScenario(s: Scenario, error: unknown): void {
    s.status = 'failed';
    s.error = [s.error, safeError(error)].filter(Boolean).join('; ').slice(0, 600);
}
function emptySnapshot() {
    return { grants: [], outbox: [], trials: [], subscriptions: [], paymentIssues: [], events: [] } as {
        grants: unknown[]; outbox: unknown[]; trials: unknown[]; subscriptions: unknown[]; paymentIssues: unknown[]; events: unknown[];
    };
}
const clockOf = (s: Scenario) => new Date(s.nowSec * 1000);
const iso = (date: Date) => isoSeconds(epochSeconds(date));
/** One calendar month later in UTC, month-end clamped; written independently of trial.ts on purpose. */
function plusOneMonth(at: Date): Date {
    const y = at.getUTCFullYear(), m = at.getUTCMonth();
    const last = new Date(Date.UTC(y, m + 2, 0)).getUTCDate();
    return new Date(Date.UTC(y, m + 1, Math.min(at.getUTCDate(), last), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()));
}
function check(s: Scenario, name: string, value: unknown): void { s.checks[name] = value; }

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
    for (let attempt = 0; ; attempt++) {
        owner?.controller.signal.throwIfAborted();
        const response = await fetch(`https://api.stripe.com/v1${endpoint}`, {
            method,
            headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2026-09-30.endive',
                'Content-Type': 'application/x-www-form-urlencoded' },
            body: fields ? new URLSearchParams(fields) : undefined,
            signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(owner ? [owner.controller.signal] : [])]),
        });
        if (response.status === 429 && attempt < 5) { await delay(1000 * (attempt + 1)); continue; }
        if (!response.ok) {
            const payload: unknown = await response.json().catch(() => null);
            throw new StripeSetupError(response.status, object(object(payload).error).code);
        }
        const result = await response.json() as T;
        if (owner) learn(owner, result);
        return result;
    }
}

/** Nested Stripe parameters (trialSubscriptionData), encoded by the product's own form encoder. */
type FormFields = NonNullable<Parameters<ReturnType<typeof createStripeRequest>>[1]>;
async function stripeForm<T = StripeObject>(s: Scenario, endpoint: string, fields: FormFields, idempotencyKey?: string): Promise<T> {
    const request = createStripeRequest({ secretKey });
    for (let attempt = 0; ; attempt++) {
        s.controller.signal.throwIfAborted();
        try {
            const result = await request<T>(endpoint, fields, idempotencyKey);
            learn(s, result);
            return result;
        } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 429 && attempt < 5) { await delay(1000 * (attempt + 1)); continue; }
            throw new StripeSetupError(typeof status === 'number' ? status : 0, (error as { code?: unknown }).code);
        }
    }
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
/** Router and reader ports: every `now` is the scenario's test clock. */
function clockDeps(s: Scenario): BillingDeps {
    return { config: billingConfig(), store, stripe, usage, now: () => clockOf(s) };
}
function callerFor(s: Scenario, user: Tenant) {
    const ctx: Awaited<ReturnType<typeof createTRPCContext>> = {
        db,
        headers: new Headers({ origin: 'https://os.ezil.org' }),
        user: { id: user.userId, email: user.email, aud: 'authenticated', app_metadata: {},
            user_metadata: {}, created_at: clockOf(s).toISOString() },
    };
    const deps = clockDeps(s);
    return createBillingRouter(() => deps).createCaller(ctx);
}

function signedAtOf(header: string | null): number | null {
    const t = header?.split(',').map(part => part.trim()).find(part => part.startsWith('t='))?.slice(2);
    return t && /^\d+$/.test(t) ? Number(t) : null;
}

/**
 * Exact bytes and Stripe's original header into the unmodified handler. The handler checks the signature against
 * wall time (webhookDeps.now); the processor runs at the scenario clock. The suite never signs.
 */
async function deliver(s: Scenario, capture: Capture, kind: DeliveryKind,
    body: Buffer = capture.rawBody, header: string | null = capture.signatureHeader, eventId = capture.id):
    Promise<{ delivery: Delivery; body: JsonObject }> {
    let outcome: string | null = null;
    let eventCreated: number | null = null;
    const clockNow = s.nowSec;
    const response = await handleStripeWebhook(new Request(receiverUrl, {
        method: 'POST', body: new Uint8Array(body), headers: header ? { 'stripe-signature': header } : {},
    }), webhookDeps, async (event, processorDeps) => {
        eventCreated = event.created;
        outcome = await processStripeEvent(event, { ...processorDeps, now: () => clockOf(s) });
        return outcome;
    });
    const payload = object(await response.json());
    const delivery: Delivery = {
        kind, eventId, type: capture.type, objectId: capture.objectId, httpStatus: response.status,
        signature: !header ? 'absent' : payload.error === 'invalid_signature' ? 'rejected' : 'verified',
        duplicate: payload.duplicate === true, outcome, error: typeof payload.error === 'string' ? payload.error : null,
        ageSeconds: capture.signedAt === null ? null : Math.floor(Date.now() / 1000) - capture.signedAt,
        eventCreated, clockNow, phase: s.status === 'running' ? 'scenario' : 'cleanup',
    };
    s.deliveries.push(delivery);
    return { delivery, body: payload };
}
/** The processor alone, on the parsed bytes Stripe signed: the path a failed-then-retried delivery takes. */
async function rerunProcessor(s: Scenario, capture: Capture): Promise<string> {
    const event = JSON.parse(capture.rawBody.toString('utf8')) as StripeEventLike;
    const outcome = await processStripeEvent(event, { store, stripe, now: () => clockOf(s) });
    s.reruns.push({ eventId: capture.id, type: capture.type, outcome, clockNow: s.nowSec, path: 'processor_rerun' });
    return outcome;
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
    const signatureHeader = Array.isArray(header) ? header.join(',') : header ?? null;
    const capture: Capture = {
        seq: s.captures.length + 1,
        id: typeof envelope.id === 'string' ? envelope.id : 'invalid',
        type: typeof envelope.type === 'string' ? envelope.type : 'invalid', objectId: idOf(value),
        billingReason: typeof value.billing_reason === 'string' ? value.billing_reason : null,
        rawBody, signatureHeader, signedAt: signedAtOf(signatureHeader), httpStatus: 0, body: {}, held: false,
    };
    s.captures.push(capture);
    // Scenario 3 keeps chosen Stripe-signed requests undelivered, to deliver them for the first time after conversion.
    if (s.hold?.(capture)) {
        capture.held = true;
        s.held.push(capture);
        respond(res, 200, { held: true });
        return;
    }
    // Learn only after verification, so the intentional bad-signature tests cannot expand our scope.
    for (let attempt = 0; attempt <= 5; attempt++) {
        const { delivery, body } = await deliver(s, capture, 'stripe');
        capture.httpStatus = delivery.httpStatus;
        capture.body = body;
        if (delivery.httpStatus >= 200 && delivery.httpStatus < 300) learn(s, value);
        if (delivery.httpStatus < 500 || attempt === 5) break;
        await delay(3000); // Delivery retry backoff, not a state wait.
    }
    respond(res, capture.httpStatus, capture.body);
}

async function snapshotUsers(users: string[]) {
    if (!users.length || !db) return emptySnapshot();
    const [grants, outbox, trials, subscriptions, paymentIssues] = await Promise.all([
        db.select().from(billingGrants).where(inArray(billingGrants.userId, users)).orderBy(asc(billingGrants.id)),
        db.select().from(billingOutbox).where(inArray(billingOutbox.userId, users)).orderBy(asc(billingOutbox.eventKey)),
        db.select().from(billingTrials).where(inArray(billingTrials.userId, users)).orderBy(asc(billingTrials.id)),
        db.select().from(billingSubscriptions).where(inArray(billingSubscriptions.userId, users))
            .orderBy(asc(billingSubscriptions.stripeSubscriptionId)),
        db.select().from(billingPaymentIssues).where(inArray(billingPaymentIssues.userId, users))
            .orderBy(asc(billingPaymentIssues.stripeInvoiceId)),
    ]);
    const eventIds = [...new Set(scenarios.filter(s => s.users.some(u => users.includes(u))).flatMap(s => s.captures.map(c => c.id)))];
    const events = eventIds.length ? await db.select({ eventId: billingEvents.eventId, type: billingEvents.type,
        outcome: billingEvents.outcome, processedAt: billingEvents.processedAt })
        .from(billingEvents).where(inArray(billingEvents.eventId, eventIds)).orderBy(asc(billingEvents.eventId)) : [];
    return {
        grants, outbox,
        trials: trials.map(({ emailNormalized: _email, ...row }) => row),
        subscriptions, paymentIssues: paymentIssues.map(({ hostedInvoiceUrl: _url, ...row }) => row), events,
    };
}
/**
 * Row contents that a replay must never change (timestamps a no-op rewrite may touch are left out). `eventRows` counts
 * the inbox receipts of this scenario's captured events; a first (held) delivery legitimately adds one.
 */
async function stableState(users: string[], { events = true } = {}) {
    const snap = await snapshotUsers(users);
    return {
        grants: snap.grants,
        outbox: (snap.outbox as (typeof billingOutbox.$inferSelect)[]).map(({ eventKey, userId, kind, payload }) => ({ eventKey, userId, kind, payload })),
        trials: (snap.trials as Omit<typeof billingTrials.$inferSelect, 'emailNormalized'>[]).map(({ updatedAt: _u, ...row }) => row),
        subscriptions: (snap.subscriptions as (typeof billingSubscriptions.$inferSelect)[])
            .map(({ updatedAt: _u, stripeEventCreated: _c, ...row }) => row),
        paymentIssues: snap.paymentIssues,
        ...(events ? { eventRows: snap.events.length } : {}),
    };
}
function counts(snap: Snapshot) {
    const tally = (rows: unknown[], key: string) => rows.reduce<Record<string, number>>((acc, row) => {
        const value = String(object(row)[key]);
        acc[value] = (acc[value] ?? 0) + 1;
        return acc;
    }, {});
    return {
        grantsByKind: tally(snap.grants, 'kind'), outboxByKind: tally(snap.outbox, 'kind'), trialsByStatus: tally(snap.trials, 'status'),
        subscriptionsByStatus: tally(snap.subscriptions, 'status'), paymentIssues: snap.paymentIssues.length, eventReceipts: snap.events.length,
    };
}
async function collectSnapshot(s: Scenario): Promise<void> {
    try { s.db = await snapshotUsers(s.users); }
    catch (error) { failScenario(s, new Error(`Report snapshot failed: ${safeError(error)}`)); }
}

const FORBIDDEN_REPORT_PATTERNS = [
    /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]/, /whsec_[A-Za-z0-9]/, /_secret_[A-Za-z0-9]/, /@example\.test/i,
    /postgres(?:ql)?:\/\//, /checkout\.stripe\.com/,
];
function writeReport(finishedAt: string | null = null): Promise<void> {
    // Serialize writes so concurrent scenarios cannot replace a newer report with an older snapshot.
    const work = reportWrites.catch(() => {}).then(async () => {
        const json = JSON.stringify({
            runId, request: REQUEST, account: EXPECTED_ACCOUNT, livemode: false, startedAt, finishedAt,
            harness: {
                wrapper: 'stripe-sandbox.mjs e2e (stripe listen --forward-to the local receiver)',
                signatureClock: 'wall time (Stripe signs with wall time; tolerance 300 s)',
                processorClock: 'scenario test clock frozen_time, moved to the advance target when the advance is requested',
                checkout: 'real quoteTrial + createCheckout; session asserted then expired; subscription via POST /v1/subscriptions from trialSubscriptionData()',
                pathsLegend: {
                    stripe: 'Stripe-signed delivery forwarded by stripe listen, delivered on arrival',
                    held: 'Stripe-signed delivery kept undelivered by the receiver, first delivered later (out of order)',
                    replay: 'the same captured bytes and Stripe-Signature header re-posted into the handler',
                    control_unsigned: 'captured bytes without the Stripe-Signature header (must be 400)',
                    control_forged: 'captured bytes with one event-id byte changed, Stripe header kept (must be 400)',
                    processor_rerun: 'the parsed captured event fed to processStripeEvent directly (the retry path past the inbox)',
                },
                paidMigrationsScheduled: migrationCalls.length,
            },
            scenarios: scenarios.map(s => ({
                n: s.n, name: s.name, status: s.status, pass: s.status === 'passed', error: s.error,
                clock: s.clock ? { id: s.clock.id, frozenTime: s.clock.frozen_time, status: s.clock.status } : null,
                stripe: s.stripe,
                deliveries: s.deliveries, processorReruns: s.reruns,
                received: s.captures.map(({ seq, id, type, objectId, httpStatus, held }) => ({ seq, id, type, objectId, httpStatus, held })),
                checks: s.checks, dbCounts: counts(s.db), db: s.db,
            })),
        }, (key, value: unknown) => {
            if (/^(rawBody|signatureHeader|email|emailNormalized|hostedInvoiceUrl|clientSecret|client_secret)$/i.test(key)
                || /url|secret/i.test(key)) return undefined;
            return typeof value === 'bigint' ? value.toString() : value;
        }, 2);
        for (const secret of [secretKey, webhookSecret, publishableKey, databaseUrl]) {
            if (secret && json.includes(secret)) throw new Error('Report redaction check failed (secret)');
        }
        if (FORBIDDEN_REPORT_PATTERNS.some(pattern => pattern.test(json))) throw new Error('Report redaction check failed (pattern)');
        await mkdir(reportDir, { recursive: true });
        for (const destination of new Set([reportPath, ...(extraReportPath ? [extraReportPath] : [])])) {
            const temporary = `${destination}.${runId}.tmp`;
            await writeFile(temporary, `${json}\n`, { mode: 0o600 });
            await rename(temporary, destination);
        }
    });
    reportWrites = work;
    return work;
}

// ── Stripe setup ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function createClock(s: Scenario): Promise<void> {
    s.clock = await stripeRequest<Clock>('POST', '/test_helpers/test_clocks', {
        frozen_time: String(Math.floor(Date.now() / 1000)), name: `ezil-trial-${runId}-s${s.n}`,
    });
    s.stripe.clock = s.clock.id;
    s.nowSec = s.clock.frozen_time;
}
async function advanceClock(s: Scenario, frozenTime: number): Promise<void> {
    // Deliveries arrive while Stripe advances; they are processed at the time the clock is moving to.
    s.nowSec = frozenTime;
    await stripeRequest('POST', `/test_helpers/test_clocks/${s.clock!.id}/advance`, { frozen_time: String(frozenTime) });
    s.clock = await waitFor(async () => {
        const clock = await stripeRequest<Clock>('GET', `/test_helpers/test_clocks/${s.clock!.id}`);
        if (clock.status === 'internal_failure') throw new Error('Stripe test clock internal_failure');
        return clock.status === 'ready' && clock.frozen_time === frozenTime ? clock : null;
    }, { timeoutMs: 10 * 60_000, label: 'Stripe test clock ready' });
}
function emailFor(s: Scenario, label: string): string {
    // Distinct base addresses: a `+tag` is stripped by normalization, so `+` is used only for the same-person cases.
    return `trial-${runTag}-s${s.n}-${label}@example.test`;
}
/** An auth.users row with a confirmed email (DB only: no Stripe customer). */
async function createUser(s: Scenario, email: string): Promise<Tenant> {
    const userId = randomUUID();
    const at = clockOf(s).toISOString();
    await pool`insert into auth.users (id, email, email_confirmed_at, created_at, aud, role) values
        (${userId}::uuid, ${email}, ${at}::timestamptz, ${at}::timestamptz, 'authenticated', 'authenticated')`;
    s.users.push(userId);
    return { userId, email, customerId: null };
}
/** A confirmed user with a customer on the scenario's clock, linked before any router call (as the template does). */
async function createTenant(s: Scenario, label: string, email = emailFor(s, label)): Promise<Linked> {
    const user = await createUser(s, email);
    const customer = await stripeRequest('POST', '/customers', {
        test_clock: s.clock!.id, 'metadata[ezil_e2e]': 'os-standard-trial', 'metadata[ezil_run]': runId,
        'metadata[ezil_request]': REQUEST, 'metadata[user_id]': user.userId,
    });
    if (await store.linkCustomer(user.userId, customer.id) !== 'linked') throw new Error('Could not link scenario customer');
    return { ...user, customerId: customer.id };
}
async function attachPaymentMethod(s: Scenario, user: Linked, token: 'pm_card_visa' | 'pm_card_chargeCustomerFail'): Promise<string> {
    const paymentMethod = await stripeRequest('POST', `/payment_methods/${token}/attach`, { customer: user.customerId });
    s.stripe.paymentMethods.push(paymentMethod.id);
    await stripeRequest('POST', `/customers/${user.customerId}`, { 'invoice_settings[default_payment_method]': paymentMethod.id });
    return paymentMethod.id;
}
async function grantsFor(userId: string) {
    return db.select().from(billingGrants).where(eq(billingGrants.userId, userId)).orderBy(asc(billingGrants.id));
}
async function outboxFor(userId: string) {
    return db.select().from(billingOutbox).where(eq(billingOutbox.userId, userId)).orderBy(asc(billingOutbox.eventKey));
}
async function trialRowFor(userId: string) {
    const [row] = await db.select().from(billingTrials).where(eq(billingTrials.userId, userId));
    return row;
}
async function subscriptionRow(user: TrialSubscriber | (Linked & { subscriptionId: string })) {
    return (await store.subscriptionsFor(user.userId)).find(row => row.stripeSubscriptionId === user.subscriptionId);
}
async function summaryOf(s: Scenario, user: Tenant): Promise<BillingSummaryWithAi> {
    const result = await callerFor(s, user).summary();
    if (!('version' in result)) throw new Error('Billing summary is disabled');
    return result as BillingSummaryWithAi;
}
async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string } | 'fulfilled'> {
    try { await promise; return 'fulfilled'; }
    catch (error) {
        if (error instanceof TRPCError) return { code: error.code, message: error.message };
        throw error;
    }
}
async function paidPoolCovers(s: Scenario, userId: string) {
    return readPaidPoolEligibility(db as unknown as Parameters<typeof readPaidPoolEligibility>[0], userId, clockOf(s));
}
async function waitForCapture(s: Scenario, label: string, match: (c: Capture) => boolean) {
    return waitFor(async () => s.captures.find(c => match(c) && (c.held || c.httpStatus === 200)), { label });
}

/**
 * The real router path up to the Checkout Session, then the subscription from exactly trialSubscriptionData(), then
 * waits until the trial is bound, granted and queued and both trial-start deliveries were received (processed or held).
 */
async function startTrial(s: Scenario, expect: TestContext['expect'], user: Linked,
    card: 'pm_card_visa' | 'pm_card_chargeCustomerFail' = 'pm_card_visa'): Promise<TrialSubscriber> {
    const caller = callerFor(s, user);
    const quote = await caller.quoteTrial();
    const expectedEnd = plusOneMonth(new Date(s.nowSec * 1000));
    expect(quote).toMatchObject({ sku: TRIAL_SKU, todayCents: 0, amountCents: 2000, currency: 'usd', interval: 'month',
        trialEndsAt: iso(expectedEnd), firstChargeAt: iso(expectedEnd) });
    const quoted = await trialRowFor(user.userId);
    expect(quoted).toMatchObject({ status: 'quoted', stripeSubscriptionId: null, sku: TRIAL_SKU });
    expect(epochSeconds(quoted!.trialEnd)).toBe(epochSeconds(expectedEnd));

    const checkout = await caller.createCheckout({ sku: TRIAL_SKU, trial: { trialEndsAt: quote.trialEndsAt } });
    s.stripe.checkoutSessions.push(checkout.sessionId);
    const session = await stripeRequest('GET', `/checkout/sessions/${checkout.sessionId}`);
    const metadata = object(session.metadata);
    const checkoutFacts = {
        mode: session.mode, status: session.status, customer: idOf(session.customer), clientReference: session.client_reference_id === user.userId,
        paymentMethodCollection: session.payment_method_collection, trialMetadata: metadata.ezil_trial === quoted!.id,
        trialEndMetadata: metadata.ezil_trial_end, expiresInSeconds: Number(session.expires_at) - s.nowSec,
    };
    expect(checkoutFacts).toEqual({ mode: 'subscription', status: 'open', customer: user.customerId, clientReference: true,
        paymentMethodCollection: 'always', trialMetadata: true, trialEndMetadata: String(epochSeconds(expectedEnd)),
        expiresInSeconds: 3600 });
    check(s, `checkout:${checkout.sessionId}`, { ...checkoutFacts, trialMetadata: 'trial row id', amountToday: session.amount_total });
    expect(await trialRowFor(user.userId)).toMatchObject({ status: 'checkout', checkoutSessionId: checkout.sessionId, stripeCustomerId: user.customerId });
    // Headless: Checkout is never completed. Expire it so nothing else can complete it, as the template does.
    await stripeRequest('POST', `/checkout/sessions/${checkout.sessionId}/expire`, {});

    const paymentMethodId = await attachPaymentMethod(s, user, card);
    const subscription = await stripeForm<Subscription>(s, '/subscriptions', {
        customer: user.customerId,
        items: [{ price: standardPrice }],
        default_payment_method: paymentMethodId,
        expand: ['latest_invoice'],
        // EXACTLY the trial parameters Checkout's subscription_data carries; never hand-typed.
        ...trialSubscriptionData(TRIAL_SKU, { trialId: quoted!.id, trialEnd: quoted!.trialEnd }),
    }, `ezil-trial-e2e:${runId}:${quoted!.id}`);
    const zero = object(subscription.latest_invoice) as Invoice;
    expect({ status: subscription.status, trialEnd: subscription.trial_end, invoiceTotal: zero.total, invoiceStatus: zero.status,
        billingReason: zero.billing_reason }).toEqual({ status: 'trialing', trialEnd: epochSeconds(expectedEnd), invoiceTotal: 0,
        invoiceStatus: 'paid', billingReason: 'subscription_create' });
    const trialStart = new Date(subscription.trial_start! * 1000);
    const trialEnd = new Date(subscription.trial_end! * 1000);
    const trialRoot = `ezil-os:v1:standard_monthly_v3:${subscription.id}:${trialStart.toISOString()}:trial`;
    const started: TrialSubscriber = { ...user, trialId: quoted!.id, subscriptionId: subscription.id, zeroInvoiceId: zero.id,
        paymentMethodId, trialStart, trialEnd, trialRoot };
    await waitFor(async () => {
        const [row, grants, outbox] = await Promise.all([trialRowFor(user.userId), grantsFor(user.userId), outboxFor(user.userId)]);
        return row?.status === 'trialing' && row.stripeSubscriptionId === subscription.id
            && grants.some(grant => grant.kind === 'trial_period') && outbox.some(item => item.eventKey === `${trialRoot}:grant`);
    }, { label: 'trial bound, granted and queued' });
    // Never advance before the trial-start deliveries landed: a late one would re-read a later state.
    await waitForCapture(s, 'customer.subscription.created delivery', c => c.type === 'customer.subscription.created' && c.objectId === subscription.id);
    await waitForCapture(s, '$0 invoice.paid delivery', c => c.type === 'invoice.paid' && c.objectId === zero.id);
    return started;
}

/** Exact DB outcome of a started trial (scenario 1; re-checked as the baseline elsewhere). */
async function expectTrialStarted(s: Scenario, expect: TestContext['expect'], user: TrialSubscriber): Promise<void> {
    const grants = await grantsFor(user.userId);
    expect(grants.map(({ id: _id, createdAt: _c, ...grant }) => grant)).toEqual([{
        userId: user.userId, subscriptionId: user.subscriptionId, meter: 'compute_std_seconds', kind: 'trial_period',
        amount: BigInt(TRIAL_STD_SECONDS), periodStart: user.trialStart, periodEnd: user.trialEnd, sourceType: 'trial',
        sourceId: user.subscriptionId,
    }]);
    const aiGrants = (await outboxFor(user.userId)).filter(item => item.kind === 'ai_grant');
    expect(aiGrants.map(item => ({ eventKey: item.eventKey, entitlementId: object(item.payload).entitlementId,
        credits: object(item.payload).credits, expiresAt: object(item.payload).expiresAt, invoiceId: object(item.payload).invoiceId })))
        .toEqual([{ eventKey: `${user.trialRoot}:grant`, entitlementId: user.trialRoot, credits: 200,
            expiresAt: user.trialEnd.toISOString(), invoiceId: null }]);
    expect(await trialRowFor(user.userId)).toMatchObject({ status: 'trialing', stripeSubscriptionId: user.subscriptionId,
        stripeCustomerId: user.customerId, trialStart: user.trialStart });
    expect(await subscriptionRow(user)).toMatchObject({ status: 'trialing', sku: TRIAL_SKU, trialStart: user.trialStart,
        trialEnd: user.trialEnd, firstPaidAt: null });
}

/** Advance past the trial end; Stripe creates, finalizes and attempts the first $20 invoice. */
async function passTrialEnd(s: Scenario, user: TrialSubscriber): Promise<string> {
    await advanceClock(s, epochSeconds(user.trialEnd) + 2 * HOUR);
    const current = await stripeRequest<Subscription>('GET', `/subscriptions/${user.subscriptionId}`);
    const invoiceId = idOf(current.latest_invoice);
    if (!invoiceId || invoiceId === user.zeroInvoiceId) throw new Error('No first charge invoice after the trial end');
    learn(s, invoiceId);
    return invoiceId;
}
async function waitForPlanGrant(user: TrialSubscriber, invoiceId: string) {
    return waitFor(async () => {
        const rows = (await grantsFor(user.userId)).filter(row => row.kind === 'plan_period' && row.sourceId === invoiceId);
        return rows.length ? rows : null;
    }, { label: 'plan_period grant in database' });
}
async function expectConverted(s: Scenario, expect: TestContext['expect'], user: TrialSubscriber, invoiceId: string): Promise<void> {
    const invoice = await stripeRequest<Invoice>('GET', `/invoices/${invoiceId}`);
    const line = invoice.lines?.data.find(item => item.period);
    const periodEnd = plusOneMonth(user.trialEnd);
    expect({ status: invoice.status, total: invoice.total, paid: invoice.amount_paid, lineStart: line?.period?.start, lineEnd: line?.period?.end })
        .toEqual({ status: 'paid', total: 2000, paid: 2000, lineStart: epochSeconds(user.trialEnd), lineEnd: epochSeconds(periodEnd) });
    await waitFor(async () => (await trialRowFor(user.userId))?.status === 'converted', { label: 'converted trial row' });
    const grants = await grantsFor(user.userId);
    expect(grants.filter(row => row.kind === 'plan_period').map(({ id: _id, createdAt: _c, ...row }) => row)).toEqual([{
        userId: user.userId, subscriptionId: user.subscriptionId, meter: 'compute_std_seconds', kind: 'plan_period',
        amount: BigInt(TRIAL_STD_SECONDS), periodStart: user.trialEnd, periodEnd, sourceType: 'invoice', sourceId: invoiceId,
    }]);
    expect(grants.filter(row => row.kind === 'trial_period')).toHaveLength(1);
    const periodRoot = `ezil-os:v1:standard_monthly_v3:${user.subscriptionId}:${user.trialEnd.toISOString()}`;
    const outbox = await outboxFor(user.userId);
    expect(outbox.filter(item => item.eventKey === `${periodRoot}:grant`).map(item => ({ kind: item.kind,
        entitlementId: object(item.payload).entitlementId, credits: object(item.payload).credits,
        expiresAt: object(item.payload).expiresAt, invoiceId: object(item.payload).invoiceId })))
        .toEqual([{ kind: 'ai_grant', entitlementId: periodRoot, credits: 200,
            expiresAt: new Date(periodEnd.getTime() + 3 * DAY_MS).toISOString(), invoiceId }]);
    expect(outbox.filter(item => item.eventKey === `${user.trialRoot}:grant`)).toHaveLength(1);
    expect(outbox.filter(item => item.kind === 'ai_revoke')).toEqual([]);
    const row = await waitFor(async () => {
        const current = await subscriptionRow(user);
        return current?.status === 'active' ? current : null;
    }, { label: 'active subscription row' });
    expect(row.firstPaidAt).not.toBeNull();
    const summary = await summaryOf(s, user);
    expect({ trial: summary.plan.trial, standing: summary.computer.standing, paymentIssue: summary.plan.paymentIssue, sku: summary.plan.sku })
        .toEqual({ trial: undefined, standing: 'paid', paymentIssue: null, sku: TRIAL_SKU });
    expect(await paidPoolCovers(s, user.userId)).toEqual({ instanceType: 'm6i.large' });
    check(s, 'converted', { invoiceId, invoiceTotal: invoice.total, periodStart: iso(user.trialEnd), periodEnd: iso(periodEnd),
        periodAiRoot: periodRoot, firstPaidAtSet: true, trialStatus: 'converted', planTrialPresent: false });
}

/** An accepted delivery, re-posted unsigned and forged while still fresh: both 400, no state change. */
async function signatureControls(s: Scenario, expect: TestContext['expect']): Promise<void> {
    const capture = s.captures.find(c => !c.held && c.httpStatus === 200 && c.signatureHeader && c.signedAt !== null
        && Math.floor(Date.now() / 1000) - c.signedAt < TOLERANCE_SECONDS - 30);
    if (!capture) throw new Error('No fresh accepted delivery for the signature controls');
    const before = await stableState(s.users);
    const unsigned = await deliver(s, capture, 'control_unsigned', capture.rawBody, null);
    const tampered = Buffer.from(capture.rawBody);
    // Change exactly one ASCII byte in the event ID, preserving JSON and object relevance even if minified.
    const idOffset = tampered.indexOf(Buffer.from(capture.id));
    if (idOffset < 0) throw new Error('Captured event ID is missing from raw delivery');
    const changedByte = idOffset + capture.id.length - 1;
    tampered[changedByte] = tampered[changedByte] === 65 ? 66 : 65;
    const tamperedId = String(object(JSON.parse(tampered.toString('utf8'))).id);
    const forged = await deliver(s, capture, 'control_forged', tampered, capture.signatureHeader, tamperedId);
    expect([unsigned.delivery, forged.delivery].map(d => ({ status: d.httpStatus, signature: d.signature, error: d.error, outcome: d.outcome })))
        .toEqual([{ status: 400, signature: 'absent', error: 'invalid_signature', outcome: null },
            { status: 400, signature: 'rejected', error: 'invalid_signature', outcome: null }]);
    expect(forged.delivery.ageSeconds!).toBeLessThan(TOLERANCE_SECONDS); // Rejected for its MAC, not for its age.
    expect(await stableState(s.users)).toEqual(before);
    expect(await db.select().from(billingEvents).where(eq(billingEvents.eventId, tamperedId))).toEqual([]);
}

function scenario(n: number, name: string, body: (s: Scenario, expect: TestContext['expect']) => Promise<void>): void {
    const s: Scenario = { n, name: `${n}. ${name}`, status: 'pending', error: null, clock: null, nowSec: 0, users: [], captures: [],
        deliveries: [], reruns: [], hold: null, held: [], checks: {}, db: emptySnapshot(), controller: new AbortController(),
        stripe: { clock: null, customers: [], subscriptions: [], invoices: [], paymentIntents: [], charges: [], refunds: [],
            checkoutSessions: [], paymentMethods: [] } };
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
                // Every Stripe-signed delivery that reached the handler on arrival was verified and accepted.
                const arrivals = s.deliveries.filter(d => d.kind === 'stripe' && d.phase === 'scenario');
                expect(arrivals.filter(d => d.httpStatus !== 200 || d.signature !== 'verified')).toEqual([]);
                expect(arrivals.filter(d => d.outcome !== null && /^(review|failed|unattributed):/.test(d.outcome))).toEqual([]);
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

(enabled ? describe.concurrent : describe.skip)('Standard trial: real Stripe-signed lifecycle', () => {
    beforeAll(async () => {
        try {
            const port = Number(forwardPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid STRIPE_E2E_FORWARD_PORT');
            if (publishableKey && !publishableKey.startsWith('pk_test_')) throw new Error('STRIPE_E2E_PUBLISHABLE must be a test key');
            if (new URL(databaseUrl).hostname !== '127.0.0.1') throw new Error('BILLING_TEST_DATABASE_URL must be an isolated 127.0.0.1 database');
            // Before any write: the test account, in test mode (the wrapper checks too).
            const [account, balance] = await Promise.all([
                stripeRequest<StripeObject>('GET', '/account', undefined, undefined),
                stripeRequest<StripeObject & { livemode: boolean }>('GET', '/balance', undefined, undefined),
            ]);
            if (account.id !== EXPECTED_ACCOUNT || balance.livemode !== false) throw new Error('Not the expected Stripe test account in test mode');
            pool = postgres(databaseUrl, { max: 8, connect_timeout: 15, connection: { statement_timeout: 30_000 } });
            db = drizzle(pool, { schema });
            store = createBillingStore(db);
            if (!hasAiTopupReceipts(store)) throw new Error('Store lacks AI top-up receipts');
            stripe = createStripeClient({ secretKey });
            usage = createStripeUsageBilling({ secretKey });
            // Wall time: Stripe signs with wall time. The processor's clock is injected per delivery (deliver()).
            webhookDeps = { config: billingConfig(), store, stripe, usage, now: () => new Date() };
            // GoTrue's auth.users columns that the trial facts and the paid-compute SQL read (absent from the image).
            await pool`alter table auth.users add column if not exists email_confirmed_at timestamptz,
                add column if not exists deleted_at timestamptz, add column if not exists banned_until timestamptz`;
            const [trials] = await pool`select to_regclass('public.ezil_billing_trials') is not null as present`;
            if (trials?.present !== true) throw new Error('Migration 0021 is not applied');
            // Read-only catalog lookup; prices are never created.
            if (CATALOG_V3[TRIAL_SKU].stripeLookupKey !== 'ezil_standard_monthly_v3') throw new Error('Unexpected Standard lookup key');
            const price = await stripe.resolvePrice('ezil_standard_monthly_v3');
            if (price.id !== EXPECTED_PRICE || price.unitAmount !== 2000 || price.currency !== 'usd' || !price.recurring) {
                throw new Error('ezil_standard_monthly_v3 is not the expected $20/month USD price');
            }
            standardPrice = price.id;
            server = createServer((req, res) => {
                const task = receive(req, res).catch(() => { if (!res.writableEnded) respond(res, 500, { error: 'receiver_failed' }); });
                receiverTasks.add(task);
                void task.finally(() => receiverTasks.delete(task));
            });
            await new Promise<void>((resolve, reject) => {
                server!.once('error', reject);
                server!.listen(port, '127.0.0.1', () => { server!.off('error', reject); resolve(); });
            });
            await writeReport();
        } catch (error) {
            for (const s of scenarios) failScenario(s, error);
            await writeReport().catch(() => {});
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
                    check(s, 'cleanup', 'test clock deleted (its customers and subscriptions with it); customers were labelled ezil_e2e/ezil_run');
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

    scenario(1, 'trial start: $0, one trial grant, trial AI root, trialing summary', async (s, expect) => {
        const user = await startTrial(s, expect, await createTenant(s, 'a'));
        await signatureControls(s, expect);
        await expectTrialStarted(s, expect, user);
        expect((await grantsFor(user.userId)).filter(row => row.kind === 'plan_period')).toEqual([]);
        const invoices = await stripeRequest<StripeList<Invoice>>('GET', `/invoices?customer=${user.customerId}&limit=100`);
        expect(invoices.data.map(row => ({ id: row.id, total: row.total, status: row.status, reason: row.billing_reason })))
            .toEqual([{ id: user.zeroInvoiceId, total: 0, status: 'paid', reason: 'subscription_create' }]);
        const summary = await summaryOf(s, user);
        expect(summary.plan.trial).toEqual({ state: 'trialing', startedAt: iso(user.trialStart), endsAt: iso(user.trialEnd),
            firstChargeAt: iso(user.trialEnd), amountCents: 2000, currency: 'usd' });
        expect({ sku: summary.plan.sku, standing: summary.computer.standing, graceEndsAt: summary.plan.graceEndsAt ?? null,
            paymentIssue: summary.plan.paymentIssue, upgrade: summary.actions.upgrade })
            .toEqual({ sku: TRIAL_SKU, standing: 'paid', graceEndsAt: null, paymentIssue: null, upgrade: false });
        // The renewal amount is Stripe's own preview when it reads (null when the preview is unavailable).
        if (summary.plan.renewal !== null) expect(summary.plan.renewal.amountCents).toBe(2000);
        const entitlement = await billingV2EntitlementReader(() => clockDeps(s)).read(user.userId);
        expect(entitlement).toMatchObject({ source: 'billing_v2', planId: TRIAL_SKU, status: 'active', size: 'std-2',
            provider: 'aws', paymentIssue: false });
        expect(await paidPoolCovers(s, user.userId)).toEqual({ instanceType: 'm6i.large' });
        check(s, 'trialStart', { subscriptionId: user.subscriptionId, zeroInvoiceId: user.zeroInvoiceId, trialRoot: user.trialRoot,
            trialStart: iso(user.trialStart), trialEnd: iso(user.trialEnd), grant: { kind: 'trial_period', amount: TRIAL_STD_SECONDS },
            planPeriodRows: 0, summaryTrial: summary.plan.trial, renewal: summary.plan.renewal, renewalFromStripePreview: summary.plan.renewal !== null,
            standing: summary.computer.standing, entitlement: { status: entitlement?.status, size: entitlement?.size },
            paidComputeSql: 'covers (m6i.large)' });
    });

    scenario(2, 'duplicate replay of the captured Stripe-signed requests adds nothing', async (s, expect) => {
        const user = await startTrial(s, expect, await createTenant(s, 'a'));
        await expectTrialStarted(s, expect, user);
        const before = await stableState(s.users);
        const originals = s.captures.filter(c => !c.held && c.httpStatus === 200);
        expect(originals.map(c => c.type)).toEqual(expect.arrayContaining(['customer.subscription.created', 'invoice.paid']));
        for (const capture of originals) {
            const { delivery } = await deliver(s, capture, 'replay');
            expect({ id: delivery.eventId, status: delivery.httpStatus, duplicate: delivery.duplicate, signature: delivery.signature,
                fresh: delivery.ageSeconds! < TOLERANCE_SECONDS }).toEqual({ id: capture.id, status: 200, duplicate: true,
                signature: 'verified', fresh: true });
        }
        expect(await stableState(s.users)).toEqual(before);
        await signatureControls(s, expect);
        check(s, 'replays', { replayed: originals.length, newRows: 0 });
    });

    scenario(3, 'out of order after conversion: late $0 invoice and older subscription events', async (s, expect) => {
        // Keep the $0 subscription_create invoice.paid undelivered; customer.subscription.created starts the trial.
        const zeroPaid = (c: Capture) => c.type === 'invoice.paid' && c.billingReason === 'subscription_create';
        s.hold = zeroPaid;
        const user = await startTrial(s, expect, await createTenant(s, 'a'));
        await expectTrialStarted(s, expect, user);
        await signatureControls(s, expect);
        // From here to conversion, subscription updates are also kept undelivered.
        s.hold = c => zeroPaid(c) || c.type === 'customer.subscription.updated';
        const invoiceId = await passTrialEnd(s, user);
        await waitForPlanGrant(user, invoiceId);
        await expectConverted(s, expect, user, invoiceId);
        s.hold = null;
        const before = await stableState(s.users, { events: false });
        const activeBefore = await subscriptionRow(user);

        // (a) First delivery, after conversion, of the Stripe-signed requests that were kept back (oldest first).
        const held = [...s.held].sort((a, b) => a.seq - b.seq);
        expect(held.some(zeroPaid)).toBe(true);
        const late = [];
        for (const capture of held) {
            const { delivery } = await deliver(s, capture, 'held');
            late.push(delivery);
            if (delivery.ageSeconds! < TOLERANCE_SECONDS - 5) {
                expect({ status: delivery.httpStatus, signature: delivery.signature, duplicate: delivery.duplicate, outcome: delivery.outcome })
                    .toEqual({ status: 200, signature: 'verified', duplicate: false, outcome: 'applied' });
            } else {
                // Older than Stripe's signature tolerance: the handler must refuse it (the rerun below covers the processor).
                expect({ status: delivery.httpStatus, error: delivery.error }).toEqual({ status: 400, error: 'invalid_signature' });
            }
        }
        // (b) The same captured bytes and header of already-processed older events, re-posted after conversion.
        const older = s.captures.filter(c => !c.held && c.httpStatus === 200 && c.type === 'customer.subscription.created');
        expect(older).toHaveLength(1);
        for (const capture of older) {
            const { delivery } = await deliver(s, capture, 'replay');
            const fresh = delivery.ageSeconds! < TOLERANCE_SECONDS - 5;
            expect({ status: delivery.httpStatus, duplicate: delivery.duplicate, error: delivery.error })
                .toEqual(fresh ? { status: 200, duplicate: true, error: null } : { status: 400, duplicate: false, error: 'invalid_signature' });
        }
        // (c) The processor itself on every older event (past the inbox, as a retried delivery runs): no re-grant, no regression.
        for (const capture of [...older, ...held]) expect(await rerunProcessor(s, capture)).toBe('applied');

        expect(await stableState(s.users, { events: false })).toEqual(before);
        const grants = await grantsFor(user.userId);
        expect(grants.map(row => row.kind).sort()).toEqual(['plan_period', 'trial_period']);
        const after = await subscriptionRow(user);
        expect({ status: after?.status, start: after?.currentPeriodStart, end: after?.currentPeriodEnd, firstPaidAt: after?.firstPaidAt })
            .toEqual({ status: 'active', start: activeBefore?.currentPeriodStart, end: activeBefore?.currentPeriodEnd, firstPaidAt: activeBefore?.firstPaidAt });
        expect(after?.currentPeriodStart).toEqual(user.trialEnd);
        expect((await trialRowFor(user.userId))?.status).toBe('converted');
        check(s, 'outOfOrder', {
            heldFirstDeliveries: late.map(d => ({ eventId: d.eventId, type: d.type, httpStatus: d.httpStatus, outcome: d.outcome, ageSeconds: d.ageSeconds })),
            proved: {
                held: 'first delivery of the kept-back Stripe-signed requests after conversion (when within the 300 s tolerance): processed, no re-grant',
                replay: 'already-processed older event re-posted: inbox duplicate (or 400 when older than the tolerance)',
                processor_rerun: 'processStripeEvent on every older event at the post-conversion clock: applied, no re-grant, no status regression',
            },
            grants: grants.map(row => row.kind), subscriptionStatus: after?.status, trialStatus: 'converted',
        });
    });

    scenario(4, 'cancel at period end during the trial: no invoice, no revoke, trial ended', async (s, expect) => {
        const user = await startTrial(s, expect, await createTenant(s, 'a'));
        await signatureControls(s, expect);
        const caller = callerFor(s, user);
        expect(await caller.cancelAtPeriodEnd({ cancel: true })).toEqual({ cancelsAt: iso(user.trialEnd) });
        await waitFor(async () => (await subscriptionRow(user))?.cancelAtPeriodEnd === true, { label: 'cancelAtPeriodEnd from webhook' });
        const ending = await summaryOf(s, user);
        expect({ trial: ending.plan.trial, planEndsAt: ending.plan.planEndsAt, standing: ending.computer.standing }).toEqual({
            trial: { state: 'ending', startedAt: iso(user.trialStart), endsAt: iso(user.trialEnd), firstChargeAt: null,
                amountCents: 2000, currency: 'usd' },
            planEndsAt: iso(user.trialEnd), standing: 'plan_ending' });

        await advanceClock(s, epochSeconds(user.trialEnd) + 2 * HOUR);
        await waitFor(async () => (await subscriptionRow(user))?.status === 'canceled', { label: 'canceled subscription row' });
        await waitFor(async () => (await trialRowFor(user.userId))?.status === 'ended', { label: 'ended trial row' });
        const sub = await stripeRequest<Subscription>('GET', `/subscriptions/${user.subscriptionId}`);
        expect({ status: sub.status, endedAt: sub.ended_at }).toEqual({ status: 'canceled', endedAt: epochSeconds(user.trialEnd) });
        const invoices = await stripeRequest<StripeList<Invoice>>('GET', `/invoices?customer=${user.customerId}&limit=100`);
        expect(invoices.data.map(row => ({ id: row.id, total: row.total }))).toEqual([{ id: user.zeroInvoiceId, total: 0 }]);
        const grants = await grantsFor(user.userId);
        expect(grants.map(row => row.kind)).toEqual(['trial_period']);
        const outboxBefore = await outboxFor(user.userId);
        expect(outboxBefore.filter(item => item.kind === 'ai_revoke' || item.eventKey.startsWith(`${user.trialRoot}:revoke`))).toEqual([]);
        const ended = await summaryOf(s, user);
        expect({ standing: ended.computer.standing, trial: ended.plan.trial, sku: ended.plan.sku, offer: ended.trialOffer })
            .toEqual({ standing: 'free', trial: undefined, sku: 'free_v3', offer: { eligible: false, reason: 'trial_used' } });
        expect(await refusal(caller.quoteTrial())).toEqual({ code: 'PRECONDITION_FAILED', message: 'trial_unavailable' });
        expect(await paidPoolCovers(s, user.userId)).toBeNull();
        expect((await outboxFor(user.userId)).filter(item => item.kind === 'ai_revoke')).toEqual([]);
        check(s, 'cancelAtPeriodEnd', { cancelsAt: iso(user.trialEnd), endingTrialState: 'ending', subscriptionStatus: sub.status,
            invoices: invoices.data.length, planPeriodRows: 0, trialStatus: 'ended', revokeRows: 0, standing: 'free', requote: 'refused' });
    });

    scenario(5, 'immediate cancel during the trial: one revoke, trial canceled, top-up untouched', async (s, expect) => {
        const user = await startTrial(s, expect, await createTenant(s, 'a'));
        await signatureControls(s, expect);
        // An unrelated purchased top-up receipt (and its ledger row) for the same user.
        const pack = customTopupPack(1000)!;
        const paymentIntentId = `pi_seed${runTag}s5`;
        const expires = new Date(clockOf(s).getTime() + 365 * DAY_MS);
        const receipt = aiTopupOutboxItem(user.userId, pack, paymentIntentId, expires)!;
        const topups = store;
        if (!hasAiTopupReceipts(topups)) throw new Error('Store lacks AI top-up receipts');
        expect(await topups.recordAiTopup({
            userId: user.userId, meter: 'ai_usd_micro', kind: 'topup', amount: BigInt(pack.creditCents) * BigInt(10_000),
            periodStart: clockOf(s), periodEnd: expires, sourceType: 'payment_intent', sourceId: paymentIntentId,
        }, receipt)).toBe('applied');
        const topupRows = async () => ({
            outbox: (await outboxFor(user.userId)).filter(item => item.eventKey === receipt.eventKey),
            grants: (await grantsFor(user.userId)).filter(row => row.sourceId === paymentIntentId),
        });
        const seeded = await topupRows();
        expect([seeded.outbox.length, seeded.grants.length]).toEqual([1, 1]);

        await stripeRequest('DELETE', `/subscriptions/${user.subscriptionId}`);
        await waitFor(async () => (await trialRowFor(user.userId))?.status === 'canceled', { label: 'canceled trial row' });
        const revokes = await waitFor(async () => {
            const rows = (await outboxFor(user.userId)).filter(item => item.kind === 'ai_revoke');
            return rows.length ? rows : null;
        }, { label: 'trial root revoke row' });
        expect(revokes.map(item => ({ eventKey: item.eventKey, entitlementId: object(item.payload).entitlementId,
            credits: object(item.payload).credits, action: object(item.payload).action })))
            .toEqual([{ eventKey: `${user.trialRoot}:revoke`, entitlementId: user.trialRoot, credits: 200, action: 'revoke' }]);
        expect((await subscriptionRow(user))?.status).toBe('canceled');
        expect(await topupRows()).toEqual(seeded);
        expect((await grantsFor(user.userId)).filter(row => row.kind === 'plan_period')).toEqual([]);
        const summary = await summaryOf(s, user);
        expect({ standing: summary.computer.standing, trial: summary.plan.trial, offer: summary.trialOffer })
            .toEqual({ standing: 'free', trial: undefined, offer: { eligible: false, reason: 'trial_used' } });
        expect(await refusal(callerFor(s, user).quoteTrial())).toEqual({ code: 'PRECONDITION_FAILED', message: 'trial_unavailable' });
        expect(await paidPoolCovers(s, user.userId)).toBeNull();
        // Re-read: still exactly one revoke after the summary and the refusal.
        expect((await outboxFor(user.userId)).filter(item => item.kind === 'ai_revoke')).toHaveLength(1);
        check(s, 'immediateCancel', { revokeEventKey: `${user.trialRoot}:revoke`, trialStatus: 'canceled', standing: 'free',
            seededTopup: { eventKey: receipt.eventKey, untouched: true } });
    });

    scenario(6, 'successful first charge converts the trial once', async (s, expect) => {
        const user = await startTrial(s, expect, await createTenant(s, 'a'));
        await signatureControls(s, expect);
        const invoiceId = await passTrialEnd(s, user);
        await waitForPlanGrant(user, invoiceId);
        await expectConverted(s, expect, user, invoiceId);
        const paid = await waitForCapture(s, 'first charge invoice.paid', c => c.type === 'invoice.paid' && c.objectId === invoiceId);
        expect(paid.httpStatus).toBe(200);
        expect((await grantsFor(user.userId)).map(row => row.kind).sort()).toEqual(['plan_period', 'trial_period']);
    });

    scenario(7, 'failed first charge: Free at once, no grace; recovery grants once', async (s, expect) => {
        const user = await startTrial(s, expect, await createTenant(s, 'a'), 'pm_card_chargeCustomerFail');
        await signatureControls(s, expect);
        const invoiceId = await passTrialEnd(s, user);
        await waitForCapture(s, 'invoice.payment_failed delivery', c => c.type === 'invoice.payment_failed' && c.objectId === invoiceId);
        await waitFor(async () => (await subscriptionRow(user))?.status === 'past_due', { label: 'past_due subscription row' });
        await waitFor(async () => (await trialRowFor(user.userId))?.status === 'payment_failed', { label: 'payment_failed trial row' });
        await waitFor(async () => (await store.openPaymentIssues(user.userId)).some(row => row.stripeInvoiceId === invoiceId),
            { label: 'first-charge payment issue' });
        const invoice = await stripeRequest<Invoice>('GET', `/invoices/${invoiceId}`);
        expect({ status: invoice.status, total: invoice.total, paid: invoice.amount_paid }).toEqual({ status: 'open', total: 2000, paid: 0 });
        const failed = await summaryOf(s, user);
        expect({ standing: failed.computer.standing, graceEndsAt: failed.plan.graceEndsAt ?? null, paymentIssue: failed.plan.paymentIssue,
            trialState: failed.plan.trial?.state }).toEqual({ standing: 'free', graceEndsAt: null, paymentIssue: 'payment_failed', trialState: 'payment_failed' });
        expect(await paidPoolCovers(s, user.userId)).toBeNull();
        const freeEntitlement = await billingV2EntitlementReader(() => clockDeps(s)).read(user.userId);
        expect(freeEntitlement).toMatchObject({ planId: 'free_v3', provider: 'cloudflare' });
        expect((await grantsFor(user.userId)).map(row => row.kind)).toEqual(['trial_period']);
        // The trial root expired at the trial end by itself: nothing to revoke.
        expect((await outboxFor(user.userId)).filter(item => item.kind === 'ai_revoke')).toEqual([]);
        check(s, 'paymentFailed', { invoiceId, subscriptionStatus: 'past_due', trialStatus: 'payment_failed', standing: 'free',
            graceEndsAt: null, planTrialState: 'payment_failed', paidComputeSql: 'not covered', entitlementPlan: freeEntitlement?.planId });

        // Recovery: a working card as the default, then pay the open invoice.
        const visa = await stripeRequest('POST', '/payment_methods/pm_card_visa/attach', { customer: user.customerId });
        s.stripe.paymentMethods.push(visa.id);
        await stripeRequest('POST', `/customers/${user.customerId}`, { 'invoice_settings[default_payment_method]': visa.id });
        await stripeRequest('POST', `/subscriptions/${user.subscriptionId}`, { default_payment_method: visa.id });
        await stripeRequest('POST', `/invoices/${invoiceId}/pay`, {});
        await waitForPlanGrant(user, invoiceId);
        await expectConverted(s, expect, user, invoiceId);
        await waitFor(async () => !(await store.openPaymentIssues(user.userId)).some(row => row.stripeInvoiceId === invoiceId),
            { label: 'resolved first-charge issue' });
        const recovered = await billingV2EntitlementReader(() => clockDeps(s)).read(user.userId);
        expect(recovered).toMatchObject({ planId: TRIAL_SKU, status: 'active', size: 'std-2' });
        check(s, 'recovered', { paidWith: 'pm_card_visa', planPeriodOnce: true, trialRegrant: false, standing: 'paid' });
    });

    scenario(8, 'eligibility: bound, same person, paid before, concurrent claims', async (s, expect) => {
        const offer = (summary: BillingSummaryWithAi) => summary.trialOffer;
        // A bound trial, and the same person under another account.
        const a = await startTrial(s, expect, await createTenant(s, 'a'));
        await signatureControls(s, expect);
        const boundBefore = await trialRowFor(a.userId);
        expect(await refusal(callerFor(s, a).quoteTrial())).toEqual({ code: 'PRECONDITION_FAILED', message: 'trial_unavailable' });
        expect(await trialRowFor(a.userId)).toEqual(boundBefore);
        const b = await createUser(s, a.email.replace('@', '+b@'));
        expect(normalizeEmail(b.email)).toBe(normalizeEmail(a.email));
        expect(offer(await summaryOf(s, b))).toEqual({ eligible: false, reason: 'trial_used' });
        expect(await refusal(callerFor(s, b).quoteTrial())).toEqual({ code: 'PRECONDITION_FAILED', message: 'trial_unavailable' });
        expect(await trialRowFor(b.userId)).toBeUndefined();

        // Paid before: a real non-trial Standard period, then an immediate cancel back to Free.
        const c = await createTenant(s, 'c');
        const cardId = await attachPaymentMethod(s, c, 'pm_card_visa');
        const paidSub = await stripeForm<Subscription>(s, '/subscriptions', {
            customer: c.customerId, items: [{ price: standardPrice }], default_payment_method: cardId, expand: ['latest_invoice'],
            metadata: { sku: TRIAL_SKU, ezil_catalog: 'v3' },
        }, `ezil-trial-e2e:${runId}:paid-before`);
        const paidInvoice = requiredId(paidSub.latest_invoice);
        await waitFor(async () => (await grantsFor(c.userId)).some(row => row.kind === 'plan_period' && row.sourceId === paidInvoice && row.amount > BigInt(0)),
            { label: 'paid-before plan_period grant' });
        await stripeRequest('DELETE', `/subscriptions/${paidSub.id}`);
        await waitFor(async () => (await subscriptionRow({ ...c, subscriptionId: paidSub.id }))?.status === 'canceled', { label: 'paid-before cancel' });
        const cSummary = await summaryOf(s, c);
        expect({ family: cSummary.plan.sku, offer: offer(cSummary) }).toEqual({ family: 'free_v3', offer: { eligible: false, reason: 'paid_before' } });
        expect(await refusal(callerFor(s, c).quoteTrial())).toEqual({ code: 'PRECONDITION_FAILED', message: 'trial_unavailable' });
        const g = await createUser(s, c.email.replace('@', '+g@'));
        expect(offer(await summaryOf(s, g))).toEqual({ eligible: false, reason: 'paid_before' });

        // A fresh person is eligible (the refusals above are not vacuous).
        const f = await createUser(s, emailFor(s, 'f'));
        expect(offer(await summaryOf(s, f))).toEqual({ eligible: true, sku: TRIAL_SKU, endsAt: iso(plusOneMonth(clockOf(s))),
            amountCents: 2000, currency: 'usd' });

        // Two accounts of one person quote at the same time: exactly one claim.
        const d = await createUser(s, emailFor(s, 'dup'));
        const e = await createUser(s, emailFor(s, 'dup').replace('@', '+e@'));
        const results = await Promise.allSettled([callerFor(s, d).quoteTrial(), callerFor(s, e).quoteTrial()]);
        const fulfilled = results.filter(result => result.status === 'fulfilled');
        const rejected = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        expect(fulfilled).toHaveLength(1);
        expect(rejected.map(error => error instanceof TRPCError ? { code: error.code, message: error.message } : safeError(error)))
            .toEqual([{ code: 'PRECONDITION_FAILED', message: 'trial_unavailable' }]);
        const claims = await db.select({ userId: billingTrials.userId, status: billingTrials.status }).from(billingTrials)
            .where(eq(billingTrials.emailNormalized, normalizeEmail(d.email)!));
        expect(claims).toHaveLength(1);
        expect(claims[0]!.status).toBe('quoted');
        expect([d.userId, e.userId]).toContain(claims[0]!.userId);
        const winner = claims[0]!.userId === d.userId ? 'first' : 'second';
        expect(results[winner === 'first' ? 0 : 1]!.status).toBe('fulfilled');
        const rows = await db.execute(sql`select count(*)::int as n from public.ezil_billing_trials where user_id in (${d.userId}::uuid, ${e.userId}::uuid)`);
        expect(Number(object([...rows][0]).n)).toBe(1);
        check(s, 'eligibility', { boundRequote: 'refused', samePersonOtherAccount: 'trial_used', paidBefore: 'paid_before',
            paidBeforeSamePerson: 'paid_before', freshPerson: 'eligible', concurrentSamePerson: { fulfilled: 1, refused: 1, claims: 1 },
            paidBeforeSubscription: paidSub.id, paidBeforeInvoice: paidInvoice });
    });
});

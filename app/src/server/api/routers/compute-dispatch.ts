/**
 * P3 per-computer dispatch: which provider runs THIS computer
 * (docs/AWS-COMPUTERS.md C-1, R13 — chosen per computer, never by a global flip).
 *
 * Every lifecycle call in the routers goes through `routeComputer`. It is the
 * ONLY router-side module that names `selectComputeProvider` /
 * `resolveComputeProvider` (pinned by `no-direct-lifecycle-calls.test.ts`), so
 * no router path can bypass a computer's placement.
 *
 * 🔴 CLOUDFLARE STAYS BYTE-IDENTICAL. With placement reads off
 * (`EZIL_COMPUTE_PLACEMENT_READS` and `EZIL_AWS_COMPUTERS_ENABLED` unset — the
 * production default until the founder registers the placement SQL) this does
 * NOT touch the database and returns exactly what `selectComputeProvider`
 * returned before P3. With reads on, an active provider migration gets an
 * AWS-labelled waiting adapter. Otherwise a computer with no placement row,
 * or a `cloudflare` row, gets that same Cloudflare adapter instance.
 *
 * A placement owned by someone else is NOT_FOUND — the same anti-enumeration
 * answer `assertOwnedComputer` gives — and it is raised BEFORE any provider is
 * returned, so no provider call can happen for a foreign computer.
 */

import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';

import { billingV2EntitlementReader, gateComputerStart } from '@/server/billing/v2/compute-access';
import type { BillingDeps } from '@/server/billing/ports';
import { SIZES, type SizeCode } from '@/server/billing/v2/contract';
import { planFromSubscriptions } from '@/server/billing/v3/catalog';
import type { SwitchConfigurationOutputV3, SwitchPhaseV3 } from '@/server/billing/v3/contract';
import { meteredSizeForInstanceType } from '@/server/lib/compute/aws-config';
import { preflightSwitchCapacity, type SwitchCapacity } from '@/server/lib/compute/aws-pool-runtime';
import { recordComputeTiming } from '@/server/lib/compute/aws-pool-timing';
import {
    AWS_SIZE_CODES, readComputerMeta, resolveTransition, TRANSITION_IN_FLIGHT, TRANSITION_REQUEST_ID, TRANSITION_STOP_TIMEOUT_MS,
    TRANSITION_WAKE_TIMEOUT_MS, writeTransition, type AwsSizeCode, type ComputerTransition, type TransitionKind,
} from '@/server/lib/compute/progress';
import { TERMINAL_MIGRATION_STATES } from '@/server/lib/compute/provider-migrate';
import { createProviderMigrationStore } from '@/server/lib/compute/provider-migrate-store';
import { POOL_SESSION_PENDING, type Placement, type PlacementState } from '@/server/lib/compute/placement';
import { billingComputeMeter } from '@/server/billing/v2/compute-meter';
import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from '@/server/lib/compute/aws-config';
import { createPoolDeps } from '@/server/lib/compute/aws-pool-runtime';
import type { PlacementDb } from '@/server/lib/compute/placement';
import { sharedAwsSdkCollaborators } from '@/server/lib/compute/aws-clients';
import { workerTunnelClientFromEnv } from '@/server/lib/compute/aws-enroll';
import type { AwsPreviewResult } from '@/server/lib/compute/aws-preview';
import type { CloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { PlacementOwnerError, readLastUsageStop, readPlacement, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { AwsComputeStatus, AwsProviderDeps } from '@/server/lib/compute/aws-ec2';
import type { ComputeCtx, ComputeProvider, ComputeStatus, ComputerRef, EnsureResult, StopResult } from '@/server/lib/compute/provider';
import { resolveComputeProvider, selectComputeProvider } from '@/server/lib/compute/select';
import { migrationStartingAnswer } from '@/server/lib/compute/provider-migrate-placement';
import { plusPlanIds, resolveEntitlement, tierForEntitlement, type EntitlementReader, type EntitlementRecord } from '@/server/lib/compute/tier';

export type RoutedComputer =
    | { kind: 'cloudflare'; provider: CloudflareComputeProvider }
    | { kind: 'aws-ec2'; provider: ComputeProvider; instanceType: string | null };

/**
 * The AWS provider's runtime collaborators: the Step Functions starter and
 * execution reader (aws-clients.ts: Vercel OIDC → the region's app-caller
 * role, no stored keys) and the GW-1 tunnel client (the Worker). With the AWS
 * flag off nothing is built. With it on but the caller unconfigured (any
 * region without its role), there is no starter, so an AWS computer's
 * `ensure`/`stop` refuse BEFORE any write (`aws_lifecycle_unconfigured`) —
 * never Cloudflare. This is the ONE place the routers get them from.
 */
export function defaultAwsCollaborators(env: Env = process.env): Pick<AwsProviderDeps, 'starter' | 'executions' | 'tunnels' | 'describer' | 'meter'> {
    if (!isAwsComputersEnabled(env)) return {};
    const { starter, executions, describer } = sharedAwsSdkCollaborators(env);
    const tunnels = workerTunnelClientFromEnv(env) ?? undefined;
    return {
        // Shared by router dispatch and sandbox-reap's background reconcile.
        meter: billingComputeMeter(),
        ...(starter ? { starter } : {}), ...(executions ? { executions } : {}), ...(tunnels ? { tunnels } : {}),
        // The read-only EC2 describe that catches a guest-initiated idle stop (R9).
        ...(describer ? { describer } : {}),
    };
}

export interface RouteOptions {
    env?: Env;
    /** Defaults to billing v2, whose reader touches no store while billing is off. */
    entitlements?: EntitlementReader;
    /** Overrides `defaultAwsCollaborators(env)` (tests). */
    aws?: Pick<AwsProviderDeps, 'starter' | 'executions' | 'tunnels' | 'describer' | 'meter' | 'randomBytes' | 'now' | 'newId' | 'leaseSeconds'>;
    /** The caller starts a sandbox: pin a no-row Cloudflare computer first (select.ts `ResolveOptions`). */
    pinCloudflare?: boolean;
}

/** The AWS provider deps the routers supply: the collaborators plus the tier source. */
export function awsDepsFor(env: Env, entitlement: EntitlementRecord | null | undefined | (() => Promise<EntitlementRecord | null>), aws: RouteOptions['aws'] = {}) {
    return {
        ...aws,
        entitlement: typeof entitlement === 'function' ? undefined : entitlement,
        tierFor: async () => tierForEntitlement(typeof entitlement === 'function' ? await entitlement() : entitlement, plusPlanIds(env)),
    };
}

export async function routeComputer(
    db: unknown,
    computer: ComputerRef,
    { env = process.env, entitlements = billingV2EntitlementReader(), aws = defaultAwsCollaborators(env), pinCloudflare = false }: RouteOptions = {},
): Promise<RoutedComputer> {
    // Flag off: no database read at all — the pre-P3 call, unchanged.
    if (!isPlacementReadEnabled(env)) return { kind: 'cloudflare', provider: selectComputeProvider(computer) };
    let provider: ComputeProvider;
    let instanceType: string | null = null;
    let entitlement: Promise<EntitlementRecord | null> | undefined;
    const getEntitlement = () => entitlement ??= resolveEntitlement(computer.userId, entitlements);
    try {
        // Gate routing with the authenticated owner before any reservation read.
        // The resolver repeats this check for its own fresh placement read.
        await readPlacement(db as PlacementExecutor, computer.computerId, computer.userId);
        provider = await resolveComputeProvider(db as PlacementExecutor, computer, env, { ...awsDepsFor(env, getEntitlement, aws), pool: createPoolDeps(db as PlacementDb, env) }, {
            pinCloudflare, resolveEntitlement: getEntitlement,
            onPlacement: placement => { instanceType = placement.record?.instanceType ?? null; },
        });
    } catch (err) {
        if (err instanceof PlacementOwnerError) {
            // NOT_FOUND, never FORBIDDEN — a foreign computer must look absent.
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
        }
        throw err; // duplicate/unknown placement, missing table: fail closed, never Cloudflare.
    }
    // A cloudflare placement keeps the exact pre-P3 adapter (and its richer result type).
    if (provider.kind === 'cloudflare') return { kind: 'cloudflare', provider: selectComputeProvider(computer) };
    return { kind: 'aws-ec2', provider, instanceType };
}

/**
 * AWS answers the shell must read as "still waking": a cold boot takes minutes,
 * and the shell's wake loop (`shell/ezil/session.js` `withWakeAndOneRetry`)
 * re-asks on `sandbox_starting` for up to its wake deadline while showing
 * "Waking your machine". Mapping to that EXISTING code is what gives an AWS
 * cold boot a visible state without a shell change.
 */
const AWS_WAKING_CODES: ReadonlySet<string> = new Set(['computer_starting', 'computer_stopping']);

/** The shell-facing error code for a not-ready AWS `ensure`. */
export function shellCodeForAwsEnsure(result: Extract<EnsureResult, { ok: false }>): string {
    return result.retryable && AWS_WAKING_CODES.has(result.errorCode) ? 'sandbox_starting' : result.errorCode;
}

/** The migration may begin after dispatch read Cloudflare. Preserve the Worker's
 * fence refusal as an AWS-budget wait, including when placement reads are disabled.
 * Do not classify unrelated conflicts or ordinary Cloudflare cold starts as AWS.
 */
export function cloudflareMigrationAnswer(result: ComputeStatus) {
    const prefix = 'worker_http_409: ';
    if (result.ok || !result.error?.startsWith(prefix)) return null;
    try {
        if (JSON.parse(result.error.slice(prefix.length))?.error !== 'migrating') return null;
    } catch { return null; }
    return { ...migrationStartingAnswer(), computeMigrating: true as const, provider: 'cloudflare-guacamole' as const };
}

/** Only MIGOPEN's waiting provider emits this error; ordinary AWS wakes do not. */
function awsMigrationAnswer(result: ComputeStatus) {
    return !result.ok && result.error === 'computer_migrating'
        ? { computeMigrating: true as const } : {};
}

/** Hotfix r5: how long a just-STOPPED AWS computer is not auto-started by a hosted-app poll. */
export const STOP_COOLDOWN_MS = 60_000;

/**
 * Hotfix r5 (ACCEPT-11865d06 B6), defence in depth: a hosted-app route (`codePreviewUrl`,
 * `appPreviewUrl`) asked while the AWS placement settled STOPPED less than `STOP_COOLDOWN_MS` ago
 * answers this refusal VALUE instead of running `ensure()`, which would start (replace) the computer
 * the owner just stopped — an app window's leftover poll (another tab, an older client) re-provisioned
 * one 0.23 s after its stop. The key is a settled STOPPED placement whose last RUN ended (its usage
 * row closed, `readLastUsageStop`) less than `STOP_COOLDOWN_MS` ago — not the placement's `updated_at`:
 * a pool-mode open of a long-stopped computer passes through STOPPED itself (ensure writes STOPPING
 * `pool_open_release`, the release receipt lands STOPPED `pool_released`, the next ensure replaces), and
 * that start must not be refused. No stop reason is recorded, so any recent run ending holds (user Stop,
 * idle or session limit). STOPPING/DRAINING are not held: ensure() writes STOPPING to START a pool-mode
 * open, and switch/restart pass through DRAINING. Not `sandbox_starting`: the client's wake loop re-asks
 * that for 215 s and would start it once the hold ended; `computer_stopped` is terminal for the client's
 * automatic re-ask (boot-phases AWS refusals) and has its own copy. The desktop open is never held, so
 * Settings → Open desktop still starts it. Any read failure answers null: the existing path runs unchanged.
 */
export async function stopCooldownAnswer(db: PlacementExecutor, computer: ComputerRef, now: number = Date.now()) {
    try {
        const { record } = await readPlacement(db, computer.computerId, computer.userId);
        if (record?.provider !== 'aws-ec2' || record.state !== 'STOPPED') return null;
        const ended = await readLastUsageStop(db, computer.computerId, computer.userId);
        if (!ended) return null;
        const age = now - ended.getTime();
        if (!(age > -STOP_COOLDOWN_MS && age < STOP_COOLDOWN_MS)) return null;
    } catch {
        return null;
    }
    return { ok: false as const, error: 'computer_stopped', errorCode: 'computer_stopped', retryable: false,
        provider: 'cloudflare-guacamole' as const, computeProvider: 'aws-ec2' as const };
}

/**
 * The preview answer for an AWS computer. Not-ready → a VALUE (never a throw:
 * a thrown error is what TanStack retries, and the wake loop already re-asks).
 * Ready → ask the Worker's AWS route for the current placement's URLs.
 * The callback is lazy: an ensure refusal must never issue a preview request.
 */
export async function awsPreviewAnswer(result: EnsureResult, preview: () => Promise<AwsPreviewResult>, preparePool?: () => Promise<void>,
    hold?: { wait(): Promise<boolean>; ensure(): Promise<EnsureResult>; signal?: AbortSignal }) {
    if (!result.ok && result.errorCode === 'computer_starting' && result.retryable && !hold?.signal?.aborted) {
        // Keep the existing relay preparation ahead of the hold: waiting must not
        // defer the exchange that lets the host reach session-ready.
        await preparePool?.();
        if (hold && !hold.signal?.aborted && await hold.wait() && !hold.signal?.aborted) {
            const ensured = await hold.ensure();
            if (!hold.signal?.aborted) result = ensured;
        }
    }
    if (!result.ok) {
        return {
            ok: false as const,
            error: result.errorCode,
            errorCode: shellCodeForAwsEnsure(result),
            retryable: result.retryable,
            provider: 'cloudflare-guacamole' as const,
            computeProvider: 'aws-ec2' as const,
            ...awsMigrationAnswer(result),
            // RETRY-118: the expired attempt an explicit user Retry may reset; nothing else carries it.
            ...(result.errorCode === 'capacity_attempt_expired' && result.capacityAttemptId
                ? { capacityAttemptId: result.capacityAttemptId } : {}),
            ...(result.errorCode === 'computer_starting' && result.retryable === true && result.computeLaunching === true
                ? { computeLaunching: true as const } : {}),
        };
    }
    return {
        ...await preview(),
        provider: 'cloudflare-guacamole' as const,
        computeProvider: 'aws-ec2' as const,
    };
}

/** How long the shell's stop waits for an AWS stop to be confirmed (its route allows 300 s). */
export const AWS_SHELL_STOP_BUDGET_MS = 200_000;
/** Interval between status looks (each applies the stop's lifecycle receipt). */
export const AWS_SHELL_STOP_POLL_MS = 5_000;

/**
 * The shell's stop contract (`POST /api/shell/stop`, e2e/hosted-continuity.mjs) for an
 * AWS computer: a CONFIRMED answer, never "requested". An AWS stop is asynchronous (a
 * lifecycle job), so this starts it (or finds one in flight) and polls `status`, which
 * applies the job's receipt, until the placement is STOPPED or the budget runs out:
 * - already STOPPED → `{ ok: true, terminated: false, outcome: 'not_running' }`;
 * - reaches STOPPED within the budget → `{ ok: true, terminated: true, outcome: 'destroyed' }`;
 * - still draining/stopping at the deadline → `{ ok: false, terminated: false, outcome:
 *   'still_running' }`, the shell's "not yet" (the client asks again; never a false success);
 * - any other answer (refused, moved to another state) is returned as a failure unchanged.
 */
export async function confirmAwsStop(
    provider: ComputeProvider,
    ctx: ComputeCtx,
    computer: ComputerRef,
    opts: { budgetMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<StopResult> {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (opts.budgetMs ?? AWS_SHELL_STOP_BUDGET_MS);
    const first = await provider.stop(ctx, computer, 'user');
    if (first.ok) return { ok: true, terminated: false, outcome: 'not_running' };
    if (!['stopping', 'placement_draining', 'placement_stopping'].includes(first.outcome ?? '')) return first;
    while (now() < deadline) {
        await sleep(Math.max(0, Math.min(opts.pollMs ?? AWS_SHELL_STOP_POLL_MS, deadline - now())));
        const placementState = ((await provider.status(ctx, computer)) as AwsComputeStatus).placementState;
        if (placementState === 'STOPPED') return { ok: true, terminated: true, outcome: 'destroyed' };
        if (placementState !== 'DRAINING' && placementState !== 'STOPPING') {
            const outcome = placementState ? `placement_${placementState.toLowerCase()}` : 'aws_status_unavailable';
            return { ok: false, terminated: false, outcome, error: outcome };
        }
    }
    return { ok: false, terminated: false, outcome: 'still_running' };
}

/**
 * The status answer for an AWS computer, in the shape the desktop canvas already
 * polls: `guacamoleRunning` is its "the machine is up" mid-boot signal, which for
 * AWS means the lifecycle reports `running`. The lifecycle `state`
 * (`starting`/`running`/`stopping`/`stopped`/`error`) is passed through as well.
 */
export function awsStatusAnswer(status: ComputeStatus) {
    const state = (status as AwsComputeStatus).state;
    return { ...status, guacamoleRunning: status.ok === true && state === 'running', computeProvider: 'aws-ec2' as const,
        ...awsMigrationAnswer(status) };
}

// ── One computer, selectable configuration (round 3, contract v3 D5) ─────────

/** What the switch and restart drivers touch beyond the placement: billing, routing and time. */
export interface TransitionDeps {
    env?: Env;
    now?: () => Date;
    newId?: () => string;
    billing?: () => BillingDeps;
    /** `routeComputer` options for the driver's own provider (tests inject collaborators). */
    route?: RouteOptions;
    /** Runs the stop → wake driver after the answer (`after()` in production, awaited in tests). */
    schedule?: (work: () => Promise<void>) => void;
    stop?: { budgetMs?: number; pollMs?: number };
    wake?: { budgetMs?: number; pollMs?: number };
    sleep?: (ms: number) => Promise<void>;
    preflight?: (db: PlacementExecutor, p: Placement, targetType: string, env: Env, now: Date) => Promise<SwitchCapacity>;
    /** Defaults to `routeComputer` (tests inject a scripted provider). */
    routeComputer?: (db: unknown, computer: ComputerRef, options: RouteOptions) => Promise<RoutedComputer>;
    /** The pool-session preview exchange for a pending warm adopt (`prepareAwsPoolSession`). */
    preparePool?: (db: PlacementExecutor, computer: ComputerRef, correlationId: string) => Promise<void>;
    /** The computer's provider migration, if any (defaults to the migration store). */
    migration?: (db: PlacementExecutor, computerId: string) => Promise<{ state: string } | null>;
}

export type RestartComputerOutput =
    | { ok: true; transitionId: string; path: 'restart'; size: AwsSizeCode }
    | { ok: false; reason: 'not_running' | 'busy' | 'switch_in_progress' | 'foreign_computer' | 'not_entitled' | 'aws_monthly_cap' | 'unavailable' };

const TRANSITION_POLL_MS = 5_000;
const BUSY_STATES: readonly PlacementState[] = ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RECOVERING', 'RETIRING'];
const isAwsSize = (size: unknown): size is AwsSizeCode => (AWS_SIZE_CODES as readonly unknown[]).includes(size);

async function defaultBilling(): Promise<BillingDeps> {
    const { getBillingDeps } = await import('@/server/billing/deps');
    return getBillingDeps();
}
function defaultSchedule(work: () => Promise<void>): void {
    const run = () => work().catch(() => console.error('[compute.transition] driver failed'));
    // Registered synchronously, inside the request scope (as provider-migrate-orchestrator.ts does).
    try { after(run); } catch { void run(); }
}

/**
 * A warm adopt reaches session-ready only after the Worker's preview exchange for the new epoch
 * (the open route runs it as `prepareAwsPoolSession` before its hold). A server-initiated wake
 * has no browser open, so the driver runs the same exchange once per pool-pending lease epoch.
 */
async function defaultPreparePool(db: PlacementExecutor, computer: ComputerRef, correlationId: string): Promise<void> {
    const [{ prepareAwsPoolSession }, { resolveCloudflareGuacamoleConfig }] = await Promise.all([
        import('@/server/lib/compute/aws-preview'), import('@/server/lib/cloudflare-guacamole-provider')]);
    await prepareAwsPoolSession(db, computer, { sessionId: computer.computerId, desktopMode: 'neko' }, resolveCloudflareGuacamoleConfig(),
        process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '', correlationId);
}

/** The same plan rule `billing.selectMachine` applies: an active Premium plan whose machine choice lists `size`. */
async function entitledTo(billing: BillingDeps, userId: string, size: SizeCode): Promise<boolean> {
    try {
        const [subs, userCreatedAt] = await Promise.all([billing.store.subscriptionsFor(userId), billing.store.userCreatedAt(userId)]);
        const plan = planFromSubscriptions({ subs, now: billing.now(), userCreatedAt });
        if (plan.sku !== 'premium_monthly_v3' || plan.status !== 'active' || !plan.offer.machineChoice.includes(size)) return false;
        // The compute entitlement itself (allowance granted, no payment issue), as every AWS open reads it.
        const record = await billingV2EntitlementReader(() => billing).read(userId);
        return record?.status === 'active' && record.provider === 'aws' && !record.paymentIssue;
    } catch { return false; }
}

/** End a transition once (compare-and-swap on its id and phase); a failed switch reverts the preference it set. */
async function finishTransition(db: PlacementExecutor, billing: BillingDeps, computer: ComputerRef, t: ComputerTransition,
    resolved: { phase: SwitchPhaseV3; reason: string | null }, now: Date): Promise<void> {
    if (resolved.phase !== 'done' && resolved.phase !== 'failed') return;
    const ended = await writeTransition(db, computer, { transitionId: t.transitionId, phase: t.phase },
        { ...t, phase: resolved.phase, reason: resolved.reason, endedAt: now.toISOString() });
    if (!ended) return;
    console.info(JSON.stringify({ event: 'compute-transition', kind: t.kind, phase: resolved.phase, reason: resolved.reason,
        current: t.current, target: t.target, ms: now.getTime() - Date.parse(t.requestedAt) }));
    // The switch phases as one durable row (telemetry ingestion): requested → stopping → waking → end.
    const at = (v: string | null) => v ? Date.parse(v) - Date.parse(t.requestedAt) : NaN;
    await recordComputeTiming(db, { site: 'compute.transition', code: `${t.kind}_${resolved.phase}`, outcome: resolved.phase === 'done' ? 'ok' : 'error',
        ownerUserId: computer.userId, computerId: computer.computerId, durationMs: now.getTime() - Date.parse(t.requestedAt),
        phases: { stopping: at(t.stoppingAt), waking: at(t.wakingAt), end: now.getTime() - Date.parse(t.requestedAt) } });
    if (resolved.phase === 'failed' && t.kind === 'switch' && t.current !== t.target) {
        // Only the preference this switch wrote: a later explicit choice is never overwritten.
        try { if (await billing.store.sizePreference(computer.userId) === t.target) await billing.store.setSizePreference(computer.userId, t.current); }
        catch { console.error('[compute.transition] preference revert failed'); }
    }
}

/** Settle a stored transition whose resolved phase ended (a driver that died); returns what is now true. */
async function settleStored(db: PlacementExecutor, billing: BillingDeps, computer: ComputerRef, p: Placement | null, now: Date) {
    const meta = await readComputerMeta(db, computer);
    if (!meta) return null;
    const t = meta.transition;
    if (!t) return { meta, t: null, resolved: null };
    const resolved = resolveTransition(t, p, now);
    if (TRANSITION_IN_FLIGHT.includes(t.phase) && !TRANSITION_IN_FLIGHT.includes(resolved.phase)) await finishTransition(db, billing, computer, t, resolved, now);
    return { meta, t, resolved };
}

/**
 * The server-side stop → wake of one transition. Every step is the existing lifecycle:
 * `confirmAwsStop` (≤ 200 s), then `ensure` on the STOPPED placement, which replaces onto the
 * same data volume as generation + 1 with a fresh fence (warm adopt of the target class, else
 * cold) because the stored preference now names the target. `ensure` is only ever called on a
 * non-RUNNING placement (it never renews a lease as owner presence). Completion is RUNNING on
 * a later lease epoch; UNCONFIRMED, `capacity:*`, a refused open or a budget overrun fails.
 */
export async function driveTransition(db: PlacementDb, computer: ComputerRef, t: ComputerTransition, deps: TransitionDeps = {}): Promise<ComputerTransition> {
    const env = deps.env ?? process.env, clock = deps.now ?? (() => new Date());
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const billing = deps.billing ? deps.billing() : await defaultBilling();
    const ctx = { correlationId: t.transitionId };
    let current = t;
    const advance = async (phase: SwitchPhaseV3, fields: Partial<ComputerTransition>) => {
        const next = { ...current, ...fields, phase };
        if (await writeTransition(db, computer, { transitionId: current.transitionId, phase: current.phase }, next)) current = next;
        return current.phase === phase;
    };
    const fail = async (reason: string) => { await finishTransition(db, billing, computer, current, { phase: 'failed', reason }, clock()); return current; };
    try {
        // A restart wakes on the size it stopped on, whatever the stored next-open preference says.
        const route: RouteOptions = { env, ...deps.route, ...(t.kind === 'restart' ? { entitlements: sameSizeReader(deps.route?.entitlements, billing, t.current) } : {}) };
        const routed = await (deps.routeComputer ?? routeComputer)(db, computer, route);
        if (routed.kind !== 'aws-ec2') return fail('placement_missing');
        if (current.phase === 'requested' && !await advance('stopping', { stoppingAt: clock().toISOString() })) return current;
        if (current.phase === 'stopping') {
            const stopped = await confirmAwsStop(routed.provider, ctx, computer, { budgetMs: deps.stop?.budgetMs ?? TRANSITION_STOP_TIMEOUT_MS,
                pollMs: deps.stop?.pollMs, sleep, now: () => clock().getTime() });
            if (!stopped.ok) return fail(stopped.outcome === 'still_running' ? 'stop_timeout' : `stop_${stopped.outcome ?? 'refused'}`.slice(0, 64));
            if (!await advance('waking', { wakingAt: clock().toISOString() })) return current;
        }
        const gate = await gateComputerStart({ deps: billing, ...computer, kind: 'aws-ec2', instanceType: routed.instanceType, now: billing.now() });
        if (!gate.allowed) return fail(`billing_${gate.reason}`);
        const deadline = (Date.parse(current.wakingAt ?? '') || clock().getTime()) + (deps.wake?.budgetMs ?? TRANSITION_WAKE_TIMEOUT_MS);
        let prepared = -1;
        for (;;) {
            const { record: p } = await readPlacement(db, computer.computerId, computer.userId);
            const resolved = resolveTransition(current, p, clock());
            if (resolved.phase === 'done' || resolved.phase === 'failed') { await finishTransition(db, billing, computer, current, resolved, clock()); return current; }
            if (clock().getTime() >= deadline) return fail('wake_timeout');
            if (p && p.leaseEpoch > current.fromLeaseEpoch && p.lastError === POOL_SESSION_PENDING && prepared !== p.leaseEpoch) {
                prepared = p.leaseEpoch;
                await (deps.preparePool ?? defaultPreparePool)(db, computer, ctx.correlationId).catch(() => undefined);
            }
            if (p && p.state !== 'RUNNING') {
                const woke = await routed.provider.ensure(ctx, computer, { sessionId: computer.computerId, desktopMode: 'neko' });
                if (!woke.ok && !woke.retryable) return fail(woke.errorCode === 'capacity_unavailable' ? 'capacity_unavailable' : woke.errorCode.slice(0, 64));
            } else await routed.provider.status(ctx, computer);
            await sleep(Math.max(0, Math.min(deps.wake?.pollMs ?? TRANSITION_POLL_MS, deadline - clock().getTime())));
        }
    } catch (error) {
        if (error instanceof TRPCError) return fail('placement_unavailable');
        console.error('[compute.transition] driver error');
        return current;
    }
}

function sameSizeReader(inner: EntitlementReader | undefined, billing: BillingDeps, size: AwsSizeCode): EntitlementReader {
    const base = inner ?? billingV2EntitlementReader(() => billing);
    return { async read(userId) { const record = await base.read(userId); return record ? { ...record, size } : record; } };
}

async function startTransition(db: PlacementDb, computer: ComputerRef, kind: TransitionKind, p: Placement, current: AwsSizeCode, target: AwsSizeCode,
    requestId: string, deps: TransitionDeps): Promise<ComputerTransition | 'conflict'> {
    const now = (deps.now ?? (() => new Date()))();
    const t: ComputerTransition = { v: 1, transitionId: (deps.newId ?? randomUUID)(), requestId, kind,
        computerId: computer.computerId.toLowerCase(), userId: computer.userId.toLowerCase(), current, target, phase: 'requested', reason: null,
        fromGeneration: p.generation, fromLeaseEpoch: p.leaseEpoch, requestedAt: now.toISOString(), stoppingAt: null, wakingAt: null, endedAt: null };
    return await writeTransition(db, computer, null, t) ? t : 'conflict';
}

function runDriver(db: PlacementDb, computer: ComputerRef, t: ComputerTransition, deps: TransitionDeps): void {
    (deps.schedule ?? defaultSchedule)(async () => { await driveTransition(db, computer, t, deps); });
}

const sameRequest = (t: ComputerTransition, requestId: string, target: SizeCode) => t.requestId === requestId || (t.kind === 'switch' && t.target === target);

/**
 * `computer.switchConfiguration` (contract v3 `SwitchConfiguration*`). Checks in order:
 * ownership, the `selectMachine` plan rule, an in-flight transition (the same request id or the
 * same target answers that transition; another target is `switch_in_progress`), then by state:
 * RUNNING → capacity preflight before any stop, then a persisted transition and the server
 * stop → wake (`switching`); STOPPED (or no AWS host yet) → the preference only (`next_start`);
 * opening, stopping or migrating → `computer_busy`.
 */
export async function switchComputerConfiguration(db: PlacementDb, computer: ComputerRef, input: { size: SizeCode; requestId: string },
    deps: TransitionDeps = {}): Promise<SwitchConfigurationOutputV3> {
    const env = deps.env ?? process.env, now = (deps.now ?? (() => new Date()))();
    const billing = deps.billing ? deps.billing() : await defaultBilling();
    let p: Placement | null;
    try { p = isPlacementReadEnabled(env) ? (await readPlacement(db, computer.computerId, computer.userId)).record : null; }
    catch (error) { if (error instanceof PlacementOwnerError) return { ok: false, reason: 'foreign_computer' }; throw error; }
    const settled = await settleStored(db, billing, computer, p, now);
    if (!settled) return { ok: false, reason: 'foreign_computer' };
    if (!isAwsSize(input.size) || !TRANSITION_REQUEST_ID.test(input.requestId) || !await entitledTo(billing, computer.userId, input.size)) return { ok: false, reason: 'not_entitled' };
    const target = input.size;
    if (settled.t && settled.resolved && TRANSITION_IN_FLIGHT.includes(settled.resolved.phase)) {
        return sameRequest(settled.t, input.requestId, target)
            ? { ok: true, effective: 'switching', current: settled.t.current, target: settled.t.target, transitionId: settled.t.transitionId }
            : { ok: false, reason: 'switch_in_progress' };
    }
    const aws = p?.provider === 'aws-ec2' ? p : null;
    const running = meteredSizeForInstanceType(aws?.instanceType);
    const preferred = isAwsSize(running) ? null : await billing.store.sizePreference(computer.userId);
    const current: AwsSizeCode = isAwsSize(running) ? running : isAwsSize(preferred) ? preferred : 'std-2';
    // Fail closed: an unreadable migration state is busy, never a stop of a computer mid-migration.
    let migrating: boolean;
    try {
        const migration = await (deps.migration ?? ((x, id) => createProviderMigrationStore(x).readByComputer(id)))(db, computer.computerId);
        migrating = !!migration && !TERMINAL_MIGRATION_STATES.includes(migration.state as never);
    } catch { return { ok: false, reason: 'computer_busy' }; }
    if (aws?.state === 'RUNNING' && !migrating && target !== current) {
        const preflight = await (deps.preflight ?? preflightSwitchCapacity)(db, aws, SIZES[target].machine, env, now);
        if (!preflight.ok) {
            console.info(JSON.stringify({ event: 'compute-transition', kind: 'switch', phase: 'refused', reason: preflight.reason, current, target }));
            // D11: the AWS monthly cap is a distinct, explainable refusal; egress caps stay an entitlement matter.
            return { ok: false, reason: preflight.reason === 'user_hours_cap' ? 'aws_monthly_cap'
                : preflight.reason === 'user_egress_cap' ? 'not_entitled' : 'capacity_unavailable' };
        }
        const t = await startTransition(db, computer, 'switch', aws, current, target, input.requestId, deps);
        if (t === 'conflict') {
            // A concurrent tab won: answer its transition when it is this same request, else refuse.
            const again = await readComputerMeta(db, computer);
            return again?.transition && TRANSITION_IN_FLIGHT.includes(again.transition.phase) && sameRequest(again.transition, input.requestId, target)
                ? { ok: true, effective: 'switching', current: again.transition.current, target: again.transition.target, transitionId: again.transition.transitionId }
                : { ok: false, reason: 'switch_in_progress' };
        }
        await billing.store.setSizePreference(computer.userId, target);
        console.info(JSON.stringify({ event: 'compute-transition', kind: 'switch', phase: 'requested', current, target }));
        runDriver(db, computer, t, deps);
        return { ok: true, effective: 'switching', current, target, transitionId: t.transitionId };
    }
    if (migrating || (aws && BUSY_STATES.includes(aws.state))) return { ok: false, reason: 'computer_busy' };
    // Stopped, not yet on AWS, already on this size, or waiting on recovery: the next start opens on `target`.
    await billing.store.setSizePreference(computer.userId, target);
    return { ok: true, effective: 'next_start', current, target, transitionId: (deps.newId ?? randomUUID)() };
}

/**
 * `computer.restartComputer`: the whole computer, not only its desktop service. A confirmed
 * stop, then a server-initiated open on the SAME size (warm adopt or cold), reported as a
 * transition whose opening path is `restart`. Only a RUNNING AWS computer restarts.
 */
export async function restartWholeComputer(db: PlacementDb, computer: ComputerRef, input: { requestId: string }, deps: TransitionDeps = {}): Promise<RestartComputerOutput> {
    const env = deps.env ?? process.env, now = (deps.now ?? (() => new Date()))();
    const billing = deps.billing ? deps.billing() : await defaultBilling();
    if (!isPlacementReadEnabled(env) || !isAwsComputersEnabled(env)) return { ok: false, reason: 'unavailable' };
    let p: Placement | null;
    try { p = (await readPlacement(db, computer.computerId, computer.userId)).record; }
    catch (error) { if (error instanceof PlacementOwnerError) return { ok: false, reason: 'foreign_computer' }; throw error; }
    const settled = await settleStored(db, billing, computer, p, now);
    if (!settled) return { ok: false, reason: 'foreign_computer' };
    if (!TRANSITION_REQUEST_ID.test(input.requestId)) return { ok: false, reason: 'unavailable' };
    if (settled.t && settled.resolved && TRANSITION_IN_FLIGHT.includes(settled.resolved.phase)) {
        return settled.t.kind === 'restart' && settled.t.requestId === input.requestId
            ? { ok: true, transitionId: settled.t.transitionId, path: 'restart', size: settled.t.current } : { ok: false, reason: 'switch_in_progress' };
    }
    if (!p || p.provider !== 'aws-ec2') return { ok: false, reason: 'not_running' };
    if (BUSY_STATES.includes(p.state)) return { ok: false, reason: 'busy' };
    const size = meteredSizeForInstanceType(p.instanceType);
    if (p.state !== 'RUNNING' || !isAwsSize(size)) return { ok: false, reason: 'not_running' };
    const gate = await gateComputerStart({ deps: billing, ...computer, kind: 'aws-ec2', instanceType: p.instanceType, now: billing.now() });
    if (!gate.allowed) return { ok: false, reason: 'not_entitled' };
    const t = await startTransition(db, computer, 'restart', p, size, size, input.requestId, deps);
    if (t === 'conflict') {
        const again = await readComputerMeta(db, computer);
        return again?.transition?.kind === 'restart' && again.transition.requestId === input.requestId
            ? { ok: true, transitionId: again.transition.transitionId, path: 'restart', size } : { ok: false, reason: 'switch_in_progress' };
    }
    console.info(JSON.stringify({ event: 'compute-transition', kind: 'restart', phase: 'requested', current: size, target: size }));
    runDriver(db, computer, t, deps);
    return { ok: true, transitionId: t.transitionId, path: 'restart', size };
}

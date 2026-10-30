import { z } from 'zod';

import {
    CORRELATION_HEADER,
    deriveGuacamoleSandboxId,
    type CloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';

import { readAwsBrowserZone, type Env } from './aws-config';
import {
    ENROLLMENT_FAILED, ENROLLMENT_PENDING, POOL_SESSION_PENDING, ImageJobConflictError, PlacementIntegrityError, PlacementOwnerError,
    readPlacement, type Placement, type PlacementExecutor,
} from './placement';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ComputerRef, EnsureOptions } from './provider';
import { PollDeadline, pollWait } from './poll-wait';

type UnavailableReason = 'config_missing' | 'zone_invalid' | 'endpoint_invalid' | 'placement_missing'
    | 'placement_foreign' | 'placement_provider' | 'placement_not_running' | 'placement_epoch_invalid'
    | 'placement_integrity' | 'placement_reserved' | 'placement_read_failed' | 'enrollment_failed'
    | 'sign_failed' | 'parse_failed' | `worker_status_${number}`;

/**
 * Round 6 (seam B): which window asks (worker/src/aws-origin.ts `awsPreviewSurface`). Code and the hosted
 * app are answered once the desktop config is applied (Code: once code-server answers too), without
 * waiting on the desktop's relay. Absent is the desktop, whose signed body stays byte-identical to the
 * one sent before this field existed. A Worker that predates it parses the body field by field and never
 * reads an unknown key (74ed2c92 `handlePreview`); the v2 digest covers the bytes either way.
 */
export type AwsPreviewSurface = 'code' | 'app';
/** The preview's options: the provider's ensure options plus the asking surface (never sent to `ensure`). */
export type AwsPreviewOptions = EnsureOptions & { surface?: AwsPreviewSurface };

/**
 * Round 6 (seam A): the reasons the Worker gives with `503 aws_desktop_starting` (worker/src/aws-ice.ts
 * `AwsDesktopStarting`, aws-origin.ts `code_starting`), a closed set. Every one is retryable within the
 * shell's existing wake bound, like any `aws_desktop_starting`; an absent or unknown reason is too, and is
 * never echoed.
 */
export const AWS_DESKTOP_STARTING_REASONS = ['config_pushed', 'restart_scheduled', 'config_pending', 'desktop_starting', 'code_starting'] as const;
export type AwsDesktopStartingReason = typeof AWS_DESKTOP_STARTING_REASONS[number];
/**
 * Round 6 (seam C): the reasons that mean the desktop is taking this host boot's config (one push, then a
 * container restart; the Worker bounds it at 150 s, aws-ice.ts AWS_DESKTOP_CONFIG_APPLY_MS) or code-server is
 * starting after it. The answer then carries `computePreparing: true`, so the shell shows that wait's
 * expectation instead of a connect's. `desktop_starting` (no push, the desktop is booting) is not one.
 */
export const AWS_PREPARING_REASONS: readonly AwsDesktopStartingReason[] = ['config_pushed', 'restart_scheduled', 'config_pending', 'code_starting'];
/**
 * Round 6 (seam A): the Worker's terminal desktop answers and the shell code each becomes. Classified by code
 * at 502 or 503 (the Worker sends both at 502 today). Re-asking returns the same answer until the host's
 * record changes, so neither is retried: `desktop_config_unapplied` (the pushed config was still not applied
 * after the Worker's 150 s bound) and `desktop_failed` (the host's desktop restarts are exhausted).
 */
const WORKER_TERMINAL = {
    aws_desktop_config_unapplied: 'desktop_config_unapplied',
    aws_desktop_failed: 'desktop_failed',
} as const;
type WorkerTerminalCode = keyof typeof WORKER_TERMINAL;

/** The Worker's explicit transient codes by HTTP status, never an arbitrary 409/5xx (see `workerStarting`). */
const WORKER_STARTING = {
    503: ['aws_desktop_starting', 'aws_origin_starting', 'aws_desktop_unreachable'],
    502: ['aws_origin_unavailable'],
    409: ['relay_busy', 'relay_runtime_changed', 'relay_negotiation_busy'],
    504: ['relay_timeout'],
} as const;
type WorkerStartingCode = typeof WORKER_STARTING[keyof typeof WORKER_STARTING][number];
type StartingReason = 'placement_opening' | 'pool_session_pending' | 'enrollment_pending' | 'lifecycle_pending'
    | 'transport_failed' | 'epoch_moved' | WorkerStartingCode;

/**
 * Round 6 (R3-2/R3-8): why an answer was not ok — one bounded code (a category below or an allow-listed
 * Worker code) and the Worker's HTTP status when it answered — for the router's one `aws-preview` log line.
 * Kept beside the answer object, never on it: the wire answer is unchanged. Nothing logs here (the hold reads
 * placements up to 33 times per wait, and pool relay preparation has no user surface).
 */
export interface AwsPreviewRefusal {
    reason: string; status: number | null;
    /** Round 6: the Worker's `aws_desktop_starting` reason, only when it is one of AWS_DESKTOP_STARTING_REASONS. */
    detail?: AwsDesktopStartingReason;
}
const refusals = new WeakMap<object, AwsPreviewRefusal>();
const tagged = <T extends object>(answer: T, reason: string, status: number | null, detail?: AwsDesktopStartingReason): T => {
    refusals.set(answer, detail ? { reason, status, detail } : { reason, status }); return answer;
};
/** The reason `requestAwsPreview` refused with; undefined for an ok answer or any other object. */
export const awsPreviewRefusal = (answer: object): AwsPreviewRefusal | undefined => refusals.get(answer);

const unavailable = (reason: UnavailableReason, status: number | null = null) => {
    // One bounded category per refusal. Never log bodies, URLs, tokens, IDs or exceptions.
    console.warn(`[aws-preview] unavailable reason=${reason}`);
    return tagged({
        ok: false as const,
        error: 'aws_preview_unavailable',
        errorCode: 'aws_preview_unavailable',
    }, reason, status);
};

const starting = (reason: StartingReason, status: number | null = null, detail?: AwsDesktopStartingReason) =>
    tagged({
        ok: false as const, error: 'sandbox_starting', errorCode: 'sandbox_starting',
        // Seam C: additive, and only for the preparing reasons (absent otherwise), like `computeLaunching`.
        ...(detail && AWS_PREPARING_REASONS.includes(detail) ? { computePreparing: true as const } : {}),
    }, reason, status, detail);

/** Seam A: a terminal desktop answer, as its own shell code (never `aws_preview_unavailable`'s one silent re-ask). */
const desktopRefused = (code: WorkerTerminalCode, status: number) =>
    tagged({ ok: false as const, error: code, errorCode: WORKER_TERMINAL[code] }, code, status);

function placementRefusal(p: Placement | null, preparePool = false) {
    if (!p) return unavailable('placement_missing');
    if (p.provider !== 'aws-ec2') return unavailable('placement_provider');
    if (p.generation < 1 || p.leaseEpoch < 1) return unavailable('placement_epoch_invalid');
    if (preparePool) return p.lastError === POOL_SESSION_PENDING && p.enrollNonceHash === null && p.enrollConsumedHash !== null
        && p.instanceId !== null && p.volumeId !== null && p.lifecycleJobId !== null && p.lifecycleDigest !== null
        && ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(p.state) ? null : starting('pool_session_pending');
    if (p.lastError === ENROLLMENT_FAILED) return unavailable('enrollment_failed');
    if (['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(p.state)) return starting('placement_opening');
    if (p.state !== 'RUNNING') return unavailable('placement_not_running');
    // Do not sign an epoch whose enrollment or receipt is still being settled.
    if (p.enrollNonceHash || p.lastError === ENROLLMENT_PENDING) return starting('enrollment_pending');
    if (p.lifecycleJobId || p.lifecycleDigest) return starting('lifecycle_pending');
    return null;
}

// Shared by Code and desktop asks in this server process. Always released, including
// on disconnect/refusal. No transaction or database lock spans a polling delay.
const holdKey = Symbol.for('ezil.aws-preview-holds');
const processHolds = globalThis as typeof globalThis & { [holdKey]?: Set<string> };
const heldPreviews = processHolds[holdKey] ??= new Set<string>();
export async function waitForAwsPreviewPlacement(db: PlacementExecutor, computer: ComputerRef, signal?: AbortSignal): Promise<boolean> {
    const key = JSON.stringify([computer.userId.toLowerCase(), computer.computerId.toLowerCase()]);
    if (signal?.aborted || heldPreviews.has(key)) return false;
    heldPreviews.add(key);
    const poll = new PollDeadline(8_000, signal);
    const reads: PlacementExecutor = { execute: query => poll.read(() => db.execute(query)) };
    try {
        for (let check = 0; check <= 32 && !signal?.aborted; check++) {
            const { record } = await poll.read(() => readPlacement(reads, computer.computerId, computer.userId));
            poll.check();
            const refused = placementRefusal(record);
            if (!refused) return true;
            if (refused.errorCode !== 'sandbox_starting' || !record
                || !['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(record.state)) return false;
            const remaining = poll.remaining();
            if (remaining <= 0 || check === 32 || !await pollWait(Math.min(250, remaining), signal)) return false;
        }
    } catch {
        // The ordinary ensure/preview path retains its existing refusal response.
    } finally {
        heldPreviews.delete(key);
    }
    return false;
}

/** The Worker's `aws_desktop_starting` reason when it is in the closed set, else undefined (never echoed). */
function workerStartingReason(data: unknown): AwsDesktopStartingReason | undefined {
    const reason = (data as { reason?: unknown } | null)?.reason;
    return AWS_DESKTOP_STARTING_REASONS.find(r => r === reason);
}

/** The Worker's terminal desktop code at 502 or 503 (`WORKER_TERMINAL`), or null. */
function workerTerminal(status: number, data: unknown): WorkerTerminalCode | null {
    if (status !== 502 && status !== 503) return null;
    const parsed = z.object({ ok: z.literal(false).optional(), error: z.string() }).safeParse(data);
    if (!parsed.success || !Object.hasOwn(WORKER_TERMINAL, parsed.data.error)) return null;
    return parsed.data.error as WorkerTerminalCode;
}

/** The Worker's transient code (from `WORKER_STARTING` only), or null. */
function workerStarting(status: number, data: unknown): WorkerStartingCode | null {
    const parsed = z.object({ ok: z.literal(false).optional(), error: z.string() }).safeParse(data);
    if (!parsed.success) return null;
    const error = parsed.data.error;
    // Pin to the Worker's explicit transient codes, never an arbitrary 409/5xx.
    // aws-origin.ts uses 502 aws_origin_unavailable for an absent or mismatched tunnel.
    // aws-ice.ts uses 503 aws_desktop_unreachable while the host control service boots.
    const codes: readonly WorkerStartingCode[] | undefined = (WORKER_STARTING as Partial<Record<number, readonly WorkerStartingCode[]>>)[status];
    return codes?.find(code => code === error) ?? null;
}

/**
 * The route token the Worker appends to every AWS browser host:
 * `aws-<port>-<sandboxId>-aws.<zoneRoot>` (worker/src/aws-origin.ts `AWS_BROWSER_ROUTE_TOKEN`,
 * claimed by the narrow `*-aws.<zone>/*` route). Pinned against the Worker source by
 * aws-preview.test.ts.
 */
export const AWS_BROWSER_ROUTE_TOKEN = 'aws';

/** Preserve the bootstrap URL verbatim; never compose a Cloudflare bridge URL. */
function bootstrapUrl(port: number, sandboxId: string, zone: string) {
    const label = `aws-${port}-${sandboxId}-${AWS_BROWSER_ROUTE_TOKEN}`.toLowerCase();
    return z.string().url().refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port
            && url.hostname === `${label}.${zone}`
            && url.pathname === '/preview-bootstrap' && !!url.searchParams.get('token');
    });
}

/**
 * The same POST/body/v2 envelope as requestGuacamolePreview, with AWS claims.
 * Keep HTTP classification here: the Cloudflare helper deliberately has its
 * own error classification and wake-budget behavior, which must not change.
 */
export async function requestAwsPreview(
    db: PlacementExecutor,
    computer: ComputerRef,
    options: AwsPreviewOptions,
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    correlationId: string,
    env: Env = process.env,
    preparePool = false,
) {
    if (!config.isConfigured || !hmacSecret.trim()) return unavailable('config_missing');
    // The ONLY zone an AWS browser host may sit in: the Worker's configured preview root
    // (EZIL_AWS_BROWSER_ZONE, the same value enrollment hands the host). Never derived from
    // the Worker's own host name: `api-desktop-staging.ezil.work` and `api-desktop.ezil.org`
    // have different shapes, and a derivation that fits one silently refuses the other.
    const zone = readAwsBrowserZone(env);
    if (!zone) return unavailable('zone_invalid');
    let failureReason: UnavailableReason = 'placement_read_failed';
    try {
        // ensure may have observed a different epoch; sign only the authoritative owned
        // placement. Never substitute an image job's unconfirmed target generation/fence.
        // Check ownership BEFORE the reservation read (including the second read below).
        const readOwned = () => readPlacement(db, computer.computerId, computer.userId);
        const { record: placement } = await readOwned();
        const refused = placementRefusal(placement, preparePool);
        if (refused) return refused;
        if (!placement) return unavailable('placement_missing');
        const sandboxId = deriveGuacamoleSandboxId(placement.ownerUserId, placement.computerId);
        failureReason = 'endpoint_invalid';
        const endpoint = new URL(`${config.workerUrl.replace(/\/$/, '')}/sandbox/preview`);
        if (endpoint.search || endpoint.hash) return unavailable('endpoint_invalid');
        const body = JSON.stringify({
            sessionId: options.sessionId,
            userId: placement.ownerUserId,
            projectId: placement.computerId,
            desktopMode: options.desktopMode,
            ...(options.screen ? { screen: options.screen } : {}),
            // Seam B: only when set, last. Pool relay preparation is the desktop's exchange: never a surface.
            ...(options.surface && !preparePool ? { surface: options.surface } : {}),
        });
        // AWS always requires v2, independently of the Cloudflare opt-in flag.
        // EBS has no v2 object-store claim; '' means no store claim.
        failureReason = 'sign_failed';
        const token = mintPreviewTokenV2(hmacSecret, {
            ts: Date.now(), sandboxId,
            computerId: placement.computerId, userId: placement.ownerUserId,
            provider: 'aws-ec2', store: '',
            generation: placement.generation, leaseEpoch: placement.leaseEpoch,
        }, { method: 'POST', path: endpoint.pathname, body });
        const response = await fetch(endpoint.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [CORRELATION_HEADER]: correlationId,
                [PREVIEW_TOKEN_V2_HEADER]: token,
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(210_000),
        }).catch(() => null);
        // A transport loss says nothing about the origin's readiness; let the bounded
        // shell wake loop re-ask. No inline retry with potentially stale signed claims.
        if (!response) return starting('transport_failed');
        failureReason = 'parse_failed';
        const data: unknown = await response.json();
        const retryable = workerStarting(response.status, data);
        const terminal = retryable ? null : workerTerminal(response.status, data);
        if (response.status !== 200 && !retryable && !terminal) return unavailable(`worker_status_${response.status}`, response.status);
        // Enrollment/receipt, stop or replacement may win while the Worker is answering.
        // Discard the old handoff and let the next request sign the newly confirmed pair.
        failureReason = 'placement_read_failed';
        const { record: current } = await readOwned();
        const currentRefusal = placementRefusal(current);
        if (currentRefusal) return currentRefusal;
        if (!current) return unavailable('placement_missing');
        if (current.generation !== placement.generation || current.leaseEpoch !== placement.leaseEpoch) return starting('epoch_moved', response.status);
        // A terminal answer about this same epoch (one about a replaced epoch re-asks above).
        if (terminal) return desktopRefused(terminal, response.status);
        if (retryable) return starting(retryable, response.status, retryable === 'aws_desktop_starting' ? workerStartingReason(data) : undefined);
        failureReason = 'parse_failed';
        // Allowlist the response, including only public relay metadata.
        const parsed = z.object({
            ok: z.literal(true),
            provider: z.literal('aws-ec2'),
            mode: z.literal('neko'),
            sandboxId: z.literal(sandboxId),
            generation: z.literal(placement.generation),
            leaseEpoch: z.literal(placement.leaseEpoch),
            guacamoleUrl: bootstrapUrl(8181, sandboxId, zone),
            appPreviewUrl: bootstrapUrl(3002, sandboxId, zone),
            codePreviewUrl: bootstrapUrl(8443, sandboxId, zone),
            expiresAt: z.number().int().gt(Date.now()),
            relay: z.object({
                runtimeId: z.string().regex(/^[a-f0-9]{32}$/),
                expiresAt: z.number().int().gt(Date.now()),
            }).optional(),
            turnRelay: z.boolean().optional(),
        }).safeParse(data);
        if (!parsed.success) return unavailable('parse_failed');
        // Readiness is not a browser-frame observation. Keep that field absent on the wire.
        return { ...parsed.data, correlationId, frame: undefined };
    } catch (error) {
        // Neither Worker bodies nor fetch/parse/signing exceptions reach the shell.
        if (error instanceof PlacementOwnerError) return unavailable('placement_foreign');
        if (error instanceof PlacementIntegrityError) return unavailable('placement_integrity');
        if (error instanceof ImageJobConflictError) return unavailable('placement_reserved');
        return unavailable(failureReason);
    }
}

export type AwsPreviewResult = Awaited<ReturnType<typeof requestAwsPreview>>;

/** Prime the existing Worker relay exchange after enrollment, before session-ready. No URLs escape. */
export async function prepareAwsPoolSession(...args: Parameters<typeof requestAwsPreview>): Promise<void> {
    await requestAwsPreview(args[0], args[1], args[2], args[3], args[4], args[5], args[6], true);
}

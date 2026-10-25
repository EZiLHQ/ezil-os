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

type UnavailableReason = 'config_missing' | 'zone_invalid' | 'endpoint_invalid' | 'placement_missing'
    | 'placement_foreign' | 'placement_provider' | 'placement_not_running' | 'placement_epoch_invalid'
    | 'placement_integrity' | 'placement_reserved' | 'placement_read_failed' | 'enrollment_failed'
    | 'sign_failed' | 'parse_failed' | `worker_status_${number}`;

const unavailable = (reason: UnavailableReason) => {
    // One bounded category per refusal. Never log bodies, URLs, tokens, IDs or exceptions.
    console.warn(`[aws-preview] unavailable reason=${reason}`);
    return {
        ok: false as const,
        error: 'aws_preview_unavailable',
        errorCode: 'aws_preview_unavailable',
    };
};

const starting = () => ({ ok: false as const, error: 'sandbox_starting', errorCode: 'sandbox_starting' });

function placementRefusal(p: Placement | null, preparePool = false) {
    if (!p) return unavailable('placement_missing');
    if (p.provider !== 'aws-ec2') return unavailable('placement_provider');
    if (p.generation < 1 || p.leaseEpoch < 1) return unavailable('placement_epoch_invalid');
    if (preparePool) return p.lastError === POOL_SESSION_PENDING && p.enrollNonceHash === null && p.enrollConsumedHash !== null
        && p.instanceId !== null && p.volumeId !== null && p.lifecycleJobId !== null && p.lifecycleDigest !== null
        && ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(p.state) ? null : starting();
    if (p.lastError === ENROLLMENT_FAILED) return unavailable('enrollment_failed');
    if (['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(p.state)) return starting();
    if (p.state !== 'RUNNING') return unavailable('placement_not_running');
    // Do not sign an epoch whose enrollment or receipt is still being settled.
    if (p.enrollNonceHash || p.lastError === ENROLLMENT_PENDING || p.lifecycleJobId || p.lifecycleDigest) return starting();
    return null;
}

function workerStarting(status: number, data: unknown): boolean {
    const parsed = z.object({ ok: z.literal(false).optional(), error: z.string() }).safeParse(data);
    if (!parsed.success) return false;
    const error = parsed.data.error;
    // Pin to the Worker's explicit transient codes, never an arbitrary 409/5xx.
    // aws-origin.ts uses 502 aws_origin_unavailable for an absent or mismatched tunnel.
    // aws-ice.ts uses 503 aws_desktop_unreachable while the host control service boots.
    return (status === 503 && ['aws_desktop_starting', 'aws_origin_starting', 'aws_desktop_unreachable'].includes(error))
        || (status === 502 && error === 'aws_origin_unavailable')
        || (status === 409 && ['relay_busy', 'relay_runtime_changed', 'relay_negotiation_busy'].includes(error))
        || (status === 504 && error === 'relay_timeout');
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
    options: EnsureOptions,
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
        if (!response) return starting();
        failureReason = 'parse_failed';
        const data: unknown = await response.json();
        const retryable = workerStarting(response.status, data);
        if (response.status !== 200 && !retryable) return unavailable(`worker_status_${response.status}`);
        // Enrollment/receipt, stop or replacement may win while the Worker is answering.
        // Discard the old handoff and let the next request sign the newly confirmed pair.
        failureReason = 'placement_read_failed';
        const { record: current } = await readOwned();
        const currentRefusal = placementRefusal(current);
        if (currentRefusal) return currentRefusal;
        if (!current) return unavailable('placement_missing');
        if (current.generation !== placement.generation || current.leaseEpoch !== placement.leaseEpoch) return starting();
        if (retryable) return starting();
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

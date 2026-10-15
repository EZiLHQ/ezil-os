import { z } from 'zod';

import {
    CORRELATION_HEADER,
    deriveGuacamoleSandboxId,
    type CloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';

import { readAwsBrowserZone, type Env } from './aws-config';
import { readPlacement, type PlacementExecutor } from './placement';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ComputerRef, EnsureOptions } from './provider';

const unavailable = () => ({
    ok: false as const,
    error: 'aws_preview_unavailable',
    errorCode: 'aws_preview_unavailable',
});

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
) {
    if (!config.isConfigured || !hmacSecret.trim()) return unavailable();
    // The ONLY zone an AWS browser host may sit in: the Worker's configured preview root
    // (EZIL_AWS_BROWSER_ZONE, the same value enrollment hands the host). Never derived from
    // the Worker's own host name: `api-desktop-staging.ezil.work` and `api-desktop.ezil.org`
    // have different shapes, and a derivation that fits one silently refuses the other.
    const zone = readAwsBrowserZone(env);
    if (!zone) return unavailable();
    try {
        // ensure may have observed a different epoch; sign a fresh owned placement.
        const { record: placement } = await readPlacement(db, computer.computerId);
        if (!placement || placement.provider !== 'aws-ec2'
            || placement.ownerUserId !== computer.userId.toLowerCase()
            || placement.state !== 'RUNNING' || placement.generation < 1 || placement.leaseEpoch < 1) {
            return unavailable();
        }
        const sandboxId = deriveGuacamoleSandboxId(placement.ownerUserId, placement.computerId);
        const endpoint = new URL(`${config.workerUrl.replace(/\/$/, '')}/sandbox/preview`);
        if (endpoint.search || endpoint.hash) return unavailable();
        const body = JSON.stringify({
            sessionId: options.sessionId,
            userId: placement.ownerUserId,
            projectId: placement.computerId,
            desktopMode: options.desktopMode,
            ...(options.screen ? { screen: options.screen } : {}),
        });
        // AWS always requires v2, independently of the Cloudflare opt-in flag.
        // EBS has no v2 object-store claim; '' means no store claim.
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
        });
        const data: unknown = await response.json();
        if (response.status === 503) {
            const starting = z.object({
                error: z.enum(['aws_desktop_starting', 'aws_origin_starting']),
            }).safeParse(data);
            if (starting.success) {
                return { ok: false as const, error: 'sandbox_starting', errorCode: 'sandbox_starting' };
            }
        }
        if (response.status !== 200) return unavailable();
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
        if (!parsed.success) return unavailable();
        // Readiness is not a browser-frame observation. Keep that field absent on the wire.
        return { ...parsed.data, correlationId, frame: undefined };
    } catch {
        // Neither Worker bodies nor fetch/parse/signing exceptions reach the shell.
        return unavailable();
    }
}

export type AwsPreviewResult = Awaited<ReturnType<typeof requestAwsPreview>>;

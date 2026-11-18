/**
 * The AWS private host delivery channel: OS -> Worker (`POST /sandbox/<server-derived name>/native-session`,
 * PreviewV2 over the exact body bytes) -> host edge -> agent (worker/src/aws-native-session.ts,
 * infra/host-agent native_session.py).
 *
 * Shaped to the shared `NativeHostTransport` ABI (available, supportsKind, checkReadiness, deliver); the
 * integration owner assigns it there. Off unless constructed with complete configuration AND
 * `EZIL_NATIVE_HOST_TRANSPORT=1`:
 * - `supportsKind('create')` only when available; `renew` is always false (no qualified Core renew API);
 * - `checkReadiness` is `refused` until the host's pure per-target readiness query is qualified: the runner
 *   therefore blocks before any proof, claim, outbox or exchange;
 * - `deliver` sends ONCE. Counters must be canonical decimals the host can represent (<= 2147483647) or the
 *   delivery is refused before any network call (never cast). The Worker's closed outcome maps one to one;
 *   anything after the request may have reached the host is `unknown`.
 * The instruction and grant travel only in the signed body: never a URL, log or error.
 */
import { createHash, randomBytes } from 'node:crypto';

import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';

const COUNTER = /^[1-9]\d{0,9}$/;
const HOST_COUNTER_MAX = 2_147_483_647;
const ANSWER_MAX_BYTES = 4096;
export const NATIVE_DELIVERY_BODY_MAX_BYTES = 131_072;

/** The Root-sealed delivery fields this channel carries (the shared NativeHostDelivery). */
export interface AwsNativeDelivery {
    readonly profileId: 'ezil-native-claude-v1';
    readonly kind: 'create' | 'renew';
    readonly operationId: string;
    readonly sessionId: string;
    readonly computerId: string;
    readonly ownerUserId: string;
    readonly placement: { readonly generation: string; readonly leaseEpoch: string; readonly instanceId: string; readonly fenceToken: string };
    readonly leaseUntil: string;
    readonly task: { readonly taskRef: string; readonly instructionRevision: 1; readonly instructionDigest: string; readonly instruction: string } | null;
    readonly sourceAuthorization: {
        readonly authorizationId: string; readonly epoch: string; readonly authorizationDeadline: string; readonly clientId: string;
        readonly profileId: 'ezil-native-claude-v1'; readonly policyId: string; readonly budgetMicro: string; readonly initialApprovalAt: string;
    };
    readonly grant: { readonly accessToken: string; readonly tokenSha256: string; readonly grantId: string; readonly expiresAt: string };
}

export type AwsNativeOutcome =
    | { kind: 'acknowledged' }
    | { kind: 'refused'; reason: 'host_unavailable' | 'host_refused' | 'placement_mismatch' }
    | { kind: 'unknown'; reason: 'host_timeout' | 'host_no_ack' };

export interface AwsHostTransportConfig {
    env: Record<string, string | undefined>;
    fetch: typeof fetch;
    now?: () => number;
    /** Trusted deployment pin; production always supplies it. */
    expectedManifestSha256?: string;
}

function hostCounter(value: string): number | null {
    return COUNTER.test(value) && Number(value) <= HOST_COUNTER_MAX ? Number(value) : null;
}

/** The exact body bytes (fixed key order) the Worker forwards and the host parses strictly. */
export function nativeDeliveryBody(d: AwsNativeDelivery): string {
    const s = d.sourceAuthorization, g = d.grant, t = d.task;
    return JSON.stringify({
        v: 1, kind: d.kind, profileId: d.profileId, operationId: d.operationId, sessionId: d.sessionId, computerId: d.computerId,
        ownerUserId: d.ownerUserId,
        placement: { generation: d.placement.generation, leaseEpoch: d.placement.leaseEpoch, instanceId: d.placement.instanceId,
            fenceToken: d.placement.fenceToken },
        leaseUntil: d.leaseUntil,
        sourceAuthorization: { authorizationId: s.authorizationId, epoch: s.epoch, authorizationDeadline: s.authorizationDeadline,
            clientId: s.clientId, profileId: s.profileId, policyId: s.policyId, budgetMicro: s.budgetMicro, initialApprovalAt: s.initialApprovalAt },
        task: t && { taskRef: t.taskRef, instructionRevision: t.instructionRevision, instructionDigest: t.instructionDigest, instruction: t.instruction },
        grant: { accessToken: g.accessToken, tokenSha256: g.tokenSha256, grantId: g.grantId, expiresAt: g.expiresAt },
    });
}

export function createAwsHostTransport(config: AwsHostTransportConfig) {
    const secret = config.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
    const workerUrl = config.env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim() ?? '';
    let base: URL | null = null;
    try { base = workerUrl ? new URL(workerUrl) : null; } catch { base = null; }
    const available = config.env.EZIL_NATIVE_HOST_TRANSPORT === '1' && !!secret && base?.protocol === 'https:'
        && !base.username && !base.password && !base.search && !base.hash;
    const now = config.now ?? Date.now;

    async function deliver(d: AwsNativeDelivery, signal: AbortSignal): Promise<AwsNativeOutcome> {
        if (!available || !base) return { kind: 'refused', reason: 'host_unavailable' };
        if (d.kind !== 'create' || !d.task) return { kind: 'refused', reason: 'host_refused' };
        const generation = hostCounter(d.placement.generation), leaseEpoch = hostCounter(d.placement.leaseEpoch);
        if (generation === null || leaseEpoch === null) return { kind: 'refused', reason: 'host_refused' };
        if (createHash('sha256').update(d.grant.accessToken, 'utf8').digest('hex') !== d.grant.tokenSha256) return { kind: 'refused', reason: 'host_refused' };
        const body = nativeDeliveryBody(d);
        if (Buffer.byteLength(body, 'utf8') > NATIVE_DELIVERY_BODY_MAX_BYTES) return { kind: 'refused', reason: 'host_refused' };
        const sandboxId = deriveGuacamoleSandboxId(d.ownerUserId, d.computerId);
        const url = new URL(`${base.toString().replace(/\/$/, '')}/sandbox/${sandboxId}/native-session`);
        let response: Response;
        try {
            const token = mintPreviewTokenV2(secret, { ts: now(), sandboxId, computerId: d.computerId, userId: d.ownerUserId,
                provider: 'aws-ec2', store: '', generation, leaseEpoch }, { method: 'POST', path: url.pathname, body });
            response = await config.fetch(url.toString(), { method: 'POST', body, redirect: 'error', cache: 'no-store', signal,
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token } });
        } catch {
            return { kind: 'unknown', reason: signal.aborted ? 'host_timeout' : 'host_no_ack' };
        }
        // The Worker refused before any host call (v2 envelope/size): nothing was delivered.
        if (response.status === 401 || response.status === 413) return { kind: 'refused', reason: 'host_refused' };
        let answer: Record<string, unknown> | null = null;
        try {
            const text = await response.text();
            answer = Buffer.byteLength(text) <= ANSWER_MAX_BYTES ? JSON.parse(text) as Record<string, unknown> : null;
        } catch { answer = null; }
        if (response.status === 200 && answer?.outcome === 'acknowledged' && answer.ok === true) return { kind: 'acknowledged' };
        if (response.status === 409 && answer?.outcome === 'refused'
            && (answer.reason === 'host_unavailable' || answer.reason === 'host_refused' || answer.reason === 'placement_mismatch')) {
            return { kind: 'refused', reason: answer.reason };
        }
        return { kind: 'unknown', reason: answer?.reason === 'host_timeout' ? 'host_timeout' : 'host_no_ack' };
    }

    async function checkReadiness(target: { kind: 'create' | 'renew'; profileId: 'ezil-native-claude-v1'; ownerUserId: string;
        computerId: string; placement: AwsNativeDelivery['placement'] }, signal?: AbortSignal): Promise<{ kind: 'ready' } | { kind: 'refused' } | { kind: 'unknown' }> {
        if (!available || !base || target.kind !== 'create') return { kind: 'refused' };
        const generation = hostCounter(target.placement.generation), leaseEpoch = hostCounter(target.placement.leaseEpoch);
        if (generation === null || leaseEpoch === null) return { kind: 'refused' };
        const issuedAt = now(), expiresAt = new Date(issuedAt + 4500).toISOString();
        const query = { computerId: target.computerId, expiresAt, issuedAt: new Date(issuedAt).toISOString(), kind: target.kind,
            nonce: randomBytes(32).toString('base64url'), ownerUserId: target.ownerUserId,
            placement: { fenceToken: target.placement.fenceToken, generation: target.placement.generation,
                instanceId: target.placement.instanceId, leaseEpoch: target.placement.leaseEpoch }, profileId: target.profileId };
        const body = JSON.stringify(query), encoded = Buffer.from(body).toString('base64url');
        const sandboxId = deriveGuacamoleSandboxId(target.ownerUserId, target.computerId);
        const url = new URL(`${base.toString().replace(/\/$/, '')}/sandbox/${sandboxId}/native-readiness/${encoded}`);
        const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
        try {
            const token = mintPreviewTokenV2(secret, { ts: issuedAt, sandboxId, computerId: target.computerId, userId: target.ownerUserId,
                provider: 'aws-ec2', store: '', generation, leaseEpoch }, { method: 'GET', path: url.pathname, body: '' });
            const response = await config.fetch(url.toString(), { method: 'GET', redirect: 'error', cache: 'no-store', signal: abort,
                headers: { [PREVIEW_TOKEN_V2_HEADER]: token } });
            const text = await response.text();
            if (Buffer.byteLength(text) > ANSWER_MAX_BYTES) return { kind: 'unknown' };
            const reply = JSON.parse(text) as Record<string, unknown>;
            if (response.status === 200 && reply.ok === true && reply.kind === 'ready' && reply.nonce === query.nonce
                && reply.expiresAt === expiresAt && now() < Date.parse(expiresAt)
                && reply.targetDigest === createHash('sha256').update(body).digest('hex')
                && typeof reply.hostEpoch === 'string' && /^[0-9a-f]{32}$/.test(reply.hostEpoch)
                && typeof reply.manifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(reply.manifestSha256)
                && (!config.expectedManifestSha256 || reply.manifestSha256 === config.expectedManifestSha256)) return { kind: 'ready' };
            return response.status === 409 ? { kind: 'refused' } : { kind: 'unknown' };
        } catch { return { kind: 'unknown' }; }
    }

    return Object.freeze({
        available,
        supportsKind: (kind: 'create' | 'renew') => available && kind === 'create',
        checkReadiness,
        deliver,
    });
}

import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';
/**
 * The private OS → Worker → host `native-runtime` channel, as a port. The transport itself (the derived sandbox
 * path, the Worker hop and the host's `/__ezil/control/native-runtime/<bodySHA>` handler) belongs to the host
 * lane; this module only fixes what the OS sends and accepts, and how one call is bounded.
 *
 * One call, one attempt, a hard deadline that holds even when the adapter ignores its abort signal: after it, the
 * outcome is `unknown` for good and a late reply is dropped. No retry, no reissue, no second key.
 */
import { RUNTIME_LIMITS, RUNTIME_RPC_VERSION, plainObject, serializeRuntimeRpc, utf8Bytes, type RuntimeRpcRequest } from './runtime-contract';

/** What a transport adapter reports. `reply` carries the raw reply body text exactly as received. */
export type RuntimeChannelOutcome =
    | { kind: 'reply'; body: string }
    | { kind: 'refused'; reason: 'host_unavailable' | 'host_refused' }
    | { kind: 'unknown'; reason: 'host_timeout' | 'host_no_ack' };

export interface NativeRuntimeHostChannel {
    /** False until the host lane ships a qualified transport: callers block before any effect. */
    readonly available: boolean;
    call(body: string, signal: AbortSignal): Promise<RuntimeChannelOutcome>;
}

export const UNAVAILABLE_RUNTIME_HOST_CHANNEL: NativeRuntimeHostChannel = Object.freeze({
    available: false,
    call: async (): Promise<RuntimeChannelOutcome> => ({ kind: 'refused', reason: 'host_unavailable' }),
});

/**
 * The host reply envelope (exact keys): `{"v", "outcome": "ok", "result"}`, `{"v", "outcome": "refused", "reason"}`
 * (a definite no-effect refusal) or `{"v", "outcome": "unsupported"}` (the producer lacks this ABI).
 */
export type RuntimeHostResult =
    | { kind: 'ok'; result: unknown }
    | { kind: 'refused'; reason: string }
    | { kind: 'unsupported' }
    | { kind: 'unavailable'; reason: 'host_unavailable' | 'host_refused' }
    | { kind: 'unknown'; reason: 'host_timeout' | 'host_no_ack' | 'host_invalid_reply' };

function parseReply(body: string): RuntimeHostResult {
    if (utf8Bytes(body) > RUNTIME_LIMITS.nativeHopBytes) return { kind: 'unknown', reason: 'host_invalid_reply' };
    let value: unknown;
    try { value = JSON.parse(body); } catch { return { kind: 'unknown', reason: 'host_invalid_reply' }; }
    if (!plainObject(value) || value.v !== RUNTIME_RPC_VERSION) return { kind: 'unknown', reason: 'host_invalid_reply' };
    const keys = Object.keys(value).sort().join(',');
    if (value.outcome === 'ok' && keys === 'outcome,result,v') return { kind: 'ok', result: value.result };
    if (value.outcome === 'refused' && keys === 'outcome,reason,v' && typeof value.reason === 'string'
        && /^[a-z][a-z0-9_]{0,63}$/.test(value.reason)) return { kind: 'refused', reason: value.reason };
    if (value.outcome === 'unknown' && keys === 'outcome,reason,v' && (value.reason === 'host_timeout' || value.reason === 'host_no_ack'))
        return { kind: 'unknown', reason: value.reason };
    if (value.outcome === 'unsupported' && keys === 'outcome,v') return { kind: 'unsupported' };
    return { kind: 'unknown', reason: 'host_invalid_reply' };
}

/**
 * Send one RPC. For reads, `unknown` simply means "not observed". For effects, the caller records it once as
 * `dispatch_unknown` and never sends again.
 */
export async function callRuntimeHost(channel: NativeRuntimeHostChannel, request: RuntimeRpcRequest, timeoutMs: number): Promise<RuntimeHostResult> {
    if (!channel.available) return { kind: 'unavailable', reason: 'host_unavailable' };
    const body = serializeRuntimeRpc(request);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RuntimeChannelOutcome>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown', reason: 'host_timeout' }); }, Math.max(0, timeoutMs));
    });
    const attempt = Promise.resolve().then(() => channel.call(body, controller.signal))
        .catch((): RuntimeChannelOutcome => ({ kind: 'unknown', reason: 'host_no_ack' }));
    let outcome: RuntimeChannelOutcome;
    try {
        outcome = await Promise.race([attempt, deadline]);
    } finally {
        clearTimeout(timer);
    }
    if (outcome.kind === 'reply') return typeof outcome.body === 'string' ? parseReply(outcome.body) : { kind: 'unknown', reason: 'host_invalid_reply' };
    if (outcome.kind === 'refused') return { kind: 'unavailable', reason: outcome.reason === 'host_refused' ? 'host_refused' : 'host_unavailable' };
    return { kind: 'unknown', reason: outcome.reason === 'host_timeout' ? 'host_timeout' : 'host_no_ack' };
}

/** AWS channel over the existing PreviewV2 exact-body authentication. No retry or model admission. */
export function createAwsRuntimeHostChannel(env: Record<string, string | undefined>, request: typeof fetch = fetch): NativeRuntimeHostChannel {
    const secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
    let base: URL | null = null;
    try { base = new URL(env.CLOUDFLARE_GUACAMOLE_WORKER_URL ?? ''); } catch { /* unavailable */ }
    const available = env.EZIL_NATIVE_HOST_TRANSPORT === '1' && !!secret && base?.protocol === 'https:'
        && !base.username && !base.password && !base.search && !base.hash;
    return { available, async call(body, signal): Promise<RuntimeChannelOutcome> {
        if (!available || !base || utf8Bytes(body) > 130000) return { kind: 'refused', reason: 'host_unavailable' };
        try {
            const rpc = JSON.parse(body) as RuntimeRpcRequest, s = rpc.scope;
            const generation = Number(s.placement.generation), leaseEpoch = Number(s.placement.leaseEpoch);
            if (![generation, leaseEpoch].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 2147483647)) return { kind: 'refused', reason: 'host_refused' };
            const sandboxId = deriveGuacamoleSandboxId(s.ownerUserId, s.computerId);
            const url = new URL(`${base.toString().replace(/\/$/, '')}/sandbox/${sandboxId}/native-runtime`);
            const token = mintPreviewTokenV2(secret, { ts: Date.now(), sandboxId, computerId: s.computerId, userId: s.ownerUserId,
                provider: 'aws-ec2', store: '', generation, leaseEpoch }, { method: 'POST', path: url.pathname, body });
            const response = await request(url.toString(), { method: 'POST', body, signal, redirect: 'error', cache: 'no-store',
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token } });
            if (!response.body) return { kind: 'unknown', reason: 'host_no_ack' };
            const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
            try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.byteLength;
                if (size > RUNTIME_LIMITS.nativeHopBytes) return { kind: 'unknown', reason: 'host_no_ack' }; parts.push(p.value); } }
            finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            return { kind: 'reply', body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) };
        } catch { return { kind: 'unknown', reason: signal.aborted ? 'host_timeout' : 'host_no_ack' }; }
    } };
}

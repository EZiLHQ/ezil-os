import { createNativeRuntimeAiPort, type NativeConsentReadPorts } from './runtime-composition';
/** Private host callback. Exact epoch key, domain, nonce and raw-request correlation; read-only. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { deriveControlKey } from '@/server/lib/compute/aws-enroll';
import type { Placement, PlacementExecutor } from '@/server/lib/compute/placement';
import type { NativeAiAuthorityPort } from './runtime-authority';
import { recheckNativeRuntimeControl, recheckNativeRuntimeRead } from './runtime-control-reader';
import { RUNTIME_RPC_VERSION, READ_RPC_ACTIONS, canonicalScope, isoTimestamp, plainObject, serializeRuntimeRpc, type RuntimeRpcRequest } from './runtime-contract';

export const RUNTIME_AUTHORITY_DOMAIN = 'ezil-native-runtime-authority-v1';
export const RUNTIME_AUTHORITY_REPLY_DOMAIN = 'ezil-native-runtime-authority-reply-v1';
const MAX = 131072;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const mac = (key: Buffer, parts: (string | number)[]) => `v1=${createHmac('sha256', key).update(parts.join('|')).digest('hex')}`;
const plain = (status: number) => Response.json({ error: 'native_authority_unavailable' }, { status, headers: { 'cache-control': 'no-store' } });
export interface RuntimeAuthorityQueryDeps {
    env: Record<string, string | undefined>; db: PlacementExecutor; aiPort: NativeAiAuthorityPort | null;
    now(): Date; placement(computerId: string): Promise<Placement | null>;
}
async function boundedBody(request: Request): Promise<string | null> {
    if (!request.body) return null;
    const reader = request.body.getReader(), parts: Uint8Array[] = []; let n = 0;
    try {
        for (;;) { const p = await reader.read(); if (p.done) break; n += p.value.byteLength; if (n > MAX) return null; parts.push(p.value); }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
    } catch { return null; } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function handleNativeRuntimeAuthorityQuery(request: Request, deps: RuntimeAuthorityQueryDeps): Promise<Response> {
    const h = (key: string) => request.headers.get(key) ?? '';
    const computerId = h('x-ezil-computer-id'), generation = h('x-ezil-generation'), leaseEpoch = h('x-ezil-lease-epoch');
    const ts = h('x-ezil-timestamp'), signature = h('x-ezil-signature'), now = deps.now().getTime();
    const secret = deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    if (!secret) return plain(503);
    if (!uuid.test(computerId) || !/^[1-9][0-9]{0,9}$/.test(generation) || !/^[1-9][0-9]{0,9}$/.test(leaseEpoch)
        || Number(generation) > 2147483647 || Number(leaseEpoch) > 2147483647 || !/^[0-9]{1,12}$/.test(ts)
        || Math.abs(now / 1000 - Number(ts)) > 300 || !/^v1=[0-9a-f]{64}$/.test(signature)) return plain(401);
    const raw = await boundedBody(request); if (raw === null) return plain(400);
    let placement: Placement | null;
    try { placement = await deps.placement(computerId); } catch { return plain(503); }
    if (!placement || placement.provider !== 'aws-ec2' || placement.computerId !== computerId
        || String(placement.generation) !== generation || String(placement.leaseEpoch) !== leaseEpoch
        || placement.state !== 'RUNNING' || !/^[0-9a-f]{64}$/.test(placement.enrollConsumedHash ?? '')) return plain(401);
    const key = deriveControlKey(secret, { computerId, generation: placement.generation, leaseEpoch: placement.leaseEpoch,
        nonceHash: placement.enrollConsumedHash! });
    const expected = mac(key, [RUNTIME_AUTHORITY_DOMAIN, ts, computerId, generation, leaseEpoch, sha(raw)]);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return plain(401);
    let envelope: Record<string, unknown>, rpc: RuntimeRpcRequest;
    try {
        envelope = JSON.parse(raw) as Record<string, unknown>;
        if (!plainObject(envelope) || Object.keys(envelope).sort().join(',') !== 'expiresAt,issuedAt,request,requestNonce,v'
            || envelope.v !== 1 || typeof envelope.requestNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(envelope.requestNonce)
            || isoTimestamp(envelope.issuedAt) === null || isoTimestamp(envelope.expiresAt) === null) return plain(400);
        const issued = Date.parse(envelope.issuedAt as string), expires = Date.parse(envelope.expiresAt as string);
        if (!(issued <= now && now < expires && expires <= issued + 10000)) return plain(400);
        rpc = envelope.request as RuntimeRpcRequest;
        if (rpc.v !== RUNTIME_RPC_VERSION || rpc.scope.computerId !== computerId || rpc.scope.placement.generation !== generation
            || rpc.scope.placement.leaseEpoch !== leaseEpoch || Date.parse(rpc.deadline) > expires) return plain(400);
        serializeRuntimeRpc(rpc);
    } catch { return plain(400); }
    let result;
    try {
        result = READ_RPC_ACTIONS.has(rpc.action)
            ? await recheckNativeRuntimeRead(deps.db, deps.aiPort, { scope: rpc.scope, action: rpc.action as 'read' | 'prompt_get' | 'request_get',
                rootRequestId: rpc.rootRequestId, deadline: rpc.deadline })
            : await recheckNativeRuntimeControl(deps.db, deps.aiPort, { ownerUserId: rpc.scope.ownerUserId,
                requestId: rpc.rootRequestId!, controlAuthorizationId: rpc.scope.controlAuthorizationId!, requestDigest: rpc.requestDigest!,
                action: rpc.action as 'send' | 'answer' | 'cancel' });
    } catch { return plain(503); }
    // CONTROL must resolve byte-for-byte the immutable signed scope. READ refreshes only the dynamic AI state.
    if (result.ok && !READ_RPC_ACTIONS.has(rpc.action) && (JSON.stringify(canonicalScope(result.resolved.scope)) !== JSON.stringify(canonicalScope(rpc.scope))
        || result.resolved.action !== rpc.action || result.resolved.rootRequestId !== rpc.rootRequestId
        || result.resolved.requestDigest !== rpc.requestDigest || Date.parse(result.resolved.deadline) < Date.parse(rpc.deadline))) return plain(403);
    const reply = JSON.stringify({ v: 1, requestNonce: envelope.requestNonce, requestSha256: sha(raw), ...result });
    if (Buffer.byteLength(reply) > MAX) return plain(503);
    return new Response(reply, { status: result.ok ? 200 : 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-ezil-authority': mac(key, [RUNTIME_AUTHORITY_REPLY_DOMAIN, computerId, generation, leaseEpoch, sha(raw), sha(reply)]) } });
}

/** Production integration factory over actual 0031 exports and trusted installed Core policy fingerprint. */
export function createNativeRuntimeAuthorityHandler(deps: Omit<RuntimeAuthorityQueryDeps, 'aiPort'>,
    composition: { consent: NativeConsentReadPorts; installedPolicyDigest: string | null }): (request: Request) => Promise<Response> {
    const aiPort = createNativeRuntimeAiPort(deps.db, composition.consent, composition.installedPolicyDigest);
    return request => handleNativeRuntimeAuthorityQuery(request, { ...deps, aiPort });
}

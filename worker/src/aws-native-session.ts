/**
 * Native session delivery hop: OS -> this Worker -> the computer's host edge. No generic exec, no
 * Cloudflare fallback, no retry.
 *
 * POST /sandbox/<server-derived name>/native-session (v2 only; `preauthorizeV2` has verified the
 * signature over these exact bytes and that the claims name this sandbox). The body is forwarded
 * BYTE FOR BYTE to POST /__ezil/control/native-session/<sha256(body)> under the placement's gw1
 * signature, after a closed shape check that binds it to the v2 claims and the current tunnel record
 * (computer, owner, generation, lease epoch). The host does the deep validation.
 *
 * GET /sandbox/<name>/native-session/<operationId>: the host's exact-operation status, read only.
 *
 * Outcomes (`outcome`): acknowledged (host 200 running); refused (nothing reached the host agent, or
 * the agent sent a closed refusal); unknown (anything after the request may have reached the agent:
 * 202 starting, 5xx, timeout, unreadable answer). Unknown is never retried here.
 */
import { awsOriginHostname, decodeControlKey, isComputerId, signGatewayHeader, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';

export const NATIVE_BODY_MAX_BYTES = 131_072;
const DELIVERY_TIMEOUT_MS = 9_000;
const STATUS_TIMEOUT_MS = 5_000;
const ANSWER_MAX_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTER = /^[1-9][0-9]{0,9}$/;
const DELIVERY_KEYS = 'computerId,grant,kind,leaseUntil,operationId,ownerUserId,placement,profileId,sessionId,sourceAuthorization,task,v';
const HOST_REFUSALS: Readonly<Record<string, 'host_refused' | 'placement_mismatch'>> = {
  native_unavailable: 'host_refused', native_invalid: 'host_refused', renew_unsupported: 'host_refused',
  placement_mismatch: 'placement_mismatch', operation_conflict: 'host_refused', session_exists: 'host_refused',
  permits_exhausted: 'host_refused', stopping: 'host_refused', grant_invalid: 'host_refused', lease_expired: 'host_refused',
  native_start_failed: 'host_refused',
};
const STATES = new Set(['starting', 'running', 'stopping', 'stopped', 'quarantined', 'refused']);
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

type Outcome =
  | { outcome: 'acknowledged' }
  | { outcome: 'refused'; reason: 'host_unavailable' | 'host_refused' | 'placement_mismatch' }
  | { outcome: 'unknown'; reason: 'host_timeout' | 'host_no_ack' };

const answer = (body: Record<string, unknown>, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const settle = (o: Outcome) => answer({ ok: o.outcome === 'acknowledged', ...o },
  o.outcome === 'acknowledged' ? 200 : o.outcome === 'refused' ? 409 : 502);
const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');

export interface AwsNativeSessionDeps {
  enabled: boolean;
  zone: string | null;
  lookup: (sandbox: string) => Promise<AwsTunnelRecord | null>;
  fetch: FetchLike;
  now?: () => number;
}

async function readCapped(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > ANSWER_MAX_BYTES) throw new Error('large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}

const exact = (v: unknown, keys: string): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === keys;

/** Claims must be an AWS computer addressed by its server-derived sandbox name (as repo-open). */
function claimsValid(claims: PreviewTokenV2Claims, sandbox: string): boolean {
  const derived = `guac-${claims.userId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}-${claims.computerId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;
  return claims.provider === 'aws-ec2' && claims.store === '' && isComputerId(claims.userId) && isComputerId(claims.computerId)
    && claims.sandboxId === sandbox && derived === sandbox && Number.isSafeInteger(claims.generation) && claims.generation >= 1
    && claims.generation <= 2_147_483_647 && Number.isSafeInteger(claims.leaseEpoch) && claims.leaseEpoch >= 1
    && claims.leaseEpoch <= 2_147_483_647;
}

/** The closed outer shape, bound to the claims. Counters compare as canonical strings, never cast. */
export function bindsToClaims(bytes: Uint8Array, claims: PreviewTokenV2Claims): boolean {
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return false; }
  if (!exact(body, DELIVERY_KEYS) || body.v !== 1 || body.kind !== 'create' || body.profileId !== 'ezil-native-claude-v1') return false;
  const p = body.placement;
  return typeof body.operationId === 'string' && UUID.test(body.operationId) && typeof body.sessionId === 'string' && UUID.test(body.sessionId)
    && body.computerId === claims.computerId && body.ownerUserId === claims.userId
    && exact(p, 'fenceToken,generation,instanceId,leaseEpoch') && typeof p.generation === 'string' && COUNTER.test(p.generation)
    && typeof p.leaseEpoch === 'string' && COUNTER.test(p.leaseEpoch)
    && p.generation === String(claims.generation) && p.leaseEpoch === String(claims.leaseEpoch);
}

async function current(deps: AwsNativeSessionDeps, sandbox: string, claims: PreviewTokenV2Claims): Promise<AwsTunnelRecord | null> {
  const rec = await deps.lookup(sandbox);
  return rec && rec.originVerified && rec.computerId === claims.computerId && rec.sandboxId === sandbox
    && rec.generation === claims.generation && rec.leaseEpoch === claims.leaseEpoch ? rec : null;
}

async function call(deps: AwsNativeSessionDeps, rec: AwsTunnelRecord, sandbox: string, method: 'POST' | 'GET', path: string,
  signal: AbortSignal, body?: Uint8Array): Promise<Response> {
  const key = decodeControlKey(rec.controlKey);
  if (!key) throw new Error('key');
  const host = awsOriginHostname(sandbox, rec.generation, rec.leaseEpoch, deps.zone!);
  const signed = await signGatewayHeader(key, rec, method, path, (deps.now ?? Date.now)() / 1000);
  return deps.fetch(`https://${host}${path}`, {
    method, redirect: 'manual', signal,
    headers: { 'x-ezil-gw': signed, ...(body ? { 'content-type': 'application/json', 'content-length': String(body.byteLength) } : {}) },
    ...(body ? { body } : {}),
  });
}

export async function deliverAwsNativeSession(request: Request, claims: PreviewTokenV2Claims, sandbox: string, bytes: Uint8Array,
  deps: AwsNativeSessionDeps): Promise<Response> {
  if (!deps.enabled || !deps.zone) return settle({ outcome: 'refused', reason: 'host_unavailable' });
  if (!claimsValid(claims, sandbox) || bytes.byteLength === 0 || bytes.byteLength > NATIVE_BODY_MAX_BYTES || !bindsToClaims(bytes, claims)) {
    return settle({ outcome: 'refused', reason: 'host_refused' });
  }
  const rec = await current(deps, sandbox, claims).catch(() => null);
  if (!rec) return settle({ outcome: 'refused', reason: 'placement_mismatch' });
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]);
  let response: Response;
  try {
    response = await call(deps, rec, sandbox, 'POST', `/__ezil/control/native-session/${digest}`, signal, bytes);
  } catch {
    // The request may have reached the agent: unknown, never a retry.
    return settle({ outcome: 'unknown', reason: signal.aborted ? 'host_timeout' : 'host_no_ack' });
  }
  // gw/digest/shape refusals happen before the agent: nothing was admitted.
  if (response.status === 401 || response.status === 400) return settle({ outcome: 'refused', reason: 'host_refused' });
  if (response.status === 404) return settle({ outcome: 'refused', reason: 'host_unavailable' });
  let parsed: unknown;
  try { parsed = await readCapped(response); } catch { return settle({ outcome: 'unknown', reason: 'host_no_ack' }); }
  if (response.status === 200 && exact(parsed, 'ok,state') && parsed.ok === true && parsed.state === 'running') return settle({ outcome: 'acknowledged' });
  if (response.status === 409 && (exact(parsed, 'error,ok') || exact(parsed, 'error,ok,reason')) && parsed.ok === false
    && typeof parsed.error === 'string' && Object.hasOwn(HOST_REFUSALS, parsed.error)) {
    return settle({ outcome: 'refused', reason: HOST_REFUSALS[parsed.error]! });
  }
  return settle({ outcome: 'unknown', reason: 'host_no_ack' });
}

export async function readAwsNativeSessionStatus(request: Request, claims: PreviewTokenV2Claims, sandbox: string, operationId: string,
  deps: AwsNativeSessionDeps): Promise<Response> {
  if (!deps.enabled || !deps.zone) return answer({ ok: false, error: 'native_unavailable' }, 409);
  if (!claimsValid(claims, sandbox) || !UUID.test(operationId)) return answer({ ok: false, error: 'native_invalid' }, 400);
  const rec = await current(deps, sandbox, claims).catch(() => null);
  if (!rec) return answer({ ok: false, error: 'placement_mismatch' }, 409);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
  try {
    const response = await call(deps, rec, sandbox, 'GET', `/__ezil/control/native-session-status/${operationId}`, signal);
    if (response.status === 404) return answer({ ok: false, error: 'operation_unknown' }, 404);
    const parsed = await readCapped(response);
    if (response.status === 200 && (exact(parsed, 'ok,state') || exact(parsed, 'ok,reason,state')) && parsed.ok === true
      && STATES.has(parsed.state as string) && (parsed.reason === undefined || (typeof parsed.reason === 'string' && REASON.test(parsed.reason)))) {
      return answer({ ok: true, state: parsed.state, ...(parsed.reason ? { reason: parsed.reason } : {}) }, 200);
    }
  } catch { /* unreadable status is unavailable, never a state */ }
  return answer({ ok: false, error: 'status_unavailable' }, 502);
}

/** Pure per-target query. Exact signed path binds nonce, full tuple and fixed expiry. */
export async function readAwsNativeReadiness(request: Request, claims: PreviewTokenV2Claims, sandbox: string, encoded: string,
  deps: AwsNativeSessionDeps): Promise<Response> {
  if (!deps.enabled || !deps.zone || !claimsValid(claims, sandbox)) return answer({ ok: false, kind: 'refused' }, 409);
  let query: Record<string, unknown>;
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) throw new Error('shape');
    query = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    const p = query.placement as Record<string, unknown>;
    const now = (deps.now ?? Date.now)();
    if (query.kind !== 'create' || query.profileId !== 'ezil-native-claude-v1' || query.computerId !== claims.computerId
      || query.ownerUserId !== claims.userId || p.generation !== String(claims.generation) || p.leaseEpoch !== String(claims.leaseEpoch)
      || typeof query.issuedAt !== 'string' || typeof query.expiresAt !== 'string'
      || !(Date.parse(query.issuedAt) <= now && now < Date.parse(query.expiresAt) && Date.parse(query.expiresAt) <= Date.parse(query.issuedAt) + 5000)) throw new Error('target');
  } catch { return answer({ ok: false, kind: 'refused' }, 409); }
  const rec = await current(deps, sandbox, claims).catch(() => null);
  if (!rec) return answer({ ok: false, kind: 'refused' }, 409);
  try {
    const response = await call(deps, rec, sandbox, 'GET', `/__ezil/control/native-readiness/${encoded}`,
      AbortSignal.any([request.signal, AbortSignal.timeout(4000)]));
    const reply = await readCapped(response);
    if (response.status === 200 && exact(reply, 'expiresAt,hostEpoch,kind,manifestSha256,nonce,ok,targetDigest')
      && reply.ok === true && reply.kind === 'ready' && reply.nonce === query.nonce && reply.expiresAt === query.expiresAt) return answer(reply, 200);
    if (response.status === 409) return answer({ ok: false, kind: 'refused' }, 409);
  } catch { /* unavailable */ }
  return answer({ ok: false, kind: 'unknown' }, 502);
}

/** Closed 0032 runtime envelope; only exact scope and current placement can reach the private host. */
export async function callAwsNativeRuntime(request: Request, claims: PreviewTokenV2Claims, sandbox: string, bytes: Uint8Array,
  deps: AwsNativeSessionDeps): Promise<Response> {
  if (!deps.enabled || !deps.zone || !claimsValid(claims, sandbox)) return answer({ kind: 'unavailable', reason: 'host_unavailable' }, 409);
  let q: Record<string, unknown>;
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > 130000) throw new Error('size');
    q = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    const scope = q.scope as Record<string, unknown>, p = scope.placement as Record<string, unknown>;
    if (q.v !== 'ezil-native-runtime-rpc/1' || scope.ownerUserId !== claims.userId || scope.computerId !== claims.computerId
      || p.generation !== String(claims.generation) || p.leaseEpoch !== String(claims.leaseEpoch)) throw new Error('scope');
  } catch { return answer({ kind: 'refused', reason: 'runtime_invalid' }, 400); }
  const rec = await current(deps, sandbox, claims).catch(() => null);
  if (!rec) return answer({ kind: 'refused', reason: 'placement_mismatch' }, 409);
  try {
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    const response = await call(deps, rec, sandbox, 'POST', `/__ezil/control/native-runtime/${digest}`,
      AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), bytes);
    // Full native response includes wrapper; never clip, truncate or silently drop an event.
    if (!response.body) throw new Error('empty');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; n += part.value.byteLength;
      if (n > NATIVE_BODY_MAX_BYTES) throw new Error('large'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const out = new Uint8Array(n); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
    return new Response(out, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch { return answer({ kind: 'unknown', reason: 'host_no_ack' }, 502); }
}

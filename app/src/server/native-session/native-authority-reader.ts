/**
 * `POST /api/compute/aws/native-authority`: a host's fresh, PURE permission query for one native operation it
 * admitted (infra/host-agent `native_authority.py` is the sender). Not a Gateway exchange, not settlement:
 * nothing is written, claimed, exchanged, woken or renewed, and a signed `allow` is permission for at most
 * 30 seconds.
 *
 * Credential: the epoch's control key, re-derived from the placement exactly as `host-storage.ts` does, under
 * the domain `ezil-native-authority-v1`:
 *   X-Ezil-Signature: v1=HMAC(key, "ezil-native-authority-v1|ts|computerId|generation|leaseEpoch|sha256(body)")
 * The answer is MAC'd over the exact request and reply bytes:
 *   X-Ezil-Authority: v1=HMAC(key, "ezil-native-authority-v1-reply|computerId|generation|leaseEpoch|sha256(req)|sha256(reply)")
 *
 * Decision: the STORED operation for (owner, operationId) — never one built from host input — must be a create
 * for exactly this session and computer, in `delivering` or `delivered` (never claimed/exchanging/unknown), with
 * a grant; the fixed profile's policy digest must match; the trusted consent reader must return the approved
 * binding; and `recheckNativeAuthority` must confirm all four placement fields against the live placement. The
 * expiry is min(issuedAt + 30 s, requested expiresAt, live lease, grant expiry, consent deadline): a function of
 * stored values and the request, so a duplicate never slides it.
 *
 * Phases: `pre-runtime` omits runtimeId (request and reply); `runtime` carries the Core-minted UUID the host
 * adopted. The OS treats it as an opaque correlation value bound into the signed reply.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { deriveControlKey } from '@/server/lib/compute/aws-enroll';
import { ImageJobConflictError, PlacementIntegrityError, RUNNING_CLASS_STATES, type Placement } from '@/server/lib/compute/placement';

import { lookupNativeOperation, recheckNativeAuthority, type NativeAuthorityDb, type NativeOperation } from './authority';

export const NATIVE_AUTHORITY_MAC_INFO = 'ezil-native-authority-v1';
export const NATIVE_AUTHORITY_REPLY_INFO = 'ezil-native-authority-v1-reply';
/** sha256 over the host's canonical fixed profile (native_session.PROFILE); parity is tested on both sides. */
export const NATIVE_POLICY_DIGEST = 'sha256:669f2e04be8d8183727f1e750f4b9fe1bad3bd1b991babbbd549debc5a305e3e';
const WINDOW_MS = 30_000;
const SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTER = /^[1-9]\d{0,9}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE = ['computerId', 'expiresAt', 'issuedAt', 'operationId', 'ownerUserId', 'phase', 'placement', 'policyDigest',
    'requestNonce', 'sessionId', 'v'];
const KEYS: Record<string, string> = { 'pre-runtime': BASE.join(','), runtime: [...BASE, 'runtimeId'].sort().join(',') };

/** The approved consent binding the trusted reader returns (owned by the native-auth lane; injected). */
export interface NativeConsentBinding { readonly authorizationDeadline: string }
export type NativeConsentReader = (db: NativeAuthorityDb, key: { ownerUserId: string; operationId: string }) => Promise<NativeConsentBinding | null>;

export interface NativeAuthorityDeps {
    env: Record<string, string | undefined>;
    db: NativeAuthorityDb;
    now(): Date;
    placement(computerId: string): Promise<Placement | null>;
    /** Null until the approved consent reader is composed: every query is then denied. */
    consent: NativeConsentReader | null;
}

interface QueryBody {
    v: 1; phase: 'pre-runtime' | 'runtime'; operationId: string; sessionId: string; computerId: string; ownerUserId: string;
    placement: { generation: string; leaseEpoch: string; instanceId: string; fenceToken: string };
    runtimeId?: string; policyDigest: string; requestNonce: string; issuedAt: string; expiresAt: string;
}

const NO_STORE = { 'cache-control': 'no-store' };
const plain = (status: number, error: string) => Response.json({ error }, { status, headers: NO_STORE });
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const mac = (key: Buffer, parts: (string | number)[]) => `v1=${createHmac('sha256', key).update(parts.join('|')).digest('hex')}`;
const ms = (v: unknown): number | null => {
    if (typeof v !== 'string' || !TIME.test(v)) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) && new Date(t).toISOString() === v ? t : null;
};

function parseQuery(raw: string): QueryBody | null {
    let b: unknown;
    try { b = JSON.parse(raw); } catch { return null; }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    const q = b as Record<string, unknown>;
    if (typeof q.phase !== 'string' || !(q.phase in KEYS) || Object.keys(q).sort().join(',') !== KEYS[q.phase]) return null;
    const p = q.placement as Record<string, unknown> | null;
    const ok = q.v === 1 && ['operationId', 'sessionId', 'computerId', 'ownerUserId'].every(k => typeof q[k] === 'string' && UUID.test(q[k] as string))
        && (q.phase === 'pre-runtime' || (typeof q.runtimeId === 'string' && UUID.test(q.runtimeId)))
        && !!p && typeof p === 'object' && Object.keys(p).sort().join(',') === 'fenceToken,generation,instanceId,leaseEpoch'
        && typeof p.generation === 'string' && COUNTER.test(p.generation) && typeof p.leaseEpoch === 'string' && COUNTER.test(p.leaseEpoch)
        && typeof p.instanceId === 'string' && /^i-[0-9a-f]{8,17}$/.test(p.instanceId) && typeof p.fenceToken === 'string' && UUID.test(p.fenceToken)
        && typeof q.policyDigest === 'string' && typeof q.requestNonce === 'string' && NONCE.test(q.requestNonce);
    if (!ok) return null;
    const issued = ms(q.issuedAt), expires = ms(q.expiresAt);
    return issued !== null && expires !== null && issued < expires && expires <= issued + WINDOW_MS ? q as unknown as QueryBody : null;
}

export async function handleNativeAuthorityQuery(request: Request, deps: NativeAuthorityDeps): Promise<Response> {
    const secret = deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
    if (!secret) return plain(503, 'native_authority_unavailable');
    const h = (n: string) => request.headers.get(n) ?? '';
    const computerId = h('x-ezil-computer-id').toLowerCase(), generation = h('x-ezil-generation'), leaseEpoch = h('x-ezil-lease-epoch');
    const ts = h('x-ezil-timestamp'), signature = h('x-ezil-signature');
    if (!UUID.test(computerId) || !COUNTER.test(generation) || !COUNTER.test(leaseEpoch) || Number(generation) > 2147483647
        || Number(leaseEpoch) > 2147483647 || !/^\d{1,12}$/.test(ts) || !/^v1=[0-9a-f]{64}$/.test(signature)) return plain(401, 'native_authority_unauthenticated');
    const now = deps.now();
    if (Math.abs(now.getTime() / 1000 - Number(ts)) > SKEW_SECONDS) return plain(401, 'native_authority_unauthenticated');
    const raw = await request.text().catch(() => null);
    if (raw === null || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return plain(400, 'native_authority_invalid');

    let placement: Placement | null;
    try { placement = await deps.placement(computerId); } catch (error) {
        if (error instanceof ImageJobConflictError || error instanceof PlacementIntegrityError) return plain(401, 'native_authority_unauthenticated');
        return plain(503, 'native_authority_unavailable');
    }
    if (!placement || placement.provider !== 'aws-ec2' || placement.computerId.toLowerCase() !== computerId
        || String(placement.generation) !== generation || String(placement.leaseEpoch) !== leaseEpoch
        || !RUNNING_CLASS_STATES.includes(placement.state) || !placement.enrollConsumedHash || !HEX64.test(placement.enrollConsumedHash)) {
        return plain(401, 'native_authority_unauthenticated');
    }
    let key: Buffer;
    try {
        key = deriveControlKey(secret, { computerId, generation: placement.generation, leaseEpoch: placement.leaseEpoch, nonceHash: placement.enrollConsumedHash });
    } catch { return plain(503, 'native_authority_unavailable'); }
    const expected = Buffer.from(mac(key, [NATIVE_AUTHORITY_MAC_INFO, ts, computerId, generation, leaseEpoch, sha(raw)]));
    const presented = Buffer.from(signature);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return plain(401, 'native_authority_unauthenticated');

    // Authenticated: only now is the body parsed. Every answer below is signed and correlated.
    const q = parseQuery(raw);
    if (!q || q.computerId !== computerId || q.placement.generation !== generation || q.placement.leaseEpoch !== leaseEpoch) {
        return plain(400, 'native_authority_invalid');
    }
    const head = { v: 1, phase: q.phase, requestNonce: q.requestNonce, operationId: q.operationId,
        ...(q.phase === 'runtime' ? { runtimeId: q.runtimeId } : {}) };
    const signed = (status: number, body: Record<string, unknown>) => {
        const text = JSON.stringify(body);
        return new Response(text, { status, headers: { ...NO_STORE, 'content-type': 'application/json',
            'x-ezil-authority': mac(key, [NATIVE_AUTHORITY_REPLY_INFO, computerId, generation, leaseEpoch, sha(raw), sha(text)]) } });
    };
    const deny = (reason: string) => signed(403, { ...head, decision: 'deny', reason });

    if (q.policyDigest !== NATIVE_POLICY_DIGEST) return deny('policy_mismatch');
    let op: NativeOperation | null;
    try { op = await lookupNativeOperation(deps.db, q.ownerUserId, q.operationId); } catch { return plain(503, 'native_authority_unavailable'); }
    if (!op || op.kind !== 'create' || op.sessionId !== q.sessionId || op.computerId !== q.computerId) return deny('operation_not_found');
    if (op.state !== 'delivering' && op.state !== 'delivered') return deny('operation_not_admitted');
    if (!op.grantExpiresAt) return deny('operation_not_admitted');
    if (!deps.consent) return deny('consent_unverified');
    let consent: NativeConsentBinding | null;
    try { consent = await deps.consent(deps.db, { ownerUserId: q.ownerUserId, operationId: q.operationId }); }
    catch { return plain(503, 'native_authority_unavailable'); }
    const consentDeadline = consent ? ms(consent.authorizationDeadline) : null;
    if (consentDeadline === null) return deny('consent_unverified');
    let check;
    try { check = await recheckNativeAuthority(deps.db, op); } catch { return plain(503, 'native_authority_unavailable'); }
    if (!check.ok) return deny(check.reason);
    const p = check.placement;
    if (p.generation !== q.placement.generation || p.leaseEpoch !== q.placement.leaseEpoch || p.instanceId !== q.placement.instanceId
        || p.fenceToken !== q.placement.fenceToken) return deny('placement_changed');
    const issued = ms(q.issuedAt)!;
    const expires = Math.min(issued + WINDOW_MS, ms(q.expiresAt)!, check.leaseUntil.getTime(), op.grantExpiresAt.getTime(), consentDeadline);
    if (expires <= Math.max(issued, now.getTime())) return deny('expired');
    return signed(200, { ...head, decision: 'allow', expiresAt: new Date(expires).toISOString() });
}

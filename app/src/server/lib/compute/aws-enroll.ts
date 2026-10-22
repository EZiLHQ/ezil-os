import { EnrollmentLeaseSchema, ENROLL_NONCE_TTL_SECONDS, USER_DATA_MAX, type RebasePermit, type EbsRestore, type RebaseSchema } from './aws-rebase-lease';
export { ENROLL_NONCE_TTL_SECONDS, USER_DATA_MAX, REBASE_ENROLL_RESERVE_SECONDS, REBASE_CLOCK_SKEW_SECONDS } from './aws-rebase-lease';
/**
 * C-6 host enrollment, app side (docs/AWS-COMPUTERS.md C-6; pinned wire
 * contract reports/2026-10-14-aws-azure-first-lead/GATEWAY-CONTRACT-v1.md).
 *
 * 1. Issue (this file, used by `aws-ec2.ts`): every boot that launches or
 *    starts an instance gets 32 random bytes. Only their sha256 and a deadline
 *    (≤10 min) are stored on the placement, in the SAME write as the lease or
 *    the creation. The plaintext travels once, in the launch's user data,
 *    which is readable on that host only.
 * 2. Enroll (`handleAwsEnrollment` below): the host presents the nonce with its
 *    signed identity document; every check passes or nothing changes.
 *
 * 🔴 Never log a nonce, a control key or a tunnel token.
 */

import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { isAwsComputersEnabled, readAwsBrowserZone, type Env as AwsEnv } from './aws-config';
import { readIdentityCertificate, verifyIdentitySignature } from './aws-identity';
import { readLifecycleDeployments } from './aws-intent';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { readEnrollmentPlacement as readPlacement, consumeMigrationEnrollment as consumeEnrollmentNonce, finishMigrationEnrollment as finishEnrollment } from './provider-migrate-provision';
import { ENROLLABLE_STATES, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, type Placement, type PlacementDb, type PlacementState } from './placement';
import { mintPreviewTokenV2 } from './preview-token-v2';

/** C-6: at most 10 minutes between issue and enrollment. */


/** Host `lease.py` NONCE_RE: base64url, 32-128 characters. 32 bytes → 43. */
const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface EnrollmentNonce {
    /** Plaintext: goes into the launch user data only. */
    nonce: string;
    /** sha256(nonce) in hex: the only form the database ever holds. */
    nonceHash: string;
    expiresAt: Date;
}

export const nonceHashOf = (nonce: string): string => createHash('sha256').update(nonce, 'utf8').digest('hex');

export function issueEnrollmentNonce(now: Date, random: (n: number) => Buffer = nodeRandomBytes): EnrollmentNonce {
    const bytes = random(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('enrollment nonce needs 32 random bytes');
    const nonce = bytes.toString('base64url');
    return { nonce, nonceHash: nonceHashOf(nonce), expiresAt: new Date(now.getTime() + ENROLL_NONCE_TTL_SECONDS * 1000) };
}

/** The lifecycle intent's `userData` limit (base64 characters). */


export interface EnrollmentUserDataInput {
    restore?: import('./provider-migrate').RestoreLease;
    rebase?: z.infer<typeof RebaseSchema>;
    rebasePermit?: RebasePermit;
    ebsRestore?: EbsRestore;
    computerId: string;
    /** null on a provision: the data volume does not exist yet when the intent is built. */
    volumeId: string | null;
    fsUuid: string;
    generation: number;
    leaseEpoch: number;
    nonce: string;
    /** True only for the computer's first boot (the host may create the filesystem). */
    provision: boolean;
    enrollUrl: string;
}

export class EnrollmentUserDataError extends Error {
    constructor(reason: string) {
        super(`enrollment_user_data_invalid:${reason}`);
        this.name = 'EnrollmentUserDataError';
    }
}

/**
 * Base64 of the host lease JSON (`infra/host-agent/lib/ezil_host/lease.py`):
 * `{v, computerId, volumeId, fsUuid, generation, leaseEpoch, nonce, provision}`,
 * plus the contract's `enrollUrl` (the host reads its URL from the AMI's
 * agent.json; the field is informational and ignored by `lease.parse`).
 * Key order is fixed: the document is digest-pinned through the intent.
 */
export function buildEnrollmentUserData(i: EnrollmentUserDataInput): string {
    if (!NONCE_RE.test(i.nonce)) throw new EnrollmentUserDataError('nonce');
    if (!Number.isSafeInteger(i.generation) || i.generation < 1 || i.generation > 2147483647) throw new EnrollmentUserDataError('generation');
    if (!Number.isSafeInteger(i.leaseEpoch) || i.leaseEpoch < 1 || i.leaseEpoch > 2147483647) throw new EnrollmentUserDataError('leaseEpoch');
    if (i.provision !== (i.volumeId === null)) throw new EnrollmentUserDataError('volumeId');
    const lease = {
        v: 1,
        computerId: typeof i.computerId === 'string' ? i.computerId.toLowerCase() : i.computerId,
        ...(i.volumeId === null ? {} : { volumeId: i.volumeId }),
        fsUuid: typeof i.fsUuid === 'string' ? i.fsUuid.toLowerCase() : i.fsUuid,
        generation: i.generation,
        leaseEpoch: i.leaseEpoch,
        nonce: i.nonce,
        provision: i.provision,
        enrollUrl: i.enrollUrl,
        ...(i.restore === undefined ? {} : { restore: i.restore }),
        ...(i.rebase === undefined ? {} : { rebase: i.rebase }),
        ...(i.rebasePermit === undefined ? {} : { rebasePermit: i.rebasePermit }),
        ...(i.ebsRestore === undefined ? {} : { ebsRestore: i.ebsRestore }),
    };
    const encoded = Buffer.from(JSON.stringify(lease), 'utf8').toString('base64');
    if (encoded.length > USER_DATA_MAX) throw new EnrollmentUserDataError('too_large');
    const parsed = EnrollmentLeaseSchema.safeParse(lease);
    if (!parsed.success) throw new EnrollmentUserDataError(parsed.error.issues[0]?.path.join('.') || 'permit_invalid');
    const canonical = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64');
    if (canonical.length > USER_DATA_MAX) throw new EnrollmentUserDataError('too_large');
    return canonical;
}

// ── Enrollment endpoint (C-6 steps 3-5) ──────────────────────────────────

/** What a live EC2 describe shows about the enrolling instance (C-6 step 3, last check). */
export interface Ec2EnrollmentView {
    instanceId: string;
    instanceType?: string;
    /** EC2 state name: only `running` enrolls. */
    state: string;
    /** Timestamp in EC2's StateTransitionReason, when the provider supplies one. */
    stateTransitionAt?: Date | null;
    availabilityZone: string;
    /** The ZoneId (e.g. `aps1-az1`): compared with the placement's. */
    availabilityZoneId: string;
    publicIp: string | null;
    tags: Readonly<Record<string, string>>;
    /** Every EBS volume attached to the instance. */
    volumes: readonly { volumeId: string; deleteOnTermination: boolean; tags: Readonly<Record<string, string>> }[];
}

/** Injected: a read-only EC2 describe in the placement's region. null = no such instance. */
export interface Ec2EnrollmentDescriber {
    describeForEnrollment(region: string, instanceId: string): Promise<Ec2EnrollmentView | null>;
}

/** GW-1 request body (GATEWAY-CONTRACT-v1). `controlKey` is base64. */
export interface TunnelRequest {
    computerId: string;
    sandboxId: string;
    generation: number;
    leaseEpoch: number;
    instanceId: string;
    region: string;
    publicIp: string;
    controlKey: string;
    /**
     * Read-only replay of THIS epoch's completed create (a host retrying after its 200 was
     * lost): the Worker answers with the existing tunnel's token only when the record matches
     * exactly, key included, inside its window; it never creates a tunnel for a replay.
     */
    replay?: true;
}
export type TunnelResult = { ok: true; tunnelToken: string } | { ok: false; status: number; code: string };

/** Injected: the Worker's tunnel API (GW-1). The app never holds a Cloudflare token. */
export interface TunnelClient {
    createTunnel(owner: { userId: string }, request: TunnelRequest): Promise<TunnelResult>;
    deleteTunnel(owner: { userId: string }, request: Pick<TunnelRequest, 'computerId' | 'sandboxId' | 'generation' | 'leaseEpoch'>): Promise<{ ok: boolean; status?: number }>;
}

/** GW-1 path on the Worker. */
export const TUNNELS_PATH = '/internal/aws/tunnels';

/**
 * The Worker's routable sandbox id, `guac-<user16>-<computer16>` (worker/src/aws-origin.ts
 * `isRoutableSandboxId`): the SAME derivation as the Cloudflare path and `aws-preview.ts`,
 * so the tunnel, the preview token and the browser host all name one sandbox. Ids are
 * lower-cased first: the Worker accepts lower case only, and placement ids are canonical.
 */
export function awsSandboxId(ownerUserId: string, computerId: string): string {
    return deriveGuacamoleSandboxId(ownerUserId.toLowerCase(), computerId.toLowerCase());
}

// The browser zone reader lives in aws-config.ts (aws-preview.ts and the frame check use it too).
export { AWS_BROWSER_ZONE_ENV, readAwsBrowserZone } from './aws-config';

/**
 * GW-1 over HTTPS with the app's v2 envelope (provider aws-ec2, no store claim).
 * The claims' computer, sandbox, user, generation and epoch equal the body's.
 */
export function createWorkerTunnelClient(cfg: { workerUrl: string; secret: string; fetch?: typeof fetch; now?: () => Date }): TunnelClient {
    const doFetch = cfg.fetch ?? fetch;
    // Milliseconds, like every other v2 minter: the Worker checks |Date.now() - ts| (hmac.ts).
    const nowMs = () => (cfg.now?.() ?? new Date()).getTime();
    const call = async (method: 'POST' | 'DELETE', owner: { userId: string }, body: Record<string, unknown> & { computerId: string; sandboxId: string; generation: number; leaseEpoch: number }) => {
        const text = JSON.stringify(method === 'DELETE'
            ? { computerId: body.computerId, generation: body.generation, leaseEpoch: body.leaseEpoch }
            : body);
        const auth = mintPreviewTokenV2(
            cfg.secret,
            { ts: nowMs(), sandboxId: body.sandboxId, computerId: body.computerId, userId: owner.userId, provider: 'aws-ec2', store: '', generation: body.generation, leaseEpoch: body.leaseEpoch },
            { method, path: TUNNELS_PATH, body: text },
        );
        return doFetch(`${cfg.workerUrl.replace(/\/$/, '')}${TUNNELS_PATH}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-ezil-auth': auth },
            body: text,
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
        });
    };
    return {
        async createTunnel(owner, request) {
            let res: Response;
            try {
                res = await call('POST', owner, { ...request });
            } catch {
                return { ok: false, status: 0, code: 'tunnel_transport' };
            }
            if (res.status !== 200) return { ok: false, status: res.status, code: `tunnel_http_${res.status}` };
            try {
                const json = (await res.json()) as { tunnelToken?: unknown };
                if (typeof json.tunnelToken !== 'string' || json.tunnelToken.length < 16) return { ok: false, status: 502, code: 'tunnel_response_malformed' };
                return { ok: true, tunnelToken: json.tunnelToken };
            } catch {
                return { ok: false, status: 502, code: 'tunnel_response_malformed' };
            }
        },
        async deleteTunnel(owner, request) {
            try {
                const res = await call('DELETE', owner, { ...request });
                return { ok: res.status === 200, status: res.status };
            } catch {
                return { ok: false };
            }
        },
    };
}

/** From the app's existing Worker settings (`CLOUDFLARE_GUACAMOLE_WORKER_URL`, shared HMAC secret); null when either is unset. */
export function workerTunnelClientFromEnv(env: AwsEnv): TunnelClient | null {
    const workerUrl = env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim();
    const secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    if (!workerUrl || !secret || !/^https:\/\//.test(workerUrl)) return null;
    return createWorkerTunnelClient({ workerUrl, secret });
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** The host body (`enroll.py`): exactly these fields. */
export const EnrollBodySchema = z
    .object({
        computerId: uuid,
        generation: z.number().int().min(1).max(2147483647),
        leaseEpoch: z.number().int().min(1).max(2147483647),
        nonce: z.string().regex(NONCE_RE),
        identityDocument: z.string().min(2).max(8192),
        signature: z.string().min(16).max(16384),
    })
    .strict();

const IdentityDocumentSchema = z
    .object({
        accountId: z.string().regex(/^\d{12}$/),
        instanceId: z.string().regex(/^i-[a-f0-9]{8,17}$/),
        instanceType: z.string(),
        region: z.string(),
        availabilityZone: z.string().min(1),
    })
    .passthrough();

export interface EnrollDeps {
    db: PlacementDb;
    env: AwsEnv;
    now: () => Date;
    /** Derives the per-epoch control key (`deriveControlKey`); the app↔Worker HMAC secret. Unset: unavailable. */
    controlKeySecret?: string;
    describer?: Ec2EnrollmentDescriber | null;
    tunnels?: TunnelClient | null;
}

export interface EnrollResponse {
    status: number;
    body: Record<string, unknown>;
}

const CONTROL_KEY_INFO = 'ezil-aws-control-key-v1';

/**
 * The epoch's GW-5 control key, DERIVED rather than random, so a host that retries an
 * enrollment whose 200 was lost gets the SAME key back:
 * HMAC-SHA256(secret, "ezil-aws-control-key-v1|computerId|generation|leaseEpoch|nonceHash").
 *
 * Nothing extra is stored for a replay. The only copies of the key stay where they already
 * were: the Worker's tunnel record (GW-1) and the host. A replay re-derives the key from the
 * nonce the host presents, and the Worker answers only when it equals the stored key exactly
 * (worker/src/aws-tunnels.ts `isExactReplay`), so a wrong nonce gets nothing. The secret is the
 * app↔Worker HMAC secret, whose holder can already sign Worker calls: no new exposure.
 */
export function deriveControlKey(secret: string, input: { computerId: string; generation: number; leaseEpoch: number; nonceHash: string }): Buffer {
    if (!secret.trim()) throw new Error('control_key_secret_not_configured');
    const info = [CONTROL_KEY_INFO, input.computerId.toLowerCase(), input.generation, input.leaseEpoch, input.nonceHash].join('|');
    return createHmac('sha256', secret).update(info).digest();
}

/** A completed enrollment may be replayed while its boot is still in flight or already running. */
const REPLAYABLE_STATES: readonly PlacementState[] = [...ENROLLABLE_STATES, 'RUNNING'];

const refuse = (status: number, error: string): EnrollResponse => ({ status, body: { error } });
/**
 * A refusal that consumed NOTHING and may clear on its own (configuration, a describe
 * outage, a lost race before the swap, EC2's eventually consistent view of a fresh boot).
 * The host keeps its nonce and retries, bounded (enroll.py); every other answer is final.
 */
const retryLater = (status: number, error: string): EnrollResponse => ({ status, body: { error, retryable: true } });

/**
 * A Worker tunnel answer that does not prove the Worker created NO tunnel: no answer (transport
 * error, timeout), throttling, or a 5xx, including a 200 whose body could not be read (the client
 * maps it to 502). The Worker may have committed the create (its creates are idempotent by name,
 * GW-1), so the epoch must stay ENROLLMENT_PENDING with its consumed-nonce proof and the host must
 * keep its nonce: its retry takes `pending` (exact replay of the epoch's tunnel first, a create only
 * when the Worker answers tunnel_absent). Only an answered 4xx is a definite refusal.
 */
export function tunnelOutcomeUnknown(t: TunnelResult): boolean {
    return !t.ok && (t.status === 0 || t.status === 429 || t.status >= 500);
}

const sameHash = (a: string, b: string) => {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
};

/** Tags infra `tagsFor` puts on the generation's instance and data volume. */
function expectedTags(p: Placement, namespace: string): Record<string, string> {
    return {
        'ezil:managed-by': 'app-computer-platform',
        'ezil:stage': namespace,
        'ezil:computer-id': p.computerId.toLowerCase(),
        'ezil:generation': String(p.generation),
        'ezil:fence-token': p.fenceToken ?? '',
    };
}
const carries = (tags: Readonly<Record<string, string>>, want: Record<string, string>) => Object.entries(want).every(([k, v]) => tags[k] === v);

/**
 * POST /api/compute/aws/enroll (C-6 steps 3-5). Every check passes, or the
 * request is refused and NOTHING changes; the nonce is consumed by one
 * compare-and-swap only after all of them. A failure after the swap is still
 * non-200 and final. Before the swap, a refusal that may clear on its own carries
 * `retryable: true` (`retryLater`): the host keeps that nonce and retries, bounded;
 * on any other answer it wipes the nonce and never re-sends it (enroll.py).
 * 🔴 Never logs or echoes the nonce, the control key or the tunnel token.
 */
export async function handleAwsEnrollment(deps: EnrollDeps, raw: unknown): Promise<EnrollResponse> {
    if (!isAwsComputersEnabled(deps.env)) return retryLater(404, 'not_found');
    if (!deps.describer || !deps.tunnels) return retryLater(503, 'enroll_unavailable');
    const parsed = EnrollBodySchema.safeParse(raw);
    if (!parsed.success) return refuse(400, 'enroll_request_invalid');
    const body = parsed.data;
    const now = deps.now();

    // Placement: an aws-ec2 computer in a boot that expects exactly this enrollment.
    const { record: p } = await readPlacement(deps.db, body.computerId);
    if (!p || p.provider !== 'aws-ec2' || !p.region || !p.zoneId || !p.fenceToken || !p.instanceType) return refuse(403, 'enroll_refused');
    const nonceHash = nonceHashOf(body.nonce);
    // This epoch's enrollment already completed (nonce consumed, tunnel created, success recorded)
    // and the host is retrying because the 200 never reached it. Its nonce can no longer be checked
    // here; the Worker checks it instead, through the derived key (`deriveControlKey`).
    const replay = !p.enrollNonceHash && p.lastError === ENROLLMENT_SUCCEEDED && p.instanceId !== null;
    // The nonce was consumed but completion was never recorded (the completion write failed after
    // the Worker created the tunnel, or the consume's own response was lost). The consuming
    // instance, authenticated below by its AWS-signed identity and the live describe, may finish it.
    const pending = !p.enrollNonceHash && p.lastError === ENROLLMENT_PENDING && p.instanceId !== null;
    if (!(replay ? REPLAYABLE_STATES : ENROLLABLE_STATES).includes(p.state)) return refuse(403, 'enroll_state');
    if (p.generation !== body.generation || p.leaseEpoch !== body.leaseEpoch) return refuse(403, 'enroll_stale_epoch');
    if (replay || pending) {
        // C-6: the nonce binds enrollment to the one boot that received it. Consume moved its hash to
        // `enrollConsumedHash`; recovery still requires that nonce, inside its window, before ANY
        // Worker call. The identity document alone (replayable by whoever holds a copy) never suffices.
        if (!p.enrollConsumedHash || !p.enrollExpiresAt) return refuse(409, 'enroll_nonce_consumed');
        if (!sameHash(nonceHash, p.enrollConsumedHash)) return refuse(403, 'enroll_nonce_invalid');
        if (p.enrollExpiresAt.getTime() <= now.getTime()) return refuse(403, 'enroll_nonce_expired');
    } else {
        if (!p.enrollNonceHash || !p.enrollExpiresAt) return refuse(403, 'enroll_nonce_invalid');
        if (!sameHash(nonceHash, p.enrollNonceHash)) return refuse(403, 'enroll_nonce_invalid');
        if (p.enrollExpiresAt.getTime() <= now.getTime()) return refuse(403, 'enroll_nonce_expired');
    }

    // The signed identity document, against the region's configured AWS certificate.
    const cert = readIdentityCertificate(deps.env, p.region);
    const deployments = readLifecycleDeployments(deps.env, [p.region]);
    const browserZone = readAwsBrowserZone(deps.env);
    if (!cert || !deployments.ok || !browserZone) return retryLater(503, 'enroll_unavailable');
    const deployment = deployments.deployments[p.region]!;
    const signature = verifyIdentitySignature(body.identityDocument, body.signature, cert, now);
    if (!signature.ok) return refuse(403, signature.reason);
    let doc: z.infer<typeof IdentityDocumentSchema>;
    try {
        const d = IdentityDocumentSchema.safeParse(JSON.parse(body.identityDocument));
        if (!d.success) return refuse(403, 'identity_document_invalid');
        doc = d.data;
    } catch {
        return refuse(403, 'identity_document_invalid');
    }
    if (doc.region !== p.region || doc.accountId !== deployment.accountId || doc.instanceType !== p.instanceType) return refuse(403, 'identity_document_mismatch');
    if (p.instanceId !== null && p.instanceId !== doc.instanceId) return refuse(403, 'instance_mismatch');

    // Live describe: this instance is running NOW, in the placement's ZoneId, tagged as this
    // generation (fence included) and holding the computer's data volume.
    let view: Ec2EnrollmentView | null;
    try {
        view = await deps.describer.describeForEnrollment(p.region, doc.instanceId);
    } catch {
        return retryLater(503, 'enroll_describe_unavailable');
    }
    if (!view || view.instanceId !== doc.instanceId) return refuse(403, 'enroll_instance_unknown');
    // A host is already running code, so `pending` is only EC2's lagging view of this boot.
    if (view.state === 'pending') return retryLater(403, 'enroll_instance_not_running');
    if (view.state !== 'running') return refuse(403, 'enroll_instance_not_running');
    if (view.availabilityZone !== doc.availabilityZone || view.availabilityZoneId !== p.zoneId) return refuse(403, 'enroll_zone_mismatch');
    const tags = expectedTags(p, deployment.namespace);
    if (!carries(view.tags, tags)) return refuse(403, 'enroll_instance_mismatch');
    if (!view.publicIp) return refuse(403, 'enroll_instance_mismatch');
    let volumeId: string;
    if (p.volumeId) {
        const v = view.volumes.filter((x) => x.volumeId === p.volumeId);
        // The workflow attaches the data volume after the instance runs (helper.ts): not seen yet ≠ wrong.
        if (v.length === 0) return retryLater(403, 'enroll_volume_mismatch');
        if (v.length !== 1 || v[0]!.deleteOnTermination !== false) return refuse(403, 'enroll_volume_mismatch');
        volumeId = p.volumeId;
    } else {
        // Provision: the data volume is the one non-root, retained volume tagged for this computer.
        const data = view.volumes.filter((x) => x.deleteOnTermination === false && x.tags['ezil:disk-kind'] === undefined && x.tags['ezil:computer-id'] === tags['ezil:computer-id']);
        if (data.length === 0) return retryLater(403, 'enroll_volume_mismatch');
        if (data.length !== 1) return refuse(403, 'enroll_volume_mismatch');
        volumeId = data[0]!.volumeId;
    }

    // Derive the key before consuming: a missing secret leaves the nonce intact.
    let controlKey: Buffer;
    try {
        controlKey = deriveControlKey(deps.controlKeySecret ?? '', { computerId: p.computerId, generation: p.generation, leaseEpoch: p.leaseEpoch, nonceHash });
    } catch {
        return retryLater(503, 'enroll_unavailable');
    }
    const keyB64 = controlKey.toString('base64');
    const sandboxId = awsSandboxId(p.ownerUserId, p.computerId);
    const tunnelRequest = (instanceId: string, publicIp: string): TunnelRequest => ({
        computerId: p.computerId.toLowerCase(),
        sandboxId,
        generation: p.generation,
        leaseEpoch: p.leaseEpoch,
        instanceId,
        region: p.region!,
        publicIp,
        controlKey: keyB64,
    });
    const success = (tunnelToken: string): EnrollResponse =>
        // sandboxId + zone let the host's edge recognise its own browser hosts (edge.py).
        ({ status: 200, body: { tunnelToken, controlKey: keyB64, sandboxId, zone: browserZone } });

    if (replay) {
        // Read-only: the Worker returns this epoch's existing tunnel token only for the exact record
        // (same instance, address and key) inside its window. No consume, no new tunnel, no write.
        // Enrollment preserves placement state; the receipt path meters the first RUNNING transition.
        let replayed: TunnelResult;
        try {
            replayed = await deps.tunnels.createTunnel({ userId: p.ownerUserId }, { ...tunnelRequest(doc.instanceId, view.publicIp), replay: true });
        } catch {
            replayed = { ok: false, status: 0, code: 'tunnel_transport' };
        }
        if (replayed.ok) return success(replayed.tunnelToken);
        // 409: not this epoch's key (another nonce) or past the window; 404: no tunnel for this
        // epoch any more (stopped, fenced). Final either way.
        return replayed.status === 409 || replayed.status === 404 ? refuse(409, 'enroll_nonce_consumed') : retryLater(503, 'tunnel_unavailable');
    }

    if (pending) {
        // 1. The tunnel the first attempt created, by EXACT replay: the key derived from the nonce the
        //    host presents must equal the one the Worker stored, so a wrong nonce gets nothing here.
        // 2. Only when the Worker has NO tunnel for this epoch (404, its create never completed) is it
        //    created now; the Worker adopts by name whatever a lost create left, and answers 409 if
        //    any record already holds the epoch, so an epoch never gets a second tunnel.
        const call = async (request: TunnelRequest): Promise<TunnelResult> => {
            try {
                return await deps.tunnels!.createTunnel({ userId: p.ownerUserId }, request);
            } catch {
                return { ok: false, status: 0, code: 'tunnel_transport' };
            }
        };
        const request = tunnelRequest(doc.instanceId, view.publicIp);
        let t = await call({ ...request, replay: true });
        if (!t.ok && t.status === 404) {
            t = await call(request);
            // A concurrent completion of this same pending enrollment won the create: replay it.
            if (!t.ok && t.status === 409) t = await call({ ...request, replay: true });
        }
        if (!t.ok && (t.status === 409 || t.status === 404)) return refuse(409, 'enroll_nonce_consumed');
        // Ambiguous answers stay pending and retryable; so does any other refusal here, which leaves the
        // epoch exactly as it was (the host's bounded retry ends it, keeping its nonce).
        if (!t.ok) return retryLater(503, 'tunnel_unavailable');
        let done: Awaited<ReturnType<typeof finishEnrollment>>;
        try {
            done = await finishEnrollment(deps.db, { computerId: p.computerId, expected: p, success: true });
        } catch {
            return retryLater(503, 'enroll_finish_unavailable');
        }
        if (!done.ok) {
            // A concurrent completion may already have recorded this epoch's success.
            const { record: current } = await readPlacement(deps.db, p.computerId);
            const recorded = current && current.generation === p.generation && current.leaseEpoch === p.leaseEpoch && current.lastError === ENROLLMENT_SUCCEEDED;
            if (!recorded) return refuse(409, 'enroll_conflict');
        }
        return success(t.tunnelToken);
    }

    let expected = p;
    let consumed: Placement | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await consumeEnrollmentNonce(deps.db, {
            computerId: p.computerId, expected, nonceHash,
            fields: { instanceId: doc.instanceId, volumeId },
        });
        if (result.ok) {
            consumed = result.placement;
            break;
        }
        // Resolve receipt races here; only a swap lost twice with the nonce intact is retryable.
        const { record: current } = await readPlacement(deps.db, p.computerId);
        if (!current || current.generation !== p.generation || current.leaseEpoch !== p.leaseEpoch) return refuse(409, 'enroll_stale_epoch');
        if (!current.enrollNonceHash) return refuse(409, 'enroll_nonce_consumed');
        if (!sameHash(current.enrollNonceHash, nonceHash)) return refuse(403, 'enroll_nonce_invalid');
        if (current.instanceId !== null && current.instanceId !== doc.instanceId) return refuse(403, 'instance_mismatch');
        if (!current.enrollExpiresAt || current.enrollExpiresAt.getTime() <= deps.now().getTime()) return refuse(403, 'enroll_nonce_expired');
        if (!ENROLLABLE_STATES.includes(current.state)) return refuse(409, 'enroll_state');
        expected = current;
    }
    if (!consumed) return retryLater(503, 'enroll_conflict');
    let tunnel: TunnelResult;
    try {
        tunnel = await deps.tunnels.createTunnel({ userId: p.ownerUserId }, tunnelRequest(doc.instanceId, view.publicIp));
    } catch {
        tunnel = { ok: false, status: 0, code: 'tunnel_transport' };
    }
    // Ambiguous (the Worker may have committed the tunnel): no finish at all. The placement keeps
    // ENROLLMENT_PENDING and the consumed-nonce proof, and the retryable answer keeps the host's nonce.
    if (tunnelOutcomeUnknown(tunnel)) return retryLater(503, 'tunnel_unavailable');
    let finished: Awaited<ReturnType<typeof finishEnrollment>>;
    try {
        finished = await finishEnrollment(deps.db, { computerId: p.computerId, expected: consumed, success: tunnel.ok });
    } catch {
        // The completion write failed (a transient database error) after the nonce was consumed:
        // the placement keeps ENROLLMENT_PENDING. A structured retryable answer keeps the host's
        // nonce (enroll.py), and its retry finishes through `pending` above, against the exact
        // tunnel this call created (or creating it, if this call's create failed too).
        return retryLater(503, 'enroll_finish_unavailable');
    }
    if (!tunnel.ok) return refuse(502, 'tunnel_unavailable');
    if (!finished.ok) return refuse(409, 'enroll_conflict');
    return success(tunnel.tunnelToken);
}

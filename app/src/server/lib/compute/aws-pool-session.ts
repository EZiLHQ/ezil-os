import { poolTimingSchema, poolTimingDeltas } from './aws-pool-timing';
import { recordPoolSessionReady } from './ready-pool';
import { parseRebaseJson } from './aws-rebase-json';
import { finishEnrollment, ENROLLMENT_SUCCEEDED, POOL_SESSION_PENDING, readPlacement, type PlacementExecutor } from './placement';
import { isAwsComputersEnabled, type Env } from './aws-config';
import { awsSandboxId, type PoolRelayEnrollment } from './aws-enroll';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import { authenticatePoolHost, bindPoolRow, readPoolProof } from './aws-pool-host';
import { POOL_NO_STORE, poolErrorResponse, poolGuard } from './aws-pool-errors';
import type { PoolClaimDeps } from './aws-pool-claim';

/** After the enrollment response is sent, prime the existing Worker exchange while
 * the host starts its tunnel. Every retry rechecks this enrollment's exact binding;
 * the Worker still verifies the connector IP and the host authenticates the ICE push.
 * No handoff, readiness transition or credential is returned from this best effort job.
 */
export async function primePoolRelay(deps: { db: PlacementExecutor; env: Env; fetch?: typeof fetch;
    nowMs?: () => number; sleep?: (ms: number) => Promise<void> }, expected: PoolRelayEnrollment): Promise<void> {
    const now = deps.nowMs ?? (() => performance.now());
    const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const started = now();
    const deadline = started + 30_000;
    const PRIME_BACKOFF_MS = [500, 1000, 1000, 1500, 2000, 2500, 3000, 3000, 3000];
    const PRIME_FAST_MS = 500;
    const PRIME_FAST_WINDOW_MS = 10_000;
    const PRIME_MAX_PROBES = 30;
    let backoff = 0;
    try {
        const secret = deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
        if (!isAwsComputersEnabled(deps.env) || !secret) return;
        const endpoint = new URL(`${deps.env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim().replace(/\/$/, '')}/sandbox/preview`);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return;
        // Probe frequently while the tunnel connects, then use the existing backoff.
        // Both elapsed request time and total probe count bound the work.
        for (let attempt = 0; attempt < PRIME_MAX_PROBES && now() < deadline; attempt++) {
            const { record: p } = await readPlacement(deps.db, expected.computerId, expected.ownerUserId);
            if (!p || p.provider !== 'aws-ec2' || p.generation !== expected.generation || p.leaseEpoch !== expected.leaseEpoch
                || p.instanceId !== expected.instanceId || !p.instanceId || p.fenceToken !== expected.fenceToken || !p.fenceToken
                || p.lastError !== POOL_SESSION_PENDING || p.enrollNonceHash !== null || p.enrollConsumedHash === null
                || !p.volumeId || !p.lifecycleJobId || !p.lifecycleDigest
                || !['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(p.state)) return;
            const remaining = Math.floor(deadline - now());
            if (remaining <= 0) return;
            const body = JSON.stringify({ sessionId: `pool-enroll-${p.leaseEpoch}`, userId: p.ownerUserId,
                projectId: p.computerId, desktopMode: 'neko' });
            const token = mintPreviewTokenV2(secret, { ts: Date.now(), sandboxId: awsSandboxId(p.ownerUserId, p.computerId),
                computerId: p.computerId, userId: p.ownerUserId, provider: 'aws-ec2', store: '',
                generation: p.generation, leaseEpoch: p.leaseEpoch }, { method: 'POST', path: endpoint.pathname, body });
            const response = await (deps.fetch ?? fetch)(endpoint.toString(), { method: 'POST', body, redirect: 'error',
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token },
                signal: AbortSignal.timeout(Math.min(20_000, remaining)) });
            const result = await response.json() as { error?: unknown };
            // Only a connector/control service still starting warrants another probe.
            // aws_desktop_starting means the existing exchange has done its work.
            if (response.status !== 503 || !['aws_origin_starting', 'aws_desktop_unreachable'].includes(String(result?.error))) return;
            if (attempt + 1 < PRIME_MAX_PROBES && now() < deadline) {
                const delay = now() - started < PRIME_FAST_WINDOW_MS ? PRIME_FAST_MS
                    : PRIME_BACKOFF_MS[Math.min(backoff++, PRIME_BACKOFF_MS.length - 1)]!;
                await sleep(Math.min(delay, deadline - now()));
            }
        }
    } catch {
        // Never log Worker bodies or exceptions. The normal browser wake loop remains
        // the fallback for DB/transport failures and for an expired preparation budget.
    }
}

/** The host reports this only after the single desktop switch, mounted disk and healthy relay/editor. */
export async function handlePoolSessionReady(req: Request, deps: PoolClaimDeps): Promise<Response> {
    try {
        let body: { sessionReady?: boolean; timing?: unknown };
        try { body = parseRebaseJson(await req.text(), 1024) as typeof body; }
        catch { return Response.json({ error: 'pool_request_invalid' }, { status: 400, headers: POOL_NO_STORE }); }
        poolGuard('session_health', body?.sessionReady === true);
        const parsedTiming = body.timing === undefined ? undefined : poolTimingSchema.safeParse(body.timing);
        poolGuard('session_timing', parsedTiming === undefined || parsedTiming.success, 400);
        const timing = parsedTiming?.data;
        const proof = readPoolProof(req);
        const identity = await authenticatePoolHost(deps, proof, true);
        const computer = await deps.db.transaction(async tx => {
            const row = await deps.data.readPoolClaim(tx, proof.poolHostId, identity.doc.instanceId);
            poolGuard('session_claim', row && row.state === 'leased' && row.leasedComputerId);
            bindPoolRow(row, proof, identity);
            const p = await deps.lockPlacement(tx, row.leasedComputerId);
            poolGuard('session_binding', p && p.provider === 'aws-ec2' && p.region === row.region && p.zoneId === row.zoneId && p.instanceType === row.instanceType && p.computerId === row.leasedComputerId
                && p.generation === row.claimGeneration && p.leaseEpoch === row.claimLeaseEpoch && p.fenceToken === row.claimFence
                && p.instanceId === identity.doc.instanceId && p.volumeId?.replace('-', '') === row.claimVolumeSerial?.replace('-', '')
                && p.enrollNonceHash === null && p.enrollConsumedHash !== null);
            poolGuard('session_tags', identity.view.tags['ezil:computer'] === p.computerId
                && identity.view.tags['ezil:generation'] === String(p.generation) && identity.view.tags['ezil:fence'] === p.fenceToken
                && identity.view.tags['ezil:pool'] === undefined
                && identity.view.volumes.some(v => v.volumeId === p.volumeId && !v.deleteOnTermination));
            if (p.lastError === ENROLLMENT_SUCCEEDED) return; // Lost acknowledgement never moves the billing timestamp.
            poolGuard('session_pending', p.lastError === POOL_SESSION_PENDING);
            const result = await finishEnrollment({ execute: q => tx.execute(q), transaction: fn => fn(tx) },
                { computerId: p.computerId, expected: p, success: true, poolClaim: true, sessionReady: true });
            poolGuard('session_finished', result.ok, 503);
            poolGuard('session_timestamp', await recordPoolSessionReady(tx, row.poolHostId, p, result.placement.updatedAt), 503);
            return p.computerId.slice(0, 8);
        });
        if (computer && timing) console.info(JSON.stringify({ event: 'pool-session-timing', computer, ...poolTimingDeltas(timing) }));
        return Response.json({ ok: true }, { headers: POOL_NO_STORE });
    } catch (error) { return poolErrorResponse(error); }
}

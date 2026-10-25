import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { issueEnrollmentNonce, type EnrollmentNonce } from './aws-enroll';
import { buildLifecycleWork, LifecycleIntentSchema } from './aws-intent';
import { lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';
import { parseRebaseJson, RebaseUuid } from './aws-rebase-json';
import { ENROLLABLE_STATES, type Placement, type PlacementExecutor } from './placement';
import { authenticatePoolHost, bindPoolRow, readPoolProof, type PoolHostDeps, type PoolProof } from './aws-pool-host';
import { POOL_NO_STORE, poolErrorResponse, poolGuard } from './aws-pool-errors';
import { pollWait } from './poll-wait';

export interface PoolClaimDeps extends PoolHostDeps {
    executions: LifecycleExecutionReader | null;
    observeAdopt?(proof: PoolProof, identity: Awaited<ReturnType<typeof authenticatePoolHost>>): Promise<void | 'pending'>;
    /** Locks the placement until the nonce hash is stored. */
    lockPlacement(tx: PlacementExecutor, computerId: string): Promise<Placement | null>;
    saveNonce(tx: PlacementExecutor, p: Placement, nonce: EnrollmentNonce): Promise<boolean>;
}
const claimSchema = z.object({ computerId: RebaseUuid, generation: z.number().int().positive(), leaseEpoch: z.number().int().positive(),
    fence: RebaseUuid, volumeSerial: z.string().regex(/^vol-?[a-f0-9]{17}$/) });
export async function handlePoolClaim(req: Request, deps: PoolClaimDeps): Promise<Response> {
    try {
        const proof = readPoolProof(req);
        let identity = await authenticatePoolHost(deps, proof, true);
        const deadline = performance.now() + 5_000;
        let held = false;
        for (let check = 0; ; check++) {
            if (req.signal.aborted) return new Response(null, { status: 204, headers: POOL_NO_STORE });
            const observation = await deps.observeAdopt?.(proof, identity);
            if (observation !== 'pending') break;
            const remaining = deadline - performance.now();
            if (remaining <= 0 || check === 20 || !await pollWait(Math.min(250, remaining), req.signal))
                return new Response(null, { status: 204, headers: POOL_NO_STORE });
            held = true;
        }
        // Never issue a nonce using the pre-hold EC2 view. All original guards below
        // run again in a fresh transaction; no lock was held during the wait.
        if (req.signal.aborted) return new Response(null, { status: 204, headers: POOL_NO_STORE });
        if (held) identity = await authenticatePoolHost(deps, proof, true);
        if (req.signal.aborted) return new Response(null, { status: 204, headers: POOL_NO_STORE });
        const claim = await deps.db.transaction(async tx => {
            const row = await deps.data.readPoolClaim(tx, proof.poolHostId, identity.doc.instanceId);
            poolGuard('claim_published', row, 204);
            bindPoolRow(row, proof, identity);
            poolGuard('claim_leased', row.state === 'leased', 204);
            const payload = claimSchema.parse({ computerId: row.leasedComputerId, generation: row.claimGeneration,
                leaseEpoch: row.claimLeaseEpoch, fence: row.claimFence, volumeSerial: row.claimVolumeSerial });
            const p = await deps.lockPlacement(tx, payload.computerId);
            poolGuard('claim_placement', p && p.computerId === payload.computerId && p.provider === 'aws-ec2'
                && p.instanceId === identity.doc.instanceId && p.region === row.region && p.zoneId === row.zoneId && p.instanceType === row.instanceType);
            poolGuard('claim_epoch', p.generation === payload.generation && p.leaseEpoch === payload.leaseEpoch && p.fenceToken === payload.fence);
            poolGuard('claim_volume', p.volumeId && p.volumeId.replace('-', '') === payload.volumeSerial.replace('-', ''));
            poolGuard('claim_enrollable', ENROLLABLE_STATES.includes(p.state), 204);
            poolGuard('claim_adopted_tags', identity.view.tags['ezil:pool'] === undefined
                && identity.view.tags['ezil:computer'] === payload.computerId
                && identity.view.tags['ezil:generation'] === String(payload.generation) && identity.view.tags['ezil:fence'] === payload.fence, 204);
            poolGuard('claim_attached', identity.view.volumes.some(v => v.volumeId === p.volumeId && !v.deleteOnTermination), 204);
            poolGuard('claim_job', p.lifecycleJobId && p.lifecycleDigest && deps.executions, 204);
            const arn = lifecycleExecutionArn(identity.deployment, p.lifecycleJobId);
            const execution = await deps.executions.describe(row.region, arn);
            poolGuard('adopt_succeeded', execution.status === 'SUCCEEDED', 204);
            poolGuard('adopt_execution', execution.executionArn === arn
                && execution.stateMachineVersionArn === identity.deployment.stateMachineVersionArn && !execution.stateMachineAliasArn);
            const envelope = z.object({ schemaVersion: z.literal(1), document: z.string(), digest: z.string() }).strict()
                .parse(parseRebaseJson(execution.input ?? '', 20000));
            const work = buildLifecycleWork(LifecycleIntentSchema.parse(parseRebaseJson(envelope.document, 16384)));
            const i = work.intent;
            poolGuard('adopt_digest', work.digest === envelope.digest && envelope.digest === p.lifecycleDigest);
            poolGuard('adopt_binding', i.operation === 'adopt' && i.jobId === p.lifecycleJobId && i.computerId === p.computerId
                && i.poolHostId === row.poolHostId && i.targetGeneration === p.generation && i.leaseEpoch === p.leaseEpoch
                && i.fenceToken === p.fenceToken && i.providerInstanceId === p.instanceId
                && JSON.stringify(i.deployment) === JSON.stringify({ ...identity.deployment, storage: { rootDeviceName: '/dev/sda1', ...identity.deployment.storage } }));
            const receipt = parseRebaseJson(execution.output ?? '', 16384) as Record<string, unknown>;
            poolGuard('adopt_receipt', receipt && receipt.schemaVersion === 1 && receipt.state === 'running'
                && receipt.jobId === p.lifecycleJobId && receipt.digest === p.lifecycleDigest && receipt.computerId === p.computerId
                && receipt.generation === p.generation && receipt.leaseEpoch === p.leaseEpoch && receipt.fenceToken === p.fenceToken
                && receipt.instanceId === p.instanceId && receipt.volumeId === p.volumeId);
            poolGuard('nonce_unconsumed', p.enrollConsumedHash === null, 204);
            const secret = deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET;
            poolGuard('nonce_configured', secret && secret.length >= 32, 503);
            // A domain-separated PRF makes lost claim responses replayable without storing plaintext.
            // The existing enrollment CAS consumes the hash once; retries never extend its deadline.
            const material = JSON.stringify(['ezil-pool-enroll-v1', row.poolHostId, p.instanceId, p.computerId,
                p.generation, p.leaseEpoch, p.fenceToken, p.lifecycleJobId]);
            const nonce = issueEnrollmentNonce(deps.now(), () => createHmac('sha256', secret).update(material).digest());
            if (p.enrollNonceHash !== null) {
                poolGuard('nonce_matches', p.enrollNonceHash === nonce.nonceHash);
                poolGuard('nonce_fresh', p.enrollExpiresAt && p.enrollExpiresAt.getTime() > deps.now().getTime(), 204);
            } else poolGuard('nonce_saved', await deps.saveNonce(tx, p, nonce), 204);
            return { ...payload, enrollNonce: nonce.nonce,
                ...(row.claimPublishedAt && Number.isFinite(row.claimPublishedAt.getTime())
                    ? { claimPublishedAtMs: row.claimPublishedAt.getTime() } : {}),
                ...(i.dataVolumeGiB !== null ? { createVolume: true, fsUuid: p.fsUuid } : {}) };
        });
        return Response.json(claim, { headers: POOL_NO_STORE });
    } catch (error) { return poolErrorResponse(error); }
}

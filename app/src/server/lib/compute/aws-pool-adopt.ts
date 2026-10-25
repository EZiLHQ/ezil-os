import { performance } from 'node:perf_hooks';
import { buildLifecycleWork, LifecycleIntentSchema } from './aws-intent';
import { applyLifecycleReceipt, lifecycleExecutionArn, LifecycleReceiptSchema } from './aws-receipts';
import { parseRebaseJson } from './aws-rebase-json';
import { readPlacement } from './placement';
import * as pool from './ready-pool';
import { authenticatePoolHost, bindPoolRow, type PoolProof } from './aws-pool-host';
import type { PoolClaimDeps } from './aws-pool-claim';
import { poolGuard } from './aws-pool-errors';
import { z } from 'zod';

/** The host's existing one-second poll can observe success without a browser poll.
 * Reuse receipt reconciliation, including its admission lock, attached-volume CAS
 * and image-job exclusion. The claim endpoint still validates everything again
 * under the placement lock before issuing the epoch's one-time nonce.
 */
export async function observePoolAdopt(deps: PoolClaimDeps, proof: PoolProof,
    identity: Awaited<ReturnType<typeof authenticatePoolHost>>): Promise<void | 'pending'> {
    const row = await pool.readPendingPoolAdopt(deps.db, proof.poolHostId, identity.doc.instanceId);
    if (!row) return;
    bindPoolRow(row, proof, identity);
    poolGuard('observe_leased', row.state === 'leased' && row.leasedComputerId);
    const p = (await readPlacement(deps.db, row.leasedComputerId)).record;
    poolGuard('observe_binding', p && p.computerId === row.leasedComputerId && p.provider === 'aws-ec2'
        && p.instanceId === row.instanceId && p.region === row.region && p.zoneId === row.zoneId
        && p.instanceType === row.instanceType);
    // No recovery, stop, billing or nonce-consumption work in the claim observer.
    if (!['LEASED', 'STARTING', 'MOUNTING'].includes(p.state) || p.enrollConsumedHash !== null
        || !p.lifecycleJobId || !p.lifecycleDigest || !deps.executions) return;
    const arn = lifecycleExecutionArn(identity.deployment, p.lifecycleJobId);
    const e = await deps.executions.describe(row.region, arn);
    if (e.status === 'RUNNING') return 'pending';
    if (e.status !== 'SUCCEEDED') return;
    const observed = performance.now();
    poolGuard('observe_execution', e.executionArn === arn
        && e.stateMachineVersionArn === identity.deployment.stateMachineVersionArn && !e.stateMachineAliasArn);
    const envelope = z.object({ schemaVersion: z.literal(1), document: z.string(), digest: z.string() }).strict()
        .parse(parseRebaseJson(e.input ?? '', 20000));
    const work = buildLifecycleWork(LifecycleIntentSchema.parse(parseRebaseJson(envelope.document, 16384)));
    poolGuard('observe_work', work.digest === envelope.digest && work.digest === p.lifecycleDigest
        && work.intent.operation === 'adopt' && work.intent.poolHostId === row.poolHostId
        && work.intent.jobId === p.lifecycleJobId && work.intent.computerId === p.computerId
        && work.intent.targetGeneration === p.generation && work.intent.leaseEpoch === p.leaseEpoch
        && work.intent.fenceToken === p.fenceToken && work.intent.providerInstanceId === p.instanceId
        && JSON.stringify(work.intent.deployment) === JSON.stringify({ ...identity.deployment,
            storage: { rootDeviceName: '/dev/sda1', ...identity.deployment.storage } }));
    const receipt = LifecycleReceiptSchema.parse(parseRebaseJson(e.output ?? '', 16384));
    // The host may have been adopted since authentication at the start of a hold.
    identity = await authenticatePoolHost(deps, proof, true);
    poolGuard('observe_attached', identity.view.tags['ezil:pool'] === undefined
        && identity.view.tags['ezil:computer'] === p.computerId
        && identity.view.tags['ezil:generation'] === String(p.generation)
        && identity.view.tags['ezil:fence'] === p.fenceToken
        && identity.view.volumes.some(v => v.volumeId === receipt.volumeId && !v.deleteOnTermination), 204);
    let published = false;
    await applyLifecycleReceipt({ db: deps.db, now: deps.now, executions: { describe: async () => e },
        pool: { leasePoolHost: pool.leasePoolHost, buildWork: buildLifecycleWork, replenish: async () => {},
            publishPoolClaim: async (...args) => {
                const result = await pool.publishPoolClaim(...args);
                published = true;
                return result;
            } },
    }, p, identity.deployment, { terminalOnly: true });
    // A rollback must never emit a publication success. No provider/claim material.
    if (published) console.info(JSON.stringify({ event: 'pool-claim-timing', computer: p.computerId.slice(0, 8),
        adoptObservedToClaimPublishedMs: Math.round(performance.now() - observed) }));
}

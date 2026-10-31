import { z } from 'zod';
import type { Env } from './aws-config';
import { isAwsComputersEnabled } from './aws-config';
import { readIdentityCertificate, verifyIdentitySignature } from './aws-identity';
import type { Ec2EnrollmentDescriber } from './aws-enroll';
import { readLifecycleDeployments } from './aws-intent';
import { parseRebaseJson, RebaseUuid } from './aws-rebase-json';
import type { PlacementDb } from './placement';
import { POOL_NO_STORE, PoolError, poolErrorResponse, poolGuard } from './aws-pool-errors';
import { POOL_TYPES, type PoolClass, type PoolData, type PoolHostRow } from './ready-pool';

const proofSchema = z.object({ poolHostId: RebaseUuid, poolGeneration: z.number().int().positive().max(2147483647),
    identityDocument: z.string().min(2).max(8192), signature: z.string().min(16).max(16384) }).strict();
const identitySchema = z.object({ accountId: z.string().regex(/^\d{12}$/), instanceId: z.string().regex(/^i-[a-f0-9]{17}$/),
    region: z.string(), availabilityZone: z.string(), instanceType: z.string() }).passthrough();
export type PoolProof = z.infer<typeof proofSchema>;
export interface PoolHostDeps {
    db: PlacementDb; data: PoolData; env: Env; now(): Date;
    describer: Ec2EnrollmentDescriber | null;
    verify?: typeof verifyIdentitySignature;
}
export function readPoolProof(req: Request, body?: unknown): PoolProof {
    if (body !== undefined) return proofSchema.parse(body);
    return proofSchema.parse({ poolHostId: req.headers.get('x-ezil-pool-host-id'),
        poolGeneration: Number(req.headers.get('x-ezil-pool-generation')),
        identityDocument: Buffer.from(req.headers.get('x-ezil-identity-document') ?? '', 'base64').toString('utf8'),
        signature: req.headers.get('x-ezil-identity-signature') });
}
export async function authenticatePoolHost(deps: PoolHostDeps, proof: PoolProof, adopted = false) {
    poolGuard('host_enabled', isAwsComputersEnabled(deps.env) && deps.describer, 503);
    const doc = identitySchema.parse(parseRebaseJson(proof.identityDocument, 8192));
    const configs = readLifecycleDeployments(deps.env, [doc.region]);
    const certificate = readIdentityCertificate(deps.env, doc.region);
    poolGuard('identity_configured', configs.ok && certificate, 503);
    const deployment = configs.deployments[doc.region]!;
    poolGuard('identity_signature', (deps.verify ?? verifyIdentitySignature)(proof.identityDocument, proof.signature, certificate, deps.now()).ok);
    poolGuard('identity_account', doc.accountId === deployment.accountId);
    poolGuard('identity_type', POOL_TYPES.includes(doc.instanceType as PoolClass['instanceType']) && deployment.instanceTypes.includes(doc.instanceType));
    const view = await deps.describer.describeForEnrollment(doc.region, doc.instanceId);
    poolGuard('live_instance', view && view.instanceId === doc.instanceId && view.state === 'running');
    poolGuard('live_zone', view.availabilityZone === doc.availabilityZone && view.availabilityZoneId === deployment.zoneId);
    poolGuard('live_type', view.instanceType === doc.instanceType);
    poolGuard('live_namespace', view.tags['ezil:managed-by'] === 'app-computer-platform'
        && view.tags['ezil:stage'] === deployment.namespace && view.tags['ezil:namespace'] === deployment.namespace);
    poolGuard('live_pool_host', view.tags['ezil:pool-host'] === proof.poolHostId);
    if (!adopted) {
        poolGuard('unclaimed_pool', view.tags['ezil:pool'] === '1'
            && view.tags['ezil:computer'] === undefined && view.tags['ezil:computer-id'] === undefined);
        // The existing describer exposes deletion policy, but not device names. A clean AMI has one root EBS disk.
        poolGuard('root_only', view.volumes.length === 1 && view.volumes[0]!.deleteOnTermination);
    }
    return { doc, view, deployment };
}
export function bindPoolRow(row: PoolHostRow, proof: PoolProof, identity: Awaited<ReturnType<typeof authenticatePoolHost>>) {
    poolGuard('row_host', row.poolHostId === proof.poolHostId && row.instanceId === identity.doc.instanceId);
    poolGuard('row_generation', row.poolGeneration === proof.poolGeneration);
    poolGuard('row_class', row.region === identity.doc.region && row.zoneId === identity.deployment.zoneId && row.instanceType === identity.doc.instanceType);
}
const readySchema = z.object({ poolHostId: RebaseUuid,
    health: z.union([z.object({ editorOk: z.boolean() }).strict(),
        z.object({ ok: z.boolean(), desktop: z.boolean(), editor: z.boolean() }).strict()]) }).strict();
export async function handlePoolHost(req: Request, deps: PoolHostDeps, action: 'enroll' | 'ready'): Promise<Response> {
    let context: { poolHostId: string; poolGeneration: number; instanceId: string; reportedHealth?: unknown } | undefined;
    try {
        let body: unknown;
        try { body = parseRebaseJson(await req.text(), 32768); }
        catch { return Response.json({ error: 'pool_request_invalid' }, { status: 400, headers: POOL_NO_STORE }); }
        const proof = readPoolProof(req, action === 'enroll' ? body : undefined);
        const identity = await authenticatePoolHost(deps, proof);
        context = { poolHostId: proof.poolHostId, poolGeneration: proof.poolGeneration, instanceId: identity.doc.instanceId };
        const now = deps.now();
        const committed = await deps.db.transaction(async tx => {
            let row: PoolHostRow;
            if (action === 'enroll') row = await deps.data.recordPoolEnrollment(tx, proof.poolHostId, identity.doc.instanceId, now);
            else {
                const ready = readySchema.parse(body);
                poolGuard('ready_host', ready.poolHostId === proof.poolHostId);
                context!.reportedHealth = ready.health;
                const healthy = 'editorOk' in ready.health ? ready.health.editorOk : ready.health.ok && ready.health.desktop && ready.health.editor;
                poolGuard('ready_health', healthy);
                row = await deps.data.recordPoolReady(tx, proof.poolHostId, { editorOk: true }, now);
                poolGuard('ready_fresh', row.enrolledAt && row.enrolledAt.getTime() <= now.getTime()
                    && row.enrolledAt.getTime() > now.getTime() - 600_000);
            }
            // A mismatch throws inside the transaction, rolling back the P8 write.
            bindPoolRow(row, proof, identity);
            poolGuard('row_unclaimed', ['booting', 'ready'].includes(row.state) && row.leasedComputerId === null);
            return row;
        });
        // D4: heartbeat refreshes are silent. Log each enroll while the row is still booting (normally once) and
        // the first ready (ready_at is COALESCEd, so it equals this report's clock only the first time).
        const first = action === 'enroll' ? committed.state === 'booting' : committed.readyAt?.getTime() === now.getTime();
        if (first) console.info(JSON.stringify({ event: 'pool-host-readiness', result: action === 'enroll' ? 'enrolled' : 'ready', ...context,
            state: committed.state, enrolledAt: committed.enrolledAt?.toISOString() ?? null,
            readyAt: committed.readyAt?.toISOString() ?? null, observedAt: now.toISOString() }));
        return Response.json({ ok: true }, { headers: POOL_NO_STORE });
    } catch (error) {
        if (context) console.warn(JSON.stringify({ event: 'pool-host-readiness', result: `${action}_rejected`, ...context,
            reason: error instanceof PoolError ? error.message : error instanceof z.ZodError ? 'pool_request_invalid' : 'pool_unavailable' }));
        return error instanceof z.ZodError ? Response.json({ error: 'pool_request_invalid' }, { status: 400, headers: POOL_NO_STORE }) : poolErrorResponse(error);
    }
}

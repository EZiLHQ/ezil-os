import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { db } from '@/server/db';
import { computers, computerConfigurations, computerConfigurationDeliveries, computerDataMountAuthorizations as mounts,
    computerLifecycleJobs as jobs, computerLifecycleIntents as intents, computerRecoveryIntents as recoveries,
    computerControlBindings as bindings, computerStartAuthorizations as grants, appAuditEvents } from '@/server/db/schema';
import { produceComputerConfigurationInTransaction } from './computer-configuration';
import { hasCurrentOsAccess } from './runtime-authority';
import { lifecycleDeploymentApproved } from './lifecycle-approval';
import { parseComputerLifecycleWork, validateComputerLifecycleReceipt } from './computer-lifecycle-work';
import { loadRecoveryWriters } from './computer-recovery-authority';
import type { LifecycleConsumerOptions } from './lifecycle-consumer';
import { ComputerControlKeyPolicySchema, ComputerControlKeyObservationSchema, controlKeyArnMatches,
    type ComputerControlKeys, type ComputerControlKeyPolicy, type ComputerControlKeyWork } from './computer-control-key';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Options = LifecycleConsumerOptions & { keys: ComputerControlKeys; signal?: AbortSignal };
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const Input = z.object({ computerId: uuid, configurationId: uuid, mountAuthorizationId: uuid }).strict();
type Input = z.infer<typeof Input>;
export type ComputerStartIssueResult = { state: 'disabled' | 'denied' | 'unconfirmed' | 'recovery_required' }
    | { state: 'issued'; authorizationId: string; expiresAt: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const policyCurrent = (o: Options, p: ComputerControlKeyPolicy) => {
    const current = ComputerControlKeyPolicySchema.safeParse(o.keys.policy);
    return current.success && same(current.data, p);
};

/** Computer first, then current mount/configuration authority, then queue rows.
 * A completed mount outlives its execution deadline. A stored configuration
 * still needs recompilation against live user/app authority before every effect. */
async function load(tx: Transaction, o: Options, input: Input, policy: ComputerControlKeyPolicy) {
    if (!o.enabled || o.signal?.aborted || !policyCurrent(o, policy)) return null;
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [computer] = await tx.select().from(computers).where(eq(computers.id, input.computerId)).limit(1).for('update');
    if (!computer || computer.provider !== 'aws-ec2' || computer.deletedAt) return null;
    const [mount] = await tx.select().from(mounts).where(and(eq(mounts.id, input.mountAuthorizationId),
        eq(mounts.computerId, computer.id))).limit(1);
    if (!mount) return null;
    const [current] = await tx.execute<{ current: boolean }>(sql`SELECT public.ezil_start_mount_current(${mount.id}) AS current`);
    if (!current?.current || !await hasCurrentOsAccess(tx, computer.userId, o.osAccessMode)) return null;
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, mount.lifecycleJobId)).limit(1);
    if (!job) return null;
    const table = job.operation === 'recover' ? recoveries : intents;
    const document = job.operation === 'recover' ? sql<string>`public.ezil_computer_recovery_document(${recoveries})`
        : sql<string>`public.ezil_lifecycle_intent_document(${intents})`;
    const [work] = await tx.select({ document, digest: table.digest, createdAt: table.createdAt }).from(table)
        .where(and(eq(table.jobId, job.id), eq(table.computerId, computer.id))).limit(1);
    if (!work) return null;
    const intent = parseComputerLifecycleWork(work);
    if (!lifecycleDeploymentApproved(o.deployments, intent) || intent.deployment.accountId !== policy.accountId
        || intent.deployment.region !== policy.region || intent.deployment.namespace !== policy.namespace) return null;
    const fencedWriters = intent.schemaVersion === 2 ? await loadRecoveryWriters(tx, intent, mount.providerInstanceId) : [];
    if (!fencedWriters) return null;
    const configuration = await produceComputerConfigurationInTransaction(tx, computer.id, o.osAccessMode);
    if (!('configurationId' in configuration) || configuration.configurationId !== input.configurationId) return null;
    const [target] = await tx.select().from(computerConfigurations).where(eq(computerConfigurations.id, input.configurationId)).limit(1);
    const [delivery] = await tx.select().from(computerConfigurationDeliveries)
        .where(eq(computerConfigurationDeliveries.configurationId, input.configurationId)).limit(1).for('share');
    if (!target || !delivery?.preparedAt || delivery.supersededAt || JSON.parse(target.configuration).suspended !== false
        || target.computerGeneration !== mount.computerGeneration || target.fenceToken !== mount.fenceToken
        || target.providerInstanceId !== mount.providerInstanceId || target.dataVolumeId !== mount.dataVolumeId) return null;
    const scope = { computerId: computer.id, computerGeneration: mount.computerGeneration, fenceToken: mount.fenceToken,
        providerInstanceId: mount.providerInstanceId, dataVolumeId: mount.dataVolumeId };
    let [binding] = await tx.select().from(bindings).where(and(eq(bindings.computerId, computer.id),
        eq(bindings.computerGeneration, mount.computerGeneration))).limit(1).for('update');
    if (binding && (binding.revokedAt || Object.entries({ ...scope, ...policy })
        .some(([key, value]) => binding![key as keyof typeof binding] !== value))) return null;
    if (!binding) [binding] = await tx.insert(bindings).values({ ...scope, ...policy, creationMountId: mount.id }).returning();
    if (!binding) throw new Error('start_binding_unavailable');
    const [existing] = await tx.select({ grant: grants, active: sql<boolean>`${grants.expiresAt}>clock_timestamp()` }).from(grants)
        .where(and(eq(grants.computerId, computer.id), isNull(grants.revokedAt))).limit(1).for('update');
    const blocked = Boolean(existing && (!existing.active || existing.grant.configurationId !== target.id
        || existing.grant.controlBindingId !== binding.id || existing.grant.mountAuthorizationId !== mount.id));
    return { owner: computer.userId, scope, work, fencedWriters, binding, existing: existing?.grant, blocked };
}
type Authority = NonNullable<Awaited<ReturnType<typeof load>>>;
const unchanged = (a: Authority, b: Authority | null): b is Authority => Boolean(b && a.owner === b.owner
    && a.binding.id === b.binding.id && same(a.scope, b.scope) && same(a.work, b.work) && same(a.fencedWriters, b.fencedWriters));
async function fresh(tx: Transaction, observedAt: Date) {
    const [row] = await tx.execute<{ fresh: boolean }>(sql`SELECT ${observedAt.toISOString()}::timestamptz
        BETWEEN clock_timestamp()-interval '29 seconds' AND clock_timestamp()+interval '4 seconds' AS fresh`);
    return Boolean(row?.fresh);
}
/** Bound injected transports too; their ignoring AbortSignal must not hold the
 * issuer open. Late responses cannot continue into a confirmation transaction. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    try {
        const aborted = new Promise<never>((_resolve, reject) => {
            cancel = () => { reject(new Error('start_transport_aborted')); controller.abort(); };
            parent?.addEventListener('abort', cancel, { once: true });
            timer = setTimeout(cancel, ms);
        });
        if (parent?.aborted) { cancel(); return await aborted; }
        const result = await Promise.race([aborted, run(controller.signal)]);
        if (controller.signal.aborted) throw new Error('start_transport_aborted');
        return result;
    } finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
}

/** Trusted internal issuer only: no browser-selected provider IDs, no start
 * request to AWS and no readiness claim. Use the real no-wake lifecycle and
 * control-key transports. Delivery must reauthorize again before host effects.
 * An ambiguous key-creation attempt consumes creation authority permanently. */
export async function issueComputerStart(o: Options, input: unknown): Promise<ComputerStartIssueResult> {
    if (!o.enabled) return { state: 'disabled' };
    const parsed = Input.safeParse(input);
    if (!parsed.success || o.signal?.aborted) return { state: 'denied' };
    const policy = ComputerControlKeyPolicySchema.safeParse(o.keys.policy);
    if (!policy.success) return { state: 'denied' };
    try {
        const before = await o.database.transaction(tx => load(tx, o, parsed.data, policy.data));
        if (!before) return { state: 'denied' };
        if (before.blocked) return { state: 'recovery_required' };
        let observed: Awaited<ReturnType<Options['advance']>>;
        try {
            observed = await bounded(signal => o.advance(before.work, false, signal, { fencedWriters: before.fencedWriters }), 20000, o.signal);
            if (observed.state !== 'observed' || !(observed.observedAt instanceof Date) || !Number.isFinite(observed.observedAt.getTime())) {
                return { state: 'unconfirmed' };
            }
            const receipt = validateComputerLifecycleReceipt(before.work, observed.receipt);
            if (receipt.state !== 'running' || receipt.instanceId !== before.scope.providerInstanceId
                || receipt.volumeId !== before.scope.dataVolumeId) return { state: 'unconfirmed' };
        } catch { return { state: 'unconfirmed' }; }
        const observedAt = observed.observedAt;
        const claim = await o.database.transaction(async tx => {
            const after = await load(tx, o, parsed.data, policy.data);
            if (!unchanged(before, after)) return { state: 'denied' as const };
            if (after.blocked) return { state: 'recovery_required' as const };
            if (!await fresh(tx, observedAt)) return { state: 'unconfirmed' as const };
            const [winner] = await tx.update(bindings).set({ createAttemptedAt: sql`clock_timestamp()` })
                .where(and(eq(bindings.id, after.binding.id), isNull(bindings.createAttemptedAt))).returning();
            const binding = winner ?? after.binding;
            if (!binding.createAttemptedAt) throw new Error('start_attempt_unavailable');
            const work: ComputerControlKeyWork = { versionId: binding.id, scope: after.scope,
                attemptedAt: binding.createAttemptedAt.toISOString(), secretArn: binding.secretArn };
            return { state: 'claimed' as const, work, mode: winner ? 'create' as const : 'observe' as const };
        });
        if (claim.state !== 'claimed') return claim;
        let key: z.infer<typeof ComputerControlKeyObservationSchema>;
        try {
            if (!o.enabled || !policyCurrent(o, policy.data)) return { state: 'denied' };
            key = ComputerControlKeyObservationSchema.parse(await bounded(signal => o.keys.prepare(claim.work, claim.mode, signal), 15000, o.signal));
        } catch { return { state: 'unconfirmed' }; }
        if (key.state === 'missing') return { state: 'recovery_required' };
        if (key.versionId !== claim.work.versionId || !controlKeyArnMatches(policy.data, claim.work, key.secretArn)) return { state: 'unconfirmed' };
        const confirmed = key;
        return await o.database.transaction(async tx => {
            const after = await load(tx, o, parsed.data, policy.data);
            if (!unchanged(before, after)) return { state: 'denied' };
            if (after.blocked) return { state: 'recovery_required' };
            if (!await fresh(tx, observedAt)) return { state: 'unconfirmed' };
            if (after.binding.secretArn && after.binding.secretArn !== confirmed.secretArn) return { state: 'unconfirmed' };
            if (!after.binding.keyConfirmedAt) await tx.update(bindings).set({ keyConfirmedAt: sql`clock_timestamp()`, secretArn: confirmed.secretArn })
                .where(eq(bindings.id, after.binding.id));
            const grant = after.existing ?? (await tx.insert(grants).values({ computerId: after.scope.computerId,
                computerGeneration: after.scope.computerGeneration, controlBindingId: after.binding.id,
                configurationId: parsed.data.configurationId, mountAuthorizationId: parsed.data.mountAuthorizationId,
                providerObservedAt: observedAt }).returning())[0];
            if (!grant) throw new Error('start_grant_unavailable');
            if (!after.existing) await tx.insert(appAuditEvents).values({ actorUserId: after.owner,
                computerId: after.scope.computerId, action: 'computer_start_issued', reasonCode: 'current_authority' });
            return { state: 'issued', authorizationId: grant.id, expiresAt: grant.expiresAt.toISOString() };
        });
    } catch { throw new Error('computer_start_issuer_unavailable'); }
}

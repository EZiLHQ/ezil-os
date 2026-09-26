import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computers, computerStartAuthorizations as grants, computerStartDeliveries as deliveries } from '@/server/db/schema';
import { loadComputerStartAuthority, type ComputerStartAuthorityOptions } from './computer-start-issuer';
import { ComputerControlKeyPolicySchema } from './computer-control-key';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';
import { canonicalConfiguration } from './computer-configuration';
import { ComputerStartWorkSchema, ComputerStartReceiptSchema, startReceiptMatches, type ComputerStartWork } from './computer-start-protocol';

type Transaction = Parameters<Parameters<ComputerStartAuthorityOptions['database']['transaction']>[0]>[0];
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const ClaimSchema = z.object({ computerId: uuid, authorizationId: uuid,
    attempt: z.number().int().min(1).max(2147483647) }).strict();
export type ComputerStartClaim = z.infer<typeof ClaimSchema>;
export interface ComputerStartDeliveryOptions extends ComputerStartAuthorityOptions {
    /** Durable version-pinned workflow: reauthorize current DB authority and
     * independently observe EC2/EBS before each host effect. No compute wake.
     * Pending is never a receipt. Authorization ID is stable across leases. */
    advanceStart(work: ComputerStartWork, signal: AbortSignal): Promise<unknown>;
}
export type ComputerStartDeliveryResult = 'disabled' | 'empty' | 'stale' | 'waiting' | 'started';
const resultSchema = z.discriminatedUnion('state', [z.object({ state: z.literal('pending') }).strict(),
    z.object({ state: z.literal('started'), receipt: ComputerStartReceiptSchema }).strict()]);
const owns = (c: ComputerStartClaim) => and(eq(deliveries.authorizationId, c.authorizationId), eq(deliveries.attempts, c.attempt),
    isNull(deliveries.startedAt), sql`${deliveries.leaseUntil}>clock_timestamp()`);
const due = () => and(isNull(deliveries.startedAt), sql`${deliveries.availableAt}<=clock_timestamp()`,
    sql`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil}<=clock_timestamp())`, sql`${deliveries.attempts}<2147483647`,
    isNull(grants.revokedAt), sql`${grants.expiresAt}>clock_timestamp()`);

async function currentWork(tx: Transaction, o: ComputerStartAuthorityOptions, computerId: string, authorizationId: string) {
    if (!o.enabled || o.signal?.aborted) return null;
    const policy = ComputerControlKeyPolicySchema.safeParse(o.keys.policy); if (!policy.success) return null;
    // Immutable metadata read only; loader acquires computer/writer authority
    // before it locks the key or grant. Never reverse that lock order.
    const [grant] = await tx.select().from(grants).where(and(eq(grants.id, authorizationId), eq(grants.computerId, computerId))).limit(1);
    if (!grant) return null;
    const current = await loadComputerStartAuthority(tx, o, { computerId, configurationId: grant.configurationId,
        mountAuthorizationId: grant.mountAuthorizationId }, policy.data);
    if (!current || current.blocked || current.existing?.id !== grant.id || !current.binding.keyConfirmedAt || !current.binding.secretArn) return null;
    const work = ComputerStartWorkSchema.parse({ schemaVersion: 1, authorizationId: grant.id,
        mountAuthorizationId: grant.mountAuthorizationId, scope: current.scope,
        configuration: { configurationId: current.target.id, revision: current.target.revision,
            digest: current.target.digest, bytes: Buffer.byteLength(current.target.configuration) },
        controlKey: { versionId: current.binding.id, secretArn: current.binding.secretArn, policy: policy.data },
        issuedAt: grant.issuedAt.getTime()/1000, expiresAt: grant.expiresAt.getTime()/1000,
        deployment: parseComputerLifecycleWork(current.work).deployment });
    return work;
}

/** Point-in-time reauthorization only; the workflow must authenticate separately
 * and observe actual provider state. A replay repeats live checks. The function
 * never creates a key/grant or starts compute, services or a provider workflow. */
export async function authorizeComputerStart(o: ComputerStartAuthorityOptions, input: unknown): Promise<boolean> {
    if (!o.enabled) return false;
    const parsed = ComputerStartWorkSchema.safeParse(input); if (!parsed.success) return false;
    try { return await o.database.transaction(async tx => {
        const work = await currentWork(tx, o, parsed.data.scope.computerId, parsed.data.authorizationId);
        if (!work || canonicalConfiguration(work) !== canonicalConfiguration(parsed.data)) return false;
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.authorizationId, work.authorizationId),
            isNull(deliveries.startedAt))).limit(1).for('share');
        return o.enabled && !o.signal?.aborted && !!delivery;
    }); } catch { throw new Error('start_authorization_unavailable'); }
}
export async function claimComputerStart(o: ComputerStartAuthorityOptions): Promise<ComputerStartClaim | null> {
    if (!o.enabled || o.signal?.aborted) return null;
    try { return await o.database.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
        const [candidate] = await tx.select({ computerId: computers.id, authorizationId: grants.id }).from(computers)
            .innerJoin(grants, eq(grants.computerId, computers.id)).innerJoin(deliveries, eq(deliveries.authorizationId, grants.id))
            .where(due()).orderBy(asc(deliveries.availableAt), asc(grants.id)).limit(1).for('update', { of: computers, skipLocked: true });
        if (!candidate) return null;
        if (!await currentWork(tx, o, candidate.computerId, candidate.authorizationId)) {
            await tx.update(deliveries).set({ availableAt: sql`clock_timestamp()+interval '60 seconds'`, errorCode: 'start_authority_denied' })
                .where(eq(deliveries.authorizationId, candidate.authorizationId));
            return null;
        }
        const [claimed] = await tx.update(deliveries).set({ attempts: sql`${deliveries.attempts}+1`, leaseUntil: sql`clock_timestamp()+interval '45 seconds'` })
            .where(and(eq(deliveries.authorizationId, candidate.authorizationId), isNull(deliveries.startedAt),
                sql`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil}<=clock_timestamp())`)).returning();
        return claimed ? { ...candidate, attempt: claimed.attempts } : null;
    }); } catch { throw new Error('start_delivery_unavailable'); }
}
async function leasedWork(tx: Transaction, o: ComputerStartAuthorityOptions, c: ComputerStartClaim) {
    const work = await currentWork(tx, o, c.computerId, c.authorizationId); if (!work) return null;
    const [delivery] = await tx.select({ enoughTime: sql<boolean>`${deliveries.leaseUntil}>clock_timestamp()+interval '22 seconds'
        AND to_timestamp(${work.expiresAt})>clock_timestamp()+interval '22 seconds'` }).from(deliveries).where(owns(c)).limit(1).for('update');
    return delivery ? { work, enoughTime: delivery.enoughTime } : null;
}
async function advance(o: ComputerStartDeliveryOptions, work: ComputerStartWork) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, cancel = () => {};
    try {
        const aborted = new Promise<never>((_resolve, reject) => {
            cancel = () => { reject(new Error('start_delivery_aborted')); controller.abort(); };
            o.signal?.addEventListener('abort', cancel, { once: true }); timer = setTimeout(cancel, 20000);
        });
        if (o.signal?.aborted) { cancel(); return await aborted; }
        const result = await Promise.race([aborted, o.advanceStart(work, controller.signal)]);
        if (controller.signal.aborted) throw new Error('start_delivery_aborted');
        return result;
    } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', cancel); }
}
/** Settlement is historical host evidence only. Configuration/install completion
 * and application readiness remain separate. Lost leases and revoked authority
 * cannot settle late receipts; the durable workflow must reconcile host effects. */
export async function dispatchComputerStartClaim(o: ComputerStartDeliveryOptions, input: ComputerStartClaim): Promise<ComputerStartDeliveryResult> {
    if (!o.enabled) return 'disabled';
    const parsed = ClaimSchema.safeParse(input); if (!parsed.success) return 'stale'; const claim = parsed.data;
    const wait = (errorCode: string | null) => o.database.transaction(async tx => {
        if (!await leasedWork(tx, o, claim)) return 'stale' as const;
        await tx.update(deliveries).set({ leaseUntil: null, availableAt: sql`clock_timestamp()+interval '5 seconds'`, errorCode }).where(owns(claim));
        return 'waiting' as const;
    });
    try {
        const current = await o.database.transaction(tx => leasedWork(tx, o, claim)); if (!current) return 'stale';
        if (!current.enoughTime) return await wait('start_lease_short');
        const result = resultSchema.safeParse(await advance(o, structuredClone(current.work)));
        if (!result.success) return await wait('start_receipt_invalid');
        if (result.data.state === 'pending') return await wait(null);
        const receipt = result.data.receipt;
        if (!startReceiptMatches(current.work, receipt)) return await wait('start_receipt_invalid');
        return await o.database.transaction(async tx => {
            const fresh = await leasedWork(tx, o, claim);
            if (!fresh || canonicalConfiguration(fresh.work) !== canonicalConfiguration(current.work)) return 'stale';
            const [recorded] = await tx.update(deliveries).set({ startedAt: sql`clock_timestamp()`, receipt: canonicalConfiguration(receipt),
                leaseUntil: null, errorCode: null }).where(owns(claim)).returning();
            return recorded ? 'started' : 'stale';
        });
    } catch { try { return await wait('start_delivery_failed'); } catch { throw new Error('start_delivery_unavailable'); } }
}
export async function dispatchNextComputerStart(o: ComputerStartDeliveryOptions): Promise<ComputerStartDeliveryResult> {
    if (!o.enabled) return 'disabled';
    const claim = await claimComputerStart(o); return claim ? dispatchComputerStartClaim(o, claim) : 'empty';
}

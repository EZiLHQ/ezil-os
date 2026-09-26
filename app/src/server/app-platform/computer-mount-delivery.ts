import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computers, computerDataMountAuthorizations as grants, computerDataMountDeliveries as deliveries } from '@/server/db/schema';
import { loadCurrentMountAuthority, mountAuthorityRecords, type MountAuthorityOptions } from './computer-mount-authority';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';
import { canonicalConfiguration } from './computer-configuration';
import { ComputerMountWorkSchema, ComputerMountReceiptSchema, mountReceiptMatches,
    type ComputerMountWork } from './computer-mount-protocol';

type Transaction = Parameters<Parameters<MountAuthorityOptions['database']['transaction']>[0]>[0];
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const ClaimSchema = z.object({ computerId: uuid, authorizationId: uuid,
    attempt: z.number().int().min(1).max(2147483647) }).strict();
export type MountDeliveryClaim = z.infer<typeof ClaimSchema>;
export interface MountDeliveryOptions extends MountAuthorityOptions {
    /** Trusted durable transport: immutable authorization ID across retries,
     * exact versioned content, independently verified writer/attachment and
     * current-authority checks before host effects. Never starts compute or
     * apps. A queued SSM request is not a mounted receipt. */
    advanceMount(work: ComputerMountWork, signal: AbortSignal): Promise<unknown>;
}
export type MountDeliveryResult = 'disabled' | 'empty' | 'stale' | 'waiting' | 'mounted';
const resultSchema = z.discriminatedUnion('state', [z.object({ state: z.literal('pending') }).strict(),
    z.object({ state: z.literal('mounted'), receipt: ComputerMountReceiptSchema }).strict()]);
const ownsLease = (c: MountDeliveryClaim) => and(eq(deliveries.authorizationId, c.authorizationId),
    eq(deliveries.attempts, c.attempt), isNull(deliveries.mountedAt), sql`${deliveries.leaseUntil}>clock_timestamp()`);
const due = () => and(isNull(deliveries.mountedAt), sql`${deliveries.availableAt}<=clock_timestamp()`,
    sql`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil}<=clock_timestamp())`, sql`${deliveries.attempts}<2147483647`,
    isNull(grants.revokedAt), sql`${grants.expiresAt}>clock_timestamp()`);

async function currentWork(tx: Transaction, o: MountAuthorityOptions, computerId: string, authorizationId: string) {
    if (!o.enabled) return null;
    // Same lock order as issuance and the receipt trigger. The first grant read
    // is immutable metadata only; never lock it before its computer/job/writer.
    const [grant] = await tx.select().from(grants).where(and(eq(grants.id, authorizationId), eq(grants.computerId, computerId))).limit(1);
    if (!grant) return null;
    const current = await loadCurrentMountAuthority(tx, o, { computerId, jobId: grant.lifecycleJobId });
    if (current?.existing?.id !== grant.id) return null;
    return ComputerMountWorkSchema.parse({ ...mountAuthorityRecords(current.existing),
        deployment: parseComputerLifecycleWork(current.work).deployment });
}

/** Workflow reauthorization uses stable work identity, not a consumer lease
 * which may expire while SSM runs. Requires a separately authenticated caller;
 * this function is not an endpoint and does not confer provider authority. */
export async function authorizeComputerMount(o: MountAuthorityOptions, input: unknown): Promise<boolean> {
    if (!o.enabled) return false;
    const parsed = ComputerMountWorkSchema.safeParse(input);
    if (!parsed.success) return false;
    try {
        return await o.database.transaction(async tx => {
            const a = parsed.data.authorization;
            const work = await currentWork(tx, o, a.scope.computerId, a.authorizationId);
            if (!work || canonicalConfiguration(work) !== canonicalConfiguration(parsed.data)) return false;
            const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.authorizationId, a.authorizationId),
                isNull(deliveries.mountedAt))).limit(1).for('share');
            return o.enabled && !!delivery;
        });
    } catch { throw new Error('mount_authorization_unavailable'); }
}

export async function claimComputerMount(o: MountAuthorityOptions): Promise<MountDeliveryClaim | null> {
    if (!o.enabled) return null;
    try {
        return await o.database.transaction(async tx => {
            await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
            const [candidate] = await tx.select({ computerId: computers.id, authorizationId: grants.id }).from(computers)
                .innerJoin(grants, eq(grants.computerId, computers.id)).innerJoin(deliveries, eq(deliveries.authorizationId, grants.id))
                .where(due()).orderBy(asc(deliveries.availableAt), asc(grants.id)).limit(1)
                .for('update', { of: computers, skipLocked: true });
            if (!candidate) return null;
            const work = await currentWork(tx, o, candidate.computerId, candidate.authorizationId);
            if (!work) {
                // Do not renew, delete or invent authority. Back off unavailable
                // work so an earlier revoked owner cannot starve other computers.
                await tx.update(deliveries).set({ availableAt: sql`clock_timestamp()+interval '60 seconds'`,
                    errorCode: 'mount_authority_denied' }).where(eq(deliveries.authorizationId, candidate.authorizationId));
                return null;
            }
            const [claimed] = await tx.update(deliveries).set({ attempts: sql`${deliveries.attempts}+1`,
                leaseUntil: sql`clock_timestamp()+interval '45 seconds'` }).where(and(eq(deliveries.authorizationId, candidate.authorizationId),
                isNull(deliveries.mountedAt), sql`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil}<=clock_timestamp())`)).returning();
            return claimed ? { ...candidate, attempt: claimed.attempts } : null;
        });
    } catch { throw new Error('mount_delivery_unavailable'); }
}

async function leasedWork(tx: Transaction, o: MountAuthorityOptions, c: MountDeliveryClaim) {
    const work = await currentWork(tx, o, c.computerId, c.authorizationId);
    if (!work) return null;
    const [delivery] = await tx.select({ enoughTime: sql<boolean>`${deliveries.leaseUntil}>clock_timestamp()+interval '22 seconds'
        AND to_timestamp(${work.authorization.expiresAt})>clock_timestamp()+interval '22 seconds'` }).from(deliveries)
        .where(ownsLease(c)).limit(1).for('update');
    return delivery ? { work, enoughTime: delivery.enoughTime } : null;
}
async function bounded(o: MountDeliveryOptions, work: ComputerMountWork) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([o.advanceMount(work, controller.signal), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { reject(new Error('mount_delivery_timeout')); controller.abort(); }, 20000);
        })]);
    } finally { clearTimeout(timer); }
}

/** Lease claims and mounted receipts commit under SQL locks; all external work
 * runs outside them. Receipt settlement rechecks current authority and attempt.
 * This does not mark installations ready or enable a producer/cron/route. */
export async function dispatchComputerMountClaim(o: MountDeliveryOptions, input: MountDeliveryClaim): Promise<MountDeliveryResult> {
    if (!o.enabled) return 'disabled';
    const parsed = ClaimSchema.safeParse(input); if (!parsed.success) return 'stale';
    const claim = parsed.data;
    const wait = (code: string | null) => o.database.transaction(async tx => {
        if (!await leasedWork(tx, o, claim)) return 'stale' as const;
        await tx.update(deliveries).set({ leaseUntil: null, availableAt: sql`clock_timestamp()+interval '5 seconds'`, errorCode: code })
            .where(ownsLease(claim));
        return 'waiting' as const;
    });
    try {
        const current = await o.database.transaction(tx => leasedWork(tx, o, claim));
        if (!current) return 'stale';
        if (!current.enoughTime) return await wait('mount_lease_short');
        // Keep a private copy; a transport cannot mutate expected receipt scope.
        const result = resultSchema.safeParse(await bounded(o, structuredClone(current.work)));
        if (!result.success) return await wait('mount_receipt_invalid');
        if (result.data.state === 'pending') return await wait(null);
        const receipt = result.data.receipt;
        if (!mountReceiptMatches(current.work, receipt)) return await wait('mount_receipt_invalid');
        return await o.database.transaction(async tx => {
            const fresh = await leasedWork(tx, o, claim);
            if (!fresh || canonicalConfiguration(fresh.work) !== canonicalConfiguration(current.work)) return 'stale';
            const [recorded] = await tx.update(deliveries).set({ mountedAt: sql`clock_timestamp()`,
                receipt: canonicalConfiguration(receipt), leaseUntil: null, errorCode: null }).where(ownsLease(claim)).returning();
            return recorded ? 'mounted' : 'stale';
        });
    } catch {
        try { return await wait('mount_delivery_failed'); } catch { throw new Error('mount_delivery_unavailable'); }
    }
}
export async function dispatchNextComputerMount(o: MountDeliveryOptions): Promise<MountDeliveryResult> {
    if (!o.enabled) return 'disabled';
    const claim = await claimComputerMount(o);
    return claim ? dispatchComputerMountClaim(o, claim) : 'empty';
}

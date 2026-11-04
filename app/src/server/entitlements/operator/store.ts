/**
 * PostgreSQL side of the ezil-os entitlement source (app/drizzle/0019_operator_entitlements.sql) and the reader every
 * billing and compute path uses. Additive and backward compatible: until 0019 is applied the reader answers "no
 * operator grants" and the pool SQL leaves its operator branch out (`operatorEntitlementsInstalled`).
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { isOperatorSku, type OperatorEntitlementRow } from '@/server/billing/v3/operator-access';
import type { BillingDeps } from '@/server/billing/ports';
import { planFromSubscriptions } from '@/server/billing/v3/catalog';
import { deriveStanding, paidAccess } from '@/server/billing/v3/standing';
import { fairUseAllowance } from '@/server/billing/v3/funding';
import { buildSummaryV2, summaryMeters } from '@/server/billing/v2/summary';
import type { Result } from './contract';
import type { CommandStore, IdentityCheck, OperatorEntitlementDeps, StoredEvent, StripeView } from './service';

export interface Executor { execute(query: SQL): Promise<unknown> }
export interface TransactionalExecutor extends Executor { transaction<T>(run: (tx: Executor) => Promise<T>): Promise<T> }

/** The source cannot answer (a missing table/view or a database failure): the route says 503, nothing applied. */
export class SourceUnavailable extends Error { constructor(what: string) { super(what); this.name = 'SourceUnavailable'; } }

const rowsOf = (result: unknown): Record<string, unknown>[] =>
    (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] } | null)?.rows) ?? [];

function missingRelation(error: unknown): boolean {
    for (let e = error as { code?: string; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
        if (e.code === '42P01' || e.code === '3F000') return true;
    }
    return false;
}

const date = (value: unknown): Date | null => value === null || value === undefined ? null : new Date(value as string | Date);

function toRow(r: Record<string, unknown>): OperatorEntitlementRow | null {
    const sku = String(r.sku);
    if (!isOperatorSku(sku)) return null;
    return { ref: String(r.ref), revision: Number(r.revision), userId: String(r.user_id), accountPublicId: String(r.account_public_id), sku,
        startsAt: date(r.starts_at)!, endsAt: date(r.ends_at), endedAt: date(r.ended_at) };
}

const SELECT = sql`SELECT ref, revision, user_id::text AS user_id, account_public_id::text AS account_public_id, sku, starts_at, ends_at, ended_at
    FROM public.ezil_operator_entitlements`;

/** Every operator assignment of one account, newest first (at most 50). [] until 0019 is applied. */
export async function readOperatorEntitlements(db: Executor, userId: string): Promise<OperatorEntitlementRow[]> {
    try {
        const rows = rowsOf(await db.execute(sql`${SELECT} WHERE user_id = ${userId}::uuid ORDER BY starts_at DESC, ref LIMIT 50`));
        return rows.map(toRow).filter((row): row is OperatorEntitlementRow => row !== null);
    } catch (error) {
        if (missingRelation(error)) return [];
        throw error;
    }
}

export { operatorEntitlementsInstalled, resetOperatorEntitlementsInstalled } from './installed';

/**
 * The OS user must be live (not deleted, banned or anonymous) and linked to exactly this Gateway account through the
 * Gateway member table the AI credits already use (`ezil_works.ai_members`). A missing member view is unavailable.
 */
export async function verifyIdentity(db: Executor, osUserId: string, accountPublicId: string, now: Date): Promise<IdentityCheck> {
    try {
        const users = rowsOf(await db.execute(sql`SELECT to_jsonb(u)->>'deleted_at' AS deleted_at, to_jsonb(u)->>'banned_until' AS banned_until,
            to_jsonb(u)->>'is_anonymous' AS is_anonymous FROM auth.users u WHERE u.id = ${osUserId}::uuid`));
        const user = users[0];
        if (!user || user.deleted_at || user.is_anonymous === 'true'
            || (user.banned_until && Date.parse(String(user.banned_until)) > now.getTime())) return 'identity_not_found';
        const members = rowsOf(await db.execute(sql`SELECT lower(auth_user_id::text) AS auth_user_id, lower(public_id::text) AS public_id
            FROM ezil_works.ai_members WHERE auth_user_id = ${osUserId}::uuid OR public_id::text = ${accountPublicId}`));
        const ofUser = members.filter(m => m.auth_user_id === osUserId);
        const ofAccount = members.filter(m => m.public_id === accountPublicId);
        if (ofUser.length > 1 || ofAccount.length > 1 || ofAccount.some(m => m.auth_user_id !== osUserId)) return 'ambiguous_identity';
        return ofUser.length === 1 && ofUser[0]!.public_id === accountPublicId ? 'ok' : 'identity_not_found';
    } catch (error) {
        if (missingRelation(error)) throw new SourceUnavailable('identity');
        throw error;
    }
}

/** What Stripe gives the account now (Stripe-only standing; this source never writes Stripe state). */
export async function stripeView(billing: Pick<BillingDeps, 'store' | 'config'>, userId: string, now: Date): Promise<StripeView> {
    const [subscriptions, paymentIssues] = await Promise.all([billing.store.subscriptionsFor(userId), billing.store.openPaymentIssues(userId)]);
    const { standing } = deriveStanding({ subscriptions, paymentIssues, placementProvider: null, now });
    const plan = planFromSubscriptions({ subs: subscriptions, now, userCreatedAt: null });
    const selected = subscriptions.find(sub => sub.stripeSubscriptionId === plan.subscriptionId);
    const newest = selected ?? [...subscriptions].sort((a, b) => (b.currentPeriodEnd?.getTime() ?? 0) - (a.currentPeriodEnd?.getTime() ?? 0))[0];
    const paid = paidAccess(standing);
    let computeActive = false;
    if (paid) {
        const grants = await billing.store.grantsForPeriod(userId, { start: new Date(plan.window.start), end: new Date(plan.window.end) }, summaryMeters(plan.family));
        if (plan.sku === 'legacy') {
            const summary = buildSummaryV2({ config: billing.config, now, userCreatedAt: null, subs: subscriptions, epochs: [], grants,
                consent: null, planChanges: [], paymentIssues, storage: [], sizePreference: null, hasCustomer: false });
            computeActive = plan.planActive && summary.plan.paymentIssue === null && summary.compute.allowanceStdSeconds > 0;
        } else {
            // Same active funding calculation as billingV2EntitlementReader. A pending receipt is not active yet.
            computeActive = (plan.planActive || standing === 'grace') && fairUseAllowance(plan, grants, { grace: standing === 'grace' }) > 0;
        }
    }
    return { paidAccess: paid, computeActive, productRef: paid && selected ? selected.sku : null, state: newest ? newest.status : null,
        checkoutOpen: subscriptions.some(sub => sub.status === 'incomplete') };
}

function commandStore(tx: Executor): CommandStore {
    return {
        async findEvent(commandId) {
            const rows = rowsOf(await tx.execute(sql`SELECT payload_sha256, result FROM public.ezil_operator_entitlement_events WHERE command_id = ${commandId}::uuid`));
            const row = rows[0];
            if (!row) return null;
            const result = (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) as Result;
            return { payloadSha256: String(row.payload_sha256), result } satisfies StoredEvent;
        },
        async assignments(userId) {
            const rows = rowsOf(await tx.execute(sql`${SELECT} WHERE user_id = ${userId}::uuid ORDER BY starts_at DESC, ref LIMIT 50`));
            return rows.map(toRow).filter((row): row is OperatorEntitlementRow => row !== null);
        },
        async insertAssignment(row) {
            await tx.execute(sql`INSERT INTO public.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at, ends_at, ended_at)
                VALUES (${row.ref}, ${row.userId}::uuid, ${row.accountPublicId}::uuid, ${row.sku}, ${row.revision}, ${row.startsAt.toISOString()}::timestamptz,
                    ${row.endsAt?.toISOString() ?? null}::timestamptz, NULL)`);
        },
        async updateAssignment(ref, expectedRevision, next) {
            const rows = rowsOf(await tx.execute(sql`UPDATE public.ezil_operator_entitlements SET revision = ${next.revision}, sku = ${next.sku},
                ends_at = ${next.endsAt?.toISOString() ?? null}::timestamptz, ended_at = ${next.endedAt?.toISOString() ?? null}::timestamptz, updated_at = now()
                WHERE ref = ${ref} AND revision = ${expectedRevision} AND ended_at IS NULL RETURNING ref`));
            return rows.length === 1;
        },
        async closeLapsed(ref, now) {
            await tx.execute(sql`UPDATE public.ezil_operator_entitlements SET ended_at = ends_at, updated_at = now()
                WHERE ref = ${ref} AND ended_at IS NULL AND ends_at IS NOT NULL AND ends_at <= ${now.toISOString()}::timestamptz`);
        },
        async insertEvent(event) {
            await tx.execute(sql`INSERT INTO public.ezil_operator_entitlement_events (id, command_id, payload_sha256, action, assignment_ref, revision,
                    user_id, operator_via, operator_actor, sender_kid, reason, result)
                VALUES (${event.id}::uuid, ${event.commandId}::uuid, ${event.payloadSha256}, ${event.action}, ${event.assignmentRef}, ${event.revision},
                    ${event.userId}::uuid, ${event.operatorVia}, ${event.operatorActor}, ${event.senderKid}, ${event.reason}, ${JSON.stringify(event.result)}::jsonb)`);
        },
    };
}

/** Production wiring: one transaction per command, the command id and then the account serialized by advisory locks. */
export function createOperatorEntitlementDeps(db: TransactionalExecutor, billing: Pick<BillingDeps, 'store' | 'config'>, clock: () => Date = () => new Date()): OperatorEntitlementDeps {
    return {
        now: clock,
        newId: () => randomUUID(),
        identity: target => verifyIdentity(db, target.os_user_id, target.account_public_id, clock()),
        stripe: userId => stripeView(billing, userId, clock()),
        async readAssignments(userId) {
            try {
                return await readOperatorEntitlements(db, userId);
            } catch (error) {
                if (missingRelation(error)) throw new SourceUnavailable('assignments');
                throw error;
            }
        },
        async withCommand(commandId, userId, run) {
            try {
                return await db.transaction(async tx => {
                    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ezil_operator_entitlement_command:${commandId}`}, 0))`);
                    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ezil_operator_entitlement_user:${userId}`}, 0))`);
                    return run(commandStore(tx));
                });
            } catch (error) {
                if (missingRelation(error)) throw new SourceUnavailable('commands');
                throw error;
            }
        },
    };
}

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AI_CREDIT_PROTOCOL } from './ai-credits';
import { AI_CREDIT_LEASE_MS, AI_CREDIT_MAX_ATTEMPTS, isAiAccountDependency, isAiDeliveryDependency, plannedAiCreditEvent,
    type AiCreditOutboxRow, type AiCreditOutboxStore } from './ai-credit-outbox';

type Database = typeof import('@/server/db').db;

/** Only missing schema/view is an absent account; permission/connectivity failures must retry. */
export function missingAiAccountView(error: unknown): boolean {
    const seen = new Set<unknown>();
    while (error && typeof error === 'object' && !seen.has(error)) {
        seen.add(error);
        const e = error as { code?: string; cause?: unknown };
        if (e.code === '42P01' || e.code === '3F000') return true;
        error = e.cause;
    }
    return false;
}

export async function lookupAiAccount(db: Pick<Database, 'execute'>, userId: string): Promise<string | null> {
    try {
        const rows = await db.execute<{ public_id: string | null }>(
            sql`select public_id from ezil_works.ai_members where auth_user_id = ${userId}::uuid limit 1`,
        );
        return rows[0]?.public_id || null;
    } catch (error) {
        if (missingAiAccountView(error)) return null;
        throw error;
    }
}

/** Delivery metadata lives under payload.delivery; the six wire fields are immutable.
 * One atomic claim commits before HTTP. A 30 s lease recovers crashed workers;
 * attempt fencing keeps an expired worker from overwriting its successor.
 */
export function createAiCreditOutboxStore(db: Database): AiCreditOutboxStore {
    return {
        async claim(now) {
            const restoreDisposition = sql`case when pending.kind = 'ai_restore' then case
                when exists (select 1 from ezil_billing_outbox terminal
                    where terminal.payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                        and terminal.payload->>'entitlementId' = pending.payload->>'entitlementId'
                        and terminal.kind = 'ai_revoke'
                        and (terminal.event_key = (pending.payload->>'entitlementId') || ':revoke'
                            or (left(terminal.event_key, length(pending.payload->>'entitlementId') + 1) = (pending.payload->>'entitlementId') || ':'
                                and length(terminal.event_key) <= 200
                                and substring(terminal.event_key from length(pending.payload->>'entitlementId') + 1)
                                    ~ '^:revoke:refund:[A-Za-z0-9_-]+$'))) then 'terminal'
                when exists (select 1 from ezil_billing_outbox overlap
                    where overlap.payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                        and overlap.payload->>'entitlementId' = pending.payload->>'entitlementId'
                        and overlap.payload->>'overlappingDisputes' = 'true') then 'review'
                end end`;
            const restoreConflict = sql`pending.kind = 'ai_restore' and suspended.id is not null and (
                suspended.kind is distinct from 'ai_revoke' or suspended.user_id is distinct from pending.user_id
                or suspended.payload->>'protocol' is distinct from pending.payload->>'protocol'
                or suspended.payload->>'action' is distinct from 'revoke'
                or suspended.payload->>'entitlementId' is distinct from pending.payload->>'entitlementId'
                or suspended.payload->>'accountPublicId' is distinct from pending.payload->>'accountPublicId'
                or pending.payload->>'accountPublicId' is null
                or suspended.payload->'credits' is distinct from pending.payload->'credits'
                or suspended.payload->'expiresAt' is distinct from pending.payload->'expiresAt'
                or suspended.payload->'reversal' is distinct from pending.payload->'reversal'
                or pending.event_key is distinct from (pending.payload->>'entitlementId') || ':restore:' || (pending.payload->'reversal'->>'causeId'))`;
            const rows = await db.execute<AiCreditOutboxRow & Record<string, unknown>>(sql`
                with candidate as (
                    select pending.id, pending.attempts,
                        coalesce((pending.payload->'delivery'->>'dependencyWaits')::integer, 0) as dependency_waits,
                        (${restoreConflict}) as restore_conflict, (${restoreDisposition}) as restore_disposition
                    from ezil_billing_outbox pending
                    left join ezil_billing_outbox suspended on pending.kind = 'ai_restore'
                        and suspended.event_key = (pending.payload->>'entitlementId') || ':revoke:dispute:' || (pending.payload->'reversal'->>'causeId')
                    where pending.payload->>'protocol' = ${AI_CREDIT_PROTOCOL} and pending.kind in ('ai_grant', 'ai_revoke', 'ai_restore')
                        and (pending.kind <> 'ai_restore' or suspended.delivered_at is not null or (${restoreConflict}) or (${restoreDisposition}) is not null)
                        and pending.delivered_at is null
                        and coalesce(pending.payload->'delivery'->>'status', 'pending') in ('pending', 'retry', 'processing')
                        and coalesce((pending.payload->'delivery'->>'nextAttemptAt')::bigint, 0) <= ${now}
                        and (pending.attempts - coalesce((pending.payload->'delivery'->>'dependencyWaits')::integer, 0) < ${AI_CREDIT_MAX_ATTEMPTS}
                            or pending.payload->'delivery'->>'status' = 'processing')
                    order by pending.created_at, pending.id for update of pending skip locked limit 1
                )
                update ezil_billing_outbox o set attempts = case when c.attempts - c.dependency_waits >= ${AI_CREDIT_MAX_ATTEMPTS}
                        then o.attempts else o.attempts + 1 end,
                    payload = jsonb_set(o.payload, '{delivery}', (${JSON.stringify({ status: 'processing', nextAttemptAt: now + AI_CREDIT_LEASE_MS,
                        leaseToken: randomUUID() })}::text)::jsonb || case when c.dependency_waits > 0
                            then jsonb_build_object('dependencyWaits', c.dependency_waits) else '{}'::jsonb end)
                from candidate c where o.id = c.id
                returning o.id, o.event_key as "eventKey", o.user_id as "userId", o.kind, o.payload, o.attempts,
                    c.dependency_waits as "dependencyWaits", c.restore_conflict as "restoreConflict", c.restore_disposition as "restoreDisposition", c.attempts - c.dependency_waits >= ${AI_CREDIT_MAX_ATTEMPTS} as exhausted
            `);
            return rows[0] ?? null;
        },
        async accountFor(row) {
            // A revoke uses the original grant's frozen mapping, even if Works has changed since.
            const rows = await db.execute<{ account: string }>(sql`
                select payload->>'accountPublicId' as account from ezil_billing_outbox
                where user_id = ${row.userId}::uuid and payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                    and payload->>'entitlementId' = ${row.payload.entitlementId as string}
                    and payload->>'accountPublicId' is not null order by created_at, id limit 1
            `);
            return rows[0]?.account ?? lookupAiAccount(db, row.userId);
        },
        async pinAccount(row, account) {
            return db.transaction(async tx => {
                const root = String(row.payload.entitlementId);
                await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:ai_root:${root}`}, 0))`);
                const conflicts = await tx.execute(sql`select id from ezil_billing_outbox
                    where payload->>'protocol' = ${AI_CREDIT_PROTOCOL} and payload->>'entitlementId' = ${root}
                        and (user_id <> ${row.userId}::uuid or
                            (payload->>'accountPublicId' is not null and payload->>'accountPublicId' <> ${account})) limit 1`);
                if (conflicts.length) throw new Error('ai_payer_conflict');
                const rows = await tx.execute(sql`
                    update ezil_billing_outbox set payload = jsonb_set(payload, '{accountPublicId}', (${JSON.stringify(account)}::text)::jsonb)
                    where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                        and payload->'delivery' = (${JSON.stringify(row.payload.delivery)}::text)::jsonb
                        and (payload->>'accountPublicId' is null or payload->>'accountPublicId' = ${account}) returning id
                `);
                return rows.length > 0;
            });
        },
        async finish(row, result, now) {
            const dependencyWaits = (row.dependencyWaits ?? 0) + Number(result.status === 'retry' && isAiDeliveryDependency(result.reason));
            await db.execute(sql`
                update ezil_billing_outbox set payload = jsonb_set(payload, '{delivery}', (${JSON.stringify({
                    status: result.status, nextAttemptAt: result.nextAttemptAt ?? null,
                    ...(dependencyWaits > 0 ? { dependencyWaits } : {}),
                    ...(result.outcome ? { outcome: result.outcome } : {}),
                    ...(result.reviewRequired ? { reviewRequired: true } : {}),
                })}::text)::jsonb), last_error = ${result.reason},
                    delivered_at = ${result.status === 'done' ? new Date(now).toISOString() : null}::timestamptz
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = (${JSON.stringify(row.payload.delivery)}::text)::jsonb
            `);
        },
        async receiptsFor(userId) {
            const rows = await db.execute<{ entitlementId: unknown; credits: unknown; expiresAt: unknown; deliveredAt: unknown }>(sql`
                select payload->>'entitlementId' as "entitlementId", payload->'credits' as credits,
                    payload->>'expiresAt' as "expiresAt", delivered_at as "deliveredAt"
                from ezil_billing_outbox where user_id = ${userId}::uuid and kind = 'ai_grant'
                    and payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                order by created_at desc, id limit 200`);
            return rows.flatMap(row => typeof row.entitlementId === 'string' && typeof row.credits === 'number'
                && Number.isSafeInteger(row.credits) && typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt))
                ? [{ entitlementId: row.entitlementId, credits: row.credits, expiresAt: new Date(row.expiresAt).toISOString(),
                    deliveredAt: row.deliveredAt == null ? null : new Date(row.deliveredAt as string | Date).toISOString() }] : []);
        },
    };
}

/** Read-only recovery preview. No replay/reset path exists in this phase. */
export async function previewAiCreditRecovery(db: Pick<Database, 'execute'>, input: {
    eventKeys: readonly string[]; now: number;
}) {
    if (!Number.isSafeInteger(input.now) || input.now < 0 || input.eventKeys.length > 200
        || input.eventKeys.some(key => typeof key !== 'string' || key.length < 1 || key.length > 200)) {
        throw new TypeError('Invalid AI recovery selection');
    }
    const keys = [...new Set(input.eventKeys)];
    const rows = keys.length === 0 ? [] : await db.execute<AiCreditOutboxRow & Record<string, unknown> & {
        deliveredAt: string | null; lastError: string | null;
    }>(sql`select id, event_key as "eventKey", user_id as "userId", kind, payload, attempts,
        delivered_at as "deliveredAt", last_error as "lastError" from ezil_billing_outbox
        where event_key in (${sql.join(keys.map(key => sql`${key}`), sql`, `)}) limit 200`);
    let legacyCount = 0;
    const decisions = keys.map(eventKey => {
        const row = rows.find(candidate => candidate.eventKey === eventKey);
        let reason: string;
        if (!row) reason = 'not_found';
        else if (row.payload.protocol !== AI_CREDIT_PROTOCOL) {
            if (row.payload.protocol == null && typeof row.payload.amountUsdMicro === 'string') legacyCount++;
            reason = 'unsupported_protocol';
        } else {
            const event = plannedAiCreditEvent(row);
            const delivery = row.payload.delivery as { status?: unknown } | null;
            reason = row.deliveredAt !== null ? 'already_delivered'
                : !event ? 'invalid_payload'
                : event.action === 'grant' && Date.parse(event.expiresAt) <= input.now ? 'expired'
                : event.action === 'restore' ? 'restore_requires_review'
                : delivery?.status !== 'failed' ? 'not_failed'
                : !isAiAccountDependency(row.lastError) ? 'unproven_dependency_failure'
                : 'eligible_dependency_wait';
        }
        return { eventKey, eligible: reason === 'eligible_dependency_wait', reason };
    });
    return { dryRun: true as const, selected: keys.length, eligible: decisions.filter(item => item.eligible).length,
        legacyCount, decisions };
}

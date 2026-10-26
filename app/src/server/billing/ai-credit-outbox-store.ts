import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AI_CREDIT_PROTOCOL } from './ai-credits';
import { AI_CREDIT_LEASE_MS, AI_CREDIT_MAX_ATTEMPTS, isAiAccountDependency, plannedAiCreditEvent,
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
            const rows = await db.execute<AiCreditOutboxRow & Record<string, unknown>>(sql`
                with candidate as (
                    select id, attempts, coalesce((payload->'delivery'->>'dependencyWaits')::integer, 0) as dependency_waits
                    from ezil_billing_outbox
                    where payload->>'protocol' = ${AI_CREDIT_PROTOCOL} and kind in ('ai_grant', 'ai_revoke')
                        and delivered_at is null
                        and coalesce(payload->'delivery'->>'status', 'pending') in ('pending', 'retry', 'processing')
                        and coalesce((payload->'delivery'->>'nextAttemptAt')::bigint, 0) <= ${now}
                        and (attempts - coalesce((payload->'delivery'->>'dependencyWaits')::integer, 0) < ${AI_CREDIT_MAX_ATTEMPTS}
                            or payload->'delivery'->>'status' = 'processing')
                    order by created_at, id for update skip locked limit 1
                )
                update ezil_billing_outbox o set attempts = case when c.attempts - c.dependency_waits >= ${AI_CREDIT_MAX_ATTEMPTS}
                        then o.attempts else o.attempts + 1 end,
                    payload = jsonb_set(o.payload, '{delivery}', (${JSON.stringify({ status: 'processing', nextAttemptAt: now + AI_CREDIT_LEASE_MS,
                        leaseToken: randomUUID() })}::text)::jsonb || case when c.dependency_waits > 0
                            then jsonb_build_object('dependencyWaits', c.dependency_waits) else '{}'::jsonb end)
                from candidate c where o.id = c.id
                returning o.id, o.event_key as "eventKey", o.user_id as "userId", o.kind, o.payload, o.attempts,
                    c.dependency_waits as "dependencyWaits", c.attempts - c.dependency_waits >= ${AI_CREDIT_MAX_ATTEMPTS} as exhausted
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
            const rows = await db.execute(sql`
                update ezil_billing_outbox set payload = jsonb_set(payload, '{accountPublicId}', (${JSON.stringify(account)}::text)::jsonb)
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = (${JSON.stringify(row.payload.delivery)}::text)::jsonb
                    and (payload->>'accountPublicId' is null or payload->>'accountPublicId' = ${account}) returning id
            `);
            return rows.length > 0;
        },
        async finish(row, result, now) {
            const dependencyWaits = (row.dependencyWaits ?? 0) + Number(result.status === 'retry' && isAiAccountDependency(result.reason));
            await db.execute(sql`
                update ezil_billing_outbox set payload = jsonb_set(payload, '{delivery}', (${JSON.stringify({
                    status: result.status, nextAttemptAt: result.nextAttemptAt ?? null,
                    ...(dependencyWaits > 0 ? { dependencyWaits } : {}),
                })}::text)::jsonb), last_error = ${result.reason},
                    delivered_at = ${result.status === 'done' ? new Date(now).toISOString() : null}::timestamptz
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = (${JSON.stringify(row.payload.delivery)}::text)::jsonb
            `);
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
                : delivery?.status !== 'failed' ? 'not_failed'
                : !isAiAccountDependency(row.lastError) ? 'unproven_dependency_failure'
                : 'eligible_dependency_wait';
        }
        return { eventKey, eligible: reason === 'eligible_dependency_wait', reason };
    });
    return { dryRun: true as const, selected: keys.length, eligible: decisions.filter(item => item.eligible).length,
        legacyCount, decisions };
}

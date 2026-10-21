import { sql } from 'drizzle-orm';
import { AI_CREDIT_PROTOCOL } from './ai-credits';
import { AI_CREDIT_LEASE_MS, AI_CREDIT_MAX_ATTEMPTS, type AiCreditOutboxRow, type AiCreditOutboxStore } from './ai-credit-outbox';

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
                    select id, attempts from ezil_billing_outbox
                    where payload->>'protocol' = ${AI_CREDIT_PROTOCOL} and kind in ('ai_grant', 'ai_revoke')
                        and delivered_at is null
                        and coalesce(payload->'delivery'->>'status', 'pending') in ('pending', 'retry', 'processing')
                        and coalesce((payload->'delivery'->>'nextAttemptAt')::bigint, 0) <= ${now}
                        and (attempts < ${AI_CREDIT_MAX_ATTEMPTS} or payload->'delivery'->>'status' = 'processing')
                    order by created_at, id for update skip locked limit 1
                )
                update ezil_billing_outbox o set attempts = least(o.attempts + 1, ${AI_CREDIT_MAX_ATTEMPTS}),
                    payload = jsonb_set(o.payload, '{delivery}', ${JSON.stringify({ status: 'processing', nextAttemptAt: now + AI_CREDIT_LEASE_MS })}::jsonb)
                from candidate c where o.id = c.id
                returning o.id, o.event_key as "eventKey", o.user_id as "userId", o.kind, o.payload, o.attempts,
                    c.attempts >= ${AI_CREDIT_MAX_ATTEMPTS} as exhausted
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
                update ezil_billing_outbox set payload = jsonb_set(payload, '{accountPublicId}', ${JSON.stringify(account)}::jsonb)
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = ${JSON.stringify(row.payload.delivery)}::jsonb
                    and (payload->>'accountPublicId' is null or payload->>'accountPublicId' = ${account}) returning id
            `);
            return rows.length > 0;
        },
        async finish(row, result, now) {
            await db.execute(sql`
                update ezil_billing_outbox set payload = jsonb_set(payload, '{delivery}', ${JSON.stringify({
                    status: result.status, nextAttemptAt: result.nextAttemptAt ?? null,
                })}::jsonb), last_error = ${result.reason},
                    delivered_at = ${result.status === 'done' ? new Date(now).toISOString() : null}::timestamptz
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = ${JSON.stringify(row.payload.delivery)}::jsonb
            `);
        },
    };
}

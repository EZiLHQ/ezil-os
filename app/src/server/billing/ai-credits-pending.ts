import { sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { AI_CREDIT_PROTOCOL } from './ai-credits';

type PendingDatabase = Pick<typeof db, 'transaction'>;

/**
 * Stored grant delivery for this owner, independent of wallet balances or catalog allowances. No receipt LIMIT:
 * false must prove there is no live undelivered grant. Malformed potentially eligible rows never produce a negative
 * answer. Unknown returns undefined; the callback-aware producer signs it as null, never false.
 */
export async function aiCreditsPendingFor(userId: string, database: PendingDatabase | undefined = undefined, now: Date = new Date()): Promise<boolean | undefined> {
    try {
        // Import the existing pool only when a real read needs it. Merely composing a router must not initialize
        // application credentials, and injected fixture databases never load the production pool.
        const connection = database ?? (await import('@/server/db')).db;
        const rows = await connection.transaction(async tx => {
            // A read-only unit on the existing app pool. Server-side limits cancel the actual SQL work; no timer race.
            await tx.execute(sql`set local statement_timeout = '1000ms'`);
            await tx.execute(sql`set local lock_timeout = '500ms'`);
            return tx.execute<{ pending: boolean; unknown: boolean }>(sql`
                with candidate as (
                    select payload from public.ezil_billing_outbox
                    where user_id = ${userId}::uuid and kind = 'ai_grant' and payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                        and delivered_at is null and payload->'delivery'->>'status' is distinct from 'failed'
                ), disposition as (
                    select case
                        when jsonb_typeof(payload->'credits') = 'number'
                            and jsonb_typeof(payload->'expiresAt') = 'string'
                            and payload->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
                        then case when (payload->>'credits')::numeric between 1 and 1000000
                                and trunc((payload->>'credits')::numeric) = (payload->>'credits')::numeric
                            then (payload->>'expiresAt')::timestamptz > ${now.toISOString()}::timestamptz
                            else null end
                        else null end as pending from candidate
                )
                select coalesce(bool_or(pending), false) as pending,
                    coalesce(bool_or(pending is null), false) as unknown from disposition
            `);
        }, { accessMode: 'read only' });
        const row = rows[0];
        if (row?.pending === true) return true;
        if (row?.pending === false && row.unknown === false) return false;
    } catch {
        console.warn('[billing.ai] pending credits unavailable');
    }
    return undefined;
}

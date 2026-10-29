import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AI_CREDIT_PROTOCOL } from './ai-credits';
import { AI_CREDIT_LEASE_MS, AI_CREDIT_MAX_ATTEMPTS, AI_ENROLL_ADMIN_READ_MS, isAiAccountDependency, isAiDeliveryDependency,
    planAiCreditRequeue, plannedAiCreditEvent, type AiCreditOutboxRow, type AiCreditOutboxStore, type AiCreditRequeueCandidate,
    type AiCreditRequeueInput, type AiCreditRequeueResult, type AiEnrollForResult } from './ai-credit-outbox';

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

/**
 * The Works AI member public id. A missing schema/view reads as "no account" for delivery; with
 * `strict` it is rethrown so callers that must not confuse "no Works view here" with "not a member"
 * (round 5 D1 enrollment state) can tell them apart.
 */
export async function lookupAiAccount(db: Pick<Database, 'execute'>, userId: string, options: { strict?: boolean } = {}): Promise<string | null> {
    try {
        const rows = await db.execute<{ public_id: string | null }>(
            sql`select public_id from ezil_works.ai_members where auth_user_id = ${userId}::uuid limit 1`,
        );
        return rows[0]?.public_id || null;
    } catch (error) {
        if (!options.strict && missingAiAccountView(error)) return null;
        throw error;
    }
}

/**
 * Round 5 D1 drain-side enrollment (the store's `enrollFor`). Reads the OS user through the existing
 * Supabase admin API and enrolls with the STORED `app_metadata.auth0_sub`; the SQL function
 * re-verifies it against the auth user (D1 trust model: app_metadata is service-role-writable only).
 * - off staging (no ai-staging funding origin / DB URL): `unavailable:disabled`, no admin read;
 * - no stored subject: `needs_ezil_id`, no DB client;
 * - a stored subject with an unconfirmed Supabase email: confirmed through the admin API first (as the
 *   bridge does at sign-in). The bridge stores a subject only after Auth0 verified this email (auth0.ts
 *   requires email_verified), and a pre-round-5 link could leave the copy unconfirmed, which the SQL
 *   refuses (email_unconfirmed) forever. A failed confirm is `unavailable:<code>`, never a refusal;
 * - otherwise `enrollAiMember(userId, sub, 'outbox')` mapped to enrolled | refused:<code> | unavailable:<code>.
 * The admin read and the confirm share one 2 s window (AI_ENROLL_BUDGET_MS is unchanged). Never throws;
 * fixed codes only. Server-only modules load lazily so the drain and its tests never import them eagerly.
 */
export async function enrollWithStoredSubject(userId: string): Promise<AiEnrollForResult> {
    const [{ createAdminClient }, enrollment] = await Promise.all([
        import('@/server/auth/supabase-admin'), import('@/server/auth/staging-ai-enrollment')]);
    if (!enrollment.aiEnrollmentConfigured()) return 'unavailable:disabled';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: string;
    try {
        const adminWindow = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), AI_ENROLL_ADMIN_READ_MS); });
        const admin = createAdminClient().auth.admin;
        const response = await Promise.race([admin.getUserById(userId), adminWindow]);
        if (response === 'timeout') return 'unavailable:timeout';
        if (response.error) return response.error.status === 404 ? 'refused:user_not_found' : 'unavailable:connect_failed';
        const user: { app_metadata?: Record<string, unknown> | null; email_confirmed_at?: string | null } | null = response.data.user;
        if (!user) return 'refused:user_not_found';
        const stored = user.app_metadata?.auth0_sub;
        if (typeof stored !== 'string' || stored.length === 0) return 'needs_ezil_id';
        sub = stored;
        if (!user.email_confirmed_at) {
            const confirmed = await Promise.race([admin.updateUserById(userId, { email_confirm: true }), adminWindow]);
            if (confirmed === 'timeout') return 'unavailable:timeout';
            if (confirmed.error) return 'unavailable:connect_failed';
        }
    } catch {
        return 'unavailable:connect_failed';
    } finally {
        clearTimeout(timer);
    }
    const result = await enrollment.enrollAiMember(userId, sub, 'outbox');
    if (result.ok) return 'enrolled';
    return enrollment.isAiEnrollRefusal(result.code) ? `refused:${result.code}` : `unavailable:${result.code}`;
}

/**
 * Round 5 D1 "kick": after a successful enrollment (EZiL ID sign-in or the drain), in its own
 * transaction, wake that user's undelivered rows
 * that wait on the AI account ($1 user uuid, $2 now in epoch ms, $3 the protocol). Only `retry` rows
 * whose last error is an account dependency move; `processing` rows (held by a worker) are never
 * touched, and `attempts` and every other delivery field stay as they are, so the claim/finish fences
 * (attempts + the delivery JSON) keep working. Under READ COMMITTED a row that a concurrent claim just
 * turned into `processing` fails the re-checked status and is skipped. Run with app privileges.
 */
export const AI_CREDIT_KICK_SQL = `update public.ezil_billing_outbox
    set payload = jsonb_set(payload, '{delivery,nextAttemptAt}', to_jsonb($2::bigint))
    where user_id = $1::uuid and delivered_at is null
        and payload->>'protocol' = $3
        and payload->'delivery'->>'status' = 'retry'
        and last_error in ('no_ai_account', 'account_not_found')`;

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
                    ...(result.blockedBy ? { blockedBy: result.blockedBy } : {}),
                })}::text)::jsonb), last_error = ${result.reason},
                    delivered_at = ${result.status === 'done' ? new Date(now).toISOString() : null}::timestamptz
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = (${JSON.stringify(row.payload.delivery)}::text)::jsonb
            `);
        },
        requeueFailed: input => requeueFailedAiCredits(db, input),
        enrollFor: enrollWithStoredSubject,
        async receiptsFor(userId) {
            const rows = await db.execute<{ entitlementId: unknown; credits: unknown; expiresAt: unknown; deliveredAt: unknown; failed: unknown }>(sql`
                select payload->>'entitlementId' as "entitlementId", payload->'credits' as credits,
                    payload->>'expiresAt' as "expiresAt", delivered_at as "deliveredAt",
                    payload->'delivery'->>'status' = 'failed' as failed
                from ezil_billing_outbox where user_id = ${userId}::uuid and kind = 'ai_grant'
                    and payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                order by created_at desc, id limit 200`);
            return rows.flatMap(row => typeof row.entitlementId === 'string' && typeof row.credits === 'number'
                && Number.isSafeInteger(row.credits) && typeof row.expiresAt === 'string' && Number.isFinite(Date.parse(row.expiresAt))
                ? [{ entitlementId: row.entitlementId, credits: row.credits, expiresAt: new Date(row.expiresAt).toISOString(),
                    deliveredAt: row.deliveredAt == null ? null : new Date(row.deliveredAt as string | Date).toISOString(),
                    ...(row.failed === true ? { failed: true as const } : {}) }] : []);
        },
    };
}

/**
 * Round 3 D5: operator requeue of failed AI grants (dry run unless `apply`). Selects at most
 * 200 failed, undelivered grant rows (by event keys and/or user), decides each with
 * `planAiCreditRequeue`, and resets only eligible rows to `retry` with attempts 0, under the
 * same delivery-JSON + attempts fence `finish` uses. One JSON log line per row.
 */
export async function requeueFailedAiCredits(db: Pick<Database, 'execute'>, input: AiCreditRequeueInput): Promise<AiCreditRequeueResult> {
    const keys = [...new Set(input.eventKeys ?? [])];
    if (!Number.isSafeInteger(input.now) || input.now < 0 || keys.length > 200 || keys.some(key => typeof key !== 'string' || key.length < 1 || key.length > 200)
        || (input.userId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.userId))
        || (keys.length === 0 && input.userId === undefined)) throw new TypeError('Invalid AI requeue selection');
    const rows = await db.execute<AiCreditRequeueCandidate & Record<string, unknown>>(sql`
        select o.id, o.event_key as "eventKey", o.user_id as "userId", o.kind, o.payload, o.attempts, o.last_error as "lastError",
            exists (select 1 from ezil_billing_outbox r where r.kind = 'ai_revoke' and r.payload->>'protocol' = ${AI_CREDIT_PROTOCOL}
                and r.payload->>'entitlementId' = o.payload->>'entitlementId') as revoked
        from ezil_billing_outbox o
        where o.payload->>'protocol' = ${AI_CREDIT_PROTOCOL} and o.kind = 'ai_grant' and o.delivered_at is null
            and o.payload->'delivery'->>'status' = 'failed'
            ${keys.length ? sql`and o.event_key in (${sql.join(keys.map(key => sql`${key}`), sql`, `)})` : sql``}
            ${input.userId !== undefined ? sql`and o.user_id = ${input.userId}::uuid` : sql``}
        order by o.created_at, o.id limit 200`);
    const decisions: AiCreditRequeueResult['decisions'] = [];
    for (const row of rows) {
        let decision = planAiCreditRequeue(row, input.now);
        if (decision === 'eligible' && input.apply) {
            const reset = await db.execute(sql`
                update ezil_billing_outbox set attempts = 0, last_error = null,
                    payload = jsonb_set(payload, '{delivery}', (${JSON.stringify({ status: 'retry', nextAttemptAt: input.now,
                        requeuedAt: input.now, requeuedFrom: row.lastError })}::text)::jsonb)
                where id = ${row.id}::uuid and attempts = ${row.attempts} and delivered_at is null
                    and payload->'delivery' = (${JSON.stringify(row.payload.delivery)}::text)::jsonb returning id`);
            decision = reset.length ? 'requeued' : 'lost_race';
        }
        console.info(JSON.stringify({ event: 'ai-outbox-requeue', eventKey: row.eventKey, decision, lastError: row.lastError, dryRun: !input.apply }));
        decisions.push({ eventKey: row.eventKey, userId: row.userId, lastError: row.lastError, decision });
    }
    return { dryRun: !input.apply, selected: rows.length, eligible: decisions.filter(d => d.decision === 'eligible' || d.decision === 'requeued').length,
        requeued: decisions.filter(d => d.decision === 'requeued').length, decisions };
}

/** Read-only recovery preview by event key (no writes); `requeueFailedAiCredits` is the reset path. */
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

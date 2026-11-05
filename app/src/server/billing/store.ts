import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
    billingComputeEpochs,
    billingOverageConsents,
    billingOverageInvoices,
    billingPaymentIssues,
    billingPlanChanges,
    billingSizePreferences,
    type BillingComputeEpochRow,
    billingCustomers,
    billingEvents,
    billingGrants,
    billingOutbox,
    billingStorageSamples,
    billingSubscriptions,
    billingPaidIdentities,
    billingTrialIdentities,
    billingTrials,
    billingUsageIntervals,
    type BillingTrialRow,
} from '@/server/db/schema/billing';
import { computers } from '@/server/db/schema/computers';
import {
    ImageJobConflictError, noNonCloudflarePlacement, PlacementIntegrityError, readLastUsageStop, readPlacement, readPlacementProvider,
    type PlacementExecutor,
} from '@/server/lib/compute/placement';
import type { BillingStore, GrantKind, GrantMeter, GrantSource, GrantRow, OutboxInsert, StoredComputeEpoch } from './ports';
import { SESSION_MAX_SECONDS, SIZES } from './v2/contract';
import { epochSeconds, isoSeconds } from './v2/time';
import { AI_CREDIT_PROTOCOL, planAiReversal, type AiReversalStore, type AiTopupReceiptStore } from './ai-credits';
import { readOperatorEntitlements } from '@/server/entitlements/operator/store';
import {
    authSubjectFor, mailboxDomains, normalizeEmail, UNBOUND_TRIAL_STATUSES, TRIAL_POLICY_VERSION, TRIAL_SKU, type TrialRow, type TrialStore,
} from './v3/trial';

type Database = typeof import('@/server/db').db;

const openChangeStates = ['pending', 'requires_action', 'payment_failed', 'scheduled'] as const;

function computeEpoch(row: BillingComputeEpochRow): StoredComputeEpoch {
    return {
        id: row.id,
        userId: row.userId,
        computerId: row.computerId,
        size: row.size,
        weight: row.weight,
        readyAt: isoSeconds(epochSeconds(row.readyAt, 'ceil')),
        endedAt: row.endedAt === null ? null : isoSeconds(epochSeconds(row.endedAt)),
        endReason: row.endReason,
        overheadSeconds: row.overheadSeconds,
        deadlineAt: row.deadlineAt === null ? null : isoSeconds(epochSeconds(row.deadlineAt)),
        lastHeartbeatAt: row.lastHeartbeatAt === null ? null : isoSeconds(epochSeconds(row.lastHeartbeatAt)),
    };
}

/**
 * The caller owns the connection; importing billing must never initialize the
 * application's database or require its environment. Conflict guards live in
 * SQL so concurrent deliveries obey the same rules as sequential retries.
 */
function trialRow(row: BillingTrialRow): TrialRow {
    return { id: row.id, userId: row.userId, authSubject: row.authSubject, emailNormalized: row.emailNormalized, sku: row.sku,
        policyVersion: row.policyVersion, status: row.status, quotedAt: row.quotedAt, trialEnd: row.trialEnd,
        checkoutSessionId: row.checkoutSessionId, stripeCustomerId: row.stripeCustomerId,
        stripeSubscriptionId: row.stripeSubscriptionId, trialStart: row.trialStart, returnOrigin: row.returnOrigin };
}

/** Postgres unique_violation: a concurrent claim by another account (email or subject) or a second quote. */
const uniqueViolation = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === '23505'
    || (error as { cause?: { code?: string } })?.cause?.code === '23505';

const PAID_GRANT_KINDS = ['plan_period', 'upgrade_prorated', 'pro_period'] as const;
const PAID_SUBSCRIPTION_SKUS = ['standard_monthly_v3', 'premium_monthly_v3', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'] as const;

/**
 * Whether ANOTHER account already claims this person's trial (one rule for trialFacts and the locked claim):
 * - a trial row of another account with the same sign-in subject or normalized email, except a deleted account's
 *   never-started quote (reclaimable); a started trial's tombstone still claims;
 * - any trial row of another live account whose CURRENT verified email is the same person;
 * - review R4: any identity a started trial retained (ezil_billing_trial_identities), a deleted account's included.
 * `people` = this account plus every live account whose current email is the same person (for paid history).
 */
async function otherTrialClaims(db: Database, userId: string, authSubject: string, emailNormalized: string | null) {
    const domains = emailNormalized === null ? [] : mailboxDomains(emailNormalized.split('@')[1]!);
    const sameDomain = domains.length === 0 ? [] : await db.execute<{ id: string; email: string | null }>(sql`
        select id::text as id, email from auth.users
        where deleted_at is null and lower(split_part(email, '@', 2)) in (${sql.join(domains.map(domain => sql`${domain}`), sql`, `)})`);
    const people = [...new Set([userId, ...[...sameDomain].filter(row => normalizeEmail(row.email) === emailNormalized).map(row => row.id)])];
    const others = people.filter(id => id !== userId);
    const rows = await db.select().from(billingTrials).where(or(eq(billingTrials.authSubject, authSubject),
        ...(emailNormalized ? [eq(billingTrials.emailNormalized, emailNormalized)] : []),
        ...(others.length ? [inArray(billingTrials.userId, others)] : [])));
    const reclaimable = (row: BillingTrialRow) => row.userId === null && UNBOUND_TRIAL_STATUSES.includes(row.status);
    const retained = await db.select({ value: billingTrialIdentities.value, kind: billingTrialIdentities.kind, userId: billingTrials.userId })
        .from(billingTrialIdentities).innerJoin(billingTrials, eq(billingTrials.id, billingTrialIdentities.trialId))
        .where(and(sql`${billingTrials.stripeSubscriptionId} is not null`, or(
            and(eq(billingTrialIdentities.kind, 'subject'), eq(billingTrialIdentities.value, authSubject)),
            ...(domains.length ? [and(eq(billingTrialIdentities.kind, 'email'), inArray(billingTrialIdentities.emailDomain, domains))] : []))));
    const claimed = rows.some(row => row.userId !== userId && !reclaimable(row))
        || retained.some(row => row.userId !== userId
            && (row.kind === 'subject' ? row.value === authSubject : emailNormalized !== null && normalizeEmail(row.value) === emailNormalized));
    return { claimed, people };
}

export function createBillingStore(db: Database): BillingStore {
    /**
     * Review R4: append the CURRENT verified email and sign-in subject of started trials' live accounts (one trial, or
     * all of them). Unverified emails are not identities. Append-only (the key ignores a repeat), so a later deletion
     * of the account leaves every identity it ever had claimed with the trial's tombstone.
     */
    async function recordTrialIdentities(trialId?: string): Promise<number> {
        const scope = trialId === undefined ? sql`` : sql`and t.id = ${trialId}::uuid`;
        const rows = await db.execute<{ trial_id: string }>(sql`
            with live as (
                select t.id, u.id as user_id, lower(trim(u.email)) as email, u.email_confirmed_at,
                    case when coalesce(trim(u.raw_app_meta_data->>'auth0_sub'), '') <> '' then 'auth0:' || trim(u.raw_app_meta_data->>'auth0_sub')
                        else 'supabase:' || u.id::text end as subject
                from public.ezil_billing_trials t join auth.users u on u.id = t.user_id
                where t.stripe_subscription_id is not null and u.deleted_at is null ${scope}
            )
            insert into public.ezil_billing_trial_identities (trial_id, kind, value, email_domain)
            select id, 'subject', subject, null from live
            union all
            select id, 'email', email, split_part(email, '@', 2) from live
                where email_confirmed_at is not null and email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
            on conflict do nothing
            returning trial_id::text as trial_id`);
        return [...rows].length;
    }
    const store: BillingStore & AiTopupReceiptStore & AiReversalStore & TrialStore = {
        /** Server facts only: auth.users (email, its confirmation, the linked Auth0 subject) and the billing tables. */
        async trialFacts(userId) {
            const [user] = await db.execute<{ email: string | null; confirmed: boolean; auth0_sub: string | null }>(sql`
                select email, email_confirmed_at is not null as confirmed, raw_app_meta_data->>'auth0_sub' as auth0_sub
                from auth.users where id = ${userId}::uuid and deleted_at is null`);
            const emailNormalized = normalizeEmail(user?.email ?? null);
            const authSubject = authSubjectFor(userId, user?.auth0_sub);
            const [own] = await db.select().from(billingTrials).where(eq(billingTrials.userId, userId)).limit(1);
            // R4: a started trial of this account keeps the identity it has NOW (Billing read it), before anything else.
            if (own?.stripeSubscriptionId) await recordTrialIdentities(own.id);
            const { claimed, people } = await otherTrialClaims(db, userId, authSubject, emailNormalized);
            const [paid] = await db.execute<{ paid: boolean }>(sql`
                select exists (
                    select 1 from public.ezil_billing_grants g where g.user_id = any(${`{${people.join(',')}}`}::uuid[])
                        and g.kind in (${sql.join(PAID_GRANT_KINDS.map(kind => sql`${kind}`), sql`, `)}) and g.amount > 0
                ) or exists (
                    -- A live or once-live paid subscription that is not a trial (legacy rows predate first_paid_at).
                    select 1 from public.ezil_billing_subscriptions s where s.user_id = any(${`{${people.join(',')}}`}::uuid[])
                        and s.sku in (${sql.join(PAID_SUBSCRIPTION_SKUS.map(sku => sql`${sku}`), sql`, `)})
                        and s.status not in ('incomplete', 'incomplete_expired') and (s.trial_end is null or s.first_paid_at is not null)
                ) as paid`);
            // Known paid identities of a person whose paid account is gone (0021 capture hook): same subject or same email.
            const domains = emailNormalized === null ? [] : mailboxDomains(emailNormalized.split('@')[1]!);
            const known = await db.select({ kind: billingPaidIdentities.kind, value: billingPaidIdentities.value }).from(billingPaidIdentities)
                .where(or(and(eq(billingPaidIdentities.kind, 'subject'), eq(billingPaidIdentities.value, authSubject)),
                    ...(domains.length ? [and(eq(billingPaidIdentities.kind, 'email'), inArray(billingPaidIdentities.emailDomain, domains))] : [])));
            const paidIdentity = known.some(row => row.kind === 'subject' ? row.value === authSubject
                : emailNormalized !== null && normalizeEmail(row.value) === emailNormalized);
            return {
                emailNormalized, emailVerified: user?.confirmed === true, authSubject,
                own: own ? trialRow(own) : null,
                claimedElsewhere: claimed,
                paidBefore: paid?.paid === true || paidIdentity,
            };
        },

        async trialById(trialId) {
            if (!/^[0-9a-f-]{36}$/.test(trialId)) return null;
            const [row] = await db.select().from(billingTrials).where(eq(billingTrials.id, trialId)).limit(1);
            return row ? trialRow(row) : null;
        },

        async claimTrialQuote(input) {
            try {
                return await db.transaction(async tx => {
                    // One lock per key in a fixed order: same-account, same-subject and same-email claims serialize.
                    for (const key of [`user:${input.userId}`, `subject:${input.authSubject}`, `email:${input.emailNormalized}`].sort()) {
                        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:trial:${key}`}, 0))`);
                    }
                    const [existing] = await tx.select().from(billingTrials).where(eq(billingTrials.userId, input.userId)).for('update');
                    if (existing && !UNBOUND_TRIAL_STATUSES.includes(existing.status)) return { status: 'refused' as const, reason: 'trial_used' as const };
                    // The same rule as trialFacts, under the locks: another account's claim, a same-person account's trial,
                    // or an identity a started trial retained (R4) refuses, whatever the caller read earlier.
                    if ((await otherTrialClaims(tx as unknown as Database, input.userId, input.authSubject, input.emailNormalized)).claimed) {
                        return { status: 'refused' as const, reason: 'trial_used' as const };
                    }
                    // A deleted account's never-started quote on this subject or email gives way; a started one never does.
                    await tx.delete(billingTrials).where(and(isNull(billingTrials.userId), isNull(billingTrials.stripeSubscriptionId),
                        inArray(billingTrials.status, [...UNBOUND_TRIAL_STATUSES]),
                        or(eq(billingTrials.authSubject, input.authSubject), eq(billingTrials.emailNormalized, input.emailNormalized))));
                    if (existing) {
                        // The claim follows the current verified identity; the unique keys refuse one another account holds.
                        const [row] = await tx.update(billingTrials).set({ quotedAt: input.quotedAt, trialEnd: input.trialEnd, status: 'quoted',
                            authSubject: input.authSubject, emailNormalized: input.emailNormalized, returnOrigin: input.returnOrigin,
                            checkoutSessionId: null, policyVersion: TRIAL_POLICY_VERSION, updatedAt: sql`now()` })
                            .where(and(eq(billingTrials.id, existing.id), isNull(billingTrials.stripeSubscriptionId))).returning();
                        if (!row) return { status: 'refused' as const, reason: 'trial_used' as const };
                        return { status: 'quoted' as const, trial: trialRow(row), supersededCheckoutSessionId: existing.checkoutSessionId };
                    }
                    const [row] = await tx.insert(billingTrials).values({ userId: input.userId, authSubject: input.authSubject,
                        emailNormalized: input.emailNormalized, sku: TRIAL_SKU, policyVersion: TRIAL_POLICY_VERSION, status: 'quoted',
                        quotedAt: input.quotedAt, trialEnd: input.trialEnd, returnOrigin: input.returnOrigin }).returning();
                    return { status: 'quoted' as const, trial: trialRow(row!), supersededCheckoutSessionId: null };
                });
            } catch (error) {
                // Another account holds this person's email or subject: the unique constraint decides a concurrent race.
                if (uniqueViolation(error)) return { status: 'refused', reason: 'trial_used' };
                throw error;
            }
        },

        async attachTrialCheckout(input) {
            const rows = await db.update(billingTrials).set({ status: 'checkout', checkoutSessionId: input.checkoutSessionId,
                stripeCustomerId: input.customerId, updatedAt: sql`now()` }).where(and(eq(billingTrials.id, input.trialId),
                eq(billingTrials.userId, input.userId), eq(billingTrials.quotedAt, input.quotedAt), isNull(billingTrials.stripeSubscriptionId),
                or(isNull(billingTrials.stripeCustomerId), eq(billingTrials.stripeCustomerId, input.customerId))))
                .returning({ id: billingTrials.id });
            return rows.length > 0 ? 'attached' : 'stale';
        },

        async bindTrialSubscription(input) {
            const rows = await db.update(billingTrials).set({ stripeSubscriptionId: input.subscriptionId, trialStart: input.trialStart,
                stripeCustomerId: input.customerId, status: sql`case when ${billingTrials.status} in ('quoted', 'checkout') then 'trialing' else ${billingTrials.status} end`,
                updatedAt: sql`now()` }).where(and(eq(billingTrials.id, input.trialId), eq(billingTrials.userId, input.userId),
                or(isNull(billingTrials.stripeSubscriptionId), eq(billingTrials.stripeSubscriptionId, input.subscriptionId)),
                or(isNull(billingTrials.stripeCustomerId), eq(billingTrials.stripeCustomerId, input.customerId))))
                .returning({ id: billingTrials.id });
            if (rows.length > 0) {
                await recordTrialIdentities(input.trialId);
                return 'bound';
            }
            const [row] = await db.select({ id: billingTrials.id }).from(billingTrials).where(eq(billingTrials.id, input.trialId)).limit(1);
            return row ? 'conflict' : 'missing';
        },

        async setTrialStatus(input) {
            await db.update(billingTrials).set({ status: input.status, updatedAt: sql`now()` }).where(and(
                eq(billingTrials.id, input.trialId), eq(billingTrials.stripeSubscriptionId, input.subscriptionId),
                inArray(billingTrials.status, [...input.from])));
        },

        async markSubscriptionPaid(subscriptionId, at) {
            await db.update(billingSubscriptions).set({ firstPaidAt: sql`coalesce(${billingSubscriptions.firstPaidAt}, ${at.toISOString()}::timestamptz)` })
                .where(eq(billingSubscriptions.stripeSubscriptionId, subscriptionId));
        },

        recordTrialIdentities: trialId => recordTrialIdentities(trialId),

        async outboxByEventKey(eventKey) {
            const [row] = await db.select().from(billingOutbox).where(eq(billingOutbox.eventKey, eventKey)).limit(1);
            return row ? { eventKey: row.eventKey, userId: row.userId, kind: row.kind, payload: row.payload as Record<string, unknown> } : null;
        },

        async grantsForPeriod(userId, window, meters) {
            if (meters.length === 0) return [];
            const rows = await db.select().from(billingGrants).where(and(
                eq(billingGrants.userId, userId),
                inArray(billingGrants.meter, meters),
                lt(billingGrants.periodStart, window.end),
                gt(billingGrants.periodEnd, window.start),
            ));
            return rows.map(row => ({
                ...row,
                meter: row.meter as GrantMeter,
                kind: row.kind as GrantKind,
                sourceType: row.sourceType as GrantSource,
            }));
        },

        async openEpoch(input) {
            const [owner] = await db.select({ id: computers.id }).from(computers).where(and(
                eq(computers.id, input.computerId), eq(computers.userId, input.userId),
            ));
            if (!owner) throw new Error('Computer does not belong to billing user');
            const readyAt = new Date(epochSeconds(input.readyAt, 'ceil') * 1000);
            const { sessionMaxSeconds = SESSION_MAX_SECONDS, ...epochInput } = input;
            const deadlineAt = input.deadlineAt == null ? null : new Date(Math.max(readyAt.getTime(),
                Math.min(readyAt.getTime() + (sessionMaxSeconds ?? Infinity) * 1000, epochSeconds(input.deadlineAt) * 1000)));
            // A concurrent close can remove the conflicting open row between the
            // insert and select. Retry then, without changing any existing epoch.
            // Bound contention so the caller can retry instead of spinning forever.
            for (let attempt = 0; attempt < 3; attempt++) {
                // Ready-event replays keep their original epoch, even after it has closed.
                const [replayed] = await db.select().from(billingComputeEpochs).where(and(
                    eq(billingComputeEpochs.computerId, input.computerId), eq(billingComputeEpochs.readyAt, readyAt),
                ));
                if (replayed) {
                    if (replayed.userId !== input.userId) throw new Error('Epoch ownership conflict');
                    return { status: 'exists', epoch: computeEpoch(replayed) };
                }
                const [inserted] = await db.insert(billingComputeEpochs).values({
                    ...epochInput, readyAt, deadlineAt, weight: SIZES[input.size].weight,
                }).onConflictDoNothing().returning();
                if (inserted) return { status: 'opened', epoch: computeEpoch(inserted) };
                const [existing] = await db.select().from(billingComputeEpochs).where(and(
                    eq(billingComputeEpochs.computerId, input.computerId),
                    isNull(billingComputeEpochs.endedAt),
                ));
                if (existing) {
                    if (existing.userId !== input.userId) throw new Error('Epoch ownership conflict');
                    return { status: 'exists', epoch: computeEpoch(existing) };
                }
                const [concurrent] = await db.select().from(billingComputeEpochs).where(and(
                    eq(billingComputeEpochs.userId, input.userId),
                    isNull(billingComputeEpochs.endedAt),
                ));
                if (concurrent && concurrent.computerId !== input.computerId) {
                    return { status: 'concurrent', epoch: computeEpoch(concurrent) };
                }
            }
            throw new Error('Could not open compute epoch after 3 attempts');
        },

        async openEpochFor(computerId) {
            const [row] = await db.select().from(billingComputeEpochs).where(and(
                eq(billingComputeEpochs.computerId, computerId), isNull(billingComputeEpochs.endedAt),
            )).limit(1);
            return row ? computeEpoch(row) : null;
        },

        async touchEpoch(computerId, at) {
            const rows = await db.update(billingComputeEpochs).set({
                lastHeartbeatAt: sql`greatest(coalesce(${billingComputeEpochs.lastHeartbeatAt}, ${billingComputeEpochs.readyAt}), ${at.toISOString()}::timestamptz)`,
            }).where(and(
                eq(billingComputeEpochs.computerId, computerId), isNull(billingComputeEpochs.endedAt),
            )).returning({ id: billingComputeEpochs.id });
            return rows.length > 0 ? 'touched' : 'not_open';
        },

        async openEpochsForSweep({ limit }) {
            if (!Number.isFinite(limit) || limit < 0) throw new RangeError('Invalid sweep limit');
            const boundedLimit = Math.min(200, Math.floor(limit));
            if (boundedLimit === 0) return [];
            const rows = await db.select().from(billingComputeEpochs).where(isNull(billingComputeEpochs.endedAt))
                .orderBy(sql`coalesce(${billingComputeEpochs.deadlineAt}, ${billingComputeEpochs.readyAt} + interval '21600 seconds')`, billingComputeEpochs.id)
                .limit(boundedLimit);
            return rows.map(computeEpoch);
        },

        async policyClosedEpochsSince(since, limit) {
            if (!Number.isFinite(limit) || limit < 0) throw new RangeError('Invalid sweep limit');
            const boundedLimit = Math.min(200, Math.floor(limit));
            if (boundedLimit === 0) return [];
            const open = alias(billingComputeEpochs, 'open_epoch');
            const rows = await db.select().from(billingComputeEpochs).where(and(
                inArray(billingComputeEpochs.endReason, ['session_max', 'allowance_exhausted', 'overage_cap']),
                gte(billingComputeEpochs.endedAt, since),
                notExists(db.select({ id: open.id }).from(open).where(and(
                    eq(open.computerId, billingComputeEpochs.computerId), isNull(open.endedAt),
                ))),
            )).orderBy(desc(billingComputeEpochs.endedAt), billingComputeEpochs.id).limit(boundedLimit);
            return rows.map(computeEpoch);
        },

        async closeEpoch({ computerId, epochId, readyBy, endedAt, reason, overheadSeconds }) {
            const ended = isoSeconds(epochSeconds(endedAt));
            const rows = await db.update(billingComputeEpochs).set({
                endedAt: sql`greatest(${billingComputeEpochs.readyAt}, ${ended}::timestamptz)`,
                endReason: reason,
                overheadSeconds,
            }).where(and(
                eq(billingComputeEpochs.computerId, computerId), isNull(billingComputeEpochs.endedAt),
                epochId === undefined ? undefined : eq(billingComputeEpochs.id, epochId),
                readyBy === undefined ? undefined : lte(billingComputeEpochs.readyAt, new Date(epochSeconds(readyBy, 'ceil') * 1000)),
            )).returning({ id: billingComputeEpochs.id });
            return rows.length > 0 ? 'closed' : 'not_open';
        },

        async epochsFor(userId, since) {
            const rows = await db.select().from(billingComputeEpochs).where(and(
                eq(billingComputeEpochs.userId, userId),
                or(isNull(billingComputeEpochs.endedAt), gt(billingComputeEpochs.endedAt, since)),
            )).orderBy(billingComputeEpochs.readyAt, billingComputeEpochs.id);
            return rows.map(computeEpoch);
        },

        async recordConsent(input) {
            const [inserted] = await db.insert(billingOverageConsents).values(input)
                .onConflictDoNothing().returning();
            if (inserted) return inserted;
            // A replay must not become the latest decision, especially if a
            // newer consent has since disabled overage. The unique key also
            // serializes concurrent retries of this exact audit record.
            const [row] = await db.select().from(billingOverageConsents).where(and(
                eq(billingOverageConsents.userId, input.userId),
                eq(billingOverageConsents.subscriptionId, input.subscriptionId),
                eq(billingOverageConsents.acceptedAt, input.acceptedAt),
                eq(billingOverageConsents.enabled, input.enabled),
                eq(billingOverageConsents.capCents, input.capCents),
                eq(billingOverageConsents.termsVersion, input.termsVersion),
                eq(billingOverageConsents.catalogVersion, input.catalogVersion),
                eq(billingOverageConsents.rateCentsPerStdHour, input.rateCentsPerStdHour),
                eq(billingOverageConsents.actor, input.actor),
            ));
            if (!row) throw new Error('Consent disappeared after a duplicate insert');
            return row;
        },

        async consentAsOf(userId, subscriptionId, at) {
            const [row] = await db.select().from(billingOverageConsents).where(and(
                eq(billingOverageConsents.userId, userId),
                eq(billingOverageConsents.subscriptionId, subscriptionId),
                lt(billingOverageConsents.acceptedAt, at),
            )).orderBy(desc(billingOverageConsents.acceptedAt), desc(billingOverageConsents.id)).limit(1);
            return row ?? null;
        },

        async consentDecisionsForPeriod(userId, subscriptionId, start, end) {
            const initial = db.select({ id: billingOverageConsents.id }).from(billingOverageConsents).where(and(
                eq(billingOverageConsents.userId, userId),
                eq(billingOverageConsents.subscriptionId, subscriptionId),
                lte(billingOverageConsents.acceptedAt, start),
            )).orderBy(desc(billingOverageConsents.acceptedAt), desc(billingOverageConsents.id)).limit(1);
            return db.select().from(billingOverageConsents).where(and(
                eq(billingOverageConsents.userId, userId),
                eq(billingOverageConsents.subscriptionId, subscriptionId),
                or(inArray(billingOverageConsents.id, initial), and(
                    gt(billingOverageConsents.acceptedAt, start),
                    lt(billingOverageConsents.acceptedAt, end),
                )),
            )).orderBy(billingOverageConsents.acceptedAt, billingOverageConsents.id);
        },

        async latestConsent(userId, subscriptionId) {
            const [row] = await db.select().from(billingOverageConsents).where(and(
                eq(billingOverageConsents.userId, userId),
                eq(billingOverageConsents.subscriptionId, subscriptionId),
            )).orderBy(desc(billingOverageConsents.acceptedAt), desc(billingOverageConsents.id)).limit(1);
            return row ?? null;
        },

        async upsertOverageInvoice(input) {
            const [inserted] = await db.insert(billingOverageInvoices).values({ ...input, status: 'pending' })
                .onConflictDoNothing().returning();
            if (inserted) return { status: 'inserted', row: inserted };
            const [row] = await db.select().from(billingOverageInvoices).where(and(
                eq(billingOverageInvoices.userId, input.userId),
                eq(billingOverageInvoices.subscriptionId, input.subscriptionId),
                eq(billingOverageInvoices.periodStart, input.periodStart),
                eq(billingOverageInvoices.ratingVersion, input.ratingVersion),
            ));
            if (!row) throw new Error('Overage invoice ownership conflict');
            return { status: 'exists', row };
        },

        async attachOverageStripeInvoice(id, stripeInvoiceId) {
            // Once linked, a retry cannot replace the invoice which owns this charge.
            await db.update(billingOverageInvoices).set({ stripeInvoiceId, updatedAt: sql`now()` }).where(and(
                eq(billingOverageInvoices.id, id),
                or(isNull(billingOverageInvoices.stripeInvoiceId), eq(billingOverageInvoices.stripeInvoiceId, stripeInvoiceId)),
            ));
        },

        async markOverageInvoiceOpen(stripeInvoiceId) {
            await db.update(billingOverageInvoices).set({ status: 'open', updatedAt: sql`now()` }).where(and(
                eq(billingOverageInvoices.stripeInvoiceId, stripeInvoiceId), eq(billingOverageInvoices.status, 'pending'),
            ));
        },

        async setOverageInvoiceStatus(stripeInvoiceId, status) {
            const rows = await db.update(billingOverageInvoices).set({ status, updatedAt: sql`now()` })
                .where(eq(billingOverageInvoices.stripeInvoiceId, stripeInvoiceId))
                .returning({ id: billingOverageInvoices.id });
            return rows.length > 0 ? 'updated' : 'not_found';
        },

        async overageInvoiceByStripeId(stripeInvoiceId) {
            const [row] = await db.select().from(billingOverageInvoices)
                .where(eq(billingOverageInvoices.stripeInvoiceId, stripeInvoiceId));
            return row ?? null;
        },

        async overageInvoicesFor(userId) {
            return db.select().from(billingOverageInvoices).where(eq(billingOverageInvoices.userId, userId))
                .orderBy(desc(billingOverageInvoices.periodStart));
        },

        async recordPlanChange(input) {
            const rows = await db.insert(billingPlanChanges).values(input).onConflictDoNothing()
                .returning({ id: billingPlanChanges.id });
            return rows.length > 0 ? 'inserted' : 'exists';
        },

        async setPlanChangeState({ userId, subscriptionId, kind, state, stripeInvoiceId, effectiveAt, hostedInvoiceUrl, expiresAt }) {
            await db.update(billingPlanChanges).set({ state, stripeInvoiceId, effectiveAt, hostedInvoiceUrl, expiresAt, updatedAt: sql`now()` })
                .where(and(
                    eq(billingPlanChanges.userId, userId),
                    eq(billingPlanChanges.subscriptionId, subscriptionId),
                    eq(billingPlanChanges.kind, kind),
                    inArray(billingPlanChanges.state, openChangeStates),
                ));
        },

        async openPlanChanges(userId) {
            return db.select().from(billingPlanChanges).where(and(
                eq(billingPlanChanges.userId, userId), inArray(billingPlanChanges.state, openChangeStates),
            )).orderBy(billingPlanChanges.createdAt, billingPlanChanges.id);
        },

        async recordPaymentIssue({ eventCreated, ...input }) {
            await db.insert(billingPaymentIssues).values({ ...input, stripeEventCreated: eventCreated })
                .onConflictDoUpdate({
                    target: billingPaymentIssues.stripeInvoiceId,
                    set: {
                        subscriptionId: sql`excluded.subscription_id`,
                        invoiceKind: sql`excluded.invoice_kind`,
                        issue: sql`excluded.issue`,
                        hostedInvoiceUrl: sql`excluded.hosted_invoice_url`,
                        stripeEventCreated: sql`excluded.stripe_event_created`,
                        resolvedAt: null,
                        updatedAt: sql`now()`,
                    },
                    // Preserve ownership and the resolution watermark. An equal-time
                    // failed-event replay must not reopen an already resolved invoice.
                    setWhere: and(
                        eq(billingPaymentIssues.userId, input.userId),
                        sql`excluded.stripe_event_created >= ${billingPaymentIssues.stripeEventCreated}`,
                        or(isNull(billingPaymentIssues.resolvedAt), sql`excluded.stripe_event_created > ${billingPaymentIssues.resolvedAt}`),
                    ),
                });
        },

        async resolvePaymentIssue(stripeInvoiceId, eventCreated) {
            await db.update(billingPaymentIssues).set({
                resolvedAt: eventCreated,
                stripeEventCreated: eventCreated,
                updatedAt: sql`now()`,
            }).where(and(
                eq(billingPaymentIssues.stripeInvoiceId, stripeInvoiceId),
                sql`${billingPaymentIssues.stripeEventCreated} <= ${eventCreated.toISOString()}::timestamptz`,
            ));
        },

        async openPaymentIssues(userId) {
            return db.select().from(billingPaymentIssues).where(and(
                eq(billingPaymentIssues.userId, userId), isNull(billingPaymentIssues.resolvedAt),
            )).orderBy(desc(billingPaymentIssues.stripeEventCreated));
        },

        async setSizePreference(userId, size) {
            await db.insert(billingSizePreferences).values({ userId, size }).onConflictDoUpdate({
                target: billingSizePreferences.userId,
                set: { size, updatedAt: sql`now()` },
            });
        },

        async sizePreference(userId) {
            const [row] = await db.select().from(billingSizePreferences)
                .where(eq(billingSizePreferences.userId, userId));
            return row?.size ?? null;
        },

        async userCreatedAt(userId) {
            const [row] = await db.execute<{ created_at: Date | string | null }>(
                sql`select created_at from auth.users where id = ${userId}::uuid`,
            );
            return row?.created_at == null ? null : new Date(row.created_at);
        },

        async stripeCustomerFor(userId) {
            const [row] = await db.select().from(billingCustomers)
                .where(eq(billingCustomers.userId, userId)).limit(1);
            return row?.stripeCustomerId ?? null;
        },

        async userForStripeCustomer(stripeCustomerId) {
            const [row] = await db.select().from(billingCustomers)
                .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId)).limit(1);
            return row?.userId ?? null;
        },

        operatorEntitlementsFor: userId => readOperatorEntitlements(db, userId),

        async subscriptionsFor(userId) {
            return db.select({
                stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
                status: billingSubscriptions.status,
                sku: billingSubscriptions.sku,
                currentPeriodStart: billingSubscriptions.currentPeriodStart,
                currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
                cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
                trialStart: billingSubscriptions.trialStart,
                trialEnd: billingSubscriptions.trialEnd,
                firstPaidAt: billingSubscriptions.firstPaidAt,
            }).from(billingSubscriptions).where(eq(billingSubscriptions.userId, userId));
        },

        async intervalsFor(userId, since) {
            return db.select({
                startedAt: billingUsageIntervals.startedAt,
                endedAt: billingUsageIntervals.endedAt,
                lastSeenAt: billingUsageIntervals.lastSeenAt,
            }).from(billingUsageIntervals).where(and(
                eq(billingUsageIntervals.userId, userId),
                or(isNull(billingUsageIntervals.endedAt), gte(billingUsageIntervals.endedAt, since)),
            ));
        },

        async latestStorageFor(userId) {
            return db.selectDistinctOn([billingStorageSamples.computerId], {
                computerId: billingStorageSamples.computerId,
                bytes: billingStorageSamples.bytes,
                measuredAt: billingStorageSamples.measuredAt,
            }).from(billingStorageSamples)
                .where(eq(billingStorageSamples.userId, userId))
                .orderBy(billingStorageSamples.computerId, desc(billingStorageSamples.measuredAt));
        },

        async grantsBySource(sourceType, sourceId) {
            const rows = await db.select().from(billingGrants).where(and(
                eq(billingGrants.sourceType, sourceType),
                eq(billingGrants.sourceId, sourceId),
            ));
            // Migration checks constrain these text columns to the port's unions.
            return rows.map(row => ({
                ...row,
                meter: row.meter as GrantMeter,
                kind: row.kind as GrantKind,
                sourceType: row.sourceType as GrantSource,
            }));
        },

        async computerOwner(computerId) {
            const [row] = await db.select({ userId: computers.userId }).from(computers)
                .where(eq(computers.id, computerId)).limit(1);
            return row?.userId ?? null;
        },

        async placementProvider(computerId) {
            // placement.ts is the one module that names the placement table (C-2), reads included.
            return readPlacementProvider(db, computerId);
        },

        async linkCustomer(userId, stripeCustomerId) {
            const inserted = await db.insert(billingCustomers).values({ userId, stripeCustomerId })
                .onConflictDoNothing().returning({ userId: billingCustomers.userId });
            if (inserted.length > 0) return 'linked';
            const [row] = await db.select().from(billingCustomers)
                .where(eq(billingCustomers.userId, userId)).limit(1);
            return row?.stripeCustomerId === stripeCustomerId ? 'exists' : 'conflict';
        },

        async recordEvent(event) {
            const inserted = await db.insert(billingEvents).values(event)
                .onConflictDoNothing().returning({ eventId: billingEvents.eventId });
            if (inserted.length > 0) return 'new';
            const [row] = await db.select().from(billingEvents)
                .where(eq(billingEvents.eventId, event.eventId)).limit(1);
            if (!row) throw new Error('billing_receipt_unavailable');
            if (row.payloadSha256 !== event.payloadSha256 || row.type !== event.type || row.livemode !== event.livemode) return 'conflict';
            // Failed attempts retain their receipt but must remain retryable.
            return row?.processedAt && !row.outcome?.startsWith('failed') ? 'processed' : 'unprocessed';
        },

        async markEventProcessed(eventId, outcome) {
            await db.update(billingEvents).set({ processedAt: sql`now()`, outcome })
                .where(eq(billingEvents.eventId, eventId));
        },

        async upsertSubscription(row) {
            const written = await db.insert(billingSubscriptions).values(row).onConflictDoUpdate({
                target: billingSubscriptions.stripeSubscriptionId,
                // Ownership is fixed by the first insert, even when a newer event arrives. first_paid_at is never
                // written here: only the first positive paid period sets it (markSubscriptionPaid).
                set: {
                    status: sql`excluded.status`,
                    sku: sql`excluded.sku`,
                    currentPeriodStart: sql`excluded.current_period_start`,
                    currentPeriodEnd: sql`excluded.current_period_end`,
                    cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
                    stripeEventCreated: sql`excluded.stripe_event_created`,
                    ...(row.trialStart !== undefined ? { trialStart: sql`excluded.trial_start` } : {}),
                    ...(row.trialEnd !== undefined ? { trialEnd: sql`excluded.trial_end` } : {}),
                    updatedAt: sql`now()`,
                },
                setWhere: sql`${billingSubscriptions.userId} = excluded.user_id
                    and excluded.stripe_event_created >= ${billingSubscriptions.stripeEventCreated}`,
            }).returning({ id: billingSubscriptions.stripeSubscriptionId });
            if (written.length > 0) return 'applied';
            const [existing] = await db.select({ userId: billingSubscriptions.userId }).from(billingSubscriptions)
                .where(eq(billingSubscriptions.stripeSubscriptionId, row.stripeSubscriptionId));
            return existing && existing.userId !== row.userId ? 'conflict' : 'stale';
        },

        async insertGrant(grant) {
            const inserted = await db.insert(billingGrants).values(grant)
                .onConflictDoNothing().returning({ id: billingGrants.id });
            return inserted.length > 0 ? 'inserted' : 'duplicate';
        },

        async enqueueOutbox(item) {
            const inserted = await db.insert(billingOutbox).values(item)
                .onConflictDoNothing().returning({ id: billingOutbox.id });
            return inserted.length > 0 ? 'queued' : 'duplicate';
        },

        async aiCreditGrantsByInvoice(userId, invoiceId) {
            const rows = await db.select().from(billingOutbox).where(and(
                eq(billingOutbox.userId, userId), eq(billingOutbox.kind, 'ai_grant'),
                sql`${billingOutbox.payload}->>'protocol' = ${AI_CREDIT_PROTOCOL}`,
                sql`${billingOutbox.payload}->>'invoiceId' = ${invoiceId}`,
            ));
            return rows.map(row => ({ eventKey: row.eventKey, userId: row.userId, kind: 'ai_grant' as const,
                payload: row.payload as Record<string, unknown> }));
        },

        async aiTopupReceipt(userId, paymentIntentId) {
            const rows = await db.select().from(billingOutbox).where(and(
                eq(billingOutbox.userId, userId), eq(billingOutbox.kind, 'ai_grant'),
                sql`${billingOutbox.payload}->>'protocol' = ${AI_CREDIT_PROTOCOL}`,
                sql`${billingOutbox.payload}->>'paymentIntentId' = ${paymentIntentId}`,
            )).limit(2);
            if (rows.length > 1) throw new Error('ai_topup_receipt_conflict');
            const row = rows[0];
            return row ? { eventKey: row.eventKey, userId: row.userId, kind: 'ai_grant',
                payload: row.payload as Record<string, unknown> } : null;
        },

        async recordAiTopup(grant, receipt) {
            if (grant.sourceType !== 'payment_intent' || grant.kind !== 'topup' || grant.meter !== 'ai_usd_micro'
                || receipt.userId !== grant.userId || receipt.kind !== 'ai_grant'
                || receipt.payload.protocol !== AI_CREDIT_PROTOCOL || receipt.payload.paymentIntentId !== grant.sourceId
                || receipt.payload.amountUsdMicro !== grant.amount.toString()
                || receipt.payload.expiresAt !== grant.periodEnd?.toISOString()) throw new Error('invalid_ai_topup_receipt');
            return db.transaction(async tx => {
                // Serialize by payment intent, including conflicting SKU/owner deliveries.
                await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:ai_topup:${grant.sourceId}`}, 0))`);
                const [original] = await tx.select().from(billingGrants).where(and(
                    eq(billingGrants.sourceType, 'payment_intent'), eq(billingGrants.sourceId, grant.sourceId),
                    eq(billingGrants.kind, 'topup'), eq(billingGrants.meter, 'ai_usd_micro'),
                )).limit(1);
                const receipts = await tx.select().from(billingOutbox).where(and(
                    eq(billingOutbox.kind, 'ai_grant'),
                    sql`${billingOutbox.payload}->>'protocol' = ${AI_CREDIT_PROTOCOL}`,
                    sql`${billingOutbox.payload}->>'paymentIntentId' = ${grant.sourceId}`,
                )).limit(2);
                if ((original && original.userId !== grant.userId) || receipts.some(row => row.userId !== grant.userId)) return 'review:customer_mismatch';
                if (receipts.length > 1 || (receipts.length === 1 && !original)) throw new Error('ai_topup_receipt_conflict');
                if (receipts.length === 1) return 'applied';
                const [legacy] = await tx.select({ id: billingOutbox.id }).from(billingOutbox)
                    .where(eq(billingOutbox.eventKey, `payment_intent:${grant.sourceId}:ai_topup`)).limit(1);
                // This phase never converts or repairs historical dollar-only funding.
                if (original || legacy) return 'review:legacy_topup_unfunded';
                const inserted = await tx.insert(billingGrants).values(grant).onConflictDoNothing().returning({ id: billingGrants.id });
                const queued = await tx.insert(billingOutbox).values(receipt).onConflictDoNothing().returning({ id: billingOutbox.id });
                if (inserted.length !== 1 || queued.length !== 1) throw new Error('ai_topup_receipt_conflict');
                return 'applied';
            });
        },

        async recordAiReversal(input) {
            return db.transaction(async tx => {
                const causeType = input.action === 'revoke' ? 'refund' : 'dispute';
                await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:ai_cause:${causeType}:${input.causeId}`}, 0))`);
                const roots = [...new Set(input.receipts.map(r => String(r.payload.entitlementId)))].sort();
                for (const root of roots) {
                    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:ai_root:${root}`}, 0))`);
                }
                const [owner] = await tx.select().from(billingCustomers).where(eq(billingCustomers.stripeCustomerId, input.customerId));
                if (owner?.userId !== input.userId) return 'review:customer_mismatch';
                const original = input.originals[0];
                if (!original || roots.length === 0) return 'review:restore_receipt_missing';
                const originals = await tx.select().from(billingGrants).where(and(
                    eq(billingGrants.sourceType, original.sourceType), eq(billingGrants.sourceId, original.sourceId),
                ));
                // No user predicate: a conflicting owner/root/D must be seen and refused.
                const receipts = await tx.select().from(billingOutbox).where(and(
                    sql`${billingOutbox.payload}->>'protocol' = ${AI_CREDIT_PROTOCOL}`,
                    or(sql`${billingOutbox.payload}->>'entitlementId' in (${sql.join(roots.map(root => sql`${root}`), sql`, `)})`,
                        and(sql`${billingOutbox.payload}->'reversal'->>'causeType' = ${causeType}`,
                            sql`${billingOutbox.payload}->'reversal'->>'causeId' = ${input.causeId}`)),
                ));
                // Include every local cause bound to these roots, not just the incoming D/R.
                // Root locks serialize different disputes/refunds against the same paid allowance.
                const causes = new Map<string, { type: 'refund' | 'dispute'; id: string }>([
                    [`${causeType}:${input.causeId}`, { type: causeType, id: input.causeId }],
                ]);
                for (const receipt of receipts) {
                    const proof = (receipt.payload as Record<string, unknown>).reversal as { causeType?: unknown; causeId?: unknown } | undefined;
                    if ((proof?.causeType === 'dispute' || proof?.causeType === 'refund') && typeof proof.causeId === 'string') {
                        causes.set(`${proof.causeType}:${proof.causeId}`, { type: proof.causeType, id: proof.causeId });
                    }
                }
                const corrections = await tx.select().from(billingGrants).where(or(...[...causes.values()].map(cause => and(
                    eq(billingGrants.sourceType, cause.type), eq(billingGrants.sourceId, cause.id),
                ))));
                const plan = planAiReversal(input, { originals: originals as GrantRow[], corrections: corrections as GrantRow[],
                    receipts: receipts.map(r => ({ ...r, kind: r.kind as OutboxInsert['kind'], payload: r.payload as Record<string, unknown> })) });
                if (plan.outcome !== 'applied') return plan.outcome;
                for (const grant of plan.grants) {
                    const inserted = await tx.insert(billingGrants).values(grant).onConflictDoNothing().returning({ id: billingGrants.id });
                    if (inserted.length !== 1) throw new Error('ai_reversal_receipt_conflict');
                }
                for (const item of plan.outbox) {
                    const inserted = await tx.insert(billingOutbox).values(item).onConflictDoNothing().returning({ id: billingOutbox.id });
                    if (inserted.length !== 1) throw new Error('ai_reversal_receipt_conflict');
                }
                return 'applied';
            });
        },

        async latestIntervalFor(computerId) {
            const [row] = await db.select({ endedAt: billingUsageIntervals.endedAt })
                .from(billingUsageIntervals).where(eq(billingUsageIntervals.computerId, computerId))
                .orderBy(desc(billingUsageIntervals.startedAt), desc(billingUsageIntervals.id)).limit(1);
            return row ?? null;
        },

        async openInterval(userId, computerId, at, source) {
            await db.insert(billingUsageIntervals).values({
                userId, computerId, startedAt: at, lastSeenAt: at, source,
            }).onConflictDoNothing();
        },

        async touchInterval(computerId, at) {
            await db.update(billingUsageIntervals).set({
                lastSeenAt: sql`greatest(${billingUsageIntervals.lastSeenAt}, ${at.toISOString()}::timestamptz)`,
            }).where(and(eq(billingUsageIntervals.computerId, computerId), isNull(billingUsageIntervals.endedAt)));
        },

        async closeInterval(computerId, at, reason) {
            await db.update(billingUsageIntervals).set({
                endedAt: sql`greatest(${billingUsageIntervals.startedAt}, ${at.toISOString()}::timestamptz)`,
                closeReason: reason,
            }).where(and(eq(billingUsageIntervals.computerId, computerId), isNull(billingUsageIntervals.endedAt)));
        },

        async insertStorageSample(userId, sample) {
            await db.insert(billingStorageSamples).values({ userId, ...sample });
        },

        async insertStorageSampleOnce(userId, sample) {
            return db.transaction(async tx => {
                // One writer per computer, then a fresh READ COMMITTED snapshot sees any committed twin.
                await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:storage_sample:${sample.computerId.toLowerCase()}`}, 0))`);
                const [twin] = await tx.select({ id: billingStorageSamples.id }).from(billingStorageSamples).where(and(
                    eq(billingStorageSamples.computerId, sample.computerId),
                    eq(billingStorageSamples.measuredAt, sample.measuredAt),
                    eq(billingStorageSamples.source, sample.source),
                )).limit(1);
                if (twin) return 'duplicate' as const;
                await tx.insert(billingStorageSamples).values({ userId, ...sample });
                return 'recorded' as const;
            });
        },

        async closeStaleIntervals(staleBefore, reason) {
            const closed = await db.update(billingUsageIntervals).set({
                endedAt: billingUsageIntervals.lastSeenAt,
                closeReason: reason,
            }).where(and(
                isNull(billingUsageIntervals.endedAt),
                lt(billingUsageIntervals.lastSeenAt, staleBefore),
            )).returning({ id: billingUsageIntervals.id });
            return closed.length;
        },
    };
    return store;
}

/** Round 6 R1-01: one held-bound candidate (store.ts `runningAwsComputersAfterEpochs`). */
export interface HeldCandidate {
    userId: string;
    computerId: string;
    /** RUNNING (stoppable), or UNCONFIRMED (a failed stop or boot: reported, never stopped from here). */
    state: 'RUNNING' | 'UNCONFIRMED';
    /** The placement row's last write: never before it entered `state`, but a lease renewal moves it later. */
    since: Date;
    /** When the computer's newest compute epoch closed. */
    closedAt: Date;
    /** Its host stopped after that close (a usage row closed since): what runs now is a later open with no epoch. */
    stoppedSinceClose: boolean;
}

/**
 * Round 6 R1-01: one page of the billing sweep's held-bound input, `after` a cursor from the previous page (null =
 * the first). The computers with an aws-ec2 placement (placement.ts `noNonCloudflarePlacement`, applied before the
 * LIMIT: a Cloudflare computer never fills a page) whose newest compute epoch is closed, newest close first, at any
 * age; each read through the placement module (the one reader of the placement tables, C-2). Kept: RUNNING with no
 * lifecycle, migration or image job in flight, and UNCONFIRMED; same owner. An open epoch is the policy pass's; a
 * re-open whose epoch failed to open still has its last session's. A computer that never had an epoch is not seen:
 * that needs a placement-side lister (placement.ts). Needs the placement table: the caller gates on placement reads.
 */
export async function runningAwsComputersAfterEpochs(db: Database, after: string | null, limit: number):
    Promise<{ candidates: HeldCandidate[]; next: string | null }> {
    const bounded = Math.max(0, Math.min(200, Math.floor(limit)));
    if (bounded === 0) return { candidates: [], next: null };
    const placements = db as unknown as PlacementExecutor;
    // The cursor is the last row's (ended_at as Postgres text, computer_id): exact, whatever the stored precision.
    const cursor = after === null ? null : /^(.+)\|([0-9a-f-]{36})$/.exec(after);
    if (after !== null && !cursor) throw new Error('held cursor invalid');
    const result = await db.execute(sql`/* billing:held-candidates */ SELECT computer_id::text AS computer_id, user_id::text AS user_id,
            extract(epoch FROM ended_at)::text AS ended_epoch, ended_at::text AS ended_key
        FROM (SELECT DISTINCT ON (computer_id) computer_id, user_id, ended_at
            FROM ${billingComputeEpochs}
            ORDER BY computer_id, ready_at DESC, id DESC) newest
        WHERE ended_at IS NOT NULL AND NOT ${noNonCloudflarePlacement(sql`newest.computer_id`)}
            ${cursor ? sql`AND (ended_at, computer_id) < (${cursor[1]}::timestamptz, ${cursor[2]}::uuid)` : sql``}
        ORDER BY ended_at DESC, computer_id DESC
        LIMIT ${bounded}`);
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
    const candidates: HeldCandidate[] = [];
    for (const row of rows) {
        let record;
        try {
            ({ record } = await readPlacement(placements, String(row.computer_id)));
        } catch (error) {
            // A duplicate or corrupt row, or an image job holding it: never this pass's to stop.
            if (error instanceof PlacementIntegrityError || error instanceof ImageJobConflictError) continue;
            throw error;
        }
        if (!record || record.provider !== 'aws-ec2' || record.lastError?.startsWith('migration_pending:')
            || record.ownerUserId !== String(row.user_id).toLowerCase()) continue;
        const running = record.state === 'RUNNING' && record.lifecycleJobId === null;
        if (!running && record.state !== 'UNCONFIRMED') continue;
        const closedAt = new Date(Math.round(Number(row.ended_epoch) * 1000));
        // A usage row closes only when its host stops (or is replaced); a lease renewal never moves it.
        const lastStop = running ? await readLastUsageStop(placements, record.computerId, record.ownerUserId) : null;
        candidates.push({ userId: record.ownerUserId, computerId: record.computerId, state: running ? 'RUNNING' : 'UNCONFIRMED',
            since: record.updatedAt, closedAt, stoppedSinceClose: lastStop !== null && lastStop.getTime() >= closedAt.getTime() });
    }
    const last = rows.at(-1);
    return { candidates, next: rows.length === bounded && last ? `${String(last.ended_key)}|${String(last.computer_id)}` : null };
}

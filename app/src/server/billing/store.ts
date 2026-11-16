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
    billingUsageIntervals,
} from '@/server/db/schema/billing';
import { computers } from '@/server/db/schema/computers';
import type { BillingStore, GrantKind, GrantMeter, GrantSource, GrantRow, OutboxInsert, StoredComputeEpoch } from './ports';
import { SESSION_MAX_SECONDS, SIZES } from './v2/contract';
import { epochSeconds, isoSeconds } from './v2/time';
import { AI_CREDIT_PROTOCOL, planAiReversal, type AiReversalStore, type AiTopupReceiptStore } from './ai-credits';

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
export function createBillingStore(db: Database): BillingStore {
    const store: BillingStore & AiTopupReceiptStore & AiReversalStore = {
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

        async closeEpoch({ computerId, endedAt, reason, overheadSeconds }) {
            const ended = isoSeconds(epochSeconds(endedAt));
            const rows = await db.update(billingComputeEpochs).set({
                endedAt: sql`greatest(${billingComputeEpochs.readyAt}, ${ended}::timestamptz)`,
                endReason: reason,
                overheadSeconds,
            }).where(and(
                eq(billingComputeEpochs.computerId, computerId), isNull(billingComputeEpochs.endedAt),
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

        async subscriptionsFor(userId) {
            return db.select({
                stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
                status: billingSubscriptions.status,
                sku: billingSubscriptions.sku,
                currentPeriodStart: billingSubscriptions.currentPeriodStart,
                currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
                cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
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
                // Ownership is fixed by the first insert, even when a newer event arrives.
                set: {
                    status: sql`excluded.status`,
                    sku: sql`excluded.sku`,
                    currentPeriodStart: sql`excluded.current_period_start`,
                    currentPeriodEnd: sql`excluded.current_period_end`,
                    cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
                    stripeEventCreated: sql`excluded.stripe_event_created`,
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

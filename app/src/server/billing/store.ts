import { and, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

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
import type { BillingStore, GrantKind, GrantMeter, GrantSource } from './ports';
import { SIZES, type ComputeEpoch } from './v2/contract';
import { epochSeconds, isoSeconds } from './v2/time';

type Database = typeof import('@/server/db').db;

const openChangeStates = ['pending', 'requires_action', 'payment_failed', 'scheduled'] as const;

function computeEpoch(row: BillingComputeEpochRow): ComputeEpoch {
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
    };
}

/**
 * The caller owns the connection; importing billing must never initialize the
 * application's database or require its environment. Conflict guards live in
 * SQL so concurrent deliveries obey the same rules as sequential retries.
 */
export function createBillingStore(db: Database): BillingStore {
    return {
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
            // A concurrent close can remove the conflicting open row between the
            // insert and select. Retry then, without changing any existing epoch.
            for (;;) {
                const [inserted] = await db.insert(billingComputeEpochs).values({
                    ...input, readyAt, weight: SIZES[input.size].weight,
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
            }
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

        async latestConsent(userId, subscriptionId) {
            const [row] = await db.select().from(billingOverageConsents).where(and(
                eq(billingOverageConsents.userId, userId),
                eq(billingOverageConsents.subscriptionId, subscriptionId),
            )).orderBy(desc(billingOverageConsents.id)).limit(1);
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

        async setPlanChangeState({ subscriptionId, kind, state, stripeInvoiceId, effectiveAt }) {
            await db.update(billingPlanChanges).set({ state, stripeInvoiceId, effectiveAt, updatedAt: sql`now()` })
                .where(and(
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
                setWhere: sql`excluded.stripe_event_created >= ${billingSubscriptions.stripeEventCreated}`,
            }).returning({ id: billingSubscriptions.stripeSubscriptionId });
            return written.length > 0 ? 'applied' : 'stale';
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
}

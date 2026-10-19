import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    check,
    foreignKey,
    integer,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    unique,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';

import type { EpochEndReason, SizeCode, SizeWeight } from '@/server/billing/v2/contract';

import { authUsers } from './auth-users';
import { computers } from './computers';

/**
 * Billing ownership comes from this mapping, never from webhook metadata.
 * Stripe customer ids are unique so a customer cannot fund two OS users.
 */
export const billingCustomers = pgTable(
    'ezil_billing_customers',
    {
        userId: uuid('user_id').primaryKey(),
        stripeCustomerId: text('stripe_customer_id').notNull().unique(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        foreignKey({
            name: 'ezil_billing_customers_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

/**
 * Keep Stripe's event time beside the state so the processor can refuse an
 * older event without losing a newer subscription period or cancellation.
 */
export const billingSubscriptions = pgTable(
    'ezil_billing_subscriptions',
    {
        stripeSubscriptionId: text('stripe_subscription_id').primaryKey(),
        userId: uuid('user_id').notNull(),
        status: text('status').notNull(),
        sku: text('sku').notNull(),
        currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
        currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
        cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
        stripeEventCreated: timestamp('stripe_event_created', { withTimezone: true }).notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        foreignKey({
            name: 'ezil_billing_subscriptions_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

/**
 * The inbox accepts verified events before processing resolves a customer.
 * Its user FK is therefore nullable; unrelated events still need a durable
 * receipt, and the event id makes retries safe to acknowledge.
 */
export const billingEvents = pgTable(
    'ezil_billing_events',
    {
        eventId: text('event_id').primaryKey(),
        userId: uuid('user_id'),
        type: text('type').notNull(),
        livemode: boolean('livemode').notNull(),
        payloadSha256: text('payload_sha256').notNull(),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        processedAt: timestamp('processed_at', { withTimezone: true }),
        outcome: text('outcome'),
    },
    (table) => [
        foreignKey({
            name: 'ezil_billing_events_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

/**
 * Corrections are new grants, including negative revoke/suspend amounts.
 * Migration 0003 refuses UPDATE, DELETE and TRUNCATE even for the service
 * role; uniqueness here makes a replayed funding event a no-op.
 */
export const billingGrants = pgTable(
    'ezil_billing_grants',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        meter: text('meter').notNull(),
        kind: text('kind').notNull(),
        amount: bigint('amount', { mode: 'bigint' }).notNull(),
        periodStart: timestamp('period_start', { withTimezone: true }),
        periodEnd: timestamp('period_end', { withTimezone: true }),
        sourceType: text('source_type').notNull(),
        sourceId: text('source_id').notNull(),
        subscriptionId: text('subscription_id'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_grants_meter_chk', sql`${table.meter} in ('workspace_seconds', 'ai_usd_micro', 'compute_std_seconds')`),
        check('ezil_billing_grants_kind_chk', sql`${table.kind} in ('pro_period', 'topup', 'revoke', 'suspend', 'restore', 'plan_period', 'upgrade_prorated')`),
        check('ezil_billing_grants_source_type_chk', sql`${table.sourceType} in ('invoice', 'payment_intent', 'refund', 'dispute')`),
        uniqueIndex('ezil_billing_grants_plan_period_uidx')
            .on(table.subscriptionId, table.periodStart, table.meter)
            .where(sql`${table.kind} = 'plan_period'`),
        unique('ezil_billing_grants_source_meter_kind_unique')
            .on(table.sourceType, table.sourceId, table.meter, table.kind),
        foreignKey({
            name: 'ezil_billing_grants_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

/**
 * The partial index serializes concurrent starts for the same computer,
 * while closed intervals remain available for each billing window.
 */
export const billingUsageIntervals = pgTable(
    'ezil_billing_usage_intervals',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
        endedAt: timestamp('ended_at', { withTimezone: true }),
        closeReason: text('close_reason'),
        source: text('source').notNull(),
    },
    (table) => [
        uniqueIndex('ezil_billing_usage_intervals_open_computer_uidx')
            .on(table.computerId)
            .where(sql`${table.endedAt} is null`),
        foreignKey({
            name: 'ezil_billing_usage_intervals_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
        foreignKey({
            name: 'ezil_billing_usage_intervals_computer_id_fkey',
            columns: [table.computerId],
            foreignColumns: [computers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

/**
 * Samples outlive computer deletion until storage is purged, so computerId
 * deliberately has no cascading computer FK. New samples replace the meter's
 * latest observation without rewriting the append-only history.
 */
export const billingStorageSamples = pgTable(
    'ezil_billing_storage_samples',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
        measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
        source: text('source').notNull(),
    },
    (table) => [
        check('ezil_billing_storage_samples_bytes_chk', sql`${table.bytes} >= 0`),
        foreignKey({
            name: 'ezil_billing_storage_samples_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

/**
 * AI grants wait here until Gateway delivery is enabled. A stable event key
 * prevents retries from queuing the same grant more than once.
 */
export const billingOutbox = pgTable(
    'ezil_billing_outbox',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        eventKey: text('event_key').notNull().unique(),
        userId: uuid('user_id').notNull(),
        kind: text('kind').notNull(),
        payload: jsonb('payload').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        deliveredAt: timestamp('delivered_at', { withTimezone: true }),
        attempts: integer('attempts').notNull().default(0),
        lastError: text('last_error'),
    },
    (table) => [
        foreignKey({
            name: 'ezil_billing_outbox_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

export type BillingCustomerRow = typeof billingCustomers.$inferSelect;
export type BillingSubscriptionRow = typeof billingSubscriptions.$inferSelect;
export type BillingEventRow = typeof billingEvents.$inferSelect;
export type BillingGrantRow = typeof billingGrants.$inferSelect;
export type BillingUsageIntervalRow = typeof billingUsageIntervals.$inferSelect;
export type BillingStorageSampleRow = typeof billingStorageSamples.$inferSelect;
export type BillingOutboxRow = typeof billingOutbox.$inferSelect;

/** A size-stable, whole-second interval from resource readiness to verified stop. */
export const billingComputeEpochs = pgTable(
    'ezil_billing_compute_epochs',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        subscriptionId: text('subscription_id'),
        size: text('size').$type<SizeCode>().notNull(),
        weight: integer('weight').$type<SizeWeight>().notNull(),
        readyAt: timestamp('ready_at', { withTimezone: true }).notNull(),
        deadlineAt: timestamp('deadline_at', { withTimezone: true }),
        lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
        endedAt: timestamp('ended_at', { withTimezone: true }),
        endReason: text('end_reason').$type<EpochEndReason>(),
        overheadSeconds: integer('overhead_seconds').notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_compute_epochs_size_chk', sql`${table.size} in ('free-cf', 'std-2', 'cmp-4', 'cmp-8')`),
        check('ezil_billing_compute_epochs_weight_chk', sql`(${table.size} in ('free-cf', 'std-2') and ${table.weight} = 1) or (${table.size} = 'cmp-4' and ${table.weight} = 2) or (${table.size} = 'cmp-8' and ${table.weight} = 4)`),
        check('ezil_billing_compute_epochs_end_reason_chk', sql`${table.endReason} is null or ${table.endReason} in ('user_stop', 'idle_sleep', 'session_max', 'allowance_exhausted', 'overage_cap', 'payment_issue', 'resize', 'provider_stop', 'platform_failure')`),
        check('ezil_billing_compute_epochs_end_pair_chk', sql`(${table.endedAt} is null) = (${table.endReason} is null)`),
        check('ezil_billing_compute_epochs_ended_at_chk', sql`${table.endedAt} is null or ${table.endedAt} >= ${table.readyAt}`),
        check('ezil_billing_compute_epochs_overhead_seconds_chk', sql`${table.overheadSeconds} >= 0`),
        check('ezil_billing_compute_epochs_deadline_at_chk', sql`${table.deadlineAt} is null or (${table.deadlineAt} >= ${table.readyAt} and ${table.deadlineAt} <= ${table.readyAt} + interval '21600 seconds')`),
        check('ezil_billing_compute_epochs_last_heartbeat_at_chk', sql`${table.lastHeartbeatAt} is null or ${table.lastHeartbeatAt} >= ${table.readyAt}`),
        uniqueIndex('ezil_billing_compute_epochs_open_computer_uidx')
            .on(table.computerId)
            .where(sql`${table.endedAt} is null`),
        index('ezil_billing_compute_epochs_open_deadline_idx')
            .on(table.deadlineAt)
            .where(sql`${table.endedAt} is null`),
        foreignKey({
            name: 'ezil_billing_compute_epochs_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        }).onDelete('cascade').onUpdate('cascade'),
        foreignKey({
            name: 'ezil_billing_compute_epochs_computer_id_fkey',
            columns: [table.computerId],
            foreignColumns: [computers.id],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

/** Append-only decisions; identity order, not client timestamps, selects the latest. */
export const billingOverageConsents = pgTable(
    'ezil_billing_overage_consents',
    {
        id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
        userId: uuid('user_id').notNull(),
        subscriptionId: text('subscription_id').notNull(),
        enabled: boolean('enabled').notNull(),
        capCents: integer('cap_cents').notNull(),
        termsVersion: text('terms_version').notNull(),
        catalogVersion: integer('catalog_version').notNull(),
        rateCentsPerStdHour: integer('rate_cents_per_std_hour').notNull(),
        actor: text('actor').notNull(),
        acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        unique('ezil_billing_overage_consents_decision_unique')
            .on(table.userId, table.subscriptionId, table.acceptedAt, table.enabled, table.capCents,
                table.termsVersion, table.catalogVersion, table.rateCentsPerStdHour, table.actor),
        check('ezil_billing_overage_consents_cap_cents_chk', sql`${table.capCents} between 0 and 10000`),
        check('ezil_billing_overage_consents_rate_chk', sql`${table.rateCentsPerStdHour} > 0`),
        foreignKey({
            name: 'ezil_billing_overage_consents_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

export const billingOverageInvoices = pgTable(
    'ezil_billing_overage_invoices',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        subscriptionId: text('subscription_id').notNull(),
        periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
        periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
        ratingVersion: integer('rating_version').notNull(),
        stdSecondsOver: bigint('std_seconds_over', { mode: 'bigint' }).notNull(),
        cents: integer('cents').notNull(),
        stripeInvoiceId: text('stripe_invoice_id').unique(),
        status: text('status', { enum: ['pending', 'open', 'paid', 'payment_failed', 'requires_action', 'void', 'uncollectible'] }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_overage_invoices_std_seconds_over_chk', sql`${table.stdSecondsOver} >= 0`),
        check('ezil_billing_overage_invoices_cents_chk', sql`${table.cents} >= 0`),
        check('ezil_billing_overage_invoices_status_chk', sql`${table.status} in ('pending', 'open', 'paid', 'payment_failed', 'requires_action', 'void', 'uncollectible')`),
        unique('ezil_billing_overage_invoices_period_rating_unique')
            .on(table.subscriptionId, table.periodStart, table.ratingVersion),
        foreignKey({
            name: 'ezil_billing_overage_invoices_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

export const billingPlanChanges = pgTable(
    'ezil_billing_plan_changes',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        subscriptionId: text('subscription_id').notNull(),
        kind: text('kind', { enum: ['upgrade', 'downgrade', 'cancel'] }).notNull(),
        fromSku: text('from_sku').notNull(),
        toSku: text('to_sku'),
        stripeInvoiceId: text('stripe_invoice_id'),
        stripeScheduleId: text('stripe_schedule_id'),
        hostedInvoiceUrl: text('hosted_invoice_url'),
        state: text('state', { enum: ['pending', 'requires_action', 'payment_failed', 'scheduled', 'applied', 'expired', 'canceled'] }).notNull(),
        effectiveAt: timestamp('effective_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_plan_changes_kind_chk', sql`${table.kind} in ('upgrade', 'downgrade', 'cancel')`),
        check('ezil_billing_plan_changes_state_chk', sql`${table.state} in ('pending', 'requires_action', 'payment_failed', 'scheduled', 'applied', 'expired', 'canceled')`),
        uniqueIndex('ezil_billing_plan_changes_open_kind_uidx')
            .on(table.subscriptionId, table.kind)
            .where(sql`${table.state} in ('pending', 'requires_action', 'payment_failed', 'scheduled')`),
        foreignKey({
            name: 'ezil_billing_plan_changes_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

export const billingSizePreferences = pgTable(
    'ezil_billing_size_preferences',
    {
        userId: uuid('user_id').primaryKey(),
        size: text('size').$type<SizeCode>().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_size_preferences_size_chk', sql`${table.size} in ('free-cf', 'std-2', 'cmp-4', 'cmp-8')`),
        foreignKey({
            name: 'ezil_billing_size_preferences_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

export const billingPaymentIssues = pgTable(
    'ezil_billing_payment_issues',
    {
        stripeInvoiceId: text('stripe_invoice_id').primaryKey(),
        userId: uuid('user_id').notNull(),
        subscriptionId: text('subscription_id'),
        invoiceKind: text('invoice_kind', { enum: ['subscription', 'upgrade', 'overage'] }).notNull(),
        issue: text('issue', { enum: ['payment_failed', 'requires_action', 'voided', 'uncollectible'] }).notNull(),
        hostedInvoiceUrl: text('hosted_invoice_url'),
        stripeEventCreated: timestamp('stripe_event_created', { withTimezone: true }).notNull(),
        resolvedAt: timestamp('resolved_at', { withTimezone: true }),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_payment_issues_invoice_kind_chk', sql`${table.invoiceKind} in ('subscription', 'upgrade', 'overage')`),
        check('ezil_billing_payment_issues_issue_chk', sql`${table.issue} in ('payment_failed', 'requires_action', 'voided', 'uncollectible')`),
        foreignKey({
            name: 'ezil_billing_payment_issues_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        }).onDelete('cascade').onUpdate('cascade'),
    ],
).enableRLS();

export type BillingComputeEpochRow = typeof billingComputeEpochs.$inferSelect;
export type BillingOverageConsentRow = typeof billingOverageConsents.$inferSelect;
export type BillingOverageInvoiceRow = typeof billingOverageInvoices.$inferSelect;
export type BillingPlanChangeRow = typeof billingPlanChanges.$inferSelect;
export type BillingSizePreferenceRow = typeof billingSizePreferences.$inferSelect;
export type BillingPaymentIssueRow = typeof billingPaymentIssues.$inferSelect;

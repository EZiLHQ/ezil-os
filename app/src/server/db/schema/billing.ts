import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    check,
    foreignKey,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    unique,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';

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
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('ezil_billing_grants_meter_chk', sql`${table.meter} in ('workspace_seconds', 'ai_usd_micro')`),
        check('ezil_billing_grants_kind_chk', sql`${table.kind} in ('pro_period', 'topup', 'revoke', 'suspend', 'restore')`),
        check('ezil_billing_grants_source_type_chk', sql`${table.sourceType} in ('invoice', 'payment_intent', 'refund', 'dispute')`),
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

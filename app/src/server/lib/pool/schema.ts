import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// Kept in the pool's owned directory; include this export in future schema generation.
export const poolSlots = pgTable('ezil_pool_slots', {
    id: uuid('id').primaryKey().defaultRandom(),
    shape: text('shape').notNull(),
    sandboxId: text('sandbox_id').notNull().unique(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    leasedAt: timestamp('leased_at', { withTimezone: true }),
    leaseId: uuid('lease_id').unique(),
    leasedToUserId: uuid('leased_to_user_id'),
    leasedComputerId: uuid('leased_computer_id'),
    lastError: text('last_error'),
}, (t) => [
    check('ezil_pool_slots_state_check', sql`${t.state} in ('warming','ready','leased','draining','destroyed')`),
    check('ezil_pool_slots_shape_check', sql`${t.shape} in ('standard','performance')`),
    uniqueIndex('ezil_pool_slots_live_user_idx').on(t.leasedToUserId).where(sql`${t.state} = 'leased'`),
    uniqueIndex('ezil_pool_slots_live_computer_idx').on(t.leasedComputerId).where(sql`${t.state} = 'leased'`),
    index('ezil_pool_slots_ready_idx').on(t.shape, t.readyAt).where(sql`${t.state} = 'ready'`),
]).enableRLS();

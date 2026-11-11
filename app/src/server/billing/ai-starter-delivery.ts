import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';

import { aiFreeStarterEventKey } from './ai-credits';
import { createAiCreditOutboxStore } from './ai-credit-outbox-store';
import { drainAiCreditOutbox } from './ai-credit-outbox';

/** The Gateway request budget of the sign-in attempt (the sweep keeps its 10 s). */
export const AI_STARTER_REQUEST_MS = 2_000;
/** The drain admits a claim only with the request plus 1 s left; this adds 0.25 s for the claim itself, so an admitted attempt is not deferred mid-way. */
export const AI_STARTER_ADMISSION_MS = AI_STARTER_REQUEST_MS + 1_000 + 250;

export type AiStarterDelivery = 'delivered' | 'queued' | 'skipped';

/**
 * One bounded attempt, at sign-in before the OS session exists, to deliver the Free starter grant that
 * `enrollStagingAiMember` just committed, so Code usually opens on the credits. It is the normal outbox delivery
 * (the same atomic SKIP LOCKED claim with its 30 s lease, account pin and finish fences, the same HMAC event and
 * idempotent `eventId`) scoped to that one grant event for this user, over the enrollment's own owned PostgreSQL
 * client: no shared pool, no global drain, and the client's socket deadline bounds the database work as well.
 *
 * Call it only after the Free receipt's transaction has committed (the role reset); wrapping the client with drizzle
 * replaces its json serializers, which the receipt insert must not see.
 *
 * - `skipped`: under 3.25 s left, so nothing was claimed and no attempt or lease was used; the sweep delivers.
 * - `delivered`: the Gateway acknowledged and the row is finished.
 * - `queued`: anything else. If the socket was cut after the claim, the row stays `processing` with its attempt
 *   counted until the lease expires (30 s); the sweep then resends the same `eventId`, which the Gateway applies once.
 *
 * Never throws; a caller must not treat any outcome as an enrollment failure.
 */
export async function deliverStarterCredits(input: {
    client: postgres.Sql; userId: string; deadlineAt: number;
    config: { fundingUrl?: string | null; fundingHmacSecret?: string | null };
    fetch?: typeof fetch; clock?: () => number;
}): Promise<AiStarterDelivery> {
    const clock = input.clock ?? Date.now;
    try {
        if (!input.config.fundingUrl || !input.config.fundingHmacSecret) return 'skipped';
        if (input.deadlineAt - clock() < AI_STARTER_ADMISSION_MS) return 'skipped';
        const aiCredits = createAiCreditOutboxStore(drizzle(input.client) as unknown as Parameters<typeof createAiCreditOutboxStore>[0]);
        const counts = await drainAiCreditOutbox({ config: { fundingUrl: input.config.fundingUrl, fundingHmacSecret: input.config.fundingHmacSecret },
            aiCredits, clock, fetch: input.fetch, log: () => {} },
        { limit: 1, deadlineMs: input.deadlineAt, requestTimeoutMs: AI_STARTER_REQUEST_MS,
            scope: { userId: input.userId, eventKey: aiFreeStarterEventKey(input.userId), kind: 'ai_grant' } });
        return counts.done === 1 ? 'delivered' : 'queued';
    } catch {
        return 'queued';
    }
}

import type { BillingConfig } from './config';
import { AI_CREDIT_PROTOCOL } from './ai-credits';
import { AI_GATEWAY_TIMEOUT_MS, sendAiCreditEvent, type AiGatewayEvent, type AiLogger } from './ai-gateway-client';

export const AI_CREDIT_MAX_ATTEMPTS = 10;
export const AI_CREDIT_LEASE_MS = 30_000;
export interface AiCreditOutboxRow {
    id: string; eventKey: string; userId: string; kind: string; payload: Record<string, unknown>; attempts: number; exhausted?: boolean;
}
export interface AiCreditDelivery {
    status: 'done' | 'failed' | 'retry'; reason: string | null; nextAttemptAt?: number;
}
export interface AiCreditOutboxStore {
    claim(now: number): Promise<AiCreditOutboxRow | null>;
    accountFor(row: AiCreditOutboxRow): Promise<string | null>;
    pinAccount(row: AiCreditOutboxRow, accountPublicId: string): Promise<boolean>;
    finish(row: AiCreditOutboxRow, result: AiCreditDelivery, now: number): Promise<void>;
}
export const aiCreditBackoffMs = (attempt: number) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));

function plannedEvent(row: AiCreditOutboxRow): Omit<AiGatewayEvent, 'accountPublicId'> | null {
    const p = row.payload;
    if (p.protocol !== AI_CREDIT_PROTOCOL || typeof p.entitlementId !== 'string'
        || !/^ezil-os:v1:[A-Za-z0-9._:-]+$/.test(p.entitlementId) || p.entitlementId.length > 193
        || (p.action !== 'grant' && p.action !== 'revoke') || row.kind !== `ai_${p.action}`
        || p.eventId !== `${p.entitlementId}:${p.action}` || row.eventKey !== p.eventId
        || typeof p.credits !== 'number' || !Number.isSafeInteger(p.credits) || p.credits < 1 || p.credits > 1_000_000
        || typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt))) return null;
    return { eventId: p.eventId, entitlementId: p.entitlementId, action: p.action, credits: p.credits, expiresAt: p.expiresAt };
}

let warnedDisabled = false;
/** deadlineMs is an absolute wall-clock deadline shared with the session sweep. */
export async function drainAiCreditOutbox(deps: {
    config: Pick<BillingConfig, 'fundingUrl' | 'fundingHmacSecret'>;
    aiCredits?: AiCreditOutboxStore; clock?: () => number; fetch?: typeof fetch; log?: AiLogger;
}, { limit, deadlineMs }: { limit: number; deadlineMs: number }) {
    const counts = { claimed: 0, done: 0, failed: 0, retry: 0, skipped: 0 };
    const log = deps.log ?? console.warn;
    if (!deps.config.fundingUrl || !deps.config.fundingHmacSecret) {
        if (!warnedDisabled) { warnedDisabled = true; log('[billing.ai] funding disabled'); }
        return counts;
    }
    const store = deps.aiCredits;
    if (!store) return counts;
    const clock = deps.clock ?? Date.now;
    const hasTime = () => deadlineMs - clock() >= AI_GATEWAY_TIMEOUT_MS + 1_000;
    for (let i = 0; i < Math.min(200, Math.max(0, Math.floor(limit))); i++) {
        if (!hasTime()) break;
        const row = await store.claim(clock());
        if (!row) break;
        counts.claimed++;
        let result: AiCreditDelivery;
        const event = plannedEvent(row);
        if (row.exhausted) result = { status: 'failed', reason: 'attempts_exhausted' };
        else if (!event) result = { status: 'failed', reason: 'invalid_payload' };
        else if (event.action === 'grant' && Date.parse(event.expiresAt) <= clock()) result = { status: 'failed', reason: 'expired' };
        else {
            try {
                const account = typeof row.payload.accountPublicId === 'string' ? row.payload.accountPublicId : await store.accountFor(row);
                if (!account) {
                    result = { status: 'failed', reason: 'no_ai_account' };
                    counts.skipped++;
                } else if (!hasTime() || !await store.pinAccount(row, account) || !hasTime()) {
                    result = { status: 'retry', reason: 'deadline_or_lease' };
                } else {
                    const sent = await sendAiCreditEvent({ url: deps.config.fundingUrl, secret: deps.config.fundingHmacSecret,
                        event: { ...event, accountPublicId: account }, fetch: deps.fetch, now: clock, log });
                    result = sent.status === 'ok' ? { status: 'done', reason: null }
                        : { status: sent.status === 'retryable' ? 'retry' : 'failed', reason: sent.reason };
                }
            } catch {
                // SQL/transport errors may contain URLs, credentials or tokens. Store only a fixed code.
                result = { status: 'retry', reason: 'delivery_unavailable' };
            }
        }
        if (result.status === 'retry') {
            if (row.attempts >= AI_CREDIT_MAX_ATTEMPTS) result = { status: 'failed', reason: 'attempts_exhausted' };
            else result.nextAttemptAt = clock() + aiCreditBackoffMs(row.attempts);
        }
        await store.finish(row, result, clock());
        counts[result.status]++;
    }
    return counts;
}

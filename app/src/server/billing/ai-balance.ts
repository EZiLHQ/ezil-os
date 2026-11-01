import type { BillingStore } from './ports';
import type { BillingSummaryV3 } from './v3/contract';
import { aiCreditEntitlement, aiCreditOutboxItem } from './ai-credits';
import { createAiReader, creditNumber, isoTimestamp, microString, record, type AiReadInput } from './ai-read';
import { readAiUsage, type AiUsagePage } from './ai-usage';
import { readAiLimits, type AiLimits } from './ai-limits';

/** Account/global pause status, not a promise that a particular model request will be admitted. */
export type AiSpendingState = 'available' | 'paused_operations' | 'paused_reconciliation' | 'paused_policy' | 'unavailable';
export interface AiAccountView {
    balanceMicro: string | null;
    heldMicro: string | null;
    balance: number | null;
    balanceState: BillingSummaryV3['ai']['state'];
    spendingState: AiSpendingState;
    recentUsage: AiUsagePage | null;
    limits: AiLimits | null;
    usageState: 'available' | 'unavailable';
    limitsState: 'available' | 'unavailable';
}
export type BillingSummaryWithAi = BillingSummaryV3 & { ai: BillingSummaryV3['ai'] & AiAccountView };

export function parseAiBalanceMicro(body: unknown): string | null {
    const value = record(body);
    if (!value) return null;
    if ('available_micro' in value) return microString(value.available_micro);
    // Retain the older credit-number response without rounding fractions to whole credits.
    const credits = value.credits;
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0 || credits > Number.MAX_SAFE_INTEGER) return null;
    const decimal = credits.toFixed(6);
    return Number(decimal) === credits ? BigInt(decimal.replace('.', '')).toString() : null;
}

/**
 * One Gateway grant from `/v1/me/balance` `grants[]` (it carries no entitlement id; see `aiCreditBuckets`).
 * `source` 'admin' = an operator grant (never an OS receipt). `revokedAt` 'unknown' = revoked at an unreadable time.
 */
export interface AiGatewayGrant {
    creditsMicro: string; remainingMicro: string; expiresAt: string; live: boolean;
    source?: 'admin' | 'entitlement' | null; revokedAt?: string | 'unknown' | null;
}

/** The whole list or null: a partly readable list must not split the balance into wrong buckets. */
export function parseAiGrants(body: unknown): AiGatewayGrant[] | null {
    const list = record(body)?.grants;
    if (!Array.isArray(list) || list.length > 1_000) return null;
    const grants: AiGatewayGrant[] = [];
    for (const item of list) {
        const g = record(item);
        const creditsMicro = microString(g?.credits_micro), remainingMicro = microString(g?.remaining_micro);
        const expiresAt = isoTimestamp(g?.expires_at);
        if (!g || creditsMicro === null || remainingMicro === null || expiresAt === null || typeof g.live !== 'boolean') return null;
        grants.push({ creditsMicro, remainingMicro, expiresAt, live: g.live && g.revoked_at == null,
            source: g.source === 'admin' || g.source === 'entitlement' ? g.source : null,
            revokedAt: g.revoked_at == null ? null : isoTimestamp(g.revoked_at) ?? 'unknown' });
    }
    return grants;
}

/** An open (reserved or pending) request on the member's usage page: when it reserved, and its hold. */
export interface AiOpenHold { at: string; heldMicro: string }

/**
 * Evidence for `usedMicro` (summary.ts): the open requests on the usage page, or null when the page is
 * unreadable, an open row's hold is unreadable, or one was platform-absorbed (0021 releases its hold on
 * the ledger but `balance()` still counts it in `held_micro`).
 */
export function parseAiOpenHolds(body: unknown): AiOpenHold[] | null {
    const data = record(body);
    if (data?.object !== 'list' || !Array.isArray(data.data)) return null;
    const open: AiOpenHold[] = [];
    for (const value of data.data) {
        const row = record(value);
        if (row?.status !== 'reserved' && row?.status !== 'pending') continue;
        const at = isoTimestamp(row.created_at), heldMicro = microString(row.hold_micro);
        if (at === null || heldMicro === null || (row.billing_resolution !== undefined && row.billing_resolution !== 'user')) return null;
        open.push({ at, heldMicro });
    }
    return open;
}

/** The Gateway's own balance state (`myBalance`), or null when absent or unknown. */
export function parseAiGatewayState(body: unknown): 'ok' | 'exhausted' | 'paused_operations' | 'paused_reconciliation' | null {
    const state = record(body)?.state;
    return state === 'ok' || state === 'exhausted' || state === 'paused_operations' || state === 'paused_reconciliation' ? state : null;
}

export function parseAiBalance(body: unknown): number | null {
    return creditNumber(parseAiBalanceMicro(body));
}

export function aiBalanceState(balance: number | null, grant: number): BillingSummaryV3['ai']['state'] {
    return balance === null ? 'unavailable' : balance === 0 ? 'exhausted' : balance <= grant * 0.1 ? 'low' : 'ok';
}

export function aiMicroBalanceState(micro: string | null, grant: number): BillingSummaryV3['ai']['state'] {
    if (micro === null) return 'unavailable';
    const balance = BigInt(micro);
    if (balance === BigInt(0)) return 'exhausted';
    return Number.isSafeInteger(grant) && grant > 0 && balance <= BigInt(grant) * BigInt(100_000) ? 'low' : 'ok';
}

/** Caller authentication remains exclusively in the normal Supabase tRPC context. */
export async function readAiBalance(input: AiReadInput): Promise<number | null> {
    return parseAiBalance(await createAiReader(input)('/v1/me/balance'));
}

function spendingState(balance: unknown, models: unknown, limits: AiLimits | null): AiSpendingState {
    const b = record(balance), m = record(models);
    if (m?.killswitch === true) {
        return m.pause === 'operations' ? 'paused_operations' : m.pause === 'reconciliation' ? 'paused_reconciliation' : 'unavailable';
    }
    if (b?.state === 'paused_operations' || b?.state === 'paused_reconciliation') return b.state;
    if (limits?.pauses?.some(p => ['user', 'account', 'role'].includes(p.scope))
        || (limits?.entitlement?.required === true && limits.entitlement.basis === null)) return 'paused_policy';
    // An exhausted balance response hides the global pause: /models reports it independently.
    const globalKnown = m?.killswitch === false || (b?.state === 'ok' && parseAiBalanceMicro(b) !== null);
    return parseAiBalanceMicro(b) !== null && globalKnown && limits?.pauses !== null && limits?.pauses !== undefined
        && limits.entitlement !== null && limits.policy !== null
        ? 'available' : 'unavailable';
}

/** Server-side input for the bucket split and `ai.account`; callers strip these before the wire. */
export interface AiAccountEvidence {
    gatewayGrants: AiGatewayGrant[] | null;
    openHolds: AiOpenHold[] | null;
    gatewayState: ReturnType<typeof parseAiGatewayState>;
}
export async function readAiAccount(input: AiReadInput): Promise<AiAccountView & AiAccountEvidence> {
    const read = createAiReader(input);
    // The same usage page feeds `recentUsage` and the open-hold evidence (one read).
    let usageBody: unknown = null;
    const [balanceBody, usage, limitsResult, models] = await Promise.all([
        read('/v1/me/balance'), readAiUsage(input, { limit: 20 }, async path => usageBody = await read(path)), readAiLimits(input, read), read('/v1/models'),
    ]);
    const balanceMicro = parseAiBalanceMicro(balanceBody);
    return { gatewayGrants: balanceMicro === null ? null : parseAiGrants(balanceBody),
        openHolds: usage.state === 'available' ? parseAiOpenHolds(usageBody) : null, gatewayState: parseAiGatewayState(balanceBody),
        balanceMicro, heldMicro: microString(record(balanceBody)?.held_micro), balance: creditNumber(balanceMicro),
        balanceState: aiMicroBalanceState(balanceMicro, 0), spendingState: spendingState(balanceBody, models, limitsResult.limits),
        recentUsage: usage.recentUsage, limits: limitsResult.limits, usageState: usage.state, limitsState: limitsResult.state };
}

export async function enqueueFreeAiCredits(store: Pick<BillingStore, 'enqueueOutbox'>, userId: string, sku: string, now: Date): Promise<void> {
    if (sku !== 'free_v3') return;
    try {
        const entitlement = aiCreditEntitlement({ userId, sku, subscriptionId: null, periodStart: now, periodEnd: null, invoiceId: null });
        // ON CONFLICT DO NOTHING preserves the first grant instant and expiry across summary reads.
        await store.enqueueOutbox(aiCreditOutboxItem(userId, entitlement, 'grant', null));
    } catch { console.warn('[billing.ai] free grant enqueue unavailable'); }
}

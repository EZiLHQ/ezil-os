import type { BillingStore } from './ports';
import type { BillingSummaryV3 } from './v3/contract';
import { aiCreditEntitlement, aiCreditOutboxItem } from './ai-credits';
import { createAiReader, creditNumber, microString, record, type AiReadInput } from './ai-read';
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

export async function readAiAccount(input: AiReadInput): Promise<AiAccountView> {
    const read = createAiReader(input);
    const [balanceBody, usage, limitsResult, models] = await Promise.all([
        read('/v1/me/balance'), readAiUsage(input, { limit: 20 }, read), readAiLimits(input, read), read('/v1/models'),
    ]);
    const balanceMicro = parseAiBalanceMicro(balanceBody);
    return { balanceMicro, heldMicro: microString(record(balanceBody)?.held_micro), balance: creditNumber(balanceMicro),
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

import type { BillingStore, GrantInsert, OutboxInsert } from './ports';
import type { CatalogPack } from './types';
import { aiPackCheckoutEligible } from './catalog';
import { AI_CREDIT_POLICY_VERSION, CATALOG_V3, type PlanSkuV3 } from './v3/contract';

const DAY = 86_400_000;
export const AI_CREDIT_PROTOCOL = 'ezil-ai-credits-v1';
export interface AiCreditEntitlement {
    entitlementId: string;
    credits: number;
    expiresAt: string;
}

/** Free's periodStart is the grant instant, supplied by the caller, never a wall clock read. */
export function aiCreditEntitlement(input: {
    userId: string; sku: PlanSkuV3; subscriptionId: string | null;
    periodStart: Date; periodEnd: Date | null; invoiceId: string | null;
}): AiCreditEntitlement {
    const policy = CATALOG_V3[input.sku].aiCredits;
    const start = input.periodStart.getTime();
    if (!input.userId || !Number.isFinite(start)) throw new TypeError('Invalid AI grant');
    if (policy.per === 'period' && (!input.subscriptionId || !input.invoiceId || !input.periodEnd
        || !Number.isFinite(input.periodEnd.getTime()) || input.periodEnd.getTime() <= start)) {
        throw new TypeError('Invalid AI period');
    }
    return {
        entitlementId: policy.per === 'once' ? `ezil-os:v${AI_CREDIT_POLICY_VERSION}:free-once:${input.userId}`
            : `ezil-os:v${AI_CREDIT_POLICY_VERSION}:${input.sku}:${input.subscriptionId}:${input.periodStart.toISOString()}`,
        credits: policy.amount,
        expiresAt: new Date(policy.per === 'once' ? start + 365 * DAY : input.periodEnd!.getTime() + 3 * DAY).toISOString(),
    };
}

export function aiCreditOutboxItem(userId: string, entitlement: AiCreditEntitlement, action: 'grant' | 'revoke', invoiceId: string | null): OutboxInsert {
    const eventId = `${entitlement.entitlementId}:${action}`;
    return { eventKey: eventId, userId, kind: action === 'grant' ? 'ai_grant' : 'ai_revoke', payload: {
        protocol: AI_CREDIT_PROTOCOL, policyVersion: AI_CREDIT_POLICY_VERSION, invoiceId,
        ...entitlement, eventId, action,
    } };
}

/** Only explicit whole-credit pack policy can create a deliverable top-up receipt. */
export function aiTopupOutboxItem(userId: string, pack: CatalogPack, paymentIntentId: string, expiresAt: Date): OutboxInsert | null {
    if (!aiPackCheckoutEligible(pack)) return null;
    const entitlementId = `ezil-os:v1:topup:${pack.sku}:${paymentIntentId}`;
    if (!userId || !/^ai_pack_[A-Za-z0-9_]+$/.test(pack.sku) || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)
        || entitlementId.length > 193 || !Number.isFinite(expiresAt.getTime())
        || !Number.isSafeInteger(pack.creditCents) || pack.creditCents < 1) throw new TypeError('Invalid AI topup');
    const item = aiCreditOutboxItem(userId, { entitlementId, credits: pack.aiCredits, expiresAt: expiresAt.toISOString() }, 'grant', null);
    return { ...item, payload: { ...item.payload, packSku: pack.sku, paymentIntentId,
        amountUsdMicro: (BigInt(pack.creditCents) * BigInt(10_000)).toString(),
        bucket: 'purchased', provider: 'stripe', providerObjectId: paymentIntentId } };
}

/** Local extension keeps the frozen shared billing ports unchanged. */
export interface AiTopupReceiptStore {
    aiTopupReceipt(userId: string, paymentIntentId: string): Promise<OutboxInsert | null>;
    /** Commit the first receipt and monetary ledger entry together; replays retain both. */
    recordAiTopup(grant: GrantInsert, receipt: OutboxInsert): Promise<'applied' | 'review:customer_mismatch' | 'review:legacy_topup_unfunded'>;
}

export function hasAiTopupReceipts(store: BillingStore): store is BillingStore & AiTopupReceiptStore {
    return 'aiTopupReceipt' in store && typeof store.aiTopupReceipt === 'function'
        && 'recordAiTopup' in store && typeof store.recordAiTopup === 'function';
}

/** Reverse the stored receipt, retaining its policy/amount if the catalog changes later. */
export function aiCreditRevokeItem(grant: OutboxInsert): OutboxInsert {
    const p = grant.payload;
    if (p.protocol !== AI_CREDIT_PROTOCOL || typeof p.entitlementId !== 'string' || typeof p.credits !== 'number'
        || typeof p.expiresAt !== 'string' || p.action !== 'grant') throw new TypeError('Invalid AI credit receipt');
    const eventId = `${p.entitlementId}:revoke`;
    return { userId: grant.userId, eventKey: eventId, kind: 'ai_revoke', payload: {
        protocol: p.protocol, policyVersion: p.policyVersion, invoiceId: p.invoiceId,
        entitlementId: p.entitlementId, credits: p.credits, expiresAt: p.expiresAt, eventId, action: 'revoke',
        ...(typeof p.paymentIntentId === 'string' ? { paymentIntentId: p.paymentIntentId, packSku: p.packSku } : {}),
        ...(typeof p.accountPublicId === 'string' ? { accountPublicId: p.accountPublicId } : {}),
    } };
}

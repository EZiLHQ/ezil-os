import type { OutboxInsert } from './ports';
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

/** Reverse the stored receipt, retaining its policy/amount if the catalog changes later. */
export function aiCreditRevokeItem(grant: OutboxInsert): OutboxInsert {
    const p = grant.payload;
    if (p.protocol !== AI_CREDIT_PROTOCOL || typeof p.entitlementId !== 'string' || typeof p.credits !== 'number'
        || typeof p.expiresAt !== 'string' || p.action !== 'grant') throw new TypeError('Invalid AI credit receipt');
    const eventId = `${p.entitlementId}:revoke`;
    return { userId: grant.userId, eventKey: eventId, kind: 'ai_revoke', payload: {
        protocol: p.protocol, policyVersion: p.policyVersion, invoiceId: p.invoiceId,
        entitlementId: p.entitlementId, credits: p.credits, expiresAt: p.expiresAt, eventId, action: 'revoke',
        ...(typeof p.accountPublicId === 'string' ? { accountPublicId: p.accountPublicId } : {}),
    } };
}

import type { OverageInvoiceRequest, OverageInvoiceResult } from '../ports';

export const OVERAGE_GRACE_SECONDS = 3600;
export const OVERAGE_RATING_VERSION = 1;

export function overageIdempotencyKey(subscriptionId: string, periodStart: Date, ratingVersion: number): string {
    return `overage:${subscriptionId}:${Math.floor(periodStart.getTime() / 1000)}:${ratingVersion}`;
}

export function overageEligibility(input: Pick<OverageInvoiceRequest, 'overageEnabled' | 'cents' | 'periodEnd' | 'now'>):
    Extract<OverageInvoiceResult, { status: 'skipped' }>['reason'] | null {
    if (!input.overageEnabled) return 'overage_disabled';
    if (!Number.isSafeInteger(input.cents) || input.cents <= 0) return 'nothing_to_bill';
    if (!(input.now.getTime() >= input.periodEnd.getTime() + OVERAGE_GRACE_SECONDS * 1000)) return 'period_not_closed';
    return null;
}

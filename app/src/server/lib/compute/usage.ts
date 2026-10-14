/**
 * Usage-ledger accounting (docs/AWS-COMPUTERS.md §4, R9). Pure functions over
 * usage-ledger rows as `placement.ts` reads them; no database here.
 *
 * - Months are UTC calendar months.
 * - Hours: each row covers `[started_at, stopped_at ?? now]`, clipped to the
 *   month and to `now`. An open row counts up to now.
 * - Egress: `egress_bytes` is one total per row with no time breakdown, so it
 *   cannot be clipped. A row's whole egress counts in EVERY month the row
 *   overlaps: a row spanning a boundary is over-counted, which is the safe
 *   direction for a cap.
 * - 🔴 EGRESS IS NOT MEASURED YET. Nothing writes `egress_bytes` (the receipt
 *   path always writes NULL, placement.ts `UsageEffect`), and NULL counts as 0,
 *   so the egress caps are configured but NEVER bind. Only the hour caps are
 *   enforced (rows are opened and closed by lifecycle receipts). Measuring egress
 *   outside the guest is open work (docs/AWS-COMPUTERS.md C-2, §4).
 */

import type { UsageRow } from './placement';

const HOUR_MS = 3_600_000;
export const BYTES_PER_GB = 1_000_000_000;

export function utcMonthStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function utcNextMonthStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Hours of `row` inside the UTC month containing `now`, up to `now`. Never negative. */
export function rowHoursInMonth(row: Pick<UsageRow, 'startedAt' | 'stoppedAt'>, now: Date): number {
    const from = Math.max(row.startedAt.getTime(), utcMonthStart(now).getTime());
    const to = Math.min((row.stoppedAt ?? now).getTime(), now.getTime(), utcNextMonthStart(now).getTime());
    return to > from ? (to - from) / HOUR_MS : 0;
}

/** True when the row overlaps the UTC month containing `now` (and started by `now`). */
export function rowOverlapsMonth(row: Pick<UsageRow, 'startedAt' | 'stoppedAt'>, now: Date): boolean {
    const monthStart = utcMonthStart(now).getTime();
    if (row.startedAt.getTime() >= Math.min(now.getTime(), utcNextMonthStart(now).getTime())) return false;
    return row.stoppedAt === null || row.stoppedAt.getTime() >= monthStart;
}

export interface UsageTotals {
    hours: number;
    egressBytes: number;
}

export function totalsFor(rows: readonly UsageRow[], now: Date): UsageTotals {
    let hours = 0;
    let egressBytes = 0;
    for (const row of rows) {
        if (!rowOverlapsMonth(row, now)) continue;
        hours += rowHoursInMonth(row, now);
        egressBytes += row.egressBytes ?? 0;
    }
    return { hours, egressBytes };
}

export function summarizeUsage(rows: readonly UsageRow[], userId: string, now: Date): { user: UsageTotals; global: UsageTotals } {
    return { user: totalsFor(rows.filter((r) => r.userId === userId), now), global: totalsFor(rows, now) };
}

/**
 * Usage-ledger accounting (docs/AWS-COMPUTERS.md §4, R9). Pure functions over
 * usage-ledger rows as `placement.ts` reads them; no database here.
 *
 * - Months are UTC calendar months.
 * - Hours: each row covers `[started_at, stopped_at ?? now]`, clipped to the
 *   month and to `now`. An open row counts up to now.
 * - Caps: floor each clipped row to whole seconds, then multiply by vCPU / 2.
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
import { instanceVcpu } from './aws-config';

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
    return rowMillisecondsInMonth(row, now) / HOUR_MS;
}

function rowMillisecondsInMonth(row: Pick<UsageRow, 'startedAt' | 'stoppedAt'>, now: Date): number {
    const from = Math.max(row.startedAt.getTime(), utcMonthStart(now).getTime());
    const to = Math.min((row.stoppedAt ?? now).getTime(), now.getTime(), utcNextMonthStart(now).getTime());
    return to > from ? to - from : 0;
}

/** Whole seconds per row, clipped before flooring, weighted in 2-vCPU units. */
export function rowWeightedSecondsInMonth(row: UsageRow, now: Date): number {
    return Math.floor(rowMillisecondsInMonth(row, now) / 1_000) * (instanceVcpu(row.instanceType) / 2);
}

/** True when the row overlaps the UTC month containing `now` (and started by `now`). */
export function rowOverlapsMonth(row: Pick<UsageRow, 'startedAt' | 'stoppedAt'>, now: Date): boolean {
    const monthStart = utcMonthStart(now).getTime();
    if (row.startedAt.getTime() >= Math.min(now.getTime(), utcNextMonthStart(now).getTime())) return false;
    return row.stoppedAt === null || row.stoppedAt.getTime() >= monthStart;
}

export interface UsageTotals {
    /** @deprecated for caps; use weightedSeconds. Unweighted wall-clock hours. */
    hours: number;
    weightedSeconds: number;
    egressBytes: number;
}

export function totalsFor(rows: readonly UsageRow[], now: Date): UsageTotals {
    let hours = 0;
    let weightedSeconds = 0;
    let egressBytes = 0;
    for (const row of rows) {
        if (!rowOverlapsMonth(row, now)) continue;
        hours += rowHoursInMonth(row, now);
        weightedSeconds += rowWeightedSecondsInMonth(row, now);
        egressBytes += row.egressBytes ?? 0;
    }
    return { hours, weightedSeconds, egressBytes };
}

export function summarizeUsage(rows: readonly UsageRow[], userId: string, now: Date): { user: UsageTotals; global: UsageTotals } {
    return { user: totalsFor(rows.filter((r) => r.userId === userId), now), global: totalsFor(rows, now) };
}

/**
 * This month's usage, already totalled: fleet-wide and per user. `placement.ts`
 * `readMonthUsage` computes it IN THE DATABASE (one row per user with usage this
 * month), so an admission under its lock never transfers the whole month's ledger.
 * `monthUsageFromRows` is the same arithmetic over rows: the reference the SQL is
 * checked against, and what the test fake answers with.
 */
export interface MonthUsage {
    global: UsageTotals;
    byUser: ReadonlyMap<string, UsageTotals>;
}

const ZERO: UsageTotals = Object.freeze({ hours: 0, weightedSeconds: 0, egressBytes: 0 });

export function monthUsageFromRows(rows: readonly UsageRow[], now: Date): MonthUsage {
    const byUser = new Map<string, UsageTotals>();
    for (const row of rows) {
        if (!rowOverlapsMonth(row, now)) continue;
        const key = row.userId.toLowerCase();
        const prev = byUser.get(key) ?? ZERO;
        byUser.set(key, {
            hours: prev.hours + rowHoursInMonth(row, now),
            weightedSeconds: prev.weightedSeconds + rowWeightedSecondsInMonth(row, now),
            egressBytes: prev.egressBytes + (row.egressBytes ?? 0),
        });
    }
    return { global: totalsOf(byUser.values()), byUser };
}

/** Fleet-wide totals from per-user totals. */
export function totalsOf(perUser: Iterable<UsageTotals>): UsageTotals {
    let hours = 0;
    let weightedSeconds = 0;
    let egressBytes = 0;
    for (const t of perUser) {
        hours += t.hours;
        weightedSeconds += t.weightedSeconds;
        egressBytes += t.egressBytes;
    }
    return { hours, weightedSeconds, egressBytes };
}

/** One user's and the fleet's totals: what the caps compare against. */
export function usageFor(usage: MonthUsage, userId: string): { user: UsageTotals; global: UsageTotals } {
    return { user: usage.byUser.get(userId.toLowerCase()) ?? ZERO, global: usage.global };
}

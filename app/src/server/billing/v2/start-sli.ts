import type { EpochEndReason, SizeCode } from './contract';

export interface StartReadinessRow {
    size: SizeCode;
    readyAt: Date | string;
    overheadSeconds: number;
    endReason: EpochEndReason | null;
}

export interface TierStartReadiness {
    count: number;
    p50: number;
    p95: number;
    max: number;
    platformFailures: number;
}

/** Bind $1 = from (inclusive), $2 = to (exclusive); no customer identifiers. */
export const START_SLI_SQL = `
SELECT size, ready_at AS "readyAt", overhead_seconds AS "overheadSeconds", end_reason AS "endReason"
FROM ezil_billing_compute_epochs
WHERE ready_at >= $1::timestamptz AND ready_at < $2::timestamptz
`;

function timestamp(value: Date | string): number {
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(ms)) throw new RangeError('Invalid readiness timestamp');
    return ms;
}

/**
 * Aggregate epochs that became ready in [from, to), including open epochs.
 * Only observed sizes are returned (empty input produces {}). Percentiles use
 * nearest rank over whole overhead seconds. Failures before readiness have no
 * epoch and therefore cannot be counted by this report.
 */
export function startReadinessByTier(
    rows: readonly StartReadinessRow[],
    { from, to }: { from: Date | string; to: Date | string },
): Partial<Record<SizeCode, TierStartReadiness>> {
    const start = timestamp(from);
    const end = timestamp(to);
    if (end < start) throw new RangeError('Readiness window ends before it starts');
    const groups = new Map<SizeCode, { seconds: number[]; platformFailures: number }>();
    for (const row of rows) {
        const ready = timestamp(row.readyAt);
        if (ready < start || ready >= end) continue;
        const seconds = Math.floor(row.overheadSeconds);
        if (!Number.isSafeInteger(seconds) || seconds < 0) throw new RangeError('Invalid readiness overhead');
        const group = groups.get(row.size) ?? { seconds: [], platformFailures: 0 };
        group.seconds.push(seconds);
        if (row.endReason === 'platform_failure') group.platformFailures++;
        groups.set(row.size, group);
    }
    const result: Partial<Record<SizeCode, TierStartReadiness>> = {};
    for (const [size, { seconds, platformFailures }] of groups) {
        seconds.sort((a, b) => a - b);
        const count = seconds.length;
        result[size] = {
            count,
            p50: seconds[Math.ceil(count * 0.5) - 1]!,
            p95: seconds[Math.ceil(count * 0.95) - 1]!,
            max: seconds[count - 1]!,
            platformFailures,
        };
    }
    return result;
}

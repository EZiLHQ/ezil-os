import { createAiReader, isoTimestamp, microString, record, type AiReadInput, type AiReader } from './ai-read';

export interface AiUsageRow {
    at: string;
    status: 'reserved' | 'pending' | 'settled';
    heldMicro: string | null;
    chargedMicro: string | null;
}
export interface AiUsagePage { rows: AiUsageRow[]; limit: number; before: string | null; }
export interface AiUsageResult { state: 'available' | 'unavailable'; recentUsage: AiUsagePage | null; }

export function parseAiUsage(body: unknown, limit: number, before: string | null): AiUsageResult {
    const data = record(body);
    const unavailable: AiUsageResult = { state: 'unavailable', recentUsage: null };
    if (data?.object !== 'list' || !Array.isArray(data.data) || data.data.length > limit) return unavailable;
    const rows: AiUsageRow[] = [];
    for (const value of data.data) {
        const row = record(value), at = isoTimestamp(row?.created_at);
        if (!row || !at || typeof row.status !== 'string' || !['reserved', 'pending', 'settled'].includes(row.status)) return unavailable;
        const cost = microString(row.cost_micro), uncollected = microString(row.uncollected_micro);
        const chargedMicro = row.status === 'settled' && cost !== null && uncollected !== null && BigInt(cost) >= BigInt(uncollected)
            ? String(BigInt(cost) - BigInt(uncollected)) : null;
        // A settled row retains its original reservation in hold_micro, but no longer holds it.
        rows.push({ at, status: row.status as AiUsageRow['status'], heldMicro: row.status === 'settled' ? '0' : microString(row.hold_micro), chargedMicro });
    }
    return { state: 'available', recentUsage: { rows, limit, before } };
}

export async function readAiUsage(input: AiReadInput, options: { limit?: number; before?: string } = {},
    read: AiReader = createAiReader(input)): Promise<AiUsageResult> {
    const limit = options.limit ?? 20;
    const before = options.before === undefined ? null : isoTimestamp(options.before);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (options.before !== undefined && before === null)) {
        return { state: 'unavailable', recentUsage: null };
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    return parseAiUsage(await read(`/v1/me/usage?${params}`), limit, before);
}

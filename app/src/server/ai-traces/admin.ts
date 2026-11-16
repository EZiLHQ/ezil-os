import { sql } from 'drizzle-orm';
import { isTelemetryAdmin } from '../telemetry/admin';
import { validateInferenceTrace } from './schema';
import { rowsOf, type TraceDb } from './store';
import type { InferenceTrace } from './types';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface TraceRow { userId: string; receivedAt: string; trace: InferenceTrace }
export const tokenValue = (value: number | null | undefined) => value == null ? 'unknown' : String(value);
export function gatewayLink(id: string | null, pinnedOrigin: string | undefined): string | null {
    if (!id || !UUID.test(id) || !pinnedOrigin) return null;
    try {
        const url = new URL(pinnedOrigin);
        if (url.protocol !== 'https:' || url.origin !== pinnedOrigin || url.username || url.password) return null;
        return `${url.origin}/#requests?request_id=${id.toLowerCase()}&range=30d`;
    } catch { return null; }
}
export async function queryTraces(db: TraceDb, opts: {
    email: string | null | undefined; allowList: string | undefined; userId?: string; page?: number;
}): Promise<{ rows: TraceRow[]; available: boolean }> {
    if (!isTelemetryAdmin(opts.email, opts.allowList)) return { rows: [], available: false };
    if (opts.userId !== undefined && !UUID.test(opts.userId)) return { rows: [], available: false };
    const page = Number.isSafeInteger(opts.page) ? Math.min(100, Math.max(0, opts.page!)) : 0;
    try {
        const rows = rowsOf(await db.execute(sql`
            SELECT user_id, received_at, metadata FROM ezil_ai_request_traces
            WHERE received_at >= now() - interval '7 days'
            ${opts.userId ? sql`AND user_id = ${opts.userId}::uuid` : sql``}
            ORDER BY received_at DESC, user_id, request_id LIMIT 50 OFFSET ${page * 50}`));
        const clean: TraceRow[] = [];
        for (const row of rows) {
            const trace = validateInferenceTrace(row.metadata);
            const receivedAt = new Date(String(row.received_at));
            if (trace && typeof row.user_id === 'string' && UUID.test(row.user_id) && Number.isFinite(receivedAt.getTime()))
                clean.push({ userId: row.user_id, receivedAt: receivedAt.toISOString(), trace });
        }
        return { rows: clean, available: true };
    } catch { return { rows: [], available: false }; }
}

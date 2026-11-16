import { LIMITS, parseBatch } from './schema';
import { ingestTraces, type TraceDb } from './store';
export interface HandlerDeps {
    getContext(req: Request): Promise<{ user: { id: string } | null; db: TraceDb }>;
    schedule(work: () => Promise<void>): void;
}
const accepted = () => new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
export async function handleAiTracesPost(req: Request, deps: HandlerDeps): Promise<Response> {
    try {
        const ctx = await deps.getContext(req);
        if (!ctx.user || !req.body) return accepted();
        const reader = req.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > LIMITS.bodyBytes) { void reader.cancel().catch(() => {}); return accepted(); }
            chunks.push(value);
        }
        const raw = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
        const traces = parseBatch(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
        if (!traces) return accepted();
        const userId = ctx.user.id;
        deps.schedule(async () => {
            try { await ingestTraces(ctx.db, userId, traces); }
            catch { /* No raw database/error text, retry, or inference coupling. */ }
        });
    } catch { /* Optional operational collection fails soft. */ }
    return accepted();
}

/**
 * The testable core of `POST /api/shell/telemetry`, separated from
 * `src/app/api/shell/telemetry/route.ts` for exactly one reason: `route.ts`
 * wires the REAL `next/server`'s `after()`, which throws
 * ("`after` was called outside a request scope") unless it runs inside an
 * actual Next.js request — including inside a unit test that imports the
 * route module directly. Injecting `schedule` here means `http-handler.test.ts`
 * can assert on exactly what gets deferred without needing a live Next
 * request context or a real Postgres connection.
 *
 * THE GUARANTEE, stated once (design §4.6): no telemetry code path here is
 * ever awaited by anything that produces user-visible output, and the
 * response body/status is never meaningfully read by the client. Every
 * early return is `ACCEPTED` — a fixed 202 — specifically so a caller has
 * nothing to branch on.
 *
 * Bounds enforced here, in order, each one a reason to return 202 and do
 * nothing further:
 *   1. No authenticated user            -> nothing to attribute the batch to.
 *   2. Body exceeds `MAX_BODY_BYTES`     -> read bounded by BYTES ACTUALLY ON
 *      THE WIRE (a stream reader with a running total), not by trusting a
 *      `Content-Length` header a client could lie about.
 *   3. Malformed JSON                   -> nothing valid to ingest.
 *   4. Zero valid events after `parseTelemetryBatch` -> nothing to ingest
 *      (an all-invalid batch, e.g. one that tried to smuggle `userId`,
 *      silently produces zero rows rather than an error the caller could
 *      read and adapt to).
 *   5. Per-user rate limit exceeded      -> `./rate-limit.ts`.
 *   6. Global row-count breaker tripped  -> `./load-shed.ts`.
 * Only past all six does anything get scheduled to run AFTER the response.
 */
import { safeUserHash } from './sanitize';
import { parseTelemetryBatch } from './schema';
import { isRateLimited } from './rate-limit';
import { shouldShedLoad, type RowEstimateDb } from './load-shed';
import { ingestBatch, type IngestDb } from './ingest';
import { TELEMETRY_LIMITS } from './types';

export const TELEMETRY_ACCEPTED_RESPONSE = (): Response =>
    new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });

export interface TelemetryRequestContext {
    user: { id: string } | null;
    db: IngestDb & RowEstimateDb;
}

export interface TelemetryHandlerDeps {
    getContext: (req: Request) => Promise<TelemetryRequestContext>;
    /** In production, `next/server`'s `after()`. In tests, a spy that
     * captures the callback without a real request scope. */
    schedule: (work: () => void | Promise<void>) => void;
}

/**
 * Read a request body up to `maxBytes`, based on bytes actually received —
 * never trusts `Content-Length`, which a client can simply omit or lie
 * about. Returns `null` the moment the running total crosses the cap, and
 * cancels the underlying stream immediately rather than draining the rest
 * of a hostile body.
 */
async function readBoundedBody(req: Request, maxBytes: number): Promise<string | null> {
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
}

export async function handleTelemetryPost(req: Request, deps: TelemetryHandlerDeps): Promise<Response> {
    const ACCEPTED = TELEMETRY_ACCEPTED_RESPONSE;
    try {
        const ctx = await deps.getContext(req);
        if (!ctx.user) return ACCEPTED();

        const rawBody = await readBoundedBody(req, TELEMETRY_LIMITS.MAX_BODY_BYTES);
        if (rawBody === null) return ACCEPTED(); // over the byte cap — dropped, not rejected

        let parsedJson: unknown;
        try {
            parsedJson = rawBody ? JSON.parse(rawBody) : null;
        } catch {
            return ACCEPTED();
        }

        const batch = parseTelemetryBatch(parsedJson);
        if (batch.events.length === 0) return ACCEPTED();

        // user_hash is derived HERE, server-side, from the authenticated
        // session — the client never sends one and is never trusted with one.
        const userHash = safeUserHash(ctx.user.id);

        if (isRateLimited(userHash)) return ACCEPTED();
        if (shouldShedLoad(ctx.db)) return ACCEPTED();

        deps.schedule(async () => {
            try {
                await ingestBatch(ctx.db, batch.events, userHash);
            } catch (err) {
                // The one place this route is allowed to be noisy: server logs,
                // never the response. Matches the shell's own console.error
                // discipline (kept ALONGSIDE telemetry, never replaced by it).
                console.error('[telemetry] ingest failed', { m: String((err as Error)?.message ?? err) });
            }
        });

        return ACCEPTED();
    } catch {
        return ACCEPTED();
    }
}

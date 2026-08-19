/**
 * The testable core of `POST /api/cron/telemetry-drain` — the app side of the
 * missing last hop `worker/src/telemetry.ts`'s own "KNOWN GAP" doc comment
 * names: `spoolTelemetry()` has been writing worker/container boot-phase
 * events to R2 (`ezil-telemetry-spool`) since the telemetry design landed,
 * and until this file, nothing ever read them back out.
 *
 * Separated from `src/app/api/cron/telemetry-drain/route.ts` for the SAME
 * reason `./maintenance-handler.ts` is separated from its own route: keeping
 * `@/env` (eager validation, throws on a missing `SUPABASE_DATABASE_URL`), a
 * live Postgres connection, and a real `fetch()` to the Worker out of the
 * import graph a unit test exercises. `handleTelemetrySpoolDrain` below is
 * `route.ts`'s ENTIRE body — every dependency (the cron secret, the db, the
 * two Worker-HTTP calls) is injected, exactly like `MaintenanceHandlerDeps`.
 *
 * FAIL CLOSED, the same two ways as `./maintenance-handler.ts`:
 *   1. `CRON_SECRET` unset at all -> 404. A deploy that forgot to set the
 *      secret cannot expose the drain (a read of an R2 bucket AND a write
 *      into `ezil_error_events`) to the internet.
 *   2. A present-but-wrong bearer token ALSO 404s, not 401 — indistinguishable
 *      from "route does not exist" to an outside prober.
 *
 * ── Why this can never lose an event, only re-process one ───────────────────
 * The design's own ordering guarantee: INGEST BEFORE ACK, every time, per
 * page. `ingestBatch` is idempotent on `eventId` (`ON CONFLICT DO NOTHING`),
 * so:
 *   - a crash/timeout between ingest and ack leaves the page's objects
 *     un-acked -> they are drained (and re-ingested, as a pure no-op) again
 *     next run;
 *   - an ack call that itself fails/times out has the SAME outcome — the
 *     Worker never deleted the objects, so they come back next run;
 *   - the one thing that must NEVER happen is acking a page whose ingest
 *     failed. `runTelemetrySpoolDrain` enforces this by construction: `ack()`
 *     is only ever called after `ingestBatch()` for THAT SAME page resolved
 *     without throwing.
 * Nothing here is a hard dependency of anything user-facing — a failed run
 * just means the spool grows a little larger and the next scheduled run
 * catches up.
 */
import { ingestBatch, type IngestDb } from './ingest';
import { parseTelemetryBatch } from './schema';
import { TELEMETRY_LIMITS, TELEMETRY_SCHEMA_VERSION, WORKER_SENTINEL_USER_HASH } from './types';

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

/** One page of the Worker's `POST /telemetry/drain` response. `ok: false`
 * covers every failure mode uniformly (unconfigured Worker URL, network
 * error, non-2xx response, malformed JSON) — the drain loop does not need to
 * distinguish them, only stop cleanly and leave the spool untouched. */
export type DrainPageResult =
    | { ok: true; objects: { key: string; body: string }[]; cursor?: string; truncated: boolean }
    | { ok: false };

/** Bounds one cron invocation's total work — `TELEMETRY_DRAIN_MAX_OBJECTS`
 * (200, Worker-side) objects per page times this many pages is the ceiling
 * on how much one run drains, so a very large backlog spreads across several
 * scheduled runs rather than one long-running request. */
const DEFAULT_MAX_PAGES = 10;

export interface SpoolDrainResult {
    pagesDrained: number;
    objectsSeen: number;
    eventsParsed: number;
    eventsDroppedInvalid: number;
    /** Rows actually inserted (`ingestBatch`'s own idempotent count — a
     * re-drained, already-ingested object contributes 0 here, not a re-count). */
    eventsIngested: number;
    objectsAcked: number;
    /**
     * How many `drainPage()` calls came back `{ ok: false }` — i.e. the Worker
     * was unreachable, unconfigured, rejected the HMAC, or answered
     * unparseably.
     *
     * 🔴 THIS FIELD EXISTS BECAUSE ITS ABSENCE HID A 16-DAY OUTAGE. Measured
     * 2026-08-19: `ezil-telemetry-spool` held 173 objects / 467 kB accumulated
     * since 2026-08-03, and `ezil_error_events` contained ZERO rows with
     * `source` of `worker` or `container` — the spool has been filling since
     * the day it was created and has never once been drained. Producing and
     * spooling both work; the drain does not.
     *
     * Without this counter the two outcomes below are indistinguishable in the
     * result AND in the HTTP response, because `runTelemetrySpoolDrain` breaks
     * out of the loop identically for both:
     *   - "the spool is empty, nothing to do"  -> a healthy no-op
     *   - "I could not reach the Worker at all" -> a total outage
     * Both returned `{ pagesDrained: 0, ... }` and a `200 {ok:true}`, so a
     * completely broken drain looked exactly like a quiet day in the cron log.
     *
     * A non-zero value here is always a fault, never a normal state.
     */
    drainFailures: number;
}

export interface SpoolDrainEngineDeps {
    db: IngestDb;
    /** Fetch one page of the R2 spool from the Worker. */
    drainPage: (cursor: string | undefined) => Promise<DrainPageResult>;
    /** Ack (delete) the given spool keys on the Worker. Returns whether the
     * ack itself succeeded — a `false` here is harmless (see file header):
     * the objects simply come back on the next drain. */
    ack: (keys: string[]) => Promise<boolean>;
    maxPages?: number;
}

/**
 * The pure drain loop: page through the Worker's spool, parse+ingest every
 * NDJSON line through the SAME validator the shell's own ingest route uses
 * (`parseTelemetryBatch` -> `ingestBatch`), then ack only what was ingested
 * without error. Every drained event is stored under
 * `WORKER_SENTINEL_USER_HASH` — worker/container events carry no real user,
 * and `ezil_error_events.userHash` is `NOT NULL` (see that constant's own
 * doc comment for why it must then be excluded from every distinct-user
 * count downstream).
 */
export async function runTelemetrySpoolDrain(deps: SpoolDrainEngineDeps): Promise<SpoolDrainResult> {
    const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
    let cursor: string | undefined;
    let pagesDrained = 0;
    let objectsSeen = 0;
    let eventsParsed = 0;
    let eventsDroppedInvalid = 0;
    let eventsIngested = 0;
    let objectsAcked = 0;
    let drainFailures = 0;

    for (let i = 0; i < maxPages; i++) {
        const page = await deps.drainPage(cursor);
        if (!page.ok) {
            // Worker/transport failure — spool is untouched, retried whole
            // next run. COUNTED and LOGGED, not silently swallowed: see
            // `SpoolDrainResult.drainFailures` for the outage this hid.
            drainFailures++;
            console.error('[telemetry] spool-drain could not reach the Worker', {
                page: i,
                hint: 'check CLOUDFLARE_GUACAMOLE_WORKER_URL, CLOUDFLARE_GUACAMOLE_HMAC_SECRET and SANDBOX_TELEMETRY_DRAIN',
            });
            break;
        }
        pagesDrained++;
        objectsSeen += page.objects.length;

        if (page.objects.length === 0) {
            cursor = page.truncated ? page.cursor : undefined;
            if (!cursor) break;
            continue;
        }

        // Every NDJSON line, across every object in this page, parsed into a
        // raw JS value. A torn/partial line (never a torn object — R2 PUTs
        // are whole-object) is dropped, never fails its neighbours — same
        // discipline as the Worker's own `parseContainerTelemetryLines`.
        const rawEvents: unknown[] = [];
        for (const obj of page.objects) {
            for (const line of obj.body.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    rawEvents.push(JSON.parse(trimmed));
                } catch {
                    // malformed line — dropped, not counted as parsed.
                }
            }
        }
        eventsParsed += rawEvents.length;

        // Validate + ingest in chunks respecting the shared per-batch cap
        // (`parseTelemetryBatch`/`ingestBatch` both re-enforce it anyway —
        // this just keeps each call's own work bounded).
        const chunkSize = TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH;
        let ingestFailed = false;
        for (let off = 0; off < rawEvents.length; off += chunkSize) {
            const chunk = rawEvents.slice(off, off + chunkSize);
            const parsed = parseTelemetryBatch({ schemaVersion: TELEMETRY_SCHEMA_VERSION, events: chunk });
            eventsDroppedInvalid += parsed.droppedInvalid;
            if (parsed.events.length === 0) continue;
            try {
                const result = await ingestBatch(deps.db, parsed.events, WORKER_SENTINEL_USER_HASH);
                eventsIngested += result.inserted;
            } catch (err) {
                console.error('[telemetry] spool-drain ingest failed', { m: String((err as Error)?.message ?? err) });
                ingestFailed = true;
                break;
            }
        }

        if (ingestFailed) {
            // 🔴 Do NOT ack. The page's objects stay in R2 and are re-drained
            // (and re-ingested — idempotent on eventId) next run. Acking here
            // would be the one way this drain could actually lose data.
            break;
        }

        const keys = page.objects.map((o) => o.key);
        const acked = await deps.ack(keys);
        if (acked) objectsAcked += keys.length;
        // A failed ack is not re-thrown or retried inline — see file header:
        // the objects simply reappear (and re-ingest as a no-op) next run.

        cursor = page.truncated ? page.cursor : undefined;
        if (!cursor) break;
    }

    return { pagesDrained, objectsSeen, eventsParsed, eventsDroppedInvalid, eventsIngested, objectsAcked, drainFailures };
}

export interface SpoolDrainHandlerDeps extends SpoolDrainEngineDeps {
    cronSecret: string | undefined;
}

export interface SpoolDrainResponseBody {
    ok: boolean;
    result?: SpoolDrainResult;
}

/**
 * `route.ts`'s entire body. Fail-closed exactly like
 * `./maintenance-handler.ts`'s `handleTelemetryMaintenance` — see this
 * file's own header for why both checks 404 rather than 401/500.
 */
export async function handleTelemetrySpoolDrain(req: Request, deps: SpoolDrainHandlerDeps): Promise<Response> {
    if (!deps.cronSecret) return NOT_FOUND();
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${deps.cronSecret}`) return NOT_FOUND();

    try {
        const result = await runTelemetrySpoolDrain(deps);
        const body: SpoolDrainResponseBody = { ok: true, result };
        return Response.json(body);
    } catch (err) {
        console.error('[telemetry] spool-drain run failed', { m: String((err as Error)?.message ?? err) });
        const body: SpoolDrainResponseBody = { ok: false };
        return Response.json(body, { status: 500 });
    }
}

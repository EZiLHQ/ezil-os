/**
 * The HTTP half of the R2 spool drain: the two Worker calls
 * (`POST /telemetry/drain`, `POST /telemetry/ack`) that
 * `runTelemetrySpoolDrain` (`./spool-drain.ts`) takes as injected
 * dependencies.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 * TWO cron routes now perform the drain:
 *
 *   - `/api/cron/telemetry-drain`      — standalone, kept for manual runs.
 *   - `/api/cron/telemetry-maintenance` — retention THEN drain, in one
 *     invocation, because `app/vercel.json` may only declare two crons.
 *
 * They must agree on every wire detail — the page limit, the timeout, the
 * bearer envelope, and what counts as failure — and the way two routes stop
 * agreeing is by each keeping its own copy. So there is exactly one copy, and
 * it lives here.
 *
 * Pure by construction: `@/env` is never imported (it validates eagerly and
 * throws without `SUPABASE_DATABASE_URL`), the token minter is passed in, and
 * `fetch` is injectable. That is what lets `spool-drain-transport.test.ts`
 * exercise the real request-building and response-mapping code rather than a
 * re-implementation of it.
 */
import type { DrainPageResult } from './spool-drain';

/**
 * Objects per drain page.
 *
 * 🔴 SENDING THIS IS LOAD-BEARING, and omitting it is what this constant
 * exists to prevent. `clampDrainLimit(undefined)` (`worker/src/telemetry.ts`)
 * falls back to `TELEMETRY_DRAIN_MAX_OBJECTS = 200`, and `handleTelemetryDrain`
 * then performs up to 200 **sequential awaited** `bucket.get()` calls inside a
 * single request — against the timeout below.
 *
 * That is not hypothetical. Measured 2026-08-19: `ezil-telemetry-spool` holds
 * **173 objects** that have never been drained, so the very first restored run
 * is the worst case. If it aborts, the app sees `{ok:false}`, never acks, and
 * the backlog is unchanged — a self-perpetuating stall indistinguishable from
 * the outage it is recovering from. Cloudflare's invocation analytics record an
 * aborting client as `clientDisconnected`, and the only three hour-03 Worker
 * hits in the whole window (2026-08-06/07/08, one per day, then silence) are
 * exactly that shape — so this may well be how the drain died in the first
 * place, rather than merely how it would fail next time.
 *
 * 25 keeps a page comfortably inside the budget and costs only more round
 * trips; `runTelemetrySpoolDrain` already loops on the returned cursor.
 */
export const DRAIN_PAGE_LIMIT = 25;

/** Per-request abort. One page must never be able to eat the whole invocation. */
export const DRAIN_REQUEST_TIMEOUT_MS = 20_000;

/** The two env values the transport needs, structurally — NOT `@/env` itself. */
export interface DrainTransportEnv {
    CLOUDFLARE_GUACAMOLE_WORKER_URL?: string | undefined;
    CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string | undefined;
}

export interface DrainTransport {
    drainPage: (cursor: string | undefined) => Promise<DrainPageResult>;
    ack: (keys: string[]) => Promise<boolean>;
}

export interface DrainTransportOptions {
    workerUrl: string | undefined;
    /** Mints the `Authorization: Bearer` value for one request. */
    mintToken: () => string;
    /** Injectable for tests; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/**
 * Build the `{ drainPage, ack }` pair `runTelemetrySpoolDrain` needs.
 *
 * Every failure mode of `drainPage` — unconfigured Worker URL, DNS/network
 * error, non-2xx, malformed JSON, `{ok:false}` from the Worker — collapses to
 * `{ ok: false }`, uniformly. The loop does not need to tell them apart; it
 * needs only to stop cleanly and leave the spool untouched, and
 * `SpoolDrainResult.drainFailures` is what makes the stop visible.
 *
 * A `false` from `ack` is likewise harmless: the objects were already ingested
 * (ingest strictly precedes ack, per page) and simply come back on the next
 * run, where they re-ingest as a no-op on `eventId`.
 */
export function createDrainTransport(opts: DrainTransportOptions): DrainTransport {
    const base = (opts.workerUrl ?? '').replace(/\/$/, '');
    const doFetch = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DRAIN_REQUEST_TIMEOUT_MS;

    const headers = (): Record<string, string> => ({
        'content-type': 'application/json',
        authorization: `Bearer ${opts.mintToken()}`,
    });

    return {
        async drainPage(cursor: string | undefined): Promise<DrainPageResult> {
            if (!base) return { ok: false };
            try {
                const res = await doFetch(`${base}/telemetry/drain`, {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({ cursor, limit: DRAIN_PAGE_LIMIT }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!res.ok) return { ok: false };
                const data = (await res.json()) as {
                    ok?: boolean;
                    objects?: { key: string; body: string }[];
                    cursor?: string;
                    truncated?: boolean;
                };
                if (!data.ok) return { ok: false };
                return {
                    ok: true,
                    objects: data.objects ?? [],
                    cursor: data.cursor,
                    truncated: Boolean(data.truncated),
                };
            } catch {
                return { ok: false };
            }
        },

        async ack(keys: string[]): Promise<boolean> {
            if (keys.length === 0) return true;
            if (!base) return false;
            try {
                const res = await doFetch(`${base}/telemetry/ack`, {
                    method: 'POST',
                    headers: headers(),
                    body: JSON.stringify({ keys }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (!res.ok) return false;
                const data = (await res.json()) as { ok?: boolean };
                return Boolean(data.ok);
            } catch {
                return false;
            }
        },
    };
}

/**
 * The one line both cron routes call. `mint` is
 * `mintSandboxPreviewToken` (`@/server/lib/cloudflare-guacamole-provider`),
 * passed in rather than imported so this module stays free of the app's
 * eager-validating env graph.
 */
export function createDrainTransportFromEnv(
    env: DrainTransportEnv,
    mint: (hmacSecret: string) => string,
): DrainTransport {
    return createDrainTransport({
        workerUrl: env.CLOUDFLARE_GUACAMOLE_WORKER_URL,
        mintToken: () => mint(env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET ?? ''),
    });
}

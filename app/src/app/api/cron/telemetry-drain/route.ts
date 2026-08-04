import { db } from '@/server/db';
import { env } from '@/env';
import { mintSandboxPreviewToken } from '@/server/lib/cloudflare-guacamole-provider';
import { handleTelemetrySpoolDrain, type DrainPageResult } from '@/server/telemetry/spool-drain';

/**
 * `GET /api/cron/telemetry-drain` — drains the Worker's R2 telemetry spool
 * (`ezil-telemetry-spool`) into Postgres via the Worker's
 * `POST /telemetry/drain` + `/telemetry/ack` (`worker/src/index.ts`).
 *
 * This is the missing last hop `worker/src/telemetry.ts`'s own "KNOWN GAP"
 * doc comment names: `spoolTelemetry()` has been writing worker/container
 * boot-phase events to R2 all along, and until this route existed nothing
 * ever read them back out — 100% of `source:'worker'`/`source:'container'`
 * events, including every container boot phase, never reached Postgres.
 *
 * ⚠️ Vercel's Hobby plan only permits DAILY cron schedules — see
 * `vercel.json`'s comment on this route's entry. The existing
 * `telemetry-maintenance` cron is `17 3 * * *` for the exact same reason.
 * This route is scheduled at a different minute/hour so the two crons never
 * clash on the same tick.
 *
 * Guarded by `CRON_SECRET` (`@/env.ts`), the SAME secret
 * `telemetry-maintenance` uses: unset -> 404, wrong/missing bearer -> 404.
 * See `@/server/telemetry/spool-drain.ts`'s `handleTelemetrySpoolDrain` doc
 * comment for the full fail-closed rationale (copied verbatim from
 * `@/server/telemetry/maintenance-handler.ts`).
 *
 * `maxDuration` set well above what one run's bounded work (≤10 pages ×
 * ≤200 objects, per `spool-drain.ts`'s `DEFAULT_MAX_PAGES`) should ever take,
 * for the same "maxDuration is not inherited" reason
 * `telemetry-maintenance/route.ts` documents.
 */
export const maxDuration = 90;

function workerBaseUrl(): string {
    return (env.CLOUDFLARE_GUACAMOLE_WORKER_URL ?? '').replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
    const token = mintSandboxPreviewToken(env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET ?? '');
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/** Real transport for `runTelemetrySpoolDrain`'s `drainPage` dependency —
 * every failure mode (unconfigured Worker, network error, non-2xx, malformed
 * JSON) collapses to `{ ok: false }` uniformly; see `spool-drain.ts`'s
 * `DrainPageResult` doc comment for why the loop does not need to
 * distinguish them. */
async function drainPage(cursor: string | undefined): Promise<DrainPageResult> {
    const base = workerBaseUrl();
    if (!base) return { ok: false };
    try {
        const res = await fetch(`${base}/telemetry/drain`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ cursor }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { ok: false };
        const data = (await res.json()) as {
            ok?: boolean;
            objects?: { key: string; body: string }[];
            cursor?: string;
            truncated?: boolean;
        };
        if (!data.ok) return { ok: false };
        return { ok: true, objects: data.objects ?? [], cursor: data.cursor, truncated: Boolean(data.truncated) };
    } catch {
        return { ok: false };
    }
}

/** Real transport for `runTelemetrySpoolDrain`'s `ack` dependency. A `false`
 * return is harmless — see `spool-drain.ts`'s file header: the un-acked
 * objects simply come back (and re-ingest as a no-op) on the next run. */
async function ack(keys: string[]): Promise<boolean> {
    if (keys.length === 0) return true;
    const base = workerBaseUrl();
    if (!base) return false;
    try {
        const res = await fetch(`${base}/telemetry/ack`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ keys }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { ok?: boolean };
        return Boolean(data.ok);
    } catch {
        return false;
    }
}

/**
 * GET, not POST — same as `telemetry-maintenance`: Vercel Cron Jobs invoke
 * their configured path with GET (`vercel.json`).
 */
export async function GET(req: Request): Promise<Response> {
    return handleTelemetrySpoolDrain(req, { cronSecret: env.CRON_SECRET, db, drainPage, ack });
}

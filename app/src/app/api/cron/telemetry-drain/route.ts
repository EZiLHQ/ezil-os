import { db } from '@/server/db';
import { env } from '@/env';
import { mintSandboxPreviewToken } from '@/server/lib/cloudflare-guacamole-provider';
import { handleTelemetrySpoolDrain } from '@/server/telemetry/spool-drain';
import { createDrainTransportFromEnv } from '@/server/telemetry/spool-drain-transport';

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
 * 🔴 NO LONGER ON A CRON OF ITS OWN, and that is the point. `vercel.json`
 * declared three crons and the plan permits two; this is the one that stopped
 * being invoked (zero hour-03 Worker requests from it since 2026-08-09, while
 * the other two kept firing). The drain now runs at the tail of
 * `/api/cron/telemetry-maintenance` — a cron that is PROVEN to fire — and this
 * route is kept as the MANUAL entry point:
 *
 *     curl -sS -H "Authorization: Bearer $CRON_SECRET" \
 *       https://ezil-os.vercel.app/api/cron/telemetry-drain
 *
 * Running it while the scheduled drain is also running is harmless: ingest
 * strictly precedes ack per page, ingest is idempotent on `eventId`, and an
 * object either gets acked (deleted) or comes back on the next run.
 *
 * Guarded by `CRON_SECRET` (`@/env.ts`), the SAME secret
 * `telemetry-maintenance` uses: unset -> 404, wrong/missing bearer -> 404.
 * See `@/server/telemetry/spool-drain.ts`'s `handleTelemetrySpoolDrain` doc
 * comment for the full fail-closed rationale (copied verbatim from
 * `@/server/telemetry/maintenance-handler.ts`).
 *
 * `maxDuration` covers one whole run of the bounded loop — `DEFAULT_MAX_PAGES`
 * (10) × `DRAIN_PAGE_LIMIT` (25) objects, cut short by
 * `DEFAULT_DRAIN_BUDGET_MS` (150 s) plus one in-flight page — for the same
 * "maxDuration is not inherited" reason docs/PLATFORM-NOTES.md §13 gives.
 *
 * The two Worker HTTP calls are NOT defined here any more: they live in
 * `@/server/telemetry/spool-drain-transport.ts` so this route and the
 * maintenance route cannot drift apart on the page limit, the timeout or the
 * auth envelope.
 */
export const maxDuration = 300;

/**
 * GET, not POST — same as `telemetry-maintenance`: Vercel Cron Jobs invoke
 * their configured path with GET (`vercel.json`).
 */
export async function GET(req: Request): Promise<Response> {
    const transport = createDrainTransportFromEnv(env, mintSandboxPreviewToken);
    return handleTelemetrySpoolDrain(req, {
        cronSecret: env.CRON_SECRET,
        db,
        drainPage: transport.drainPage,
        ack: transport.ack,
    });
}

import { db } from '@/server/db';
import { env } from '@/env';
import {
    deriveGuacamoleSandboxId,
    newCorrelationId,
    resolveCloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';
import { isPlacementReadEnabled } from '@/server/lib/compute/aws-config';
import { createCloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { readPlacement, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { ComputerRef } from '@/server/lib/compute/provider';
import { handleSandboxReap } from './handler';

/**
 * `GET /api/cron/sandbox-reap` — the BACKSTOP container reaper (see
 * `./handler.ts`'s module doc comment for the full rationale). The PRIMARY
 * fix for the billing bug this exists to contain is a Durable Object
 * idle-stop another workstream owns; this cron only catches what that
 * mechanism misses, once a day, and does so through the Worker's EXISTING
 * signed `DELETE /sandbox/:name` (already flushes to R2 then destroys — see
 * `worker/src/index.ts`'s `handleTerminate`). No new teardown path is
 * introduced here.
 *
 * 🔴 Vercel's Hobby plan REJECTS crons more frequent than daily at config
 * validation time, before the build even runs — this has already caused one
 * outage in this project. `vercel.json`'s entry for this route MUST stay
 * daily, at a minute that does not collide with the two existing crons
 * (`telemetry-maintenance` at `17 3 * * *`, `telemetry-drain` at
 * `43 3 * * *`).
 *
 * Guarded by `CRON_SECRET` (`@/env.ts`), the SAME secret the telemetry crons
 * use: unset -> 404, wrong/missing bearer -> 404 (fail closed, twice over —
 * see `./handler.ts`'s doc comment). ADDITIONALLY gated by the
 * `SANDBOX_REAP_CRON` kill switch (`off`/`false`/`0`/`disabled`/`no`, same
 * vocabulary as the Worker's own `SANDBOX_FOCUS`/`SANDBOX_RESTART`/
 * `SANDBOX_TELEMETRY_DRAIN` flags) — read directly off `process.env` rather
 * than added to the shared `@/env.ts` schema, mirroring how those Worker-side
 * flags are also plain non-secret operational toggles read straight off
 * `env`, not validated config: unset simply means "enabled", so adding this
 * route can never regress an environment that has never heard of the flag.
 *
 * `maxDuration` generous against `handler.ts`'s own bounded work (at most
 * `DEFAULT_MAX_CANDIDATES` status checks, `DEFAULT_MAX_REAP_PER_RUN`
 * terminate calls) — same "maxDuration is not inherited" reasoning
 * `telemetry-maintenance/route.ts` documents (`docs/PLATFORM-NOTES.md` §13).
 */
export const maxDuration = 90;

function guacamoleConfig() {
    return resolveCloudflareGuacamoleConfig();
}

/**
 * The reaper is a CLOUDFLARE-ONLY sweep: it addresses Cloudflare sandbox
 * names and the `lastOpenedAt` staleness rule only means anything for a
 * container the Worker idles. So it holds the Cloudflare adapter directly
 * rather than `selectComputeProvider` (placement-aware dispatch makes its
 * candidate SQL skip non-Cloudflare rows instead — plan row P3).
 *
 * The HMAC secret is read from `env`, exactly as this route did before the
 * seam, not from `process.env` like the router.
 */
const provider = createCloudflareComputeProvider({
    readHmacSecret: () => env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
});

/**
 * `handleSandboxReap` speaks in sandbox names (its tests pin that); the
 * provider speaks in computers. Every name the handler uses was derived by
 * `deriveSandboxName` in the same request, so the per-request map below is
 * total; an unknown name is a programming error, not a Worker answer.
 */
function refFor(refs: Map<string, ComputerRef>, sandboxName: string): ComputerRef {
    const ref = refs.get(sandboxName);
    if (!ref) throw new Error('sandbox_name_not_derived_this_run');
    return ref;
}

/**
 * `GET /sandbox/:name/status` — never wakes or touches the container (see
 * `worker/src/index.ts`'s `handleStatus` doc comment: it reads only Durable
 * Object storage / `ctx.container.running` via `getExposedPorts()`). A
 * transport failure or unconfigured provider is surfaced as a thrown error
 * so `handleSandboxReap` records it as `check_failed` rather than silently
 * treating "couldn't tell" as "not running" (which would skip a genuine
 * orphan) or "running" (which would attempt a terminate on bad information).
 */
async function checkRunning(computer: ComputerRef): Promise<boolean> {
    const config = guacamoleConfig();
    if (!config.isConfigured) {
        throw new Error('provider_not_configured');
    }
    const result = await provider.status({ correlationId: newCorrelationId() }, computer);
    if (!result.ok) {
        throw new Error(result.error ?? 'status_check_failed');
    }
    return result.guacamoleRunning === true;
}

/**
 * The Worker's EXISTING `DELETE /sandbox/:name` — same helper
 * `@/server/api/routers/computer.ts`'s `terminateComputerSandbox` uses for
 * the user-initiated delete path. No new teardown mechanism.
 */
async function terminate(
    computer: ComputerRef,
): Promise<{ ok: boolean; terminated: boolean; outcome?: string; error?: string }> {
    const config = guacamoleConfig();
    if (!config.isConfigured) {
        return { ok: false, terminated: false, error: 'provider_not_configured' };
    }
    return provider.stop({ correlationId: newCorrelationId() }, computer, 'idle_reap');
}

/**
 * GET, not POST: Vercel Cron Jobs invoke their configured path with GET
 * (`vercel.json`), same as `telemetry-maintenance` / `telemetry-drain`.
 */
export async function GET(req: Request): Promise<Response> {
    const refs = new Map<string, ComputerRef>();
    return handleSandboxReap(req, {
        cronSecret: env.CRON_SECRET,
        db,
        killSwitch: process.env.SANDBOX_REAP_CRON,
        // P3: with placement reads on, only Cloudflare computers are reap candidates
        // (an AWS host idle-stops itself). Reads go through placement.ts, the one
        // module that names the placement table (C-2). Off: no read, as before.
        ...(isPlacementReadEnabled(process.env)
            ? { providerOf: async (computerId: string) => (await readPlacement(db as unknown as PlacementExecutor, computerId)).provider }
            : {}),
        deriveSandboxName: (userId, computerId) => {
            const sandboxName = deriveGuacamoleSandboxId(userId, computerId);
            refs.set(sandboxName, { userId, computerId });
            return sandboxName;
        },
        checkRunning: (sandboxName) => checkRunning(refFor(refs, sandboxName)),
        terminate: (sandboxName) => terminate(refFor(refs, sandboxName)),
    });
}

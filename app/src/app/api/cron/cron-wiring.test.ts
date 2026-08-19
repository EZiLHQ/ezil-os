/**
 * The cron layer as Vercel actually invokes it: `vercel.json` -> a route file
 * -> the Worker.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Every hop of the R2 telemetry drain was verified working in isolation, and
 * the pipeline still delivered nothing for sixteen days, because the cron that
 * was supposed to start it was never invoked. `vercel.json` declared THREE
 * crons; the plan permits two. Unit tests of `runTelemetrySpoolDrain` cannot
 * see that, and neither could any test in this repo: nothing connected the
 * schedule to the route, or the route to the drain.
 *
 * So this file tests the seams rather than the parts:
 *   1. `vercel.json` declares at most two crons, and every declared path is a
 *      real route module that exports `GET` and an explicit `maxDuration`.
 *   2. Driving the REAL `/api/cron/telemetry-maintenance` handler with a real
 *      `Request` and the right bearer actually issues the Worker drain call —
 *      with the page limit that keeps the first run off the 20 s timeout.
 *   3. It does so even when the database half fails, which is the isolation
 *      guarantee the two-jobs-one-cron design rests on.
 *
 * `fetch` is stubbed because the Worker is not running here. Nothing else is:
 * the route module, the handler, the transport and the token minter are all
 * the shipped ones.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const APP_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CRON_SECRET = 'c'.repeat(40);
const WORKER_URL = 'https://worker.test';

interface CronEntry {
    path: string;
    schedule: string;
}

function vercelCrons(): CronEntry[] {
    const raw = readFileSync(path.join(APP_ROOT, 'vercel.json'), 'utf8');
    return (JSON.parse(raw) as { crons?: CronEntry[] }).crons ?? [];
}

describe('vercel.json cron manifest', () => {
    it('🔴 declares at most TWO crons — the plan ceiling that silently dropped the third', () => {
        // The third entry (`/api/cron/telemetry-drain`, `43 3 * * *`) was
        // registered here and never invoked: zero hour-03 Worker requests from
        // it since 2026-08-09, while the other two kept firing. The drain now
        // rides along with `telemetry-maintenance`, which is proven to fire.
        expect(vercelCrons().length).toBeLessThanOrEqual(2);
    });

    it('points every declared schedule at a route that exists and declares its own maxDuration', () => {
        for (const cron of vercelCrons()) {
            const routeFile = path.join(APP_ROOT, 'src', 'app', `${cron.path}`, 'route.ts');
            expect(existsSync(routeFile), `${cron.path} has no route.ts`).toBe(true);
            const src = readFileSync(routeFile, 'utf8');
            // Vercel Cron sends GET; a POST-only route would 405 forever.
            expect(src, `${cron.path} must export GET`).toMatch(/export async function GET\b/);
            // docs/PLATFORM-NOTES.md §13: maxDuration is not inherited, and the
            // platform default kills a long job in 10-15s.
            expect(src, `${cron.path} must declare maxDuration`).toMatch(/export const maxDuration\s*=\s*\d+/);
            expect(cron.schedule).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
        }
    });

    it('keeps the standalone drain route available for manual invocation', () => {
        // Removed from the schedule, NOT from the app: it is the only way to
        // force a drain between daily runs.
        expect(existsSync(path.join(APP_ROOT, 'src', 'app', 'api', 'cron', 'telemetry-drain', 'route.ts'))).toBe(true);
    });
});

describe('GET /api/cron/telemetry-maintenance — the real route, driven end to end', () => {
    const calls: { url: string; init: RequestInit }[] = [];

    beforeEach(() => {
        calls.length = 0;
        vi.stubEnv('SUPABASE_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/nope');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://stub.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'stub-anon-key');
        vi.stubEnv('CRON_SECRET', CRON_SECRET);
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', WORKER_URL);
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'h'.repeat(32));
        vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
            calls.push({ url: String(url), init });
            return Promise.resolve(
                new Response(JSON.stringify({ ok: true, objects: [], truncated: false }), {
                    headers: { 'content-type': 'application/json' },
                }),
            );
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    function cronRequest(auth?: string): Request {
        return new Request('https://ezil-os.vercel.app/api/cron/telemetry-maintenance', {
            method: 'GET',
            headers: auth ? { authorization: auth } : {},
        });
    }

    it('404s an unauthenticated caller before touching the Worker or the database', async () => {
        const { GET } = await import('./telemetry-maintenance/route');
        const res = await GET(cronRequest());
        expect(res.status).toBe(404);
        expect(calls).toHaveLength(0);
    });

    it('404s (never 401) a wrong bearer, so a prober cannot confirm the route exists', async () => {
        const { GET } = await import('./telemetry-maintenance/route');
        expect((await GET(cronRequest('Bearer wrong'))).status).toBe(404);
        expect(calls).toHaveLength(0);
    });

    it('🔴 actually drains the spool — and does so even though the database half fails', async () => {
        const { GET } = await import('./telemetry-maintenance/route');
        const res = await GET(cronRequest(`Bearer ${CRON_SECRET}`));
        const body = (await res.json()) as {
            ok: boolean;
            failed?: string[];
            drain?: { pagesDrained: number; drainFailures: number };
        };

        // The database is deliberately unreachable here, so retention throws...
        expect(body.failed).toContain('maintenance');
        expect(body.ok).toBe(false);
        expect(res.status).toBe(500);

        // ...and the drain still ran, reported, and reached the Worker. That is
        // the isolation guarantee: one half cannot take the other down.
        expect(body.drain).toBeDefined();
        expect(body.drain?.drainFailures).toBe(0);
        expect(calls.map((c) => c.url)).toContain(`${WORKER_URL}/telemetry/drain`);
    });

    it('🔴 sends an explicit page limit, which is what keeps the 173-object backlog off the 20 s abort', async () => {
        const { GET } = await import('./telemetry-maintenance/route');
        await GET(cronRequest(`Bearer ${CRON_SECRET}`));

        const drainCall = calls.find((c) => c.url.endsWith('/telemetry/drain'));
        expect(drainCall).toBeDefined();
        const sent = JSON.parse(String(drainCall!.init.body)) as { limit?: number };
        expect(sent.limit).toBe(25);

        // Signed with the same HMAC envelope every other Worker route requires.
        const auth = (drainCall!.init.headers as Record<string, string>).authorization;
        expect(auth).toMatch(/^Bearer t=\d+,v1=[0-9a-f]{64}$/);
    });
});

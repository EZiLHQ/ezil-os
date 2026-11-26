/**
 * Acceptance probe for the removed `/computer/<uuid>` page (2026-11-25).
 *
 * Anonymous, read-only, no browser, no account: a handful of GETs that do not
 * follow redirects. Run it against any deployed or local app:
 *
 *   EZIL_E2E_APP=https://os-staging.ezil.work node e2e/removed-computer-route.mjs
 *
 * Two shapes have to be checked, because they fail differently:
 *   - bare `/computer` never had a page, so it answered 404 before the removal
 *     too. On its own it proves nothing;
 *   - `/computer/<uuid>` was the dynamic page. While it is deployed, a signed-out
 *     request is bounced to `/login` (a 3xx) by its auth gate, for ANY uuid.
 *     Removed, it answers 404.
 * The controls are the surfaces that must still be there: signed out, each
 * still bounces to `/login` and carries its own path back.
 */
import { pathToFileURL } from 'node:url';

/** Synthetic: a well-formed id that belongs to nobody. The gate ran before any ownership check. */
export const PROBE_COMPUTER_ID = '9d5b0a1e-0000-4000-8000-000000000000';

export const REMOVED_PATHS = [
    '/computer',
    `/computer/${PROBE_COMPUTER_ID}`,
    `/computer/${PROBE_COMPUTER_ID.toUpperCase()}`,
    `/computer/${PROBE_COMPUTER_ID}?x=1`,
];

export const KEPT_PATHS = [
    '/computers',
    '/os',
    `/app/browser?computer=${PROBE_COMPUTER_ID}`,
    `/app/desktop?computer=${PROBE_COMPUTER_ID}`,
];

const isRedirect = status => status >= 300 && status < 400;

/** Where a response's `Location` points, as a URL on `app`; null when absent or unparseable. */
function locationOf(response, app) {
    const value = response.headers.get('location');
    if (!value) return null;
    try { return new URL(value, app); } catch { return null; }
}

/**
 * @param {{ app: string, headers?: Record<string, string>, fetch?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, results: Array<{ path: string, kind: 'removed' | 'kept', status: number, ok: boolean, reason?: string }> }>}
 */
export async function checkRemovedComputerRoute({ app, headers = {}, fetch: fetchImpl = fetch }) {
    const results = [];
    const get = path => fetchImpl(new URL(path, app), { method: 'GET', redirect: 'manual', headers });

    for (const path of REMOVED_PATHS) {
        const response = await get(path);
        const result = { path, kind: 'removed', status: response.status, ok: response.status === 404 };
        if (!result.ok) {
            const to = isRedirect(response.status) ? locationOf(response, app) : null;
            result.reason = to?.pathname === '/login' && to.origin === new URL(app).origin
                ? 'the legacy /computer/<uuid> page is still deployed: its auth gate redirected to /login'
                : `expected 404, got ${response.status}`;
        }
        results.push(result);
    }

    for (const path of KEPT_PATHS) {
        const response = await get(path);
        const to = isRedirect(response.status) ? locationOf(response, app) : null;
        const ok = to !== null && to.origin === new URL(app).origin && to.pathname === '/login'
            && to.searchParams.get('returnUrl') === path;
        const result = { path, kind: 'kept', status: response.status, ok };
        if (!ok) result.reason = `expected a redirect to /login?returnUrl=${path}, got ${response.status}`;
        results.push(result);
    }

    return { ok: results.every(result => result.ok), results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const { deployedTarget } = await import('./deployed-target.mjs');
    const { app, headers } = deployedTarget();
    const { ok, results } = await checkRemovedComputerRoute({ app, headers });
    // Paths and statuses only: never a header, so nothing secret can reach a log.
    for (const result of results) console.log(JSON.stringify({ app, ...result }));
    if (!ok) {
        console.error(`[removed-computer-route] FAIL on ${app}`);
        process.exit(1);
    }
    console.log(`[removed-computer-route] ok on ${app}`);
}

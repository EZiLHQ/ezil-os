// trpc.js — EZiL-authored. Not Puter code.
//
// A same-origin, NON-batched caller against the app's EXISTING tRPC endpoint
// (`/api/trpc/[trpc]`, `app/src/app/api/trpc/[trpc]/route.ts`). No new server
// code, no new npm dependency, no cloud service: this is EZiL's own
// first-party API — the same one `/computers` already calls through
// `httpBatchLink` — so it is exactly the kind of same-origin fetch
// `ezil/session.js` already does for `/api/shell/*`, not the "LOCAL CODE
// ONLY" backend this fork removed. `computer.list/create/rename/delete` have
// no shell-side Route Handler of their own (unlike session/desktop), so this
// file talks to the generic tRPC route directly instead of adding one —
// `session.js` is not owned by this task and the generic route already does
// everything a dedicated handler would.
//
// ── WIRE FORMAT — verified empirically, not assumed ─────────────────────────
// Ran the real dev server (`bun run dev -- --webpack`, matching `package.json`'s
// `dev` script) and curled it directly, unauthenticated, on 2026-08-01:
//
//   $ curl -i http://localhost:PORT/api/trpc/computer.list
//   HTTP/1.1 401 Unauthorized
//   {"error":{"json":{"message":"UNAUTHORIZED","code":-32001,
//             "data":{"code":"UNAUTHORIZED","httpStatus":401,...}}}}
//
//   $ curl -i -X POST http://localhost:PORT/api/trpc/computer.delete \
//       -H 'content-type: application/json' -d '{"json":{"id":"..."}}'
//   HTTP/1.1 401 Unauthorized   (same {"error":{"json":{...}}} shape)
//
// That confirms the NON-batched wire shape used below — a single object, not
// the array-indexed form `?batch=1` (what `httpBatchLink` sends) produces —
// and confirms superjson's `{json: ...}` envelope wraps both `result.data`
// and `error` at the top level.
//
// This file deliberately does NOT run `superjson.deserialize`. Every field
// the Computers tab reads (`id`, `name`, `slot`, `lastOpenedAt`, `createdAt`)
// survives as a JSON-safe string/number inside `.json` already — superjson's
// `meta` (which marks `Date`/`Map`/etc. for revival on the client) matters
// only if code needs a real `Date` object back, and this tab only ever
// formats a date STRING with `new Date(iso)`. Pulling in the actual
// `superjson` package (an app/ dependency, not a shell one) to save that one
// `new Date()` call was not worth a new dependency for a bundle whose whole
// point is having as few as possible.

const ENDPOINT = '/api/trpc';

/**
 * @param {string} path e.g. "computer.list"
 * @param {{method: 'GET'|'POST', input?: unknown}} opts
 * @returns {Promise<{ok: true, data: any} | {ok: false, code: string, message: string}>}
 */
async function send (path, { method, input }) {
    let url = `${ENDPOINT}/${path}`;
    let body;
    let headers;

    if ( method === 'GET' ) {
        if ( input !== undefined ) {
            url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
        }
    } else {
        headers = { 'content-type': 'application/json' };
        body = JSON.stringify({ json: input ?? {} });
    }

    let res;
    try {
        // Supabase's session lives in a cookie; same-origin credentials is
        // the whole auth story, exactly as in `ezil/session.js`'s `request()`.
        res = await fetch(url, { method, credentials: 'same-origin', headers, body });
    } catch {
        return { ok: false, code: 'NETWORK', message: 'Could not reach the server.' };
    }

    let parsed = null;
    try {
        parsed = await res.json();
    } catch {
        parsed = null;
    }

    if ( parsed?.error ) {
        const e = parsed.error.json ?? parsed.error;
        return {
            ok: false,
            code: e?.data?.code ?? `HTTP_${res.status}`,
            message: e?.message ?? 'Something went wrong.',
        };
    }
    if ( ! res.ok ) {
        return { ok: false, code: `HTTP_${res.status}`, message: 'Something went wrong.' };
    }

    const data = parsed?.result?.data;
    const value = (data && typeof data === 'object' && 'json' in data) ? data.json : data;
    return { ok: true, data: value };
}

/** A tRPC query — GET, idempotent, cacheable by nothing (no client cache here). */
export function query (path, input) {
    return send(path, { method: 'GET', input });
}

/** A tRPC mutation — POST. */
export function mutate (path, input) {
    return send(path, { method: 'POST', input });
}

export default { query, mutate };

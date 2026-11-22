#!/usr/bin/env node
/**
 * EZiL OS browser sidecar — the HTTP face of the desktop's real Chrome.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The desktop browser had exactly one input path: XTEST / `xdotool`. That
 * genuinely works (docs/NEKO-GROUND-TRUTH.md §f proves it with a synthetic
 * click that opened a tab), but it is blind coordinate clicking against a
 * video stream — the caller has no idea what is under the cursor. This gives
 * the same browser an addressable surface instead.
 *
 * ── The bind, stated exactly ────────────────────────────────────────────────
 *   Chrome's CDP:  127.0.0.1:9222   loopback ONLY, never exposed, never proxied
 *   this server:   0.0.0.0:9223     reached by `sandbox.containerFetch` from
 *                                   the Worker, NOT through preview-bridge.ts
 *                                   (which accepts 3002 and 8443 by design and
 *                                   whose narrowness is load-bearing)
 *
 * 🔴 The asymmetry is the whole design. CDP is unauthenticated and total.
 * Anything that can reach 9222 can read every page, exfiltrate the profile's
 * cookies and run arbitrary JS in any origin the browser is logged into. So
 * 9222 stays on loopback (Chromium M113+ enforces that anyway, and we do not
 * fight it), and what leaves the container is this fixed verb set — no
 * `evaluate`, no `raw`, no "forward this CDP command". See `verbs.mjs`.
 *
 * ── THE REDACTION CHOKE POINT IS IN THIS FILE ───────────────────────────────
 * `respond()` serializes all responses. For legacy automation payloads,
 * `redactDeep` runs there, on success responses and error responses alike. The
 * verb handlers deliberately do NOT redact — they emit what they see, and this
 * is what stops it. One guard, one place, so that deleting it turns the test
 * red and a reviewer can see in one diff whether the property still holds.
 * `redaction.test.mjs` is that test; `README.md` has the mutation procedure.
 *
 * ── Status codes ────────────────────────────────────────────────────────────
 * A verb-level failure answers HTTP 200 with `{ok:false,error,detail}`. The
 * contract makes `ok` the channel, and mixing transport failure with verb
 * failure is how a caller ends up reporting "the sidecar is down" for a typo
 * in a ref. Genuinely non-contract conditions (unknown path, wrong method,
 * oversized body) answer 404/405/413 — also in the error shape, so a caller
 * that only ever reads the body still gets a usable answer.
 *
 * ── Who may call a verb (browser verbs v2 §3) ───────────────────────────────
 * 🔴 Every `SIDECAR_WIRE` route takes `Authorization: Bearer
 * $EZIL_WORKER_BROWSER_MCP_TOKEN`, the per-sandbox token the Worker derives
 * and sends from `handleBrowserSidecar`. Missing, wrong or unset answers 401
 * with one fixed body, before the body is read and without touching the page.
 * Code chats reach the same verbs at `POST /internal/code/browser/<verb>`
 * with the Code bearer, no `Origin` header and a loopback peer (the guards of
 * the Code open-url route), and every page in `owner_app` or `idp_transit` is
 * `origin_read_only` there. That is agent policy, not confinement: see
 * `docs/contracts/browser-verbs-v2.md` §8.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CODE_BROWSER_PATH_PREFIX, CODE_BROWSER_VERBS, ERROR_CODES } from './contract.mjs';
import { VERBS } from './verbs.mjs';
import { redactDeep } from './redact.mjs';
import { isOriginPolicy, loadOriginPolicy, sanitizeText } from './origin-policy.mjs';
import { createMcpObservation, observationPayload, OBSERVE_PATH } from './mcp-observation.mjs';
import { browserUiPayload } from './mcp-observation-payload.mjs';
import { BROWSER_OPEN_PATH, CODE_BROWSER_OPEN_PATH, browserOpenFailure, createMcpBrowserOpen } from './mcp-browser-open.mjs';

const PORT = Number.parseInt(process.env.EZIL_SIDECAR_PORT ?? '9223', 10) || 9223;
const HOST = process.env.EZIL_SIDECAR_HOST ?? '0.0.0.0';
const CDP_PORT = Number.parseInt(process.env.EZIL_CDP_PORT ?? '9222', 10) || 9222;
const CDP_URL = process.env.EZIL_CDP_URL ?? `http://127.0.0.1:${CDP_PORT}`;

/** Request bodies are small by construction; anything larger is a mistake or
 *  an attempt to wedge the process. */
const MAX_BODY_BYTES = 256 * 1024;
const BROWSER_OPEN_BODY_BYTES = 4096;
/** What an observation may send without the Worker bearer: the legacy read (≤ 1024) and nothing larger. */
const OBSERVE_BODY_BYTES = 4096;
/**
 * What a bearer-authorised v2 observation may send. The largest is `fill_form`:
 * 20 fields of up to 4000 characters, which JSON can spell as up to 24,000
 * bytes each (`\uXXXX` escapes), plus the binding, handles and envelope that
 * the App and the Worker add. 513 KiB holds the worst case with room to spare.
 */
export const OBSERVE_CONTROL_BODY_BYTES = 513 * 1024;
const BOOT_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

function validBrowserOpenAuthorization (header, capability) {
    if (typeof capability !== 'string' || !BOOT_CAPABILITY.test(capability)
        || typeof header !== 'string' || header.length !== 50 || !header.startsWith('Bearer ')) return false;
    const value = header.slice(7);
    return BOOT_CAPABILITY.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(capability));
}

/** One request header, or undefined; never throws on a request without a header map. */
function headerOf (req, name) {
    const headers = req.headers;
    return headers && typeof headers === 'object' ? headers[name] : undefined;
}

/** The peer is this machine: the same check as the Code open-url route. */
function loopbackPeer (req) {
    return ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
}

/**
 * 🔴 The ONE body a refused credential gets, on every verb route. It is built
 * from nothing in the request, the page or the surface, so `respond()` writes
 * it as it is and never gathers secrets for it.
 */
const REFUSED = Object.freeze({ ok: false, error: 'bad_request', detail: 'Request failed.' });

/** Code chats never act on the user's signed-in apps or the IdP (contract §3). */
const CODE_DENIED_TIERS = Object.freeze(['owner_app', 'idp_transit']);

/**
 * An exception as it may reach the log: its stack (or its text) and its code,
 * with every URL in it through `sanitizeText` (§2). Playwright's call logs
 * quote full URLs, and on a callback or an IdP page those carry `code`,
 * `state` and the rest of `SENSITIVE_URL_PARAMS`. Never throws: a value that
 * cannot be printed is logged as fixed text.
 */
export function logText (err, policy) {
    try {
        let text = err instanceof Error
            ? (typeof err.stack === 'string' && err.stack ? err.stack : `${err.name}: ${err.message}`)
            : String(err);
        if (err !== null && typeof err === 'object' && typeof err.code === 'string') text += ` (code: ${err.code})`;
        return sanitizeText(text, policy);
    } catch {
        return '(an exception that could not be printed)';
    }
}

/** The complete set of routes. `VERBS` keys are `"<METHOD> <path>"`. */
export const ROUTES = Object.keys(VERBS);

/** Construct without binding or connecting, so the HTTP boundary can be tested offline. */
export function createSidecarServer (surface, {
    observe = createMcpObservation(surface, { allowedOrigins: process.env.EZIL_BROWSER_TEST_ALLOWED_ORIGINS }),
    browserOpen = createMcpBrowserOpen(surface, { allowedOrigins: process.env.EZIL_BROWSER_TEST_ALLOWED_ORIGINS }),
    workerBrowserOpenToken = process.env.EZIL_WORKER_BROWSER_MCP_TOKEN,
    workerBrowserControl = process.env.EZIL_WORKER_BROWSER_CONTROL === 'on',
    codeBrowserOpenToken = process.env.EZIL_CODE_BROWSER_MCP_TOKEN,
} = {}) {
    const codeBinding = typeof codeBrowserOpenToken === 'string' && BOOT_CAPABILITY.test(codeBrowserOpenToken)
        ? createHash('sha256').update('EZIL-CODE-BROWSER-OPEN/1\0').update(codeBrowserOpenToken).digest('hex')
        : null;
    /** The surface's own origin policy, or the one this environment loads: what the log sanitises with. */
    let logPolicy;
    const loggable = (err) => logText(err, logPolicy ??= isOriginPolicy(surface?.originPolicy)
        ? surface.originPolicy
        : loadOriginPolicy(process.env));
    /**
     * Serialise, REDACT, and write. Nothing else in this process writes a body.
     *
     * The secret set is gathered here rather than being passed in, because a
     * handler that threw halfway is exactly the case where the caller most needs
     * this to still happen — `surface.allSecrets()` falls back to the values this
     * process has typed when the page can no longer be read at all.
     */
    async function respond (res, status, payload, kind) {
        // The observer's closed metadata has no page content. It must never
        // inspect passwords to redact a response.
        let safe;
        if (kind === 'observation') safe = observationPayload(payload);
        else if (kind === 'browser-ui') safe = browserUiPayload(payload);
        // The open receipt is constructed from closed fields in the private
        // handler and must not inspect the desktop user's existing pages.
        else if (kind === 'browser-open') safe = payload;
        // A refused credential gets the one constant, whatever was passed.
        else if (kind === 'refused') safe = REFUSED;
        else {
            const secrets = await surface.allSecrets();
            safe = redactDeep(payload, secrets);
        }
        const body = Buffer.from(JSON.stringify(safe), 'utf8');
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.length),
            'cache-control': 'no-store',
        });
        res.end(body);
    }

    // Fixed text only: built from the constant route list, never from the request.
    const UNKNOWN_VERB_DETAIL = `Unknown verb. This surface is a fixed verb set (${ROUTES.join(', ')}) and has no CDP passthrough.`;
    const UNKNOWN_CODE_VERB_DETAIL = `Unknown verb. Code chats reach ${CODE_BROWSER_PATH_PREFIX}<verb> for a fixed verb set `
        + `(${CODE_BROWSER_VERBS.join(', ')}) and there is no CDP passthrough.`;

    function errorPayload (code, detail = 'Request failed.') {
        // Return a value from the fixed contract, never an exception's own string.
        const safeCode = ERROR_CODES.find((known) => known === code) ?? 'chrome_unreachable';
        return { ok: false, error: safeCode, detail };
    }

    function readBody (req, limit = MAX_BODY_BYTES) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > limit) {
                    reject(Object.assign(new Error('request body too large'), { httpStatus: 413, code: 'bad_request' }));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
        });
    }

    const server = createServer((req, res) => {
        void handle(req, res).catch(async (err) => {
            console.error('[ezil-sidecar] request failed:', loggable(err));
            try {
                await respond(res, 200, errorPayload('chrome_unreachable'));
            } catch { /* the socket is already gone */ }
        });
    });

    async function handle (req, res) {
        const method = (req.method || 'GET').toUpperCase();
        // Query strings and trailing slashes are normalised away so a caller
        // cannot reach a verb by a path the contract does not name.
        const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
        const key = `${method} ${path}`;
        // The private observation has a closed metadata response with no
        // page text. It deliberately does not inspect passwords to redact it.
        if (path === BROWSER_OPEN_PATH || path === CODE_BROWSER_OPEN_PATH) {
            return handleBrowserOpen(req, res, method, path);
        }
        if (req.url === OBSERVE_PATH && method === 'POST') {
            let outcome = { ok: false, error: 'browser_invalid_request' };
            let modern = false;
            // Only a bearer-authorised control caller may send a v2-sized body;
            // the unauthenticated legacy read keeps its small bound.
            const authorized = workerBrowserControl
                && validBrowserOpenAuthorization(headerOf(req, 'authorization'), workerBrowserOpenToken);
            try {
                const raw = await readBody(req, authorized ? OBSERVE_CONTROL_BODY_BYTES : OBSERVE_BODY_BYTES);
                const input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
                modern = input !== null && typeof input === 'object' && Object.hasOwn(input, 'action');
                if (modern && !authorized) {
                    return respond(res, 401, { ok: false, error: 'browser_unavailable' }, 'browser-ui');
                }
                if (modern || raw.byteLength <= 1024) {
                    const cancel = new AbortController();
                    const disconnect = () => cancel.abort();
                    res.once('close', disconnect);
                    try {
                        outcome = await observe(input, cancel.signal);
                    } finally {
                        res.off('close', disconnect);
                    }
                }
            } catch { /* The closed error contains no input or provider data. */ }
            return respond(res, 200, outcome, modern ? 'browser-ui' : 'observation');
        }
        if (path.startsWith(CODE_BROWSER_PATH_PREFIX)) return handleCodeBrowserVerb(req, res, method, path);

        const handler = VERBS[key];
        if (!handler) {
            // A path that exists under another method is a 405, so a caller that
            // GETs a POST verb is told what is wrong rather than that it invented
            // the verb.
            const otherMethod = ROUTES.some((r) => r.endsWith(` ${path}`));
            return respond(
                res,
                otherMethod ? 405 : 404,
                errorPayload('bad_request', UNKNOWN_VERB_DETAIL),
            );
        }

        // 🔴 THE VERB BEARER. Checked before the body is read, so a caller
        // without it can neither drive the browser nor make this process
        // buffer a body, and the refusal never touches the page.
        if (!validBrowserOpenAuthorization(headerOf(req, 'authorization'), workerBrowserOpenToken)) {
            return respond(res, 401, null, 'refused');
        }

        let body = {};
        if (method !== 'GET') {
            body = await verbBody(req, res);
            if (body === null) return undefined;
        }

        try {
            const payload = await handler(surface, body);
            return respond(res, 200, payload);
        } catch (err) {
            console.error('[ezil-sidecar] verb failed:', loggable(err));
            return respond(res, 200, errorPayload(err?.code));
        }
    }

    /**
     * A verb request's JSON object body, or null once the refusal has been
     * written (400/413 for an unreadable or oversized body, `bad_request` at
     * 200 for anything that is not one JSON object).
     */
    async function verbBody (req, res) {
        let raw;
        try {
            raw = await readBody(req);
        } catch (err) {
            console.error('[ezil-sidecar] body read failed:', loggable(err));
            await respond(res, err?.httpStatus === 413 ? 413 : 400, errorPayload('bad_request'));
            return null;
        }
        let body = {};
        if (raw.length > 0) {
            try {
                body = JSON.parse(raw.toString('utf8'));
            } catch (err) {
                console.error('[ezil-sidecar] invalid JSON:', loggable(err));
                await respond(res, 200, errorPayload('bad_request'));
                return null;
            }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            await respond(res, 200, errorPayload('bad_request'));
            return null;
        }
        return body;
    }

    /**
     * `POST /internal/code/browser/<verb>`: a Code chat's own door to the
     * `CODE_BROWSER_VERBS`. The path is exact (no query, no trailing slash);
     * the guards are the Code open-url route's, all three; the body and the
     * answer are the `SIDECAR_WIRE` entry for `POST /<verb>`, through the same
     * redacting `respond()`. Every page in `owner_app` or `idp_transit` is
     * `origin_read_only` here: the verbs enforce `denyTiers` themselves.
     */
    async function handleCodeBrowserVerb (req, res, method, path) {
        const verb = path.slice(CODE_BROWSER_PATH_PREFIX.length);
        const route = `POST /${verb}`;
        if (req.url !== path || !CODE_BROWSER_VERBS.includes(verb) || !Object.hasOwn(VERBS, route)) {
            return respond(res, 404, errorPayload('bad_request', UNKNOWN_CODE_VERB_DETAIL));
        }
        if (method !== 'POST') return respond(res, 405, errorPayload('bad_request', UNKNOWN_CODE_VERB_DETAIL));
        if (headerOf(req, 'origin') !== undefined || !loopbackPeer(req)
            || !validBrowserOpenAuthorization(headerOf(req, 'authorization'), codeBrowserOpenToken)) {
            return respond(res, 401, null, 'refused');
        }
        const body = await verbBody(req, res);
        if (body === null) return undefined;
        try {
            const payload = await VERBS[route](surface, body, { denyTiers: new Set(CODE_DENIED_TIERS) });
            return respond(res, 200, payload);
        } catch (err) {
            console.error('[ezil-sidecar] code verb failed:', loggable(err));
            return respond(res, 200, errorPayload(err?.code));
        }
    }

    async function handleBrowserOpen (req, res, method, path) {
        const fail = (status, error, stage) => respond(res, status, browserOpenFailure(null, error, stage), 'browser-open');
        if (req.url !== path || method !== 'POST') return fail(404, 'browser_unavailable', 'authorization');

        const code = path === CODE_BROWSER_OPEN_PATH;
        const capability = code ? codeBrowserOpenToken : workerBrowserOpenToken;
        const loopback = ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        if (req.headers.origin !== undefined || (code && !loopback)
            || !validBrowserOpenAuthorization(req.headers.authorization, capability)) {
            return fail(401, 'browser_unavailable', 'authorization');
        }

        const disconnect = new AbortController();
        const onDisconnect = () => disconnect.abort();
        res.once('close', onDisconnect);
        req.once('aborted', onDisconnect);
        try {
            const bytes = await readBody(req, BROWSER_OPEN_BODY_BYTES);
            let input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
            if (code) {
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
                    || !Object.keys(input).every(key => ['requestId', 'url', 'timeoutMs'].includes(key))) {
                    return fail(400, 'destination_denied', 'request');
                }
                input = { ...input, binding: codeBinding };
            }
            const result = await browserOpen(input, disconnect.signal);
            if (!res.destroyed) return respond(res, 200, result, 'browser-open');
        } catch (error) {
            if (!res.destroyed) return fail(error?.httpStatus ?? 400, 'destination_denied', 'request');
        } finally {
            req.off('aborted', onDisconnect);
            res.off('close', onDisconnect);
        }
    }

    return server;
}

async function startServer () {
    const { BrowserSurface } = await import('./browser.mjs');
    const surface = new BrowserSurface(CDP_URL);
    const server = createSidecarServer(surface);
    server.listen(PORT, HOST, () => {
        console.log(`[ezil-sidecar] listening on ${HOST}:${PORT}, CDP ${CDP_URL}`);
        console.log(`[ezil-sidecar] verbs: ${ROUTES.join(', ')}`);
        console.log('[ezil-sidecar] no CDP passthrough verb exists; none may be added');
        // Warm the connection so `/health` answers truthfully on the first call
        // instead of reporting a disconnected browser that is in fact fine.
        surface.connect().then(
            () => console.log('[ezil-sidecar] connected to Chrome over CDP'),
            (err) => console.log(`[ezil-sidecar] Chrome not reachable yet: ${sanitizeText(String(err?.message ?? err), surface.originPolicy)}`),
        );
    });

    // A sidecar that cannot bind must not take the boot down with it — the
    // launcher in start-neko.sh already treats a missing listener as a skipped
    // phase. Log and exit, so the supervisor's picture is accurate.
    server.on('error', (err) => {
        console.error(`[ezil-sidecar] listen failed: ${err.message}`);
        process.exit(1);
    });

    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            console.log(`[ezil-sidecar] ${signal} — closing`);
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 2000).unref();
        });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await startServer();
}

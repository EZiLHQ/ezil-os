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
 * `respond()` below is the ONLY place a payload becomes bytes on a socket, and
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
 */

import { createServer } from 'node:http';
import { BrowserSurface } from './browser.mjs';
import { VERBS } from './verbs.mjs';
import { redactDeep } from './redact.mjs';

const PORT = Number.parseInt(process.env.EZIL_SIDECAR_PORT ?? '9223', 10) || 9223;
const HOST = process.env.EZIL_SIDECAR_HOST ?? '0.0.0.0';
const CDP_PORT = Number.parseInt(process.env.EZIL_CDP_PORT ?? '9222', 10) || 9222;
const CDP_URL = process.env.EZIL_CDP_URL ?? `http://127.0.0.1:${CDP_PORT}`;

/** Request bodies are small by construction; anything larger is a mistake or
 *  an attempt to wedge the process. */
const MAX_BODY_BYTES = 256 * 1024;

/** The complete set of routes. `VERBS` keys are `"<METHOD> <path>"`. */
export const ROUTES = Object.keys(VERBS);

const surface = new BrowserSurface(CDP_URL);

/**
 * Serialise, REDACT, and write. Nothing else in this process writes a body.
 *
 * The secret set is gathered here rather than being passed in, because a
 * handler that threw halfway is exactly the case where the caller most needs
 * this to still happen — `surface.allSecrets()` falls back to the values this
 * process has typed when the page can no longer be read at all.
 */
async function respond (res, status, payload) {
    const secrets = await surface.allSecrets();
    const safe = redactDeep(payload, secrets);
    const body = Buffer.from(JSON.stringify(safe), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
    });
    res.end(body);
}

function errorPayload (code, message) {
    return { ok: false, error: code, detail: message };
}

function readBody (req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
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
        try {
            await respond(res, 200, errorPayload('chrome_unreachable', String(err && err.message ? err.message : err)));
        } catch { /* the socket is already gone */ }
    });
});

async function handle (req, res) {
    const method = (req.method || 'GET').toUpperCase();
    // Query strings and trailing slashes are normalised away so a caller
    // cannot reach a verb by a path the contract does not name.
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    const key = `${method} ${path}`;

    const handler = VERBS[key];
    if (!handler) {
        // A path that exists under another method is a 405, so a caller that
        // GETs a POST verb is told what is wrong rather than that it invented
        // the verb.
        const otherMethod = ROUTES.some((r) => r.endsWith(` ${path}`));
        return respond(
            res,
            otherMethod ? 405 : 404,
            errorPayload('bad_request', otherMethod
                ? `${path} is ${ROUTES.find((r) => r.endsWith(` ${path}`))}`
                : `no such verb: ${key}. This surface is a fixed verb set (${ROUTES.join(', ')}) and has no CDP passthrough.`),
        );
    }

    let body = {};
    if (method !== 'GET') {
        let raw;
        try {
            raw = await readBody(req);
        } catch (err) {
            return respond(res, err.httpStatus ?? 400, errorPayload('bad_request', err.message));
        }
        if (raw.length > 0) {
            try {
                body = JSON.parse(raw.toString('utf8'));
            } catch (err) {
                return respond(res, 200, errorPayload('bad_request', `body is not JSON: ${err.message}`));
            }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return respond(res, 200, errorPayload('bad_request', 'body must be a JSON object'));
        }
    }

    try {
        const payload = await handler(surface, body);
        return respond(res, 200, payload);
    } catch (err) {
        const code = err && err.code ? err.code : 'chrome_unreachable';
        const detail = err && err.message ? err.message : String(err);
        return respond(res, 200, errorPayload(code, detail));
    }
}

server.listen(PORT, HOST, () => {
    console.log(`[ezil-sidecar] listening on ${HOST}:${PORT}, CDP ${CDP_URL}`);
    console.log(`[ezil-sidecar] verbs: ${ROUTES.join(', ')}`);
    console.log('[ezil-sidecar] no CDP passthrough verb exists; none may be added');
    // Warm the connection so `/health` answers truthfully on the first call
    // instead of reporting a disconnected browser that is in fact fine.
    surface.connect().then(
        () => console.log('[ezil-sidecar] connected to Chrome over CDP'),
        (err) => console.log(`[ezil-sidecar] Chrome not reachable yet: ${err.message}`),
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

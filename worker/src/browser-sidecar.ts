/**
 * Worker-side plumbing for the browser sidecar (`worker/sidecar/`).
 *
 * ── What is exposed, and what deliberately is NOT ───────────────────────────
 * The sidecar listens on `0.0.0.0:9223` inside the container and is reached by
 * `sandbox.containerFetch`. It is **not** `exposePort()`d and it is **not**
 * carried by `preview-bridge.ts`.
 *
 * 🔴 That is a decision, not an omission, and it is the one place this module
 * deviates from a literal reading of "expose 9223 alongside 8181/3002/8443".
 * `exposePort()` mints a public preview hostname (`<port>-<id>-<token>.<zone>`)
 * that `proxyToSandbox()` raw-forwards into the container with **no
 * authentication of any kind** — that is exactly what makes it right for a
 * desktop stream a user is meant to open in an iframe, and exactly what makes
 * it catastrophic here. The sidecar can navigate the user's logged-in browser,
 * read every page it can see, and type into it. Publishing that on a guessable
 * hostname would hand the whole session to anyone who could construct the URL,
 * and it would do so while the sidecar's own careful narrowness (a fixed verb
 * set, no CDP passthrough) stayed perfectly intact and perfectly beside the
 * point.
 *
 * `preview-bridge.ts` is the other tempting answer and is also wrong: that file
 * accepts 3002 and 8443 and nothing else BY DESIGN, its narrowness is
 * load-bearing, and widening it to admit a third port would be the same
 * mistake made in a smaller font. It is also a cookie/token-gated *browser*
 * bridge, and the sidecar's caller is a server.
 *
 * So the exposure is: an HMAC-gated Worker route, one verb per request, drawn
 * from a fixed allowlist, forwarded over `containerFetch`. The container port
 * is reachable from the Worker and from nowhere else.
 *
 * ── The allowlist is a second lock on the same door ─────────────────────────
 * The sidecar already refuses anything outside its verb set. This list refuses
 * it again, before a request ever reaches the container. Two locks because the
 * property being protected — "there is no way to send arbitrary CDP through
 * this" — is the one that cannot be recovered after it is lost, and because
 * the Worker's copy is the one an operator can read without opening a
 * container.
 */

import { BROWSER_SIDECAR_PORT } from './desktop-mode';

export { BROWSER_SIDECAR_PORT };

/**
 * The verbs this Worker will forward. Same set as
 * `worker/sidecar/contract.mjs`, asserted against the pinned wire contract by
 * `./browser-sidecar-contract.test.ts`.
 *
 * 🔴 `evaluate`, `raw`, `send`, `cdp`, `exec` and `eval` are absent and must
 * stay absent. A passthrough verb does not extend the sidecar; it deletes its
 * reason to exist.
 */
export const BROWSER_SIDECAR_VERBS = [
    'health',
    'navigate',
    'snapshot',
    'click',
    'type',
    'get_text',
    'screenshot',
    'console',
    'network',
    'wait_for',
] as const;

export type BrowserSidecarVerb = (typeof BROWSER_SIDECAR_VERBS)[number];

/** `health` is the only GET; everything else is a POST, per the contract. */
export const BROWSER_SIDECAR_GET_VERBS: readonly BrowserSidecarVerb[] = ['health'];

/**
 * Bound on a forwarded response. A `/screenshot` of a 1920x1080 desktop is a
 * few hundred KB of base64; a `fullPage` capture of a long document is larger.
 * 24 MB is generous for that and still refuses a response that could only be
 * an accident or an attempt to wedge the Worker.
 */
export const BROWSER_SIDECAR_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

/** How long a single verb may take end-to-end before the Worker gives up. */
export const BROWSER_SIDECAR_TIMEOUT_MS = 45_000;

export interface ResolvedSidecarVerb {
    ok: true;
    verb: BrowserSidecarVerb;
    method: 'GET' | 'POST';
    /** The in-container URL to forward to. */
    url: string;
}

export interface RejectedSidecarVerb {
    ok: false;
    error: string;
}

/**
 * Validate a requested verb against the allowlist and build the in-container
 * URL for it.
 *
 * Everything about this is deliberately literal: an exact match against a
 * fixed array, no normalisation beyond case, no path segments, no query
 * string. A verb is a name from a list, never a path the caller composed —
 * that is what stops `../` or `json/new` (CDP's own tab-opening endpoint)
 * from arriving at 9223 dressed as a verb.
 */
export function resolveSidecarVerb(
    rawVerb: string | undefined,
    method: string,
    port: number = BROWSER_SIDECAR_PORT,
): ResolvedSidecarVerb | RejectedSidecarVerb {
    const verb = (rawVerb ?? '').trim().toLowerCase();
    if (!verb) return { ok: false, error: 'browser_verb_missing' };
    if (!(BROWSER_SIDECAR_VERBS as readonly string[]).includes(verb)) {
        return {
            ok: false,
            error:
                `browser_verb_not_allowed: '${verb}'. This surface is a fixed verb set `
                + `(${BROWSER_SIDECAR_VERBS.join(', ')}) and has no CDP passthrough.`,
        };
    }
    const allowed = BROWSER_SIDECAR_GET_VERBS.includes(verb as BrowserSidecarVerb) ? 'GET' : 'POST';
    const requested = method.toUpperCase();
    if (requested !== allowed) {
        return { ok: false, error: `browser_verb_method_mismatch: '${verb}' is ${allowed}, not ${requested}` };
    }
    return {
        ok: true,
        verb: verb as BrowserSidecarVerb,
        method: allowed,
        url: `http://127.0.0.1:${port}/${verb}`,
    };
}

/**
 * The body forwarded to the sidecar.
 *
 * The Worker's own HMAC envelope travels in `token`, which is a Worker concern
 * and must not reach the container — the sidecar has no use for it and a
 * credential that travels further than it needs to is a credential in more
 * logs than it needs to be in. Everything else is passed through untouched:
 * the sidecar validates its own arguments and is the only thing that should.
 */
export function sidecarRequestBody(body: Record<string, unknown>): string {
    const forwarded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'token') continue;
        forwarded[key] = value;
    }
    return JSON.stringify(forwarded);
}

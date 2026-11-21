/**
 * THIS SIDE'S DECLARATION OF THE WIRE — v2.
 *
 * v1 was pinned by
 * `EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json`, and that
 * JSON still pins v1: every v1 route, member and error code below is unchanged,
 * so v1 is a strict subset of this file. v2 is ADDITIVE and its authority is
 * this file plus `docs/contracts/browser-verbs-v2.md` (the prose for what data
 * cannot say: origin tiers, URL sanitising, the accepted limit).
 *
 * This file is the producer's restatement AS DATA, so that two things can be
 * checked mechanically rather than by reading:
 *
 *   1. `worker/src/browser-sidecar-contract.test.ts` asserts that the pinned v1
 *      JSON is contained in this file — route for route, member for member,
 *      code for code — and that the only additions are `V2_ROUTES`.
 *      A rename on this side goes red there rather than in production.
 *   2. `worker/sidecar/wire.test.mjs` drives every handler in `verbs.mjs`
 *      against a fake browser and asserts the keys it actually returns are the
 *      ones declared here. A handler that quietly drops `redacted` or renames
 *      `sha256` goes red without needing a container.
 *
 * `verbs.mjs` additionally asserts at load time that its handler set and this
 * route list are the same set, so a server whose routes have drifted from its
 * own declaration refuses to start rather than serving the wrong wire.
 *
 * Nothing here is prose. A brief is not a contract; a contract is a file.
 */

/** Wire version. v1 callers see no change; v2 adds routes and one error code. */
export const WIRE_VERSION = '2';

/** Transport facts, asserted against the contract's `transport` block. */
export const TRANSPORT = {
    port: 9223,
    bind: '0.0.0.0',
    cdpPort: 9222,
    cdpBind: '127.0.0.1',
};

/**
 * Verb names that must NEVER exist here, checked as a set rather than trusted
 * to a comment. Adding any of them as a route makes the contract test red.
 * Unchanged in v2. There is no `upload` verb either.
 */
export const FORBIDDEN_VERBS = ['evaluate', 'raw', 'send', 'cdp', 'exec', 'eval'];

/**
 * The error codes a caller may receive. v2 adds `origin_read_only`: the page the
 * verb would act on is in a tier that does not allow that verb (see
 * `ORIGIN_TIER_VERBS`). `server.mjs` reports any code not in this list as
 * `chrome_unreachable`, so a code must be declared here before it is thrown.
 */
export const ERROR_CODES = [
    'chrome_unreachable',
    'bad_ref',
    'stale_ref',
    'navigation_failed',
    'timeout',
    'bad_request',
    'origin_read_only',
];

/**
 * route -> { request: {member: required}, response: [members] }
 *
 * `request` values are `true` for required and `false` for optional, matching
 * the pinned JSON's `"boolean?"` / `"string?"` suffix convention.
 */
export const SIDECAR_WIRE = {
    'GET /health': {
        request: {},
        response: ['ok', 'chromeConnected', 'cdpUrl'],
    },
    'POST /navigate': {
        request: { url: true },
        response: ['ok', 'url', 'title'],
    },
    'POST /snapshot': {
        request: {},
        response: ['ok', 'snapshot', 'url', 'title'],
    },
    'POST /click': {
        request: { ref: true },
        response: ['ok', 'url'],
    },
    'POST /type': {
        request: { ref: true, text: true, submit: false },
        response: ['ok', 'url', 'redacted'],
    },
    'POST /get_text': {
        request: { ref: false },
        response: ['ok', 'markdown', 'url'],
    },
    'POST /screenshot': {
        request: { ref: false, fullPage: false },
        response: ['ok', 'pngBase64', 'sha256', 'byteSize', 'width', 'height'],
    },
    'POST /console': {
        request: { level: false },
        response: ['ok', 'entries'],
    },
    'POST /network': {
        request: { filter: false },
        response: ['ok', 'requests'],
    },
    'POST /wait_for': {
        request: { text: false, time: false },
        response: ['ok', 'matched'],
    },
    // ── v2 (additive) ───────────────────────────────────────────────────────
    /**
     * `fields`: 1..FILL_FORM_MAX_FIELDS of `{ref, value}`, `value` a string of at
     * most FIELD_VALUE_MAX_CHARS. Every ref is resolved BEFORE any field is
     * filled: one bad or stale ref fills nothing. `filled` is the count filled;
     * `redacted` is the count of password fields among them (their values are
     * registered as secrets before filling, exactly like `/type`).
     */
    'POST /fill_form': {
        request: { fields: true },
        response: ['ok', 'url', 'filled', 'redacted'],
    },
    /**
     * `values`: 1..SELECT_MAX_VALUES option labels or values. The ref must be a
     * combobox or listbox; anything else is `bad_ref`. `selected` is the list of
     * option values now selected.
     */
    'POST /select': {
        request: { ref: true, values: true },
        response: ['ok', 'url', 'selected'],
    },
    /**
     * Exactly one of `ref` (scroll that element into view) or `dy` (an integer
     * with |dy| <= SCROLL_MAX_DY, scroll the window by that many CSS pixels).
     * Both or neither is `bad_request`. `scrollY` is the window's offset after.
     */
    'POST /scroll': {
        request: { ref: false, dy: false },
        response: ['ok', 'url', 'scrollY'],
    },
    /**
     * `key` must be exactly one of PRESS_KEYS; anything else is `bad_request`.
     * With `ref` the key goes to that element, without it to the focused one.
     */
    'POST /press': {
        request: { ref: false, key: true },
        response: ['ok', 'url'],
    },
};

/** The ten v1 routes, exactly as the pinned EZiL-Works JSON declares them. */
export const V1_ROUTES = [
    'GET /health',
    'POST /navigate',
    'POST /snapshot',
    'POST /click',
    'POST /type',
    'POST /get_text',
    'POST /screenshot',
    'POST /console',
    'POST /network',
    'POST /wait_for',
];

/** The only routes v2 adds. `SIDECAR_WIRE` is exactly V1_ROUTES + V2_ROUTES. */
export const V2_ROUTES = ['POST /fill_form', 'POST /select', 'POST /scroll', 'POST /press'];

/** The error body every failure uses. */
export const ERROR_SHAPE = ['ok', 'error', 'detail'];

// ── v2 bounds ───────────────────────────────────────────────────────────────

export const FILL_FORM_MAX_FIELDS = 20;
export const FIELD_VALUE_MAX_CHARS = 4000;
export const SELECT_MAX_VALUES = 20;
export const SCROLL_MAX_DY = 5000;

/**
 * The closed key list for `/press`. A key name is matched exactly; there are no
 * chords beyond Shift+Tab and no character keys (text goes through `/type`).
 */
export const PRESS_KEYS = [
    'Enter',
    'Tab',
    'Shift+Tab',
    'Escape',
    'Backspace',
    'Delete',
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
];

// ── v2 origin tiers (implemented by `origin-policy.mjs`) ────────────────────

/**
 * Tier origins come ONLY from these two variables: comma-separated bare https
 * origins (`https://host`, no path, no port unless explicit, no wildcard). A
 * malformed entry empties that tier (fail closed) and is logged once at boot.
 * `EZIL_BROWSER_TEST_ALLOWED_ORIGINS` is not a tier source and never will be.
 */
export const ORIGIN_TIER_ENV = {
    owner_app: 'EZIL_BROWSER_OWNER_APP_ORIGINS',
    idp_transit: 'EZIL_BROWSER_IDP_ORIGINS',
};

/** `tierOf(url)` returns exactly one of these. `other` is v1 behaviour plus the v2 verbs. */
export const ORIGIN_TIERS = ['owner_app', 'idp_transit', 'other'];

/**
 * Verbs allowed while the page a verb acts on is `idp_transit`. Every other
 * route there is `origin_read_only`: no refs, typing, text, screenshots or
 * frames. `/wait_for` is allowed with `time` only; `text` makes it
 * `origin_read_only`. `owner_app` and `other` allow every route.
 */
export const IDP_TRANSIT_ROUTES = ['GET /health', 'POST /navigate', 'POST /wait_for'];

/**
 * Query or fragment parameter names whose presence strips the WHOLE query and
 * fragment from a URL before it is returned (`sanitizeUrl`). `idp_transit`
 * URLs are always reduced to origin + path, whatever their parameters.
 */
export const SENSITIVE_URL_PARAMS = [
    'code',
    'state',
    'id_token',
    'access_token',
    'refresh_token',
    'token',
    'session_transfer_token',
    'nonce',
    'ticket',
    'code_verifier',
];

// ── v2 Code-chat loopback (served by `server.mjs`) ──────────────────────────

/**
 * Code chats reach the sidecar at `POST <CODE_BROWSER_PATH_PREFIX><verb>` on
 * 127.0.0.1:9223 with `Authorization: Bearer $EZIL_CODE_BROWSER_MCP_TOKEN`, no
 * `Origin` header, from a loopback peer. Request and response bodies are the
 * `SIDECAR_WIRE` entry for `POST /<verb>`. Pages in `owner_app` or
 * `idp_transit` answer `origin_read_only` on this path. That is agent policy,
 * NOT confinement: code in the computer can reach CDP on 9222 directly (see
 * `docs/contracts/browser-verbs-v2.md`, "Accepted limit").
 * `<prefix>open-url` keeps its existing v1 body and is not listed here.
 */
export const CODE_BROWSER_PATH_PREFIX = '/internal/code/browser/';
export const CODE_BROWSER_VERBS = [
    'navigate',
    'snapshot',
    'click',
    'type',
    'fill_form',
    'select',
    'scroll',
    'press',
    'get_text',
    'screenshot',
    'console',
    'network',
    'wait_for',
];

/**
 * THIS SIDE'S DECLARATION OF THE PINNED WIRE.
 *
 * The authority is
 * `EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json`.
 * This file is the producer's restatement of it AS DATA, so that two things
 * can be checked mechanically rather than by reading:
 *
 *   1. `worker/src/browser-sidecar-contract.test.ts` asserts this file against
 *      the pinned JSON — route for route, member for member, code for code.
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
 */
export const FORBIDDEN_VERBS = ['evaluate', 'raw', 'send', 'cdp', 'exec', 'eval'];

/** The error codes a caller may receive. */
export const ERROR_CODES = [
    'chrome_unreachable',
    'bad_ref',
    'stale_ref',
    'navigation_failed',
    'timeout',
    'bad_request',
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
};

/** The error body every failure uses. */
export const ERROR_SHAPE = ['ok', 'error', 'detail'];

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { createSidecarServer, OBSERVE_CONTROL_BODY_BYTES } from './server.mjs';
import {
    CODE_BROWSER_PATH_PREFIX, CODE_BROWSER_VERBS, ERROR_CODES, ORIGIN_TIER_ENV, SIDECAR_WIRE,
} from './contract.mjs';
import { loadOriginPolicy } from './origin-policy.mjs';
import { OBSERVE_PATH } from './mcp-observation.mjs';

const PRIVATE_MESSAGE = 'private SDK message with /srv/internal/source.js and token=private';
const PRIVATE_STACK = 'Error: private stack\n    at secret (/srv/internal/source.js:42:7)';

/** Per-sandbox tokens in the boot format (43 base64url characters); test values only. */
const WORKER_TOKEN = 'W'.repeat(43);
const CODE_TOKEN = 'C'.repeat(43);
const OTHER_TOKEN = 'X'.repeat(43);
const WORKER_BEARER = { authorization: 'Bearer ' + WORKER_TOKEN };
const CODE_BEARER = { authorization: 'Bearer ' + CODE_TOKEN };
const REFUSED = { ok: false, error: 'bad_request', detail: 'Request failed.' };

const STAGING = loadOriginPolicy({
    [ORIGIN_TIER_ENV.owner_app]: 'https://universe-staging.ezil.work',
    [ORIGIN_TIER_ENV.idp_transit]: 'https://id.ezil.work',
});

// Drive the real HTTP callback and response writer without opening a socket.
function request(surface, {
    method = 'POST', url = '/click', body = '{}', readError, headers = WORKER_BEARER, peer = '127.0.0.1', options = {},
} = {}) {
    const server = createSidecarServer(surface, {
        workerBrowserOpenToken: WORKER_TOKEN, codeBrowserOpenToken: CODE_TOKEN, ...options,
    });
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    req.headers = headers;
    req.socket = { remoteAddress: peer };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('response timed out')), 1000);
        let status;
        server.emit('request', req, {
            writeHead(value) { status = value; },
            end(bytes) {
                clearTimeout(timer);
                // Whether the server ever started reading the body.
                resolve({ status, text: bytes.toString(), body: JSON.parse(bytes), bodyRead: req.listenerCount('data') > 0 });
            },
            once() {}, off() {},
        });
        if (readError) req.emit('error', readError);
        else { req.push(body); req.push(null); }
    });
}

async function withLogs(run) {
    const logs = spyOn(console, 'error').mockImplementation(() => {});
    try { await run(logs); } finally { logs.mockRestore(); }
}

function assertPrivate(result, code = 'chrome_unreachable', status = 200, detail = 'Request failed.') {
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ ok: false, error: code, detail });
    expect(result.text).not.toContain(PRIVATE_MESSAGE);
    expect(result.text).not.toContain(PRIVATE_STACK);
}

const surfaceFor = (error) => ({
    allSecrets: async () => [],
    activePage: async () => { throw error; },
});

/** A surface that records every method called on it, so a refusal can be shown to call none. */
function countingSurface () {
    const touched = [];
    return new Proxy({}, {
        get (_, name) {
            if (name === 'then' || typeof name === 'symbol') return undefined;
            if (name === 'touched') return touched;
            return () => {
                touched.push(name);
                return name === 'allSecrets' ? Promise.resolve([]) : Promise.reject(new Error('the surface was touched'));
            };
        },
    });
}

/** The URL and body each wire route is called with: valid enough to reach the handler. */
function wireCall (route) {
    const [method, path] = route.split(' ');
    const bodies = {
        '/navigate': { url: 'https://example.com/' },
        '/click': { ref: 'e1' },
        '/type': { ref: 'e1', text: 'x' },
        '/fill_form': { fields: [{ ref: 'e1', value: 'x' }] },
        '/select': { ref: 'e1', values: ['a'] },
        '/scroll': { dy: 10 },
        '/press': { key: 'Enter' },
        '/wait_for': { time: 0.001 },
    };
    return { method, url: path, body: method === 'GET' ? '' : JSON.stringify(bodies[path] ?? {}) };
}

describe('sidecar error response boundary', () => {
    it('verb failures expose only contract codes and fixed detail, retaining exceptions in logs', async () => {
        await withLogs(async (logs) => {
            for (const code of [...ERROR_CODES, PRIVATE_MESSAGE, '__proto__', { toString: () => PRIVATE_MESSAGE }]) {
                const error = Object.assign(new Error(PRIVATE_MESSAGE), { stack: PRIVATE_STACK, code });
                const result = await request(surfaceFor(error), { body: '{"ref":"e1"}' });
                assertPrivate(result, ERROR_CODES.includes(code) ? code : 'chrome_unreachable');
                expect(logs).toHaveBeenLastCalledWith('[ezil-sidecar] verb failed:', error);
            }
            assertPrivate(await request(surfaceFor(PRIVATE_MESSAGE), { body: '{"ref":"e1"}' }));
        });
    });

    it('JSON parse failures never echo parser messages or submitted text', async () => {
        await withLogs(async (logs) => {
            assertPrivate(await request(surfaceFor(null), { body: `{"${PRIVATE_MESSAGE}` }), 'bad_request');
            expect(logs.mock.calls[0][1]).toBeInstanceOf(SyntaxError);
        });
    });

    it('body stream failures expose no message, stack, or arbitrary status', async () => {
        await withLogs(async (logs) => {
            const error = Object.assign(new Error(PRIVATE_MESSAGE), { stack: PRIVATE_STACK, httpStatus: 599 });
            assertPrivate(await request(surfaceFor(null), { readError: error }), 'bad_request', 400);
            expect(logs).toHaveBeenCalledWith('[ezil-sidecar] body read failed:', error);
        });
    });

    it('oversized bodies retain the fixed 413 response', async () => {
        await withLogs(async () => {
            assertPrivate(await request(surfaceFor(null), { body: 'x'.repeat(256 * 1024 + 1) }), 'bad_request', 413);
        });
    });

    it('outer request failures expose no exception text', async () => {
        await withLogs(async (logs) => {
            const error = Object.assign(new Error(PRIVATE_MESSAGE), { stack: PRIVATE_STACK });
            assertPrivate(await request(surfaceFor(null), { method: { toUpperCase() { throw error; } } }));
            expect(logs).toHaveBeenCalledWith('[ezil-sidecar] request failed:', error);
        });
    });

    it('unknown paths and wrong methods return fixed errors without reflecting input', async () => {
        // The refusal names the fixed verb set (constant text), never the request.
        const unknownVerb = expect.stringMatching(/^Unknown verb\. This surface is a fixed verb set \(.+\) and has no CDP passthrough\.$/);
        const missing = await request(surfaceFor(null), { url: `/private-${PRIVATE_MESSAGE}` });
        assertPrivate(missing, 'bad_request', 404, unknownVerb);
        expect(missing.text).not.toContain('private-');
        assertPrivate(await request(surfaceFor(null), { method: 'GET' }), 'bad_request', 405, unknownVerb);
        assertPrivate(await request(surfaceFor(null), { body: 'null' }), 'bad_request');
    });
});

describe('the verb bearer (browser verbs v2 §3)', () => {
    // These drive verbs into failures on purpose; their logs are expected.
    let muted;
    beforeAll(() => { muted = spyOn(console, 'error').mockImplementation(() => {}); });
    afterAll(() => muted.mockRestore());
    const chromeDown = Object.assign(new Error('the browser has no open page'), { code: 'timeout' });
    const routes = Object.keys(SIDECAR_WIRE);

    it('covers all fourteen wire routes', () => {
        expect(routes).toHaveLength(14);
    });

    it('positive control: the Worker bearer reaches every route\'s handler', async () => {
        for (const route of routes) {
            const surface = { ...surfaceFor(chromeDown), isConnected: () => false, cdpUrl: 'http://127.0.0.1:9222', originPolicy: STAGING };
            const result = await request(surface, wireCall(route));
            expect({ route, status: result.status }).toEqual({ route, status: 200 });
            // health answers from the surface; every other verb reached its page lookup and failed there.
            if (route === 'GET /health') expect(result.body).toEqual({ ok: true, chromeConnected: false, cdpUrl: 'http://127.0.0.1:9222' });
            else expect({ route, body: result.body }).toEqual({ route, body: { ok: false, error: 'timeout', detail: 'Request failed.' } });
        }
    });

    it('missing, wrong, misspelled or Code-scoped bearers answer 401 with the one fixed body', async () => {
        const refusals = [
            {},
            { authorization: '' },
            { authorization: 'Bearer ' + OTHER_TOKEN },
            { authorization: 'Bearer ' + CODE_TOKEN },
            { authorization: 'bearer ' + WORKER_TOKEN },
            { authorization: 'Basic ' + WORKER_TOKEN },
            { authorization: 'Bearer  ' + WORKER_TOKEN.slice(1) },
            { authorization: 'Bearer ' + WORKER_TOKEN + ' ' },
            { authorization: 'Bearer ' + WORKER_TOKEN.slice(0, 42) + '!' },
            { authorization: ['Bearer ' + WORKER_TOKEN] },
        ];
        for (const route of routes) {
            for (const headers of refusals) {
                const surface = countingSurface();
                const result = await request(surface, { ...wireCall(route), headers });
                expect({ route, headers, status: result.status, body: result.body })
                    .toEqual({ route, headers, status: 401, body: REFUSED });
                // Nothing on the page or the surface was touched to refuse it.
                expect(surface.touched).toEqual([]);
            }
        }
    });

    it('an unset, empty or malformed server token refuses even the matching header', async () => {
        for (const configured of [undefined, '', 'short', 'W'.repeat(42), 'W'.repeat(44), 'W'.repeat(42) + '=']) {
            const header = { authorization: 'Bearer ' + (configured ?? '') };
            for (const route of ['GET /health', 'POST /snapshot', 'POST /fill_form']) {
                const surface = countingSurface();
                const result = await request(surface, {
                    ...wireCall(route), headers: header, options: { workerBrowserOpenToken: configured },
                });
                expect({ configured, route, status: result.status, body: result.body })
                    .toEqual({ configured, route, status: 401, body: REFUSED });
                expect(surface.touched).toEqual([]);
            }
        }
    });

    it('a refused caller cannot make the sidecar buffer its body: 401, not 413', async () => {
        const result = await request(countingSurface(), { url: '/fill_form', body: 'x'.repeat(300 * 1024), headers: {} });
        expect([result.status, result.body, result.bodyRead]).toEqual([401, REFUSED, false]);
        // Positive control: with the bearer the same body is read, and refused as too large.
        const read = await request(surfaceFor(null), { url: '/fill_form', body: 'x'.repeat(300 * 1024) });
        expect([read.status, read.body.error, read.bodyRead]).toEqual([413, 'bad_request', true]);
    });
});

/** A fake surface with one page on `url`, enough for the verbs below to act on it. */
function pageSurface (url) {
    const calls = [];
    const page = {
        url: () => url,
        isClosed: () => false,
        goto: async (target) => { calls.push(['goto', target]); },
        title: async () => 'Preview',
        evaluate: async () => ({ text: '- heading "Preview" [ref=e1]', refs: [{ ref: 'e1', role: 'heading', name: 'Preview' }], truncated: false }),
        waitForLoadState: async () => {},
        keyboard: { press: async (key) => { calls.push(['keyboard', key]); } },
    };
    return {
        calls,
        originPolicy: STAGING,
        allSecrets: async () => [],
        activePage: async () => page,
        registerRefs: (entries) => { calls.push(['registerRefs', entries.length]); return 1; },
        resolveRef: async () => { throw Object.assign(new Error('never issued'), { code: 'bad_ref' }); },
        consoleEntries: (_, deny) => { calls.push(['console', [...deny]]); return []; },
        networkEntries: (_, deny) => { calls.push(['network', [...deny]]); return []; },
        rememberSecret: () => {},
    };
}

/** The body each Code verb is called with: valid, so only the tier decides. */
function codeBody (verb) {
    return JSON.stringify({
        navigate: { url: 'https://example.com/' },
        click: { ref: 'e1' },
        type: { ref: 'e1', text: 'x' },
        fill_form: { fields: [{ ref: 'e1', value: 'x' }] },
        select: { ref: 'e1', values: ['a'] },
        scroll: { dy: 10 },
        press: { key: 'Enter' },
        wait_for: { time: 0.001 },
    }[verb] ?? {});
}

describe('the Code-chat loopback verbs (browser verbs v2 §3)', () => {
    // These drive verbs into failures on purpose; their logs are expected.
    let muted;
    beforeAll(() => { muted = spyOn(console, 'error').mockImplementation(() => {}); });
    afterAll(() => muted.mockRestore());
    const PREVIEW = 'http://127.0.0.1:47621/app';
    const code = (verb, over = {}) => ({ url: CODE_BROWSER_PATH_PREFIX + verb, body: codeBody(verb), headers: CODE_BEARER, ...over });

    it('serves exactly the thirteen CODE_BROWSER_VERBS', async () => {
        expect(CODE_BROWSER_VERBS).toHaveLength(13);
        for (const verb of CODE_BROWSER_VERBS) {
            const result = await request(pageSurface(PREVIEW), code(verb));
            expect({ verb, status: result.status }).toEqual({ verb, status: 200 });
        }
    });

    it('positive control: a preview page answers through the redacting respond()', async () => {
        const surface = pageSurface(PREVIEW);
        const snapshot = await request(surface, code('snapshot'));
        expect(snapshot.body).toEqual({ ok: true, snapshot: '- heading "Preview" [ref=e1]', url: PREVIEW, title: 'Preview' });
        const nav = await request(surface, code('navigate'));
        expect(nav.body).toEqual({ ok: true, url: PREVIEW, title: 'Preview' });
        const logged = await request(surface, code('console'));
        expect(logged.body).toEqual({ ok: true, entries: [] });
        expect(surface.calls).toContainEqual(['goto', 'https://example.com/']);
        // denyTiers reached the verb: the console reader was told which tiers to drop.
        expect(surface.calls).toContainEqual(['console', ['owner_app', 'idp_transit']]);
    });

    it('an owner-app or IdP page is origin_read_only for every Code verb, and nothing acts on it', async () => {
        for (const page of ['https://universe-staging.ezil.work/builder/profile-builder', 'https://id.ezil.work/u/login']) {
            for (const verb of CODE_BROWSER_VERBS) {
                const surface = pageSurface(page);
                const result = await request(surface, code(verb));
                expect({ page, verb, status: result.status, body: result.body })
                    .toEqual({ page, verb, status: 200, body: { ok: false, error: 'origin_read_only', detail: 'Request failed.' } });
                expect(surface.calls).toEqual([]);
            }
        }
    });

    it('the same verb on the Worker wire acts on that owner-app page: the denial is the loopback\'s alone', async () => {
        const surface = pageSurface('https://universe-staging.ezil.work/builder/profile-builder');
        const result = await request(surface, { url: '/snapshot', body: '{}', headers: WORKER_BEARER });
        expect(result.body.ok).toBe(true);
        expect(surface.calls).toContainEqual(['registerRefs', 1]);
    });

    it('each guard refuses on its own: bearer, Origin header, loopback peer', async () => {
        const refusals = [
            { headers: {} },
            { headers: { authorization: 'Bearer ' + OTHER_TOKEN } },
            { headers: WORKER_BEARER },
            { headers: { ...CODE_BEARER, origin: 'http://localhost' } },
            { headers: { ...CODE_BEARER, origin: 'null' } },
            { peer: '10.0.0.1' },
            { peer: '::1' },
            // No peer address at all (a destroyed socket): not loopback.
            { peer: null },
            { options: { codeBrowserOpenToken: undefined } },
        ];
        for (const over of refusals) {
            const surface = countingSurface();
            const result = await request(surface, code('snapshot', over));
            expect({ over, status: result.status, body: result.body }).toEqual({ over, status: 401, body: REFUSED });
            expect(surface.touched).toEqual([]);
        }
        // The Code bearer never opens the Worker wire either.
        const wire = await request(countingSurface(), { url: '/snapshot', headers: CODE_BEARER });
        expect([wire.status, wire.body]).toEqual([401, REFUSED]);
    });

    it('only the exact path of a listed verb exists: no health, no open-url body, no query or trailing slash', async () => {
        for (const url of [
            CODE_BROWSER_PATH_PREFIX + 'health', CODE_BROWSER_PATH_PREFIX + 'evaluate', CODE_BROWSER_PATH_PREFIX + 'snapshot?x=1',
            CODE_BROWSER_PATH_PREFIX + 'snapshot/', CODE_BROWSER_PATH_PREFIX + 'Snapshot', CODE_BROWSER_PATH_PREFIX + '../snapshot',
        ]) {
            const surface = countingSurface();
            const result = await request(surface, { url, headers: CODE_BEARER });
            expect({ url, status: result.status, error: result.body.error }).toEqual({ url, status: 404, error: 'bad_request' });
        }
        const get = await request(pageSurface(PREVIEW), { method: 'GET', url: CODE_BROWSER_PATH_PREFIX + 'snapshot', headers: CODE_BEARER });
        expect(get.status).toBe(405);
    });
});

describe('the observation route keeps its legacy read and sizes only an authorised control body', () => {
    function observing () {
        const seen = [];
        const observe = async (input) => { seen.push(input); return { ok: false, error: 'browser_session_stale' }; };
        return { seen, options: { observe, workerBrowserControl: true } };
    }
    const control = (size) => JSON.stringify({ binding: 'a'.repeat(64), action: { kind: 'read' }, pad: 'p'.repeat(size) });

    it('reads a v2-sized control body only behind the Worker bearer', async () => {
        const { seen, options } = observing();
        const big = control(400 * 1024);
        expect(big.length).toBeLessThan(OBSERVE_CONTROL_BODY_BYTES);
        const accepted = await request(surfaceFor(null), { url: OBSERVE_PATH, body: big, options });
        expect([accepted.status, accepted.body]).toEqual([200, { ok: false, error: 'browser_session_stale' }]);
        expect(seen).toHaveLength(1);

        // Without the bearer the same bytes are refused at the small bound and never observed.
        const refused = await request(surfaceFor(null), { url: OBSERVE_PATH, body: big, headers: {}, options });
        expect([refused.status, refused.body]).toEqual([200, { ok: false, error: 'browser_invalid_request' }]);
        const small = await request(surfaceFor(null), { url: OBSERVE_PATH, body: control(10), headers: {}, options });
        expect([small.status, small.body]).toEqual([401, { ok: false, error: 'browser_unavailable' }]);
        expect(seen).toHaveLength(1);

        // Over the authorised bound is refused too.
        const over = await request(surfaceFor(null), { url: OBSERVE_PATH, body: control(OBSERVE_CONTROL_BODY_BYTES), options });
        expect(over.body).toEqual({ ok: false, error: 'browser_invalid_request' });
        expect(seen).toHaveLength(1);
    });

    it('the legacy read stays unauthenticated and bounded at 1024 bytes', async () => {
        const { seen, options } = observing();
        const legacy = JSON.stringify({ binding: 'a'.repeat(64) });
        const read = await request(surfaceFor(null), { url: OBSERVE_PATH, body: legacy, headers: {}, options });
        expect(read.body).toEqual({ ok: false, error: 'browser_session_stale' });
        expect(seen).toEqual([{ binding: 'a'.repeat(64) }]);
        const padded = await request(surfaceFor(null), { url: OBSERVE_PATH, body: legacy.slice(0, -1) + ',"x":"' + 'y'.repeat(1024) + '"}', headers: {}, options });
        expect(padded.body).toEqual({ ok: false, error: 'browser_invalid_request' });
        expect(seen).toHaveLength(1);
    });
});

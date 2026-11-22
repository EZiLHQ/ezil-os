import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createSidecarServer } from './server.mjs';
import {
    BROWSER_OPEN_PATH, CODE_BROWSER_OPEN_PATH, browserOpenOrigins, createMcpBrowserOpen,
} from './mcp-browser-open.mjs';

const requestId = '3a9dbafb-cc83-4ad9-afc1-2e104dc9d2a2';
const input = { binding: 'a'.repeat(64), requestId, url: 'https://test.example/path', timeoutMs: 1000 };

test('accepts only canonical exact configured origins and denies mixed invalid settings', () => {
    assert.deepEqual([...browserOpenOrigins('https://test.example, http://127.0.0.1:47621')], [
        'https://test.example', 'http://127.0.0.1:47621',
    ]);
    for (const invalid of ['https://test.example/', 'https://test.example/path', 'https://127.0.0.1:9222',
        'http://127.1:47621', 'http://127.0.0.1:3000', 'http://127.0.0.1:8181', 'http://127.0.0.1:9223']) {
        assert.equal(browserOpenOrigins('https://test.example ' + invalid).size, 0, invalid);
    }
    assert.equal(browserOpenOrigins('https://test.example '.repeat(21)).size, 0);
});

test('dedupes exact run identity and rejects a different binding before CDP attachment', async () => {
    let attached = 0;
    let complete;
    const connecting = new Promise(resolve => { complete = resolve; });
    const open = createMcpBrowserOpen({ connect: () => { attached += 1; return connecting; } }, {
        allowedOrigins: 'https://test.example',
    });
    const abort = new AbortController();
    const first = open(input, abort.signal);
    assert.equal((await open(input)).error, 'request_pending');
    assert.equal((await open({ ...input, binding: 'b'.repeat(64) })).error, 'request_conflict');
    assert.equal((await open({ ...input, url: 'https://off.example/' })).error, 'destination_denied');
    abort.abort();
    const stopped = await first;
    complete({});
    assert.equal(stopped.error, 'cancelled');
    assert.equal(stopped.retryable, false);
    assert.deepEqual(await open(input), stopped);
    assert.equal(attached, 1);
});

test('private sidecar routes enforce distinct capabilities and a server-derived Code binding', async () => {
    const seen = [];
    const workerBrowserOpenToken = 'a'.repeat(43);
    const codeBrowserOpenToken = 'b'.repeat(43);
    const server = createSidecarServer({ allSecrets: () => { throw Error('unexpected existing browser inspection'); } }, {
        workerBrowserOpenToken, codeBrowserOpenToken, workerBrowserOpen: true,
        browserOpen: async input => { seen.push(input); return { ok: false, error: 'destination_denied' }; },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    function send (path, token, body, headers = {}) {
        return fetch(endpoint + path, { method: 'POST', headers: {
            authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers,
        }, body: JSON.stringify(body) });
    }

    try {
        const { binding, ...codeInput } = input;
        assert.equal((await send(BROWSER_OPEN_PATH, codeBrowserOpenToken, input)).status, 401);
        assert.equal((await send(CODE_BROWSER_OPEN_PATH, workerBrowserOpenToken, codeInput)).status, 401);
        assert.equal((await send(CODE_BROWSER_OPEN_PATH, codeBrowserOpenToken, codeInput, { origin: 'http://localhost' })).status, 401);
        assert.equal((await send(CODE_BROWSER_OPEN_PATH, codeBrowserOpenToken, input)).status, 400);
        assert.equal((await send(BROWSER_OPEN_PATH + '?different', workerBrowserOpenToken, input)).status, 404);
        assert.equal(seen.length, 0);
        assert.equal((await send(BROWSER_OPEN_PATH, workerBrowserOpenToken, input)).status, 200);
        assert.equal((await send(CODE_BROWSER_OPEN_PATH, codeBrowserOpenToken, codeInput)).status, 200);
        assert.deepEqual(seen[0], input);
        assert.match(seen[1].binding, /^[a-f0-9]{64}$/);
        assert.notEqual(seen[1].binding, binding);
        assert.deepEqual({ ...seen[1], binding }, input);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('the Worker open route exists only behind EZIL_WORKER_BROWSER_OPEN, and off it answers as an unknown route', async () => {
    const workerBrowserOpenToken = 'a'.repeat(43);
    const codeBrowserOpenToken = 'b'.repeat(43);
    const seen = [];
    const browserOpen = async input => { seen.push(input); return { ok: false, error: 'destination_denied' }; };
    const surface = { allSecrets: async () => [] };
    const servers = [];
    async function start (options) {
        const server = createSidecarServer(surface, { workerBrowserOpenToken, codeBrowserOpenToken, browserOpen, ...options });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        servers.push(server);
        return 'http://127.0.0.1:' + server.address().port;
    }
    const answer = async (endpoint, path, method = 'POST', token = workerBrowserOpenToken, body = input) => {
        const response = await fetch(endpoint + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
    };
    try {
        // Unset (the default) and anything but exactly "on" both leave the route out.
        for (const options of [{}, { workerBrowserOpen: false }]) {
            const off = await start(options);
            const unknown = await answer(off, '/internal/no-such-route');
            assert.equal(unknown.status, 404);
            for (const [method, token] of [['POST', workerBrowserOpenToken], ['POST', 'c'.repeat(43)], ['GET', workerBrowserOpenToken]]) {
                assert.deepEqual(await answer(off, BROWSER_OPEN_PATH, method, token), method === 'GET'
                    ? await answer(off, '/internal/no-such-route', 'GET') : unknown, method + ' ' + token[0]);
            }
            // The Code open route keeps its own gate, independent of the Worker switch.
            const { binding, ...codeInput } = input;
            assert.equal((await answer(off, CODE_BROWSER_OPEN_PATH, 'POST', codeBrowserOpenToken, codeInput)).status, 200);
        }
        assert.equal(seen.filter(item => item.binding === input.binding).length, 0, 'the Worker open route never ran');
        // Positive control: switched on, the same request reaches the open handler.
        const on = await start({ workerBrowserOpen: true });
        assert.equal((await answer(on, BROWSER_OPEN_PATH)).status, 200);
        assert.deepEqual(seen.at(-1), input);
    } finally {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    }
});

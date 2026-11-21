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
        workerBrowserOpenToken, codeBrowserOpenToken,
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

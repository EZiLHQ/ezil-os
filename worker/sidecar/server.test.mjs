import { describe, expect, it, spyOn } from 'bun:test';
import { Readable } from 'node:stream';
import { createSidecarServer } from './server.mjs';
import { ERROR_CODES } from './contract.mjs';

const PRIVATE_MESSAGE = 'private SDK message with /srv/internal/source.js and token=private';
const PRIVATE_STACK = 'Error: private stack\n    at secret (/srv/internal/source.js:42:7)';

// Drive the real HTTP callback and response writer without opening a socket.
function request(surface, { method = 'POST', url = '/click', body = '{}', readError } = {}) {
    const server = createSidecarServer(surface);
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('response timed out')), 1000);
        let status;
        server.emit('request', req, {
            writeHead(value) { status = value; },
            end(bytes) { clearTimeout(timer); resolve({ status, text: bytes.toString(), body: JSON.parse(bytes) }); },
        });
        if (readError) req.emit('error', readError);
        else { req.push(body); req.push(null); }
    });
}

async function withLogs(run) {
    const logs = spyOn(console, 'error').mockImplementation(() => {});
    try { await run(logs); } finally { logs.mockRestore(); }
}

function assertPrivate(result, code = 'chrome_unreachable', status = 200) {
    expect(result.status).toBe(status);
    expect(result.body).toEqual({ ok: false, error: code, detail: 'Request failed.' });
    expect(result.text).not.toContain(PRIVATE_MESSAGE);
    expect(result.text).not.toContain(PRIVATE_STACK);
}

const surfaceFor = (error) => ({
    allSecrets: async () => [],
    activePage: async () => { throw error; },
});

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
        assertPrivate(await request(surfaceFor(null), { url: `/private-${PRIVATE_MESSAGE}` }), 'bad_request', 404);
        assertPrivate(await request(surfaceFor(null), { method: 'GET' }), 'bad_request', 405);
        assertPrivate(await request(surfaceFor(null), { body: 'null' }), 'bad_request');
    });
});

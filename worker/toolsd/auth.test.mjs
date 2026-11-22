/**
 * toolsd request authentication — the frozen contract's section 3.5, driven
 * END TO END through the real HTTP handler (no socket), with a spy job manager
 * that records whether anything was executed. Every refusal must be HTTP 401
 * `tools_unauthorized` AND must not touch the job manager.
 *
 * The MAC is signed here with raw `node:crypto` against the section 3.4 string,
 * NOT via `auth.mjs`'s own `expectedMac`, so this file is an independent oracle
 * of the wire formula rather than a mirror of the code under test.
 *
 * `node:test`; runs under `node --test` and `bun test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import { createToolsdServer } from './server.mjs';
import { deriveKey } from './auth.mjs';

const SEED = 'f'.repeat(64); // a plausible proxy-token-shaped seed
const KEY = deriveKey(SEED);
const HOST = 'toolsd.ezil.invalid';

/** Section 3.4 signer, written out independently of auth.mjs. */
function sign(ts, path, bodyStr) {
  const bodyHash = createHash('sha256').update(Buffer.from(bodyStr, 'utf8')).digest('hex');
  const payload = `EZIL-TOOLSD/1\n${ts}\nPOST\n${path}\n${bodyHash}`;
  const mac = createHmac('sha256', KEY).update(payload).digest('hex');
  return `v1.${ts}.${mac}`;
}

function spyJobManager() {
  const calls = [];
  const job = { jobId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'tool', name: null, requestId: null, state: 'exited',
    exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
    stdoutTruncated: false, stderrTruncated: false, startedAt: 'x', endedAt: 'y', timeoutSeconds: 1, background: false };
  return {
    calls,
    call: async (a) => { calls.push(['call', a]); return { ok: true, job }; },
    exec: async (a) => { calls.push(['exec', a]); return { ok: true, job }; },
    job: (a) => { calls.push(['job', a]); return { ok: true, job }; },
    cancel: async (a) => { calls.push(['cancel', a]); return { ok: true, job }; },
  };
}

const emptyScan = () => ({ catalogDigest: 'sha256:' + '0'.repeat(64), tools: [], invalid: [], byName: new Map() });

function makeServer(extra = {}) {
  const spy = spyJobManager();
  const server = createToolsdServer({ key: KEY, rescan: emptyScan, jobManager: spy, ...extra });
  return { server, spy };
}

/** Drive one request/response through the handler without a socket. */
function drive(server, { method = 'POST', url = '/v1/list', headers = {}, body = '{}' } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = headers;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('response timed out')), 2000);
    const res = {
      writeHead(status, h) { this.status = status; this.headers = h; },
      end(bytes) { clearTimeout(timer); resolve({ status: this.status, headers: this.headers, text: bytes.toString('utf8'), body: JSON.parse(bytes.toString('utf8')) }); },
    };
    server.emit('request', req, res);
    queueMicrotask(() => { if (body) req.push(Buffer.from(body, 'utf8')); req.push(null); });
  });
}

/** A fully valid request to `path` with `body`. Overrides merge into headers. */
function valid(path, body, { ts = Date.now(), headerOverride, extraHeaders } = {}) {
  const headers = {
    host: HOST,
    'content-type': 'application/json',
    'x-ezil-toolsd': headerOverride ?? sign(String(ts), path, body),
    ...extraHeaders,
  };
  return { method: 'POST', url: path, headers, body };
}

test('positive control: a valid, signed list request is 200 and returns the catalog', async () => {
  const { server, spy } = makeServer();
  const res = await drive(server, valid('/v1/list', '{}'));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.catalogDigest, 'sha256:' + '0'.repeat(64));
  assert.deepEqual(res.body.tools, []);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(spy.calls.length, 0); // list never touches the job manager
});

test('positive control: a valid, signed call request reaches the job manager exactly once', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'hello', arguments: {}, requestId: 'r1' });
  const res = await drive(server, valid('/v1/call', body));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.catalogDigest, 'sha256:' + '0'.repeat(64));
  assert.deepEqual(spy.calls, [['call', { name: 'hello', arguments: {}, requestId: 'r1' }]]);
});

test('a non-POST method is refused, nothing executed', async () => {
  const { server, spy } = makeServer();
  const req = valid('/v1/call', JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' }));
  req.method = 'GET';
  const res = await drive(server, req);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { ok: false, error: 'tools_unauthorized' });
  assert.equal(spy.calls.length, 0);
});

test('a path outside /v1/<op> is refused (including a query string)', async () => {
  const { server, spy } = makeServer();
  for (const url of ['/health', '/v1/bogus', '/v1/call?x=1', '/v1/', '/v1/call/extra']) {
    const req = valid('/v1/call', JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' }));
    req.url = url;
    const res = await drive(server, req);
    assert.equal(res.status, 401, `path ${url}`);
  }
  assert.equal(spy.calls.length, 0);
});

test('🔴 the Host check: a wrong Host is refused even with an otherwise valid request', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  const req = valid('/v1/call', body, { extraHeaders: { host: '10.0.0.1:9224' } });
  const res = await drive(server, req);
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { ok: false, error: 'tools_unauthorized' });
  assert.equal(spy.calls.length, 0);
  // Control: the identical request with the right Host is accepted — so the
  // refusal above is the Host check, not some other field.
  const { server: ok, spy: okSpy } = makeServer();
  const good = await drive(ok, valid('/v1/call', body));
  assert.equal(good.status, 200);
  assert.equal(okSpy.calls.length, 1);
});

test('🔴 the Origin check: an Origin header is refused even with a valid MAC', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  const res = await drive(server, valid('/v1/call', body, { extraHeaders: { origin: 'https://os-staging.ezil.work' } }));
  assert.equal(res.status, 401);
  assert.equal(spy.calls.length, 0);
});

test('any Sec-Fetch-* header is refused even with a valid MAC', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  const res = await drive(server, valid('/v1/call', body, { extraHeaders: { 'sec-fetch-mode': 'cors' } }));
  assert.equal(res.status, 401);
  assert.equal(spy.calls.length, 0);
});

test('a cross-origin text/plain POST from the in-computer Browser is refused, nothing executed', async () => {
  const { server, spy } = makeServer();
  // What a page's `fetch` would send: text/plain (no preflight), an Origin, a
  // Sec-Fetch header, and no MAC at all.
  const res = await drive(server, {
    method: 'POST',
    url: '/v1/exec',
    headers: {
      host: HOST,
      'content-type': 'text/plain;charset=UTF-8',
      origin: 'https://attacker.example',
      'sec-fetch-mode': 'no-cors',
    },
    body: JSON.stringify({ command: 'id', timeoutSeconds: 5, background: false, requestId: 'r' }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { ok: false, error: 'tools_unauthorized' });
  assert.equal(spy.calls.length, 0);
});

test('a Content-Type that is not exactly application/json is refused', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  for (const ct of ['application/json; charset=utf-8', 'text/plain', 'application/JSON']) {
    const res = await drive(server, valid('/v1/call', body, { extraHeaders: { 'content-type': ct } }));
    assert.equal(res.status, 401, `content-type ${ct}`);
  }
  assert.equal(spy.calls.length, 0);
});

test('a body over 40,960 bytes is refused (with a valid MAC over that body)', async () => {
  const { server, spy } = makeServer();
  // A 40,961-byte JSON string, signed, so only the size check can refuse it.
  const big = JSON.stringify({ name: 'x', arguments: { pad: 'a'.repeat(41_000) }, requestId: 'r' });
  assert.ok(Buffer.byteLength(big) > 40_960);
  const res = await drive(server, valid('/v1/call', big));
  assert.equal(res.status, 401);
  assert.equal(spy.calls.length, 0);
  // Control: a body just under the bound with a valid MAC is accepted.
  const okBody = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  const { server: ok, spy: okSpy } = makeServer();
  assert.equal((await drive(ok, valid('/v1/call', okBody))).status, 200);
  assert.equal(okSpy.calls.length, 1);
});

test('a missing or malformed x-ezil-toolsd header is refused', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  // Missing.
  const missing = { method: 'POST', url: '/v1/call', headers: { host: HOST, 'content-type': 'application/json' }, body };
  assert.equal((await drive(server, missing)).status, 401);
  // Malformed shapes.
  for (const h of ['v2.123.' + 'a'.repeat(64), 'v1.notanumber.' + 'a'.repeat(64), 'v1.123.' + 'a'.repeat(63), 'v1.123.' + 'A'.repeat(64), 'garbage']) {
    const res = await drive(server, valid('/v1/call', body, { headerOverride: h }));
    assert.equal(res.status, 401, `header ${h}`);
  }
  assert.equal(spy.calls.length, 0);
});

test('a timestamp more than 60 s from now is refused (old and future)', async () => {
  const now = Date.now();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  for (const ts of [now - 61_000, now + 61_000]) {
    const { server, spy } = makeServer();
    const res = await drive(server, valid('/v1/call', body, { ts }));
    assert.equal(res.status, 401, `ts offset ${ts - now}`);
    assert.equal(spy.calls.length, 0);
  }
  // Control: a timestamp within the window is accepted.
  const { server: ok } = makeServer();
  assert.equal((await drive(ok, valid('/v1/call', body, { ts: now - 30_000 }))).status, 200);
});

test('🔴 the MAC check: a wrong MAC is refused; the same request with the right MAC passes', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  const ts = Date.now();
  const good = sign(String(ts), '/v1/call', body);
  // Flip the last hex char: still a well-formed 64-hex MAC, but wrong.
  const bad = good.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  const refused = await drive(server, valid('/v1/call', body, { ts, headerOverride: bad }));
  assert.equal(refused.status, 401);
  assert.equal(spy.calls.length, 0);
  // Control.
  const { server: ok, spy: okSpy } = makeServer();
  const accepted = await drive(ok, valid('/v1/call', body, { ts, headerOverride: good }));
  assert.equal(accepted.status, 200);
  assert.equal(okSpy.calls.length, 1);
});

test('a MAC signed for a DIFFERENT body / path does not verify (binding is real)', async () => {
  const { server, spy } = makeServer();
  const ts = Date.now();
  const bodyA = JSON.stringify({ name: 'a', arguments: {}, requestId: 'r' });
  const bodyB = JSON.stringify({ name: 'b', arguments: {}, requestId: 'r' });
  // Header signs bodyA, but bodyB is sent.
  const header = sign(String(ts), '/v1/call', bodyA);
  const res = await drive(server, { method: 'POST', url: '/v1/call',
    headers: { host: HOST, 'content-type': 'application/json', 'x-ezil-toolsd': header }, body: bodyB });
  assert.equal(res.status, 401);
  // Header signs the /v1/call path, but sent to /v1/exec.
  const header2 = sign(String(ts), '/v1/call', bodyA);
  const res2 = await drive(server, { method: 'POST', url: '/v1/exec',
    headers: { host: HOST, 'content-type': 'application/json', 'x-ezil-toolsd': header2 }, body: bodyA });
  assert.equal(res2.status, 401);
  assert.equal(spy.calls.length, 0);
});

test('🔴 the replay guard: the same valid MAC is accepted once, then refused', async () => {
  const { server, spy } = makeServer();
  const body = JSON.stringify({ name: 'x', arguments: {}, requestId: 'r' });
  const ts = Date.now();
  const header = sign(String(ts), '/v1/call', body);
  const first = await drive(server, valid('/v1/call', body, { ts, headerOverride: header }));
  assert.equal(first.status, 200);
  const second = await drive(server, valid('/v1/call', body, { ts, headerOverride: header }));
  assert.equal(second.status, 401, 'a replayed MAC is refused');
  assert.equal(spy.calls.length, 1, 'the replay executed nothing a second time');
});

test('a well-authenticated request with a malformed op body is tools_invalid_request (not 401)', async () => {
  const { server, spy } = makeServer();
  // Valid MAC over a body that is not a valid call shape.
  const body = JSON.stringify({ name: 'x' }); // missing requestId
  const res = await drive(server, valid('/v1/call', body));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { ok: false, error: 'tools_invalid_request' });
  assert.equal(spy.calls.length, 0, 'an invalid body executes nothing');
});

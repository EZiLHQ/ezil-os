'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startBroker, LIMITS, upstream } = require('../src/broker.cjs');
const { GATEWAY_ORIGIN } = require('../src/works-session.cjs');
const { fixture, grant, modelList, event, complete } = require('./works-fixture.cjs');
const { harness } = require('./http-harness.cjs');
const chat = { model: 'ezil-code', messages: [{ role: 'user', content: 'Hello' }], maxTokens: 16 };
async function setup(t, override, limits = LIMITS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-ai-gateway-')), http = harness();
  const f = fixture(override);
  const broker = await startBroker(root, f.vault, { createServer: http.createServer, works: f.works, fetchImpl: f.fetchImpl, limits });
  t.after(() => { broker.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const descriptor = JSON.parse(fs.readFileSync(broker.descriptor));
  const headers = { authorization: `Bearer ${descriptor.capability}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() };
  const request = (body = chat, changes = {}) => http.request('/v1/chat', { method: 'POST', headers, body: JSON.stringify(body), ...changes });
  return { ...f, broker, descriptor, headers, request, http };
}
const successful = () => new Response(event('response.output_text.delta', { delta: 'hello' }) + complete, { headers: { 'content-type': 'text/event-stream' } });
test('authenticated broker performs real session/model checks and translates Responses without secrets', async t => {
  const f = await setup(t, url => url.endsWith('/v1/responses') ? successful() : undefined);
  assert.equal((await f.http.request('/v1/models')).status, 403);
  assert.equal((await f.request(chat, { headers: { ...f.headers, origin: 'https://evil.test' } })).status, 403);
  const models = await (await f.http.request('/v1/models', { headers: f.headers })).json();
  assert.deepEqual(models.models, ['ezil-fast', 'ezil-code']); assert.equal(models.modelInfo[1].maxOutputTokens, 4096);
  const result = await f.request(); assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-ezil-stream'), 'responses-v1');
  const text = await result.text(); assert.match(text, /hello/); assert.match(text, /\[DONE\]/);
  const posts = f.calls.filter(c => c.url.endsWith('/v1/responses')); assert.equal(posts.length, 1);
  assert.equal(posts[0].url, GATEWAY_ORIGIN + '/v1/responses');
  assert.equal(posts[0].options.headers.Authorization, `Bearer ${grant.accessToken}`);
  assert.equal(posts[0].options.headers['Idempotency-Key'], f.headers['idempotency-key']);
  assert.equal(posts[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(posts[0].options.body), { model: chat.model, input: chat.messages, max_output_tokens: 16, stream: true, store: false });
  for (const value of [text, JSON.stringify(f.descriptor), JSON.stringify(f.broker.usage), JSON.stringify(models)]) for (const secret of [grant.accessToken, grant.refreshToken]) assert.equal(value.includes(secret), false);
  assert.equal(f.broker.usage.completed, 1);
});
test('missing session, disabled models, paused gateway and invalid requests never reach inference', async t => {
  const f = await setup(t, url => url.endsWith('/v1/models') ? Response.json({ ...modelList, killswitch: true }) : undefined);
  assert.equal((await f.request()).headers.get('x-ezil-error'), 'paused');
  f.vault.set({ provider: 'ezil', session: null });
  assert.equal((await f.request()).headers.get('x-ezil-error'), 'signin_required');
  assert.equal(f.calls.some(c => c.url.endsWith('/v1/responses')), false);
  assert.throws(() => upstream(f.vault.get(), chat));
  f.calls.length = 0;
  for (const body of [{ ...chat, maxTokens: 8193 }, { ...chat, model: '../invalid' }, { ...chat, url: 'https://evil.test' }]) assert.equal((await f.request(body)).status, 400);
  assert.equal((await f.request(chat, { headers: { ...f.headers, 'idempotency-key': '' } })).status, 400); assert.equal(f.calls.length, 0);
});
test('gateway statuses are bounded, actionable, redacted and never retried or sent direct', async t => {
  for (const [status, code, expected] of [[402, 'insufficient_credits', 'credits'], [409, 'idempotency_replay', 'replay'], [422, 'idempotency_conflict', 'replay'], [409, 'pending_reconciliation_required', 'pending_usage'], [503, 'killswitch', 'paused'], [503, 'model_disabled', 'model_unavailable'], [403, 'account_suspended', 'membership_required'], [429, 'concurrency_limit', 'rate_limited'], [401, 'unknown', 'signin_required'], [500, 'unknown', 'gateway_unavailable']]) {
    const f = await setup(t, url => url.endsWith('/v1/responses') ? Response.json({ error: { code, message: grant.accessToken, provider: grant.refreshToken } }, { status }) : undefined);
    const result = await f.request(); assert.equal(result.headers.get('x-ezil-error'), expected);
    assert.equal((await result.text()).includes(grant.accessToken), false);
    assert.equal(f.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
    assert.ok(f.calls.every(c => !c.url.includes('azure') && !c.url.includes('amazonaws')));
    if (status === 401) assert.equal(f.vault.get().session, null);
    if (status === 409) {
      await f.request();
      assert.deepEqual(f.calls.filter(c => c.url.endsWith('/v1/responses')).map(c => c.options.headers['Idempotency-Key']), [f.headers['idempotency-key'], f.headers['idempotency-key']]);
    }
  }
});
test('partial response failures and truncated/malformed streams end with a sanitized error, never DONE', async t => {
  for (const suffix of [event('response.failed', { response: { error: { message: grant.refreshToken } } }), 'data: {invalid}\n\n', '', complete.trimEnd()]) {
    const f = await setup(t, url => url.endsWith('/v1/responses') ? new Response(event('response.output_text.delta', { delta: 'partial' }) + suffix, { headers: { 'content-type': 'text/event-stream' } }) : undefined);
    const result = await f.request(), text = await result.text();
    assert.match(text, /partial/); assert.match(text, /"error":/); assert.equal(text.includes('[DONE]'), false); assert.equal(text.includes(grant.refreshToken), false);
    assert.equal(f.broker.usage.failed, 1); assert.equal(f.broker.usage.completed, 0);
    assert.equal(f.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
  }
});
test('timeouts and downstream close abort inference without retry', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; }); let signal;
  const f = await setup(t, (url, options) => {
    if (url.endsWith('/v1/responses')) { signal = options.signal; started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('synthetic secret')), { once: true })); }
  }, { ...LIMITS, timeoutMs: 30 });
  const first = f.request(); await ready; const result = await first;
  assert.equal(result.status, 504); assert.equal(signal.aborted, true);
  let downstream; const second = f.request(chat, { onResponse: res => { downstream = res; } });
  await new Promise(resolve => setImmediate(resolve)); downstream.destroy(); await second;
  assert.equal(signal.aborted, true); assert.equal(f.calls.filter(c => c.url.endsWith('/v1/responses')).length, 2);
});
test('third registry alias reaches inference only within live model limits', async t => {
  const third = { id: 'ezil-third', enabled: true, max_input_tokens: 4096, min_output_tokens: 32, default_output_tokens: 64, max_output_tokens: 128 };
  const f = await setup(t, url => url.endsWith('/v1/models') ? Response.json({ ...modelList, data: [...modelList.data, third] }) : url.endsWith('/v1/responses') ? successful() : undefined);
  const models = await (await f.http.request('/v1/models', { headers: f.headers })).json();
  assert.equal(models.models[2], third.id); assert.equal(models.modelInfo[2].defaultOutputTokens, 64);
  for (const maxTokens of [31, 129]) assert.equal((await f.request({ ...chat, model: third.id, maxTokens })).status, 400);
  assert.equal((await f.request({ ...chat, model: third.id, maxTokens: 64, messages: [{ role: 'user', content: 'x'.repeat(4096) }] })).status, 413);
  assert.equal(f.calls.filter(c => c.url.endsWith('/v1/responses')).length, 0);
  assert.equal((await f.request({ ...chat, model: third.id, maxTokens: 64 })).status, 200);
  assert.equal(f.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
});
test('rate, budget and revoked-key errors retain safe Retry-After without retry', async t => {
  for (const [status, code, safe] of [[429, 'rate_limited', 'rate_limited'], [402, 'budget_exceeded', 'budget'], [401, 'key_revoked', 'key_revoked']]) {
    const f = await setup(t, url => url.endsWith('/v1/responses') ? Response.json({ error: { code, message: grant.refreshToken } }, { status, headers: { 'Retry-After': '30' } }) : undefined);
    const response = await f.request();
    assert.equal(response.headers.get('retry-after'), '30'); assert.equal(response.headers.get('x-ezil-error'), safe);
    assert.equal((await response.text()).includes(grant.refreshToken), false);
    assert.equal(f.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
  }
});

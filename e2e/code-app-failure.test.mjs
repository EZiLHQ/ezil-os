import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { faultHandler, MODEL, REQUEST_ID, modelConfig } from './code-app-failure-mock.mjs';
import { exposeConsumer, assertFailureRecord } from './code-app-failure-support.mjs';
import { safe_model_key, validate_failure } from '../shell/ezil/ui/feedback/app-failures.js';

function exchange(method, url, variant) {
  const logs = [], output = [];
  let status, headers;
  const req = new Proxy({ method, url }, { get(target, key) {
    assert.ok(['method', 'url'].includes(key), 'mock must never access bodies, headers or stream methods');
    return target[key];
  } });
  const res = { writeHead(code, values) { status = code; headers = values; }, write(value) { output.push(value); },
    end(value = '') { output.push(value); } };
  faultHandler({ variant, log: value => logs.push(value) })(req, res);
  return { logs, status, headers, output: output.join('') };
}

test('one safe configured/catalog model uses Anthropic messages', () => {
  const result = exchange('GET', '/ai/v1/models');
  const catalog = JSON.parse(result.output);
  assert.equal(catalog.data.length, 1); assert.equal(catalog.data[0].id, MODEL);
  assert.deepEqual(catalog.data[0].protocols, ['anthropic-messages']);
  assert.equal(safe_model_key(MODEL), true); assert.equal(modelConfig.models[0].model, MODEL);
});

for (const variant of ['missing_terminal', 'settlement_pending']) test(`metadata-only mock: ${variant}`, () => {
  const result = exchange('POST', '/ai/v1/messages', variant);
  assert.equal(result.status, 200); assert.equal(result.headers['content-type'], 'text/event-stream');
  assert.equal(result.headers['x-ezil-request-id'], REQUEST_ID);
  assert.deepEqual(result.logs, [{ method: 'POST', path: '/ai/v1/messages', status: 200, requestId: REQUEST_ID }]);
  const events = result.output.trim().split('\n\n').map(part => JSON.parse(part.split('\ndata: ')[1]));
  assert.deepEqual(events.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    ...(variant === 'settlement_pending' ? ['error'] : [])]);
  assert.equal(events[0].message.role, 'assistant');
  if (variant === 'settlement_pending') assert.equal(events.at(-1).code, 'settlement_pending');
});

test('metadata does not echo unknown paths, query strings or methods', () => {
  assert.deepEqual(exchange('UNTRUSTED', '/ai/v1/models?private-text').logs,
    [{ method: 'OTHER', path: '/unknown', status: 404, requestId: REQUEST_ID }]);
});

test('test accessor exposes the original singleton, with one exact binding and no new store', () => {
  const source = 'let register,read,clear;({register_app_frame:register,app_failures_for:read,clear_app_failures:clear}=factory())';
  let calls = 0;
  const reader = () => ({ failures: [] });
  const context = { factory() { calls++; return { register_app_frame() {}, app_failures_for: reader, clear_app_failures() {} }; } };
  runInNewContext(exposeConsumer(source), context);
  assert.equal(calls, 1); assert.equal(context.__codeFailureQA.app_failures_for, reader);
  assert.throws(() => exposeConsumer(''), /one real consumer/);
  assert.throws(() => exposeConsumer(`${source};${source}`), /one real consumer/);
  const realBundle = readFileSync(new URL('../app/public/os/bundle.min.js', import.meta.url), 'utf8');
  assert.ok(exposeConsumer(realBundle).includes('globalThis.__codeFailureQA='));
});

test('scenario checks only canonical failure fields and rejects missing IDs, duplicates handled by parent assertions', () => {
  const record = { eventId: 'a0000000-0000-4000-8000-0000000000e1', source: 'ezil_chat', operation: 'chat_request',
    category: 'interrupted', code: 'stream_interrupted', stage: 'stream', outcome: 'failed', streamReason: 'missing_terminal',
    clientRequestId: 'c0000000-0000-4000-8000-0000000000e1', gatewayRequestId: REQUEST_ID };
  assertFailureRecord(record, 'missing_terminal'); assert.deepEqual(validate_failure(record), record);
  assert.throws(() => assertFailureRecord({ ...record, clientRequestId: undefined }, 'missing_terminal'));
  assert.throws(() => assertFailureRecord({ ...record, extra: {} }, 'missing_terminal'));
  assert.throws(() => assertFailureRecord({ ...record, gatewayRequestId: REQUEST_ID.toUpperCase() }, 'missing_terminal'));
  assertFailureRecord({ ...record, category: 'provider', code: 'provider_error' }, 'settlement_pending');
});

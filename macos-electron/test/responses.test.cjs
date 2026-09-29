'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { responsesRequest, translateResponses } = require('../src/responses.cjs');
const { catalog } = require('../src/works-session.cjs');
const { modelList } = require('./works-fixture.cjs');
const { event, complete } = require('./works-fixture.cjs');
const chat = { model: 'ezil-code', messages: [{ role: 'system', content: 'instructions' }, { role: 'assistant', content: 'previous' }, { role: 'user', content: 'hello' }], maxTokens: 16 };
const model = catalog(modelList).models[1];
test('text chat maps exactly to stateless streamed Responses, preserving ordered roles', () => {
  assert.deepEqual(responsesRequest(chat, model), { model: 'ezil-code', input: chat.messages, max_output_tokens: 16, stream: true, store: false });
  assert.equal(responsesRequest({ ...chat, maxTokens: 4096 }, model).max_output_tokens, 4096);
  const fast = catalog(modelList).models[0];
  assert.equal(responsesRequest({ ...chat, model: fast.id, maxTokens: 8192 }, fast).max_output_tokens, 8192);
});
test('invalid payloads, aliases, limits and input bounds are refused before inference', () => {
  for (const change of [{ maxTokens: 15 }, { maxTokens: 4097 }, { maxTokens: 16.5 }, { model: 'gpt-6-sol' }, { model: '__proto__' }, { store: true }, { stream: false }, { instructions: 'inject' }, { messages: [] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'user', content: [{ type: 'input_image' }] }] }, { messages: [{ role: 'user', content: 'x', tools: [] }] }]) assert.throws(() => responsesRequest({ ...chat, ...change }, model), { code: 'request_invalid' });
  assert.throws(() => responsesRequest({ ...chat, messages: [{ role: 'user', content: '😃'.repeat(5000) }] }, model), { code: 'input_too_large' });
  assert.throws(() => responsesRequest(chat, { ...model, maxOutputTokens: 15 }));
});
function stream(text, oneByte = false) {
  const bytes = Buffer.from(text);
  return oneByte ? new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }) : new Response(bytes).body;
}
test('Responses SSE handles fragmented UTF-8, CRLF, multiline data, comments and terminal completion', async () => {
  const input = ': keepalive\n\n' + event('response.created', { response: { id: 'secret-id' } }) + 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"héllo 😃"}\n\n' + complete.replace('hello', 'héllo 😃');
  for (const newline of ['\n', '\r\n', '\r']) {
    const output = []; await translateResponses(stream(input.replaceAll('\n', newline), true), s => output.push(s));
    assert.equal(output.join(''), 'data: {"choices":[{"delta":{"content":"héllo 😃"}}]}\n\ndata: [DONE]\n\n');
  }
});
test('terminal errors, refusals and incomplete responses never become success or expose payloads', async () => {
  for (const [type, fields, code] of [
    ['error', { message: 'SECRET' }, 'incomplete'], ['response.failed', { response: { error: { message: 'SECRET' } } }, 'incomplete'],
    ['response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }, 'incomplete'],
    ['response.incomplete', { response: { incomplete_details: { reason: 'content_filter' } } }, 'refused'],
    ['response.refusal.delta', { delta: 'SECRET' }, 'refused'],
    ['response.completed', { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'SECRET' }] }] } }, 'refused']
  ]) {
    const output = [];
    await assert.rejects(translateResponses(stream(event('response.output_text.delta', { delta: 'partial' }) + event(type, fields)), s => output.push(s)), error => error.code === code && !error.message.includes('SECRET'));
    assert.equal(output.join('').includes('[DONE]'), false); assert.equal(output.join('').includes('SECRET'), false);
  }
});
test('missing terminals, malformed/truncated SSE, trailing errors and non-text output fail closed', async () => {
  for (const input of ['', 'data: [DONE]\n\n', event('response.output_text.delta', { delta: 'partial' }), complete.trimEnd(), 'data: {invalid}\n\n', event('response.output_text.delta', { delta: 123 }), complete + event('error', {}), complete + complete, 'event: response.completed\ndata: {"type":"response.failed"}\n\n', event('response.completed', { response: { status: 'failed', output: [] } }), event('response.completed', { response: { status: 'completed', output: [{ type: 'function_call' }] } })]) {
    const output = []; await assert.rejects(translateResponses(stream(input), s => output.push(s)), { code: 'stream_invalid' }); assert.equal(output.join('').includes('[DONE]'), false);
  }
});
test('SSE byte/frame budgets, invalid UTF-8, backpressure failure and abort cancel upstream', async () => {
  await assert.rejects(translateResponses(stream(complete), () => {}, { maxBytes: 10 }));
  await assert.rejects(translateResponses(stream('data: ' + 'x'.repeat(100)), () => {}, { maxFrameBytes: 16 }));
  await assert.rejects(translateResponses(new Response(Uint8Array.of(0xff)).body, () => {}));
  await assert.rejects(translateResponses(stream(event('response.output_text.delta', { delta: 'hello' }) + complete), () => { throw Error('downstream closed'); }));
  let cancelled = false; const controller = new AbortController();
  const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from(event('response.output_text.delta', { delta: 'partial' }))); }, cancel() { cancelled = true; } });
  await assert.rejects(translateResponses(body, () => { controller.abort(); }, { signal: controller.signal })); assert.equal(cancelled, true);
});

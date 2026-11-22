'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const path = require('node:path');

const script = readFileSync(path.join(__dirname, 'patch-copilot-chat.sh'), 'utf8');
const literal = (name) => {
  const value = script.match(new RegExp(`^${name}='([^']*)'$`, 'm'))?.[1];
  assert(value, name);
  return value;
};
const id = 'request_11111111-1111-4111-8111-111111111111';
const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
const counts = { read: 0, search: 0, write: 0, other: 0 };
const trace = {
  contract: 'ezil.inference.v1', adapterVersion: '0.1.0+carbon-progress.1',
  requestId: '22222222-2222-4222-8222-222222222222', turnId: '33333333-3333-4333-8333-333333333333',
  modelAlias: 'gemini-4-carbon', clientRequestId: null, gatewayRequestId: null, conversationId: null,
  toolCalls: [], toolResults: [], offered: counts, requested: counts, observationsTruncated: false,
  results: { matched: 0, error: 0, reportedSuccess: 0, unknown: 0, unmatched: 0 }, writeRequested: false,
  toolReportedSuccess: false, verifiedFileChange: null, usage: null, usageSource: 'unknown', estimatedInputTokens: 12,
  wireBytes: null, totalWireBytes: 0, attempts: 0, compaction: null, finishReason: null,
  durationMs: 1, cancelled: false, outcome: 'completed', thought_signature_replayed: false, readHeavyWithoutVerifiedEdit: false,
};

const promise = () => Promise.withResolvers();
const drain = () => new Promise(resolve => setImmediate(resolve));
function renderer() {
  const events = [];
  const commands = new Map();
  const dataset = { ezilAssignmentChat: '1', ezilAssignmentChatNonce: nonce };
  const helpers = literal('R_ASSIGNMENT_CHAT_HELPERS').slice(0, -literal('A_ASSIGNMENT_CHAT_HELPERS').length);
  const context = {
    document: { documentElement: { dataset } }, TextEncoder,
    window: { dispatchEvent(event) { events.push({ type: event.type, detail: JSON.parse(JSON.stringify(event.detail)) }); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    qe: { registerCommand(command, handler) { commands.set(command, handler); } },
  };
  runInNewContext(helpers + literal('R_AI_REQUEST_TRACE'), context);
  return { ...context, dataset, events, commands };
}

test('the accepted request and its exact terminal response preserve Markdown and exclude tool/reasoning contents', async () => {
  const r = renderer();
  const created = promise(), complete = promise();
  const prompt = '  Build another test.\nAllowed punctuation stays. ';
  r.ezilObserveAssignmentChat(nonce, { responseCreatedPromise: created.promise, responseCompletePromise: complete.promise }, prompt);
  await drain();
  assert.deepEqual(r.events, []);
  created.resolve({
    requestId: id, isComplete: true, isCanceled: false, response: { value: [
      { kind: 'markdownContent', content: { value: 'I changed **one** file.\n' } },
      { kind: 'thinking', content: { value: 'hidden reasoning' } },
      { kind: 'toolInvocation', content: { value: 'hidden tool arguments' } },
      { kind: 'markdownContent', content: { value: 'Test passed.' } },
    ] },
  });
  await drain();
  assert.deepEqual(r.events, [{ type: 'ezil:assignment-chat', detail: { kind: 'chat.prompt_submitted', chatRequestId: id, text: prompt } }]);
  complete.resolve();
  await drain();
  assert.deepEqual(r.events[1], { type: 'ezil:assignment-chat', detail: { kind: 'chat.response_completed',
    chatRequestId: id, text: 'I changed **one** file.\nTest passed.' } });
});

test('revocation, rearming, oversized content and redacted replies cannot emit retained text from another arm', async () => {
  const r = renderer();
  const created = promise(), complete = promise();
  r.ezilObserveAssignmentChat(nonce, { responseCreatedPromise: created.promise, responseCompletePromise: complete.promise }, 'old queue');
  r.dataset.ezilAssignmentChatNonce = 'BBBBBBBBBBBBBBBBBBBBBB';
  created.resolve({ requestId: id }); complete.resolve(); await drain();
  assert.deepEqual(r.events, []);
  r.ezilObserveAssignmentChat(r.dataset.ezilAssignmentChatNonce, {
    responseCreatedPromise: Promise.resolve({ requestId: id, isComplete: true, isCanceled: false,
      result: { errorDetails: { responseIsRedacted: true } },
      get response() { throw Error('redacted response touched'); } }),
    responseCompletePromise: Promise.resolve(),
  }, '🙂'.repeat(10000));
  await drain();
  const oversized = [{ type: 'ezil:assignment-chat',
    detail: { kind: 'chat.prompt_submitted', chatRequestId: id, contentStatus: 'over_limit' } }];
  assert.deepEqual(r.events, oversized);
  delete r.dataset.ezilAssignmentChat;
  r.ezilEmitAssignmentChat(nonce, 'chat.prompt_submitted', id, 'not armed');
  assert.deepEqual(r.events, oversized);
});

test('the already validated operational trace emits a separate exact link only while transcript capture is armed', () => {
  const r = renderer();
  const send = r.commands.get('_ezil.aiRequestTrace');
  send({}, { ...trace, prompt: 'private' }, id);
  assert.deepEqual(r.events, []);
  send({}, trace, id);
  assert.equal(r.events[0].type, 'ezil-ai-request-trace');
  assert.deepEqual(JSON.parse(r.events[0].detail), trace);
  assert.equal(r.events.length, 1);
  r.ezilRememberAssignmentChat(id);
  assert.deepEqual(r.events[1], { type: 'ezil:assignment-gateway-link', detail: { chatRequestId: id, requestId: trace.requestId } });
  delete r.dataset.ezilAssignmentChatNonce;
  send({}, trace, id);
  assert.equal(r.events.length, 3);
  assert.equal(r.events[2].type, 'ezil-ai-request-trace');
});

test('the explicit setup retry records real request lineage and reports only the replacement reply', async () => {
  const r = renderer();
  const replacement = 'request_44444444-4444-4444-8444-444444444444';
  const submitted = {
    responseCreatedPromise: Promise.resolve({ requestId: id, isComplete: true, isCanceled: true }),
    responseCompletePromise: Promise.resolve(),
  };
  const retry = {
    responseCreatedPromise: Promise.resolve({ requestId: replacement, isComplete: true, isCanceled: false,
      response: { value: [{ kind: 'markdownContent', content: { value: 'Actual replacement reply' } }] } }),
    responseCompletePromise: Promise.resolve(),
  };
  r.ezilObserveAssignmentChat(nonce, submitted, 'Accepted composer input');
  await drain();
  r.commands.get('_ezil.aiRequestTrace')({}, trace, replacement);
  r.ezilObserveAssignmentSetupRetry(id, retry);
  await drain();
  assert.deepEqual(r.events.map(e => e.detail.kind || e.type), [
    'chat.prompt_submitted', 'ezil-ai-request-trace', 'chat.request_retried', 'ezil:assignment-gateway-link', 'chat.response_completed',
  ]);
  assert.deepEqual(r.events[2].detail, { kind: 'chat.request_retried', chatRequestId: id, retryChatRequestId: replacement });
  assert.deepEqual(r.events[3].detail, { chatRequestId: replacement, requestId: trace.requestId });
  assert.deepEqual(r.events[4].detail, { kind: 'chat.response_completed', chatRequestId: replacement, text: 'Actual replacement reply' });
  r.dataset.ezilAssignmentChatNonce = 'BBBBBBBBBBBBBBBBBBBBBB';
  r.ezilObserveAssignmentSetupRetry(id, retry);
  await drain();
  assert.equal(r.events.length, 5);
});

test('the patched dispatch carries the exact primary turn identity and strips utility or subagent lanes', () => {
  const original = literal('R_ASSIGNMENT_LOOP');
  const options = new Function('n', 'p', `return ${original}null})`);
  const run = (request, values) => options.call({ options: {
    request, invocation: { endpoint: { makeChatRequest2: arg => arg } },
  } }, { turnId: id, ...values }, false).ezilAssignmentChatRequestId;
  assert.equal(run({ id }, {}), id);
  assert.equal(run({ id }, { turnId: id + 'different' }), undefined);
  assert.equal(run({ id }, { isKeepAliveProbe: true }), undefined);
  assert.equal(run({ id, isSystemInitiated: true }, {}), undefined);
  assert.equal(run({ id, subAgentInvocationId: 'subagent' }, {}), undefined);
  assert.equal(run({ id, parentRequestId: 'parent' }, {}), undefined);
  const select = literal('R_SUMMARY_BRIDGE').split('modelOptions:{')[1].split(',...h!==')[0];
  const modelOptions = new Function('g', 'f', 'summary', 'ezilChatId', `return {${select}}`);
  assert.equal(modelOptions.call({ modelProvider: 'ezil' }, '', null, false, id)._ezilAssignmentChatRequestId, id);
  assert.equal(modelOptions.call({ modelProvider: 'ezil' }, '', null, true, id)._ezilAssignmentChatRequestId, undefined);
});

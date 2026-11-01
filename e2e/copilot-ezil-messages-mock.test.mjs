import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMock, validateBody, QWEN, KIMI, SLOW_DONE } from './copilot-ezil-messages-mock.mjs';

const base = () => ({ model: QWEN, max_tokens: 16, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
const tool = name => ({ name, input_schema: { type: 'object', properties: {} } });
const paired = () => ({ ...base(), tools: [tool('create_file')], tool_choice: { type: 'auto' }, messages: [
  ...base().messages,
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'create_file', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'created' }] }] },
] });

test('valid text, paired tools, sampling and exact byte boundary', () => {
  assert.equal(validateBody(base()), null);
  assert.equal(validateBody(paired()), null);
  assert.equal(validateBody({ ...base(), system: [{ type: 'text', text: 'system' }], temperature: 0, top_p: 1, stop_sequences: ['stop'] }), null);
  assert.equal(validateBody(base(), 131072 - 1056), null);
  assert.equal(validateBody(base(), 131072 - 1055).status, 413);
  assert.equal(validateBody({ ...base(), model: KIMI, stream: false }), null);
});

test('reject every unsupported Converse shape', () => {
  const cases = [
    null, {}, { ...base(), messages: [null] }, { ...base(), messages: [] },
    { ...base(), metadata: {} }, { ...base(), thinking: {} }, { ...base(), model: KIMI },
    ...[15, 16385, 16.5].map(max_tokens => ({ ...base(), max_tokens })),
    { ...base(), tools: [] }, { ...base(), tools: Array.from({ length: 65 }, (_, i) => tool('t' + i)) },
    { ...base(), tools: [tool('bad.name')] }, { ...base(), tools: [tool('a'.repeat(65))] },
    { ...base(), tools: [{ name: 't', input_schema: { type: 'string' } }] },
    { ...paired(), tool_choice: { type: 'any' } }, { ...paired(), tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
    { ...base(), system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] },
    ...['image', 'thinking', 'document'].map(type => ({ ...base(), messages: [{ role: 'user', content: [{ type, text: 'unsupported' }] }] })),
    { ...base(), messages: [{ role: 'assistant', content: 'prefill' }] },
    { ...base(), messages: [...base().messages, { role: 'assistant', content: 'prefill' }] },
    { ...paired(), messages: [...paired().messages.slice(0, 2), { role: 'user', content: 'missing result' }] },
    ...['orphan', 'call_1'].map(id => ({ ...paired(), messages: [...paired().messages.slice(0, 2), { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] }] })),
    { ...base(), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'output' }] }] },
  ];
  for (const value of cases) assert.equal(validateBody(value)?.code, 'unsupported_bedrock_converse_request', JSON.stringify(value));
});

test('authenticated request handler, Qwen SSE, Kimi JSON and scripted tool sequence', async () => {
  const captureDir = mkdtempSync(join(tmpdir(), 'ezil-messages-test-'));
  const server = createMock({ token: 'test-only', folder: '/project', captureDir });
  // Exercise the actual HTTP handler with streams; restricted workers cannot
  // bind sockets. The lead-run image suite supplies real HTTP transport.
  const fetch = async (url, options = {}) => {
    const request = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    request.method = options.method ?? 'GET';
    request.url = new URL(url).pathname;
    request.headers = options.headers ?? {};
    let status, headers, output = '';
    const response = {
      writeHead(code, values) { status = code; headers = values; },
      write(chunk) { output += chunk; },
      end(chunk = '') { output += chunk; },
    };
    await server.listeners('request')[0](request, response);
    return new Response(output, { status, headers });
  };
  try {
    const url = 'http://127.0.0.1/ai/v1';
    const headers = { authorization: 'Bearer test-only', 'content-type': 'application/json' };
    assert.equal((await fetch(url + '/models')).status, 401);
    assert.equal((await fetch(url + '/messages', { method: 'POST', body: JSON.stringify(base()) })).status, 401);
    assert.equal((await (await fetch(url + '/models', { headers })).json()).data.length, 2);
    const post = body => fetch(url + '/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({ ...base(), model: KIMI })).status, 400);
    assert.equal((await (await post({ ...base(), model: KIMI, stream: false })).json()).content[0].text.includes('EZIL_KIMI_OK'), true);
    const body = { ...base(), tools: ['create_file', 'replace_string_in_file', 'run_in_terminal'].map(tool), tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'EZIL_E2E_AGENT' }] };
    for (const name of ['create_file', 'replace_string_in_file', 'run_in_terminal']) {
      const response = await post(body);
      assert.equal(response.status, 200);
      const raw = await response.text();
      const events = raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.at(-1).type, 'message_stop');
      const call = events.find(event => event.type === 'content_block_start').content_block;
      assert.equal(call.name, name);
      call.input = JSON.parse(events.find(event => event.type === 'content_block_delta').delta.partial_json);
      body.messages.push({ role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'success' }] });
    }
    assert.match(await (await post(body)).text(), /EZIL_E2E_DONE/);
    const invalid = await post({ ...base(), messages: [{ role: 'user', content: 'x'.repeat(131072) }] });
    assert.equal(invalid.status, 413);
    const captures = JSON.parse(readFileSync(join(captureDir, 'captured.json')));
    assert.equal(captures.length, 10);
    assert.equal(captures.filter(record => !record.authorized).length, 2);
    assert.equal(readFileSync(join(captureDir, '0002.body.json'), 'utf8'), JSON.stringify(base()));
  } finally {
    server.close();
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test('a slow answer streams its parts over time, stops for a closed client, and answers whole unstreamed', async () => {
  const captureDir = mkdtempSync(join(tmpdir(), 'ezil-messages-slow-'));
  const server = createMock({ token: 'test-only', folder: '/project', captureDir, slow: { parts: 3, ms: 40 } });
  const handle = server.listeners('request')[0];
  const call = async (body, { closeAfter } = {}) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: 'POST', url: '/ai/v1/messages', headers: { authorization: 'Bearer test-only' } });
    const writes = [];
    const response = { destroyed: false, writeHead() {}, write(chunk) { writes.push({ at: Date.now(), chunk }); if (writes.length === closeAfter) this.destroyed = true; }, end(chunk = '') { writes.push({ at: Date.now(), chunk, end: true }); } };
    await handle(request, response);
    return writes;
  };
  try {
    const slow = { ...base(), messages: [{ role: 'user', content: 'EZIL_E2E_SLOW: keep going' }] };
    const writes = await call(slow);
    const deltas = writes.filter(w => w.chunk.includes('text_delta')).map(w => ({ at: w.at, text: JSON.parse(w.chunk.split('data: ')[1]).delta.text }));
    assert.deepEqual(deltas.map(d => d.text), ['EZiL Chat: slow reply.', ' part 1.', ' part 2.', ' part 3.', SLOW_DONE]);
    assert.ok(deltas.at(-1).at - deltas[0].at >= 4 * 40 - 5, 'parts arrive over time');
    assert.equal(writes.at(-1).end, true);
    // A client that went away stops the stream: nothing after the close, and no end.
    const closed = await call(slow, { closeAfter: 4 });
    assert.equal(closed.length, 4);
    // Unstreamed, the same answer arrives whole and carries no test-only field.
    const whole = JSON.parse((await call({ ...slow, stream: false })).at(-1).chunk);
    assert.deepEqual(whole.content, [{ type: 'text', text: 'EZiL Chat: slow reply. part 1. part 2. part 3.' + SLOW_DONE }]);
    // A plain prompt is not slowed.
    assert.equal((await call(base())).filter(w => w.chunk.includes('text_delta')).length, 1);
  } finally {
    server.close();
    rmSync(captureDir, { recursive: true, force: true });
  }
});

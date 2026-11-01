#!/usr/bin/env node
// Deterministic EZiL gateway double. No model service or credentials required.
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const QWEN = 'qwen.qwen3-coder-next';
export const KIMI = 'us.moonshotai.kimi-k3';
export const SLOW_DONE = ' EZIL_SLOW_DONE';
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const text = value => only(value, ['type', 'text']) && value.type === 'text' && nonempty(value.text);
const textContent = value => nonempty(value) || (Array.isArray(value) && value.length > 0 && value.every(text));
const hasCache = value => value && typeof value === 'object' &&
  (Object.hasOwn(value, 'cache_control') || Object.values(value).some(hasCache));
const usage = { input_tokens: 1200, output_tokens: 32, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// Return an actionable reason instead of accepting payloads Bedrock would reject.
export function validateBody(body, bytes = Buffer.byteLength(JSON.stringify(body) ?? '')) {
  if (bytes + 1056 > 131072) return { status: 413, code: 'body_too_large', message: 'body bytes + 1056 exceeds 131072' };
  const reject = message => ({ status: 400, code: 'unsupported_bedrock_converse_request', message });
  if (!only(body, ['model', 'messages', 'system', 'max_tokens', 'stream', 'temperature', 'top_p', 'stop_sequences', 'tools', 'tool_choice'])) return reject('unsupported request field');
  if (![QWEN, KIMI].includes(body.model)) return reject('unsupported model');
  if (hasCache(body)) return reject('cache_control is unsupported');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 16 || body.max_tokens > 16384) return reject('max_tokens must be 16..16384');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return reject('stream must be boolean');
  if (body.model === KIMI && body.stream === true) return reject('Kimi cannot stream');
  for (const key of ['temperature', 'top_p']) {
    if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > 1)) return reject(key + ' must be 0..1');
  }
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every(nonempty))) return reject('invalid stop_sequences');
  if (body.system !== undefined && !textContent(body.system)) return reject('system must be text only');
  if (body.tool_choice !== undefined && (!only(body.tool_choice, ['type']) || body.tool_choice.type !== 'auto' || !body.tools)) return reject('tool_choice must be auto with tools');
  const names = new Set();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length < 1 || body.tools.length > 64) return reject('tools must contain 1..64 definitions');
    for (const tool of body.tools) {
      if (!only(tool, ['name', 'description', 'input_schema']) || typeof tool.name !== 'string' || !NAME.test(tool.name) || names.has(tool.name) || !object(tool.input_schema) || tool.input_schema.type !== 'object' || (tool.description !== undefined && typeof tool.description !== 'string')) return reject('invalid tool definition');
      names.add(tool.name);
    }
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages[0]?.role !== 'user' || body.messages.at(-1)?.role !== 'user') return reject('first and last turn must be user');
  const seen = new Set();
  let pending = new Set(), previous;
  for (const turn of body.messages) {
    if (!only(turn, ['role', 'content']) || !['user', 'assistant'].includes(turn.role) || turn.role === previous) return reject('invalid or non-alternating turn');
    previous = turn.role;
    const blocks = typeof turn.content === 'string' ? [{ type: 'text', text: turn.content }] : turn.content;
    if (!Array.isArray(blocks) || !blocks.length) return reject('empty content');
    const calls = new Set();
    for (const block of blocks) {
      if (text(block)) continue;
      if (turn.role === 'assistant' && only(block, ['type', 'id', 'name', 'input']) && block.type === 'tool_use' && typeof block.id === 'string' && NAME.test(block.id) && !seen.has(block.id) && names.has(block.name) && object(block.input)) {
        calls.add(block.id); seen.add(block.id); continue;
      }
      if (turn.role === 'user' && only(block, ['type', 'tool_use_id', 'content', 'is_error']) && block.type === 'tool_result' && pending.delete(block.tool_use_id) && textContent(block.content) && (block.is_error === undefined || typeof block.is_error === 'boolean')) continue;
      return reject('unsupported content or unmatched tool result (text-only required)');
    }
    if (turn.role === 'user' && pending.size) return reject('tool_use must be followed by matching tool_result');
    pending = calls;
  }
  return null;
}

function scriptedContent(body, folder) {
  const history = body.messages.flatMap(turn => Array.isArray(turn.content) ? turn.content : []);
  // The scenario is the newest user prompt that carries a marker: a chat may continue an earlier one.
  const turnText = turn => (typeof turn.content === 'string' ? [turn.content] : turn.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
  const marked = body.messages.filter(turn => turn.role === 'user').map(turnText).reverse().find(t => /EZIL_E2E_(UNDO|AGENT|KIMI|SLOW)/.test(t)) ?? '';
  const userText = marked;
  const done = id => history.some(block => block.type === 'tool_result' && block.tool_use_id === id);
  const call = (id, name, input) => {
    if (!body.tools?.some(tool => tool.name === name)) throw new Error('script requires offered tool ' + name);
    return [{ type: 'tool_use', id, name, input }];
  };
  if (userText.includes('EZIL_E2E_KIMI')) return [{ type: 'text', text: 'EZiL Chat: Kimi JSON response. EZIL_KIMI_OK' }];
  if (userText.includes('EZIL_E2E_SLOW')) return [{ type: 'text', text: 'EZiL Chat: slow reply.', slow: true }];
  if (userText.includes('EZIL_E2E_UNDO')) {
    if (!done('ezil_undo')) return call('ezil_undo', 'replace_string_in_file', { filePath: join(folder, 'existing.txt'), oldString: 'after\n', newString: 'undo candidate\n' });
    return [{ type: 'text', text: 'EZiL Chat: undo candidate ready.' }];
  }
  if (userText.includes('EZIL_E2E_AGENT') && body.tools?.length) {
    if (!done('ezil_create')) return call('ezil_create', 'create_file', { filePath: join(folder, 'hello.txt'), content: 'hi\n' });
    if (!done('ezil_edit')) return call('ezil_edit', 'replace_string_in_file', { filePath: join(folder, 'existing.txt'), oldString: 'before\n', newString: 'after\n' });
    // Output redirection intentionally needs user confirmation under VS Code's
    // default terminal policy. Never seed an auto-approval setting for this test.
    if (!done('ezil_terminal')) return call('ezil_terminal', 'run_in_terminal', { command: "printf 'confirmed\\n' > " + "'" + join(folder, 'terminal-confirmed.txt').replaceAll("'", "'\\''") + "'", explanation: 'Write the e2e confirmation marker', goal: 'Verify terminal approval', isBackground: false, timeout: 10000 });
    return [{ type: 'text', text: 'EZiL Chat: created hello.txt, edited existing.txt, and ran the confirmed command. EZIL_E2E_DONE' }];
  }
  return [{ type: 'text', text: body.model === KIMI ? 'EZiL Chat: Kimi JSON response. EZIL_KIMI_OK' : 'EZiL Chat' }];
}

// slow: a marked answer streams `parts` numbered parts `ms` apart (the image suite leaves a chat mid-answer).
export function createMock({ token, folder, captureDir, slow: { parts = 20, ms = 1000 } = {} }) {
  if (!nonempty(token)) throw new Error('a test token is required');
  const slowParts = () => Array.from({ length: parts }, (_, i) => ` part ${i + 1}.`);
  mkdirSync(captureDir, { recursive: true });
  const captured = [];
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined; } catch { /* rejected below */ }
    const n = captured.length + 1;
    const record = { n, method: req.method, path: req.url, authorized: req.headers.authorization === `Bearer ${token}`, bytes: raw.length, body };
    captured.push(record);
    writeFileSync(join(captureDir, String(n).padStart(4, '0') + '.body.json'), raw);
    writeFileSync(join(captureDir, 'captured.json'), JSON.stringify(captured, null, 2));
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'e2e-' + n }); res.end(JSON.stringify(value)); };
    const error = (status, code, message) => json(status, { error: { code, message, request_id: 'e2e-' + n } });
    if (!record.authorized) return error(401, 'os_proxy_unauthorized', 'test bearer token required');
    if (req.method === 'GET' && req.url === '/ai/v1/models') return json(200, { killswitch: false, pause: null, data: [QWEN, KIMI].map(id => ({ id, enabled: true, max_input_tokens: 131072, max_output_tokens: id === KIMI ? 4096 : 8192 })) });
    if (req.method !== 'POST' || req.url !== '/ai/v1/messages') return error(404, 'not_found', 'unsupported route');
    const invalid = validateBody(body, raw.length);
    if (invalid) return error(invalid.status, invalid.code, invalid.message);
    let scripted;
    try { scripted = scriptedContent(body, folder); } catch (err) { return error(500, 'e2e_missing_tool', err.message); }
    // A slow block streams its numbered parts, then SLOW_DONE: long enough to leave a chat while its
    // answer is still arriving. Unstreamed, it answers at once in full.
    const content = scripted.map(({ slow, ...block }) => (slow ? { ...block, text: block.text + slowParts().join('') + SLOW_DONE } : block));
    const message = { id: 'msg_e2e_' + n, type: 'message', role: 'assistant', model: body.model, content, stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
    if (body.model === KIMI || body.stream !== true) return json(200, message);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-request-id': 'e2e-' + n });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    for (const [index, block] of scripted.entries()) {
      event('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
      if (block.slow) {
        event('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        for (const part of [...slowParts(), SLOW_DONE]) {
          await new Promise(done => setTimeout(done, ms));
          if (res.destroyed) return;
          event('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
        }
      } else {
        event('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
      }
      event('content_block_stop', { index });
    }
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage });
    event('message_stop', {});
    res.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.argv[2] ?? 4142);
  const server = createMock({ token: process.env.EZIL_E2E_TEST_TOKEN ?? 'lanec-e2e-only', folder: process.argv[3] ?? '/home/neko/project', captureDir: process.argv[4] ?? '/tmp/copilot-ezil-mock' });
  server.listen(port, '127.0.0.1', () => console.log('EZiL messages mock listening on loopback port ' + port));
}

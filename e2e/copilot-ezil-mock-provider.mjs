/**
 * Mock OpenAI-compatible model server for the Copilot-Chat-on-EZiL-models
 * image e2e (`e2e/copilot-ezil-image.sh` + `e2e/copilot-ezil.mjs`).
 *
 * Runs INSIDE the desktop container with the image's own `node`. The built-in
 * `ezil-models` extension is pointed at it through a test-only config
 * (`e2e/copilot-ezil-models.json`, provider type `openai-compatible`,
 * `EZIL_MODELS_CONFIG=/etc/ezil/models.e2e.json`), so the round trip it
 * proves is: Copilot Chat UI -> VS Code LanguageModelChat API -> ezil-models
 * -> HTTP -> here -> back, on the shipped image, with no model credentials.
 *
 * It behaves like a tool-using agent model, just enough for one scripted
 * Agent-mode task and for Copilot's utility calls:
 *
 *   - a request whose last message is a `tool` result  -> "Done. hello.txt is created."
 *   - a request that mentions hello.txt AND offers a tool named `create_file`
 *     -> short text + a streamed `create_file` tool call writing "hi\n" to
 *        <workspace>/hello.txt (the tool name/shape is Copilot Chat 0.67's,
 *        captured in /workspace/copilot-byok-test/captured/027-v2_chat.json)
 *   - anything else (title generation, "generate 10 progress messages",
 *     a plain question) -> a one-line text reply
 *
 * EVERY request is captured — headers + parsed body — to
 * <capture-dir>/NNN-request.json and to <capture-dir>/captured.json (the
 * whole list, rewritten each time), which the e2e reads with `docker exec` to
 * assert what Copilot Chat actually sent (system prompt, 39 tools, the tool
 * result). Authorization is NOT enforced (the e2e asserts the header instead).
 *
 *   node e2e/copilot-ezil-mock-provider.mjs [port=4142] [workspace=/home/neko/project] [capture-dir=/tmp/copilot-ezil-mock]
 *
 * GET  /v1/models            -> { data: [{ id: "mock-1" }] }
 * POST /v1/chat/completions  -> SSE stream (always; non-stream falls back to JSON)
 * GET  /captured             -> the capture list as JSON
 * Everything else            -> 404, logged, so a wrong baseUrl is visible.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 4142);
const WORKSPACE = process.argv[3] ?? process.env.MOCK_WORKSPACE ?? '/home/neko/project';
const CAPTURE = process.argv[4] ?? process.env.MOCK_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const MODEL = 'mock-1';

mkdirSync(CAPTURE, { recursive: true });
const log = (...a) => console.error(`[copilot-ezil-mock ${new Date().toISOString()}]`, ...a);
const captured = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '';

/** Decide what the "model" answers. Returns [{type:'text',text}|{type:'tool_call',id,name,arguments}]. */
function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolNames = tools.map((t) => t?.function?.name).filter(Boolean);
  if (last?.role === 'tool') return [{ type: 'text', text: 'Done. hello.txt is created.' }];
  const lastText = textOf(last?.content);
  if (/hello\.txt/i.test(lastText) && toolNames.includes('create_file')) {
    return [
      { type: 'text', text: 'I will create hello.txt now.' },
      { type: 'tool_call', id: `call_e2e_${Date.now()}`, name: 'create_file', arguments: { filePath: `${WORKSPACE}/hello.txt`, content: 'hi\n' } },
    ];
  }
  if (!tools.length) return [{ type: 'text', text: 'EZiL e2e' }]; // utility call: title / progress messages
  return [{ type: 'text', text: `pong from the EZiL e2e mock (tools=${tools.length}, messages=${messages.length})` }];
}

const chunk = (s, n = 8) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out.length ? out : ['']; };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'ezil-e2e' }] }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/captured') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(captured));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch { body = { unparsable: raw.slice(0, 2000) }; }
    const n = captured.length + 1;
    const entry = { n, at: new Date().toISOString(), url: req.url, headers: req.headers, body };
    captured.push(entry);
    writeFileSync(join(CAPTURE, `${String(n).padStart(3, '0')}-request.json`), JSON.stringify(entry, null, 2));
    writeFileSync(join(CAPTURE, 'captured.json'), JSON.stringify(captured));
    const choices = plan(body);
    const lastText = textOf(body.messages?.[body.messages.length - 1]?.content);
    log(`#${n} chat.completions model=${body.model} stream=${body.stream === true} tools=${(body.tools ?? []).length} messages=${(body.messages ?? []).length} last=${JSON.stringify(lastText).slice(0, 90)} -> ${choices.map((c) => c.type + (c.name ? ':' + c.name : '')).join(',')}`);
    const id = `chatcmpl-e2e-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const prompt_tokens = Math.ceil(raw.length / 4);
    const completion_tokens = 12;
    const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
    if (body.stream !== false) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      send({ role: 'assistant', content: '' });
      let toolIndex = 0;
      for (const c of choices) {
        if (c.type === 'text') { for (const piece of chunk(c.text)) send({ content: piece }); continue; }
        send({ tool_calls: [{ index: toolIndex, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
        for (const piece of chunk(JSON.stringify(c.arguments), 6)) send({ tool_calls: [{ index: toolIndex, function: { arguments: piece } }] });
        toolIndex += 1;
      }
      send({}, toolIndex ? 'tool_calls' : 'stop');
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const message = { role: 'assistant', content: choices.filter((c) => c.type === 'text').map((c) => c.text).join('') || null };
    const calls = choices.filter((c) => c.type === 'tool_call');
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model: MODEL, choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage }));
    return;
  }
  log(`404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `copilot-ezil mock: no route ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}/v1 (model ${MODEL}, workspace ${WORKSPACE}, capture ${CAPTURE})`));

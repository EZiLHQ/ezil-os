/**
 * Mock OpenAI-compatible model server for the EZiL Chat image e2e.
 *
 * `e2e/ezil-chat-image.sh` copies this file into the desktop container and
 * runs it with the image's own `node`, then points OpenCode at it through a
 * project-level `opencode.json` (`provider.mock`, `npm:
 * "@ai-sdk/openai-compatible"`, `options.baseURL: http://127.0.0.1:<port>/v1`
 * — the documented custom-provider shape, https://opencode.ai/docs/providers/
 * #custom-provider). It answers every chat completion with the same short
 * text, streamed as SSE when asked, with a final usage chunk so the panel's
 * token readout has numbers to show. No model, no key, no network: the
 * round trip it proves is browser -> webview -> extension host -> `opencode
 * serve` -> provider -> back, on the shipped image, with no Foundry
 * credentials anywhere.
 *
 *   node e2e/ezil-chat-mock-provider.mjs [port=4141] [reply=pong]
 *
 * GET  /v1/models            -> { data: [{ id: "mock-1" }] }
 * POST /v1/chat/completions  -> the reply (stream or not)
 * Everything else            -> 404, logged, so a wrong baseURL is visible.
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 4141);
const REPLY = process.argv[3] ?? process.env.MOCK_REPLY ?? 'pong';
const MODEL = 'mock-1';

const log = (...a) => console.error(`[mock-provider ${new Date().toISOString()}]`, ...a);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'ezil-e2e' }] }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch { /* answer anyway */ }
    const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : undefined;
    const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    log(`chat.completions stream=${body.stream === true} model=${body.model} last_user=${JSON.stringify(lastText).slice(0, 80)}`);
    const id = `chatcmpl-mock-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 13, completion_tokens: 1, total_tokens: 14 };
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      send({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }] });
      send({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [], usage });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], usage }));
    return;
  }
  log(`404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `mock provider: no route ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}/v1 (model ${MODEL}, reply ${JSON.stringify(REPLY)})`));

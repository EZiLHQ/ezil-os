// Metadata-only deterministic Gateway fault. Never subscribe to, inspect, drain or retain request bodies.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MODEL = 'qwen.qwen3-coder-next'; // catalog aliases currently disallow '/', so use the safe dotted namespace
export const MODEL_NAME = 'Qwen3 Coder Next';
export const REQUEST_ID = 'd0000000-0000-4000-8000-0000000000e1';
export const modelConfig = {
  providers: { ezil: { type: 'ezil-gateway', baseUrl: '{env:EZIL_AI_BASE_URL}', apiKey: '{env:EZIL_AI_PROXY_TOKEN}' } },
  models: [{ id: MODEL, model: MODEL, name: MODEL_NAME, provider: 'ezil', family: 'qwen', default: true,
    roles: ['default', 'plan', 'utility', 'utilitySmall'], stream: true, maxInputTokens: 131072, maxOutputTokens: 8192,
    capabilities: { toolCalling: true, imageInput: false } }],
};

export function faultHandler({ variant = 'missing_terminal', log = line => process.stdout.write(`${JSON.stringify(line)}\n`) } = {}) {
  if (!['missing_terminal', 'settlement_pending'].includes(variant)) throw new Error('Unsupported fault variant');
  return (req, res) => {
    // Do not log query strings or attacker-selected paths. Only closed route names enter metadata.
    const route = ['/ai/v1/models', '/ai/v1/messages', '/healthz'].includes(req.url) ? req.url : '/unknown';
    const method = ['GET', 'POST'].includes(req.method) ? req.method : 'OTHER';
    const status = (method === 'GET' && ['/ai/v1/models', '/healthz'].includes(route))
      || (method === 'POST' && route === '/ai/v1/messages') ? 200 : 404;
    log({ method, path: route, status, requestId: REQUEST_ID });
    if (method === 'POST' && route === '/ai/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
        'x-ezil-request-id': REQUEST_ID, connection: 'close' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: MODEL,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Synthetic partial response.' } });
      event('content_block_stop', { index: 0 });
      if (variant === 'settlement_pending') event('error', { error: { type: 'api_error', code: 'settlement_pending' } });
      // Deliberately no message_stop. Clean EOF (not a socket reset) makes this deterministic.
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'x-ezil-request-id': REQUEST_ID });
    if (route === '/ai/v1/models' && status === 200) {
      res.end(JSON.stringify({ object: 'list', contract: 'ezil.gateway.models.v1', catalog_ttl_seconds: 60,
        killswitch: false, pause: null, default_model: MODEL,
        data: [{ id: MODEL, object: 'model', name: MODEL_NAME, enabled: true, max_input_tokens: 131072, max_output_tokens: 8192,
          protocols: ['anthropic-messages'], availability: { state: 'available', reasons: [] },
          capabilities: { tool_calling: true, image_input: false, streaming: true } }] }));
    } else res.end(JSON.stringify({ ok: status === 200 }));
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--config') process.stdout.write(JSON.stringify(modelConfig));
  else createServer(faultHandler({ variant: process.env.FAULT_VARIANT || 'missing_terminal' }))
    .listen(Number(process.env.MOCK_PORT || 4142), '127.0.0.1');
}

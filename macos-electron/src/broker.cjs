'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { exact } = require('./policy.cjs');
const { atomic, privateDir, noLinks } = require('./files.cjs');
const { WorksSession, storedSession, CLIENT_CAPS, failure, safeError, fixedFetch, responseError } = require('./works-session.cjs');
const { responsesRequest, translateResponses, frame } = require('./responses.cjs');
const LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 8 * 1024 * 1024, concurrent: 2, timeoutMs: 60000, messages: 100, maxTokens: 8192 });
function credential(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid provider');
  if (value.provider === 'ezil') {
    exact(value, ['provider', 'session']);
    if (value.session !== null) storedSession(value.session);
  } else if (value.provider === 'azure') {
    exact(value, ['provider', 'endpoint', 'deployment', 'key']);
    const url = new URL(value.endpoint);
    const openAIHost = /^[a-z0-9-]+\.openai\.azure\.com$/.test(url.hostname);
    const foundryHost = /^[a-z0-9-]+\.services\.ai\.azure\.com$/.test(url.hostname);
    const legacyPath = openAIHost && url.pathname === '/';
    const v1Path = (openAIHost || foundryHost) && (url.pathname === '/openai/v1' || url.pathname === '/openai/v1/');
    if (url.protocol !== 'https:' || (!legacyPath && !v1Path) || url.port || url.username || url.password || url.search || url.hash) throw Error('Use an Azure OpenAI resource endpoint or exact Foundry /openai/v1 endpoint');
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value.deployment)) throw Error('Invalid deployment');
    if (typeof value.key !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(value.key)) throw Error('Invalid key');
  } else if (value.provider === 'bedrock') {
    exact(value, ['provider', 'region', 'model', 'token']);
    if (!/^(us|eu|ap|ca|sa|me|af|il|mx)-(?:gov-)?[a-z]+-\d$/.test(value.region) || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value.model)) throw Error('Invalid Bedrock region/model');
    if (typeof value.token !== 'string' || !/^[\x21-\x7e]{8,8192}$/.test(value.token)) throw Error('Invalid bearer token');
  } else throw Error('Temporary IAM credentials are unavailable; use a Bedrock API key');
  return value;
}
function chatRequest(body, model) {
  exact(body, ['model', 'messages', 'maxTokens']);
  if (body.model !== model || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > LIMITS.messages || !Number.isInteger(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > LIMITS.maxTokens) throw Error('Invalid chat request');
  for (const message of body.messages) {
    exact(message, ['role', 'content']);
    if (!['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 32000) throw Error('Invalid message');
  }
  return body;
}
function upstream(config, body) {
  credential(config);
  if (config.provider === 'ezil') throw failure('gateway_unavailable');
  if (config.provider === 'azure') {
    const endpoint = new URL(config.endpoint);
    const v1 = endpoint.pathname === '/openai/v1' || endpoint.pathname === '/openai/v1/';
    return {
      url: v1
        ? `${endpoint.origin}/openai/v1/chat/completions`
        : `${endpoint.origin}/openai/deployments/${config.deployment}/chat/completions?api-version=2024-10-21`,
      headers: { 'api-key': config.key },
      body: { ...(v1 ? { model: config.deployment } : {}), messages: body.messages, max_tokens: body.maxTokens, stream: true, stream_options: { include_usage: true } },
      contentType: 'text/event-stream'
    };
  }
  return {
    url: `https://bedrock-runtime.${config.region}.amazonaws.com/model/${encodeURIComponent(config.model)}/converse-stream`,
    headers: { Authorization: `Bearer ${config.token}` },
    body: { messages: body.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: [{ text: m.content }] })), system: body.messages.filter(m => m.role === 'system').map(m => ({ text: m.content })), inferenceConfig: { maxTokens: body.maxTokens } },
    contentType: 'application/vnd.amazon.eventstream'
  };
}
class Vault {
  constructor(root, safeStorage) { this.root = privateDir(root); this.storage = safeStorage; this.file = path.join(root, 'provider.enc'); this.revision = 0; }
  check() { if (process.platform !== 'darwin' || !this.storage.isEncryptionAvailable()) throw failure('secure_storage_unavailable'); }
  set(config) { this.check(); atomic(this.file, this.storage.encryptString(JSON.stringify(credential(config)))); this.revision++; }
  get() {
    if (!fs.existsSync(this.file)) return null; this.check(); noLinks(this.file);
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw Error('Invalid provider storage');
      return credential(JSON.parse(this.storage.decryptString(fs.readFileSync(fd))));
    } finally { fs.closeSync(fd); }
  }
  remove() { if (fs.existsSync(this.file)) { noLinks(this.file); fs.unlinkSync(this.file); } this.revision++; }
}
function authorized(value, token) {
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value), expected = Buffer.from(`Bearer ${token}`);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
function drain(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { response.removeListener('drain', ready); response.removeListener('close', cancelled); signal.removeEventListener('abort', cancelled); };
    const ready = () => { cleanup(); resolve(); };
    const cancelled = () => { cleanup(); reject(Error('Cancelled')); };
    response.once('drain', ready); response.once('close', cancelled); signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}
function gatewayError(res, error) {
  const safe = safeError(error);
  if (!res.headersSent) res.writeHead(safe.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-EZiL-Error': safe.code, ...(safe.retryAfter ? { 'Retry-After': safe.retryAfter } : {}) }).end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
  else res.end(frame({ error: { code: safe.code } }));
}
async function startBroker(root, vault, { fetchImpl = fetch, limits = LIMITS, createServer = http.createServer, works = new WorksSession(vault, { fetchImpl }) } = {}) {
  privateDir(root); const token = randomBytes(32).toString('hex');
  const usage = { requests: 0, completed: 0, failed: 0, responseBytes: 0, active: 0 };
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    // No CORS, Origin-bearing requests, arbitrary URL, forwarding or signing API.
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` || !authorized(req.headers.authorization, token)) { res.writeHead(403).end(); return; }
    if (req.url === '/v1/models' && req.method === 'GET') {
      const controller = new AbortController(); controllers.add(controller); res.once('close', () => controller.abort());
      try {
        const config = vault.get(); let result = { models: config ? [config.deployment || config.model] : [] };
        if (config?.provider === 'ezil') {
          const catalog = await works.inspect(controller.signal);
          if (catalog.paused) throw failure('paused');
          if (!catalog.models.length) throw failure('model_unavailable');
          result = { models: catalog.models.map(m => m.id), modelInfo: catalog.models };
        }
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(result));
      } catch (error) { gatewayError(res, error); } finally { controller.abort(); controllers.delete(controller); } return;
    }
    if (req.url !== '/v1/chat' || req.method !== 'POST' || req.headers['content-type'] !== 'application/json') { res.writeHead(404).end(); return; }
    if (usage.active >= limits.concurrent) { gatewayError(res, failure('rate_limited')); return; }
    usage.active++; usage.requests++;
    const controller = new AbortController(); controllers.add(controller);
    let gateway = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); if (!gateway) { req.destroy(); res.destroy(); } }, limits.timeoutMs);
    res.once('close', () => controller.abort());
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > limits.requestBytes) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const config = vault.get(); if (!config) { res.writeHead(503).end(); return; }
      gateway = config.provider === 'ezil';
      if (gateway) {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('request_invalid'); }
        const idempotencyKey = req.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) throw failure('request_invalid');
        // Validate the local contract before sending any request or credentials.
        responsesRequest(body, { id: body?.model, ...CLIENT_CAPS, minOutputTokens: 1 });
        const catalog = await works.inspect(controller.signal);
        if (catalog.paused) throw failure('paused');
        const model = catalog.models.find(m => m.id === body.model);
        if (!model) throw failure('model_unavailable');
        const payload = responsesRequest(body, model);
        controller.signal.throwIfAborted();
        const response = await fixedFetch(fetchImpl, `${works.origins.gatewayOrigin}/v1/responses`, {
          method: 'POST', headers: { Authorization: `Bearer ${catalog.session.accessToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(payload), signal: controller.signal
        }, works.origins);
        if (!response.ok) {
          const error = await responseError(response);
          if (error.code === 'signin_required') works.invalidate(catalog.session);
          throw error; // Never retry a POST, including 401 and 409.
        }
        if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'text/event-stream') { await response.body?.cancel(); throw failure('stream_invalid'); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-EZiL-Stream': 'responses-v1' });
        await translateResponses(response.body, async chunk => { if (!res.write(chunk)) await drain(res, controller.signal); }, {
          signal: controller.signal, maxBytes: limits.responseBytes, onBytes: bytes => { usage.responseBytes += bytes; }
        });
        res.end(); usage.completed++; return;
      }
      const body = chatRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), config.deployment || config.model);
      const target = upstream(config, body);
      const response = await fetchImpl(target.url, { method: 'POST', headers: { ...target.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(target.body), redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body || !(response.headers.get('content-type') || '').startsWith(target.contentType)) throw Error('Provider response unavailable');
      res.writeHead(200, { 'Content-Type': target.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      let responseBytes = 0;
      for await (const chunk of response.body) {
        responseBytes += chunk.length;
        if (responseBytes > limits.responseBytes) throw Error('Response limit');
        usage.responseBytes += chunk.length;
        if (!res.write(chunk)) await drain(res, controller.signal);
      }
      res.end(); usage.completed++;
    } catch (error) {
      usage.failed++;
      // Never relay provider errors, request bodies, headers, or exception text.
      // No retries: a failed stream may already have incurred provider charges.
      if (gateway) gatewayError(res, timedOut ? failure('timeout') : error);
      else if (!res.headersSent) res.writeHead(502).end('Provider request failed; no retry was attempted'); else res.destroy();
    } finally { controller.abort(); clearTimeout(timer); controllers.delete(controller); usage.active--; }
  });
  server.requestTimeout = limits.timeoutMs; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const descriptor = path.join(root, 'ai-broker.json');
  atomic(descriptor, JSON.stringify({ contractVersion: 1, url: `http://127.0.0.1:${server.address().port}`, capability: token, operations: ['models', 'chat'], formats: ['text/event-stream', 'application/vnd.amazon.eventstream'] }));
  let closed = false;
  return { descriptor, usage, close: () => { if (closed) return; closed = true; for (const c of controllers) c.abort(); server.closeAllConnections(); server.close(); fs.unlinkSync(descriptor); } };
}
module.exports = { LIMITS, credential, chatRequest, upstream, Vault, authorized, startBroker };

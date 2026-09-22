'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { exact } = require('./policy.cjs');
const { atomic, privateDir, noLinks } = require('./files.cjs');
const LIMITS = Object.freeze({ requestBytes: 256 * 1024, responseBytes: 8 * 1024 * 1024, concurrent: 2, timeoutMs: 60000, messages: 100, maxTokens: 8192 });
function credential(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid provider');
  if (value.provider === 'azure') {
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
  constructor(root, safeStorage) { this.root = privateDir(root); this.storage = safeStorage; this.file = path.join(root, 'provider.enc'); }
  // Reading Settings must never request Keychain access. Even availability
  // probing can initialize Electron's Keychain backend and show an OS prompt.
  status() { return { configured: fs.existsSync(this.file) }; }
  check() { if (process.platform !== 'darwin' || !this.storage.isEncryptionAvailable()) throw Error('macOS Keychain encryption is unavailable'); }
  set(config) { this.check(); atomic(this.file, this.storage.encryptString(JSON.stringify(credential(config)))); }
  get() { if (!fs.existsSync(this.file)) return null; this.check(); noLinks(this.file); return credential(JSON.parse(this.storage.decryptString(fs.readFileSync(this.file)))); }
  remove() { if (fs.existsSync(this.file)) { noLinks(this.file); fs.unlinkSync(this.file); } }
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
async function startBroker(root, vault, { fetchImpl = fetch, limits = LIMITS, createServer = http.createServer } = {}) {
  privateDir(root); const token = randomBytes(32).toString('hex');
  const usage = { requests: 0, completed: 0, failed: 0, responseBytes: 0, active: 0 };
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    // No CORS, Origin-bearing requests, arbitrary URL, forwarding or signing API.
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` || !authorized(req.headers.authorization, token)) { res.writeHead(403).end(); return; }
    if (req.url === '/v1/models' && req.method === 'GET') {
      try { const config = vault.get(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: config ? [config.deployment || config.model] : [] })); } catch { res.writeHead(503).end(); } return;
    }
    if (req.url !== '/v1/chat' || req.method !== 'POST' || req.headers['content-type'] !== 'application/json') { res.writeHead(404).end(); return; }
    if (usage.active >= limits.concurrent) { res.writeHead(429).end(); return; }
    usage.active++; usage.requests++;
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => { controller.abort(); req.destroy(); res.destroy(); }, limits.timeoutMs);
    res.once('close', () => controller.abort());
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > limits.requestBytes) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const config = vault.get(); if (!config) { res.writeHead(503).end(); return; }
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
    } catch {
      usage.failed++;
      // Never relay provider errors, request bodies, headers, or exception text.
      // No retries: a failed stream may already have incurred provider charges.
      if (!res.headersSent) res.writeHead(502).end('Provider request failed; no retry was attempted'); else res.destroy();
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

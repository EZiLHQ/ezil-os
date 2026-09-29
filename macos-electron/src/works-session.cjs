'use strict';
const { exact } = require('./policy.cjs');

// Origins come only from trusted host configuration, never IPC or requests.
const WORKS_ORIGIN = 'https://ezil-works-api.vercel.app';
const GATEWAY_ORIGIN = 'https://ai.ezil.work';
const CLIENT_CAPS = Object.freeze({ maxInputTokens: 32768, maxOutputTokens: 8192 });
const safeAlias = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
function origins(worksOrigin = WORKS_ORIGIN, gatewayOrigin = GATEWAY_ORIGIN) {
  for (const value of [worksOrigin, gatewayOrigin]) {
    let url; try { url = new URL(value); } catch { throw failure('auth_unavailable'); }
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw failure('auth_unavailable');
  }
  return Object.freeze({ worksOrigin, gatewayOrigin });
}
const ERRORS = Object.freeze({
  signin_required: [401, 'Sign in to Works again in Settings.'],
  builder_required: [403, 'Sign in with an onboarded Works builder account.'],
  membership_required: [403, 'Ask Works support to enable your AI membership.'],
  credits: [402, 'Not enough Works credits for this request. Check your credit balance in Works.'],
  budget: [402, 'The AI budget limit has been reached. Check the budget in Works before submitting again.'],
  key_revoked: [401, 'The AI key was revoked. Reconnect your account in Works before submitting again.'],
  replay: [409, 'This request was already submitted. Check Works usage before starting another request.'],
  pending_usage: [409, 'AI usage needs reconciliation. Contact Works support before sending another request.'],
  paused: [503, 'The EZiL AI gateway is paused. Try again after service resumes.'],
  model_unavailable: [503, 'This EZiL model is disabled or unavailable. Refresh the model list.'],
  request_invalid: [400, 'Use text messages and an output limit within the selected model allowance.'],
  input_too_large: [413, 'Shorten the conversation to fit the selected model allowance.'],
  rate_limited: [429, 'Too many requests. Wait for current requests to finish.'],
  refused: [422, 'The model refused this request. Revise the request before submitting again.'],
  incomplete: [502, 'The response is incomplete. Check Works usage before sending another request.'],
  stream_invalid: [502, 'The response stream was interrupted or invalid. Check Works usage before sending another request.'],
  gateway_unavailable: [503, 'The EZiL gateway is unavailable. No retry was attempted; check Works usage before resubmitting.'],
  auth_unavailable: [503, 'Works sign-in is unavailable. Check the Works service configuration.'],
  secure_storage_unavailable: [503, 'macOS Keychain is unavailable. Unlock it before connecting a provider.'],
  timeout: [504, 'The request timed out. Check Works usage before sending another request.']
});
class GatewayError extends Error {
  constructor(code) { const safeCode = Object.hasOwn(ERRORS, code) ? code : 'gateway_unavailable', entry = ERRORS[safeCode]; super(entry[1]); this.code = safeCode; this.status = entry[0]; }
}
const failure = code => new GatewayError(code);
function safeError(error, fallback = 'gateway_unavailable') { return error instanceof GatewayError ? error : failure(fallback); }
function storedSession(value) {
  exact(value, ['accessToken', 'refreshToken', 'accountId', 'expiresAt', 'worksOrigin', 'gatewayOrigin']);
  if ((value.worksOrigin === undefined) !== (value.gatewayOrigin === undefined)) throw failure('signin_required');
  origins(value.worksOrigin, value.gatewayOrigin);
  if (typeof value.accessToken !== 'string' || value.accessToken.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.accessToken)
    || typeof value.refreshToken !== 'string' || !/^[A-Za-z0-9._~-]{8,8192}$/.test(value.refreshToken)
    || typeof value.accountId !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(value.accountId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) throw failure('signin_required');
  return value;
}
function authEnvelope(value, now, serviceOrigins) {
  if (!value || typeof value.tokenType !== 'string' || value.tokenType.toLowerCase() !== 'bearer' || !Number.isInteger(value.expiresIn) || value.expiresIn < 61 || value.expiresIn > 86400) throw failure('auth_unavailable');
  // JWT claims are not used to authorize the builder. Both servers verify the
  // bearer; /v1/me and gateway /v1/models check their current database rows.
  return storedSession({ accessToken: value.accessToken, refreshToken: value.refreshToken, accountId: value.accountId, expiresAt: now + value.expiresIn * 1000, ...serviceOrigins });
}
async function readJSON(response, limit = 64 * 1024) {
  if (!response.body || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') { await response.body?.cancel().catch(() => {}); throw failure('gateway_unavailable'); }
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > limit) throw failure('gateway_unavailable'); chunks.push(Buffer.from(value)); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function responseError(response, auth = false) {
  let code; try { code = (await readJSON(response, 8192))?.error?.code; } catch {} finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
  const codes = {
    budget_exceeded: 'budget', budget_limit_exceeded: 'budget', budget_exhausted: 'budget', key_revoked: 'key_revoked', api_key_revoked: 'key_revoked',
    insufficient_credits: 'credits', idempotency_replay: 'replay', idempotency_conflict: 'replay',
    pending_reconciliation_required: 'pending_usage', killswitch: 'paused', model_disabled: 'model_unavailable', model_not_found: 'model_unavailable',
    account_suspended: 'membership_required', forbidden: 'membership_required', input_too_large: 'input_too_large',
    max_output_tokens_invalid: 'request_invalid', invalid_request: 'request_invalid', rate_limited: 'rate_limited', concurrency_limit: 'rate_limited'
  };
  const error = typeof code === 'string' && Object.hasOwn(codes, code) ? failure(codes[code]) : failure(({ 400: auth ? 'signin_required' : 'request_invalid', 401: 'signin_required', 402: 'credits', 403: 'membership_required', 409: 'replay', 413: 'input_too_large', 429: 'rate_limited' })[response.status] || (auth ? 'auth_unavailable' : 'gateway_unavailable'));
  const retry = response.headers.get('retry-after');
  if (retry && (/^[0-9]{1,8}$/.test(retry) || /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(retry))) {
    error.retryAfter = retry; error.message += ` Retry after ${retry}${/^\d+$/.test(retry) ? ' seconds' : ''}.`;
  }
  return error;
}
async function fixedFetch(fetchImpl, url, options, serviceOrigins = origins()) {
  const { worksOrigin: WORKS_ORIGIN, gatewayOrigin: GATEWAY_ORIGIN } = origins(serviceOrigins.worksOrigin, serviceOrigins.gatewayOrigin);
  if (![`${WORKS_ORIGIN}/auth/signin`, `${WORKS_ORIGIN}/auth/refresh`, `${WORKS_ORIGIN}/v1/me`, `${GATEWAY_ORIGIN}/v1/models`, `${GATEWAY_ORIGIN}/v1/responses`].includes(url)) throw failure('gateway_unavailable');
  const response = await fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) { await response.body?.cancel().catch(() => {}); throw failure('gateway_unavailable'); }
  return response;
}
function catalog(value) {
  if (!value || value.object !== 'list' || typeof value.killswitch !== 'boolean' || !Array.isArray(value.data) || value.data.length > 100) throw failure('gateway_unavailable');
  const models = [], seen = new Set();
  const positive = n => Number.isSafeInteger(n) && n > 0;
  for (const row of value.data) {
    if (!row || !safeAlias(row.id) || seen.has(row.id) || typeof row.enabled !== 'boolean'
      || !positive(row.max_input_tokens) || !positive(row.max_output_tokens)) throw failure('gateway_unavailable');
    seen.add(row.id);
    const min = row.min_output_tokens === undefined ? 16 : row.min_output_tokens;
    const allowance = row.default_output_tokens;
    if (!positive(min) || min > row.max_output_tokens || (allowance !== undefined && (!positive(allowance) || allowance < min || allowance > row.max_output_tokens))) throw failure('gateway_unavailable');
    if (row.capabilities !== undefined && (!row.capabilities || Array.isArray(row.capabilities)
      || Object.keys(row.capabilities).some(k => !['tools', 'structured_output', 'reasoning'].includes(k))
      || ['tools', 'structured_output', 'reasoning'].some(k => typeof row.capabilities[k] !== 'boolean'))) throw failure('gateway_unavailable');
    const formats = row.supported_api_formats;
    if (formats !== undefined && (!Array.isArray(formats) || !formats.length || new Set(formats).size !== formats.length
      || formats.some(f => !['responses', 'chat_completions'].includes(f)))) throw failure('gateway_unavailable');
    if (row.revision !== undefined && !(typeof row.revision === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(row.revision))
      && !(Number.isSafeInteger(row.revision) && row.revision >= 0)) throw failure('gateway_unavailable');
    const maxOutputTokens = Math.min(row.max_output_tokens, CLIENT_CAPS.maxOutputTokens);
    if (row.enabled && !value.killswitch && min <= maxOutputTokens && (!formats || formats.includes('responses'))) models.push({
      id: row.id, maxInputTokens: Math.min(row.max_input_tokens, CLIENT_CAPS.maxInputTokens), maxOutputTokens, minOutputTokens: min,
      defaultOutputTokens: Math.max(min, Math.min(allowance ?? 4096, maxOutputTokens)),
      // The broker translates text only, with no tools or structured output API.
      capabilities: { tools: false, structured_output: false, reasoning: false }, supportedApiFormats: ['responses']
    });
  }
  return { paused: value.killswitch, models };
}
class WorksSession {
  // A refresh plus inspection fits within Settings' ten-second IPC deadline.
  constructor(vault, { fetchImpl = fetch, now = Date.now, timeoutMs = 4000, worksOrigin = process.env.EZIL_WORKS_ORIGIN ?? WORKS_ORIGIN, gatewayOrigin = process.env.EZIL_GATEWAY_ORIGIN ?? GATEWAY_ORIGIN } = {}) { Object.assign(this, { vault, fetchImpl, now, timeoutMs }); Object.defineProperty(this, 'origins', { value: origins(worksOrigin, gatewayOrigin), enumerable: true }); this.refreshing = null; }
  current() { const config = this.vault.get(); if (config?.provider !== 'ezil' || !config.session) throw failure('signin_required'); const session = storedSession(config.session);
    const binding = origins(session.worksOrigin, session.gatewayOrigin);
    if (binding.worksOrigin !== this.origins.worksOrigin || binding.gatewayOrigin !== this.origins.gatewayOrigin) throw failure('signin_required');
    return session; }
  same(session) { try { return this.current().accessToken === session.accessToken && this.current().refreshToken === session.refreshToken; } catch { return false; } }
  invalidate(session) { if (this.same(session)) this.vault.set({ provider: 'ezil', session: null }); }
  async json(url, options, auth = false) {
    try { const response = await fixedFetch(this.fetchImpl, url, options, this.origins); if (!response.ok) throw await responseError(response, auth); return await readJSON(response); }
    catch (error) { throw safeError(error, auth ? 'auth_unavailable' : 'gateway_unavailable'); }
  }
  async signIn(email, password) {
    if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || !password.length || password.length > 4096) throw failure('signin_required');
    const revision = this.vault.revision;
    const session = authEnvelope(await this.json(`${this.origins.worksOrigin}/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(this.timeoutMs) }, true), this.now(), this.origins);
    if (this.vault.revision !== revision || this.vault.get()?.provider !== 'ezil') throw failure('signin_required');
    this.vault.set({ provider: 'ezil', session });
    return this.inspect();
  }
  async active() {
    if (this.refreshing) { await this.refreshing; return this.current(); }
    const session = this.current();
    if (session.expiresAt > this.now() + 60000) return session;
    // Consume the stored refresh token BEFORE exchanging it. A crash, lost
    // response or failed rotated-token write then requires sign-in, not reuse.
    this.vault.set({ provider: 'ezil', session: null });
    const revision = this.vault.revision;
    this.refreshing = (async () => {
      try {
        const next = authEnvelope(await this.json(`${this.origins.worksOrigin}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refreshToken }), signal: AbortSignal.timeout(this.timeoutMs) }, true), this.now(), this.origins);
        if (this.vault.revision !== revision || this.vault.get()?.provider !== 'ezil' || next.accountId !== session.accountId) throw failure('signin_required');
        // Persist rotation before any other network request. Never reuse an old
        // refresh token after an ambiguous refresh failure or failed disk write.
        this.vault.set({ provider: 'ezil', session: next });
      } catch { throw failure('signin_required'); }
    })();
    try { await this.refreshing; return this.current(); } finally { this.refreshing = null; }
  }
  async inspect(signal) {
    const session = await this.active();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const options = { headers: { Authorization: `Bearer ${session.accessToken}` }, signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
    try {
      options.signal.throwIfAborted();
      const me = await this.json(`${this.origins.worksOrigin}/v1/me`, options);
      if (me?.accountId !== session.accountId || me.role !== 'builder' || me.onboarded !== true) throw failure('builder_required');
      const result = catalog(await this.json(`${this.origins.gatewayOrigin}/v1/models`, options));
      if (!this.same(session)) throw failure('signin_required');
      options.signal.throwIfAborted();
      return { ...result, session };
    } catch (error) { if (error?.code === 'signin_required') this.invalidate(session); throw safeError(error); }
  }
  async status() {
    let provider;
    try {
      const config = this.vault.get();
      provider = config?.provider;
      if (!config) return { configured: false, provider: 'none', state: 'disconnected' };
      if (config.provider !== 'ezil') return { configured: true, provider: config.provider, state: 'stored' };
      if (!config.session) return { configured: true, provider: 'ezil', state: 'signin_required', errorCode: 'signin_required' };
      const result = await this.inspect();
      return { configured: true, provider: 'ezil', state: result.paused ? 'paused' : result.models.length ? 'ready' : 'model_unavailable', models: result.models.map(m => m.id) };
    } catch (error) { return { configured: true, ...(provider ? { provider } : {}), state: 'unavailable', errorCode: safeError(error).code }; }
  }
}
module.exports = { WORKS_ORIGIN, GATEWAY_ORIGIN, CLIENT_CAPS, safeAlias, origins, ERRORS, GatewayError, failure, safeError, storedSession, readJSON, responseError, fixedFetch, catalog, WorksSession };

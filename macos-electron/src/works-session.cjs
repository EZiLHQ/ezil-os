'use strict';
const { exact } = require('./policy.cjs');

// Reviewed production origins. No environment, renderer, descriptor or redirect
// may change a credential destination. Works proxies the Supabase grants.
const WORKS_ORIGIN = 'https://ezil-works-api.vercel.app';
const GATEWAY_ORIGIN = 'https://ai.ezil.work';
const ALIASES = Object.freeze({
  'ezil-fast': Object.freeze({ maxInputTokens: 32768, maxOutputTokens: 8192 }),
  'ezil-code': Object.freeze({ maxInputTokens: 16384, maxOutputTokens: 4096 })
});
const ERRORS = Object.freeze({
  signin_required: [401, 'Sign in to Works again in Settings.'],
  builder_required: [403, 'Sign in with an onboarded Works builder account.'],
  membership_required: [403, 'Ask Works support to enable your AI membership.'],
  credits: [402, 'Not enough Works credits for this request. Check your credit balance in Works.'],
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
  exact(value, ['accessToken', 'refreshToken', 'accountId', 'expiresAt']);
  if (typeof value.accessToken !== 'string' || value.accessToken.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.accessToken)
    || typeof value.refreshToken !== 'string' || !/^[A-Za-z0-9._~-]{8,8192}$/.test(value.refreshToken)
    || typeof value.accountId !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(value.accountId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) throw failure('signin_required');
  return value;
}
function authEnvelope(value, now) {
  if (!value || typeof value.tokenType !== 'string' || value.tokenType.toLowerCase() !== 'bearer' || !Number.isInteger(value.expiresIn) || value.expiresIn < 61 || value.expiresIn > 86400) throw failure('auth_unavailable');
  // JWT claims are not used to authorize the builder. Both servers verify the
  // bearer; /v1/me and gateway /v1/models check their current database rows.
  return storedSession({ accessToken: value.accessToken, refreshToken: value.refreshToken, accountId: value.accountId, expiresAt: now + value.expiresIn * 1000 });
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
    insufficient_credits: 'credits', idempotency_replay: 'replay', idempotency_conflict: 'replay',
    pending_reconciliation_required: 'pending_usage', killswitch: 'paused', model_disabled: 'model_unavailable', model_not_found: 'model_unavailable',
    account_suspended: 'membership_required', forbidden: 'membership_required', input_too_large: 'input_too_large',
    max_output_tokens_invalid: 'request_invalid', invalid_request: 'request_invalid', rate_limited: 'rate_limited', concurrency_limit: 'rate_limited'
  };
  if (typeof code === 'string' && Object.hasOwn(codes, code)) return failure(codes[code]);
  return failure(({ 400: auth ? 'signin_required' : 'request_invalid', 401: 'signin_required', 402: 'credits', 403: 'membership_required', 409: 'replay', 413: 'input_too_large', 429: 'rate_limited' })[response.status] || (auth ? 'auth_unavailable' : 'gateway_unavailable'));
}
async function fixedFetch(fetchImpl, url, options) {
  if (![`${WORKS_ORIGIN}/auth/signin`, `${WORKS_ORIGIN}/auth/refresh`, `${WORKS_ORIGIN}/v1/me`, `${GATEWAY_ORIGIN}/v1/models`, `${GATEWAY_ORIGIN}/v1/responses`].includes(url)) throw failure('gateway_unavailable');
  const response = await fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) { await response.body?.cancel().catch(() => {}); throw failure('gateway_unavailable'); }
  return response;
}
function catalog(value) {
  if (!value || typeof value.killswitch !== 'boolean' || !Array.isArray(value.data) || value.data.length > 100) throw failure('gateway_unavailable');
  const models = [], seen = new Set();
  for (const row of value.data) {
    if (!row || typeof row.id !== 'string') throw failure('gateway_unavailable');
    if (!Object.hasOwn(ALIASES, row.id)) continue;
    if (seen.has(row.id) || typeof row.enabled !== 'boolean' || !Number.isInteger(row.max_input_tokens) || row.max_input_tokens < 1 || !Number.isInteger(row.max_output_tokens) || row.max_output_tokens < 16) throw failure('gateway_unavailable');
    seen.add(row.id);
    if (row.enabled && !value.killswitch) models.push({ id: row.id, maxInputTokens: Math.min(row.max_input_tokens, ALIASES[row.id].maxInputTokens), maxOutputTokens: Math.min(row.max_output_tokens, ALIASES[row.id].maxOutputTokens), minOutputTokens: 16 });
  }
  return { paused: value.killswitch, models };
}
class WorksSession {
  // A refresh plus inspection fits within Settings' ten-second IPC deadline.
  constructor(vault, { fetchImpl = fetch, now = Date.now, timeoutMs = 4000 } = {}) { Object.assign(this, { vault, fetchImpl, now, timeoutMs }); this.refreshing = null; }
  current() { const config = this.vault.get(); if (config?.provider !== 'ezil' || !config.session) throw failure('signin_required'); return config.session; }
  same(session) { try { return this.current().accessToken === session.accessToken && this.current().refreshToken === session.refreshToken; } catch { return false; } }
  invalidate(session) { if (this.same(session)) this.vault.set({ provider: 'ezil', session: null }); }
  async json(url, options, auth = false) {
    try { const response = await fixedFetch(this.fetchImpl, url, options); if (!response.ok) throw await responseError(response, auth); return await readJSON(response); }
    catch (error) { throw safeError(error, auth ? 'auth_unavailable' : 'gateway_unavailable'); }
  }
  async signIn(email, password) {
    if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || !password.length || password.length > 4096) throw failure('signin_required');
    const revision = this.vault.revision;
    const session = authEnvelope(await this.json(`${WORKS_ORIGIN}/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(this.timeoutMs) }, true), this.now());
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
        const next = authEnvelope(await this.json(`${WORKS_ORIGIN}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refreshToken }), signal: AbortSignal.timeout(this.timeoutMs) }, true), this.now());
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
      const me = await this.json(`${WORKS_ORIGIN}/v1/me`, options);
      if (me?.accountId !== session.accountId || me.role !== 'builder' || me.onboarded !== true) throw failure('builder_required');
      const result = catalog(await this.json(`${GATEWAY_ORIGIN}/v1/models`, options));
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
module.exports = { WORKS_ORIGIN, GATEWAY_ORIGIN, ALIASES, ERRORS, GatewayError, failure, safeError, storedSession, readJSON, responseError, fixedFetch, catalog, WorksSession };

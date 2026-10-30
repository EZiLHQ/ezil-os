/**
 * Container -> code-host AI proxy. The container holds only a boot-scoped HMAC;
 * the sandbox DO holds the user's JWT, pushed by the authenticated Next server.
 * Fixed member routes, one fetch, bounded request bytes and streamed responses.
 * See docs/AI-GATEWAY.md. No tokens or bodies are logged.
 */
import { hmacSha256Hex, timingSafeEqualHex, TOKEN_MAX_AGE_MS } from './hmac';

export const DEFAULT_AI_GATEWAY_URL = 'https://ai.ezil.work';
export const AI_PROXY_HEADERS_TIMEOUT_MS = 30_000;
export const AI_PROXY_IDLE_TIMEOUT_MS = 30_000;
/** Local safety ceiling; gateway validation/413 responses below it pass through. */
export const AI_PROXY_MAX_BODY_BYTES = 160 * 1024;
/** Error bodies are small JSON; read at most this much of one to log its `error.code`. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** A pushed token closer than this to `exp` is not used (the gateway allows 30 s leeway the other way). */
export const AI_CREDENTIAL_MIN_REMAINING_MS = 30_000;
/** DO storage key for the pushed access token. */
export const AI_CREDENTIAL_STORAGE_KEY = 'ezil:aiCredential';
/** Latest signed logout timestamp; retained even after the JWT is deleted. */
export const AI_CREDENTIAL_REVOKED_AT_STORAGE_KEY = 'ezil:aiCredentialRevokedAt';
export const AI_PROXY_NONCE_STORAGE_KEY = 'ezil:aiProxyNonce';

// ── Routes ───────────────────────────────────────────────────────────────────

export interface AiRoute {
  readonly method: 'GET' | 'POST';
  /** Path on the gateway; a constant, never derived from the client's path. */
  readonly upstreamPath: string;
  /** Query parameters forwarded unchanged (all others are dropped). */
  readonly requestId?: string;
  readonly query: readonly string[];
  /** Label for log lines. */
  readonly label: string;
}

const AI_ROUTES: Readonly<Record<string, AiRoute>> = {
  'GET /ai/v1/models': { method: 'GET', upstreamPath: '/v1/models', query: [], label: 'GET /v1/models' },
  'POST /ai/v1/messages': { method: 'POST', upstreamPath: '/v1/messages', query: [], label: 'POST /v1/messages' },
  'POST /ai/v1/responses': { method: 'POST', upstreamPath: '/v1/responses', query: [], label: 'POST /v1/responses' },
  'GET /ai/v1/requests/:id': { method: 'GET', upstreamPath: '/v1/requests/:id', query: [], label: 'GET /v1/requests/:id' },
  'GET /ai/v1/me/balance': { method: 'GET', upstreamPath: '/v1/me/balance', query: [], label: 'GET /v1/me/balance' },
  'GET /ai/v1/me/limits': { method: 'GET', upstreamPath: '/v1/me/limits', query: [], label: 'GET /v1/me/limits' },
  'GET /ai/v1/me/usage': { method: 'GET', upstreamPath: '/v1/me/usage', query: ['limit', 'before'], label: 'GET /v1/me/usage' },
};

/** True for every path this module owns on the code bridge host (all of `/ai`, so nothing under it reaches code-server). */
export function isAiProxyPath(pathname: string): boolean {
  return pathname === '/ai' || pathname.startsWith('/ai/');
}

/** The allow-listed route for `method pathname`, or `null` (a local 404). Exact match only. */
export function matchAiRoute(method: string, pathname: string): AiRoute | null {
  const id = /^\/ai\/v1\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(pathname)?.[1];
  if (method === 'GET' && id) return { ...AI_ROUTES['GET /ai/v1/requests/:id']!, requestId: id };
  if (pathname.includes(':')) return null;
  return AI_ROUTES[`${method} ${pathname}`] ?? null;
}

/** Non-secret kill switch, same vocabulary as the other `SANDBOX_*` route flags. */
export function aiProxyDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/** `EZIL_AI_GATEWAY_URL`, or the default, as an origin without a trailing slash. Only https (or http to localhost for tests). */
export function resolveGatewayUrl(configured: string | undefined): string {
  const raw = configured?.trim() || DEFAULT_AI_GATEWAY_URL;
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('EZIL_AI_GATEWAY_URL must be an https origin');
  }
  return url.origin;
}

// ── Per-sandbox proxy token (container -> Worker) ────────────────────────────

/** HMAC-SHA256(primary secret, `ezil-ai-proxy:<sandboxId>:<nonce>:v2`). */
export async function deriveAiProxyToken(secret: string, sandboxId: string, nonce: string): Promise<string> {
  return (await hmacSha256Hex(secret, `ezil-ai-proxy:${sandboxId.toLowerCase()}:${nonce}:v2`)).toLowerCase();
}

/** Verify `Authorization: Bearer <proxy token>` for `sandboxId`. `false` when no secret is configured (fail closed). */
export async function verifyAiProxyBearer(
  authorization: string | null,
  secret: string | null,
  sandboxId: string,
  nonce: string | null,
): Promise<boolean> {
  if (!secret || !nonce) return false;
  const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization?.trim() ?? '');
  if (!match) return false;
  const expected = await deriveAiProxyToken(secret, sandboxId, nonce);
  return timingSafeEqualHex(expected, match[1]!);
}

/**
 * Base URL the extension calls, built the same way the SDK builds the code
 * bridge preview URL (`constructPreviewUrl`: `<port>-<sanitized lowercase id>-<token>.<hostname>`).
 */
export function aiProxyBaseUrl(hostname: string, sandboxId: string, port: number, token: string): string {
  const id = sandboxId.toLowerCase();
  const host = hostname.split(':')[0]!;
  const local = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1';
  if (local) {
    const mainPort = hostname.split(':')[1] || '80';
    return `http://${port}-${id}-${token}.${host}:${mainPort}/ai/v1`;
  }
  return `https://${port}-${id}-${token}.${hostname}/ai/v1`;
}

// ── Pushed user token (Next server -> Worker) ────────────────────────────────

/**
 * Signed payload for `POST /sandbox/:id/ai-credential`. Unlike the shared
 * `/sandbox/preview` envelope it binds the sandbox id AND the body, so a
 * captured signature cannot carry a different token or reach another sandbox.
 */
export const AI_CREDENTIAL_SIGNATURE_PAYLOAD = (timestamp: number, sandboxId: string, bodySha256: string, method: 'POST' | 'DELETE' = 'POST'): string =>
  `${timestamp}.${method}./sandbox/${sandboxId}/ai-credential.${bodySha256}`;

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mint `t=<ms>,v1=<hex>` for a credential push (used by tests; the app has its own Node copy). */
export async function mintAiCredentialSignature(
  secret: string,
  sandboxId: string,
  body: Uint8Array,
  now: number = Date.now(),
  method: 'POST' | 'DELETE' = 'POST',
): Promise<string> {
  const sig = await hmacSha256Hex(secret, AI_CREDENTIAL_SIGNATURE_PAYLOAD(now, sandboxId, await sha256HexBytes(body), method));
  return `t=${now},v1=${sig}`;
}

/** Verify the `x-ezil-signature` header of a credential push. No secret configured: refused (fail closed, unlike local-dev control routes). */
export async function verifyAiCredentialSignature(
  header: string | null,
  secrets: string[],
  sandboxId: string,
  body: Uint8Array,
  now: number = Date.now(),
  method: 'POST' | 'DELETE' = 'POST',
): Promise<{ ok: true; timestamp: number } | { ok: false; error: string }> {
  const candidates = secrets.filter((s) => s && s.trim());
  if (candidates.length === 0) return { ok: false, error: 'ai_proxy_not_configured' };
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header?.trim() ?? '');
  if (!match) return { ok: false, error: 'ai_credential_signature_missing' };
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TOKEN_MAX_AGE_MS) {
    return { ok: false, error: 'ai_credential_signature_expired' };
  }
  const payload = AI_CREDENTIAL_SIGNATURE_PAYLOAD(timestamp, sandboxId, await sha256HexBytes(body), method);
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqualHex(await hmacSha256Hex(candidate, payload), match[2]!)) matched = true;
  }
  return matched ? { ok: true, timestamp } : { ok: false, error: 'ai_credential_signature_mismatch' };
}

export interface StoredAiCredential {
  readonly token: string;
  /** JWT `exp`, in milliseconds. */
  readonly expiresAt: number;
  /** Verified signature timestamp in milliseconds; absent on pre-watermark records. */
  readonly signedAt?: number;
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64UrlJson(segment: string): unknown {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

/**
 * Checks a pushed access token BEFORE it is stored. The signature is not
 * verified here (the gateway verifies it on every call, and only the signed
 * Next server can push); these checks bind the token to the sandbox:
 *   - three-segment JWT, at most 16 KiB;
 *   - `sub` is a UUID whose first 16 alphanumerics are this sandbox's owner
 *     segment (`deriveSandboxId`: `guac-<16 of userId>-<16 of scope>`);
 *   - `role` is `authenticated`, `exp` is in the future.
 */
export function parsePushedAccessToken(
  token: unknown,
  sandboxId: string,
  now: number = Date.now(),
): { ok: true; credential: StoredAiCredential } | { ok: false; error: string } {
  if (typeof token !== 'string' || token.length > 16_384 || !JWT_SHAPE.test(token)) {
    return { ok: false, error: 'access_token_malformed' };
  }
  let claims: Record<string, unknown>;
  try {
    const parsed = base64UrlJson(token.split('.')[1]!);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    claims = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'access_token_malformed' };
  }
  const sub = claims.sub;
  if (typeof sub !== 'string' || !UUID.test(sub)) return { ok: false, error: 'access_token_malformed' };
  if (!sandboxBelongsToUser(sandboxId, sub)) return { ok: false, error: 'access_token_wrong_user' };
  if (claims.role !== 'authenticated') return { ok: false, error: 'access_token_not_authenticated' };
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, error: 'access_token_malformed' };
  const expiresAt = exp * 1000;
  if (expiresAt - AI_CREDENTIAL_MIN_REMAINING_MS <= now) return { ok: false, error: 'access_token_expired' };
  return { ok: true, credential: { token, expiresAt } };
}

/** Mirrors `deriveSandboxId(userId, scope)` in `./index.ts` and the app: `guac-<first 16 alphanumerics of userId>-...`. */
export function sandboxBelongsToUser(sandboxId: string, userId: string): boolean {
  const owner = userId.replace(/[^a-z0-9]/gi, '').slice(0, 16).toLowerCase();
  return owner.length === 16 && sandboxId.toLowerCase().startsWith(`guac-${owner}-`);
}

/** Order signed pushes first, then keep the later expiry. Exact replays are no-ops. */
export function chooseAiCredential(
  current: StoredAiCredential | undefined,
  incoming: StoredAiCredential,
): { keep: StoredAiCredential; stored: boolean } {
  if (current?.signedAt !== undefined && incoming.signedAt !== undefined && current.signedAt >= incoming.signedAt) {
    if (current.signedAt !== incoming.signedAt || current.token !== incoming.token) {
      return { keep: current, stored: false };
    }
    return { keep: current, stored: true };
  }
  if (current && current.expiresAt >= incoming.expiresAt && current.token !== incoming.token) {
    return { keep: current, stored: false };
  }
  return { keep: incoming, stored: true };
}

/** The stored token if it still has more than AI_CREDENTIAL_MIN_REMAINING_MS left. */
export function usableAiCredential(stored: StoredAiCredential | undefined, now: number = Date.now()): string | null {
  if (!stored || typeof stored.token !== 'string' || typeof stored.expiresAt !== 'number') return null;
  return stored.expiresAt - AI_CREDENTIAL_MIN_REMAINING_MS > now ? stored.token : null;
}

// ── Proxying ─────────────────────────────────────────────────────────────────

export interface AiProxyDeps {
  /** Gateway origin (`resolveGatewayUrl`). */
  readonly gatewayUrl: string;
  /** Sandbox id parsed from the request's own code bridge hostname. */
  readonly sandboxId: string;
  /** Primary HMAC secret for the proxy token, or null (proxy refused). */
  readonly proxySecret: string | null;
  readonly proxyNonce: string | null;
  readonly enabled?: string;
  /** The stored user token for this sandbox, if usable. */
  readonly credential: () => Promise<string | null>;
  /** Forget `token` if it is still the stored one (after a gateway 401). */
  readonly dropCredential: (token: string) => Promise<void>;
  readonly fetch: (input: Request) => Promise<Response>;
  readonly log?: (fields: Record<string, unknown>) => void;
  readonly headersTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
}

const PASS_THROUGH_RESPONSE_HEADERS = [
  'content-type', 'cache-control', 'x-ezil-request-id', 'x-ezil-hold-micro', 'x-ezil-trace-id', 'traceparent', 'retry-after', 'x-accel-buffering',
] as const;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

/** A proxy-originated error, told apart from gateway codes by the `os_` prefix (plus `not_found`/`body_too_large`, same meaning). */
export function proxyError(status: number, code: string, message?: string): Response {
  return new Response(JSON.stringify({ error: { code, message, source: 'ezil-os-proxy' } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

class IdleTimeout extends Error {
  constructor() {
    super('upstream idle timeout');
    this.name = 'IdleTimeout';
  }
}

type ResponseUsage = { input_tokens: number; output_tokens: number };

/** Bounded telemetry only: never change the response bytes or calculate a charge. */
function responseTelemetry(sse: boolean) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let buffer = '';
  let event = '';
  let data = '';
  let overflow = false;
  let malformed = false;
  let trailingCR = false;
  let responseId: string | null = null;
  let terminal: string | null = null;
  let code: string | null = null;
  let usage: ResponseUsage | null = null;
  const decode = (bytes?: Uint8Array, stream = false): string => {
    try { return decoder.decode(bytes, { stream }); }
    catch { malformed = true; return ''; }
  };
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const inspect = (value: unknown, eventName?: string) => {
    if (!record(value)) { malformed = true; return; }
    const type = eventName || (typeof value.type === 'string' ? value.type : '');
    if (sse && eventName && value.type !== undefined && value.type !== eventName) { malformed = true; return; }
    if (sse && (type === 'error' || value.type === 'error')) {
      terminal = 'error'; usage = null;
      code = errorCodeOf(new TextEncoder().encode(JSON.stringify(value)));
      return;
    }
    if (terminal === 'error') return;
    const response = sse ? value.response : value;
    if (sse && type === 'response.created') {
      if (!record(response) || typeof response.id !== 'string' || !response.id || response.id.length > 200
        || terminal !== null || (responseId !== null && responseId !== response.id)) malformed = true;
      else responseId = response.id;
      return;
    }
    if (sse && !['response.completed', 'response.incomplete', 'response.failed'].includes(type)) return;
    if (!record(response) || !['completed', 'incomplete', 'failed'].includes(String(response.status))
      || typeof response.id !== 'string' || response.id.length === 0 || response.id.length > 200
      || terminal !== null || (responseId !== null && responseId !== response.id)
      || (sse && type !== `response.${response.status}`)) {
      malformed = true; return;
    }
    responseId = response.id;
    terminal = `response.${response.status}`;
    code = errorCodeOf(new TextEncoder().encode(JSON.stringify({ error: response.error })));
    const raw = response.usage;
    usage = record(raw) && count(raw.input_tokens) && count(raw.output_tokens)
      && (raw.total_tokens === undefined || (count(raw.total_tokens) && raw.total_tokens === raw.input_tokens + raw.output_tokens))
      ? { input_tokens: raw.input_tokens, output_tokens: raw.output_tokens } : null;
  };
  const dispatch = () => {
    if (overflow) malformed = true;
    else if (data === '[DONE]') { if (terminal === null) malformed = true; }
    else if (data) {
      try { inspect(JSON.parse(data), event); } catch { malformed = true; }
    }
    event = ''; data = ''; overflow = false;
  };
  return {
    push(bytes: Uint8Array) {
      if (!sse) {
        if (overflow) return;
        buffer += decode(bytes, true);
        if (buffer.length > MAX_ERROR_BODY_BYTES) { buffer = ''; overflow = true; }
        return;
      }
      let text = decode(bytes, true);
      if (!text) return;
      if (trailingCR && text.startsWith('\n')) text = text.slice(1);
      trailingCR = text.endsWith('\r');
      buffer += text.replace(/\r\n|\r/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line === '') dispatch();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:') && !overflow) {
          data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
          if (data.length > MAX_ERROR_BODY_BYTES) { data = ''; overflow = true; }
        }
      }
      if (buffer.length > MAX_ERROR_BODY_BYTES) { buffer = ''; overflow = true; }
    },
    finish() {
      buffer += decode();
      if (sse) {
        // A terminal-looking fragment without the SSE event boundary is not authoritative.
        if (buffer.trim() || data || event || overflow) malformed = true;
      } else if (!overflow) {
        try { inspect(JSON.parse(buffer)); } catch { malformed = true; }
      }
      return malformed || overflow ? { terminal: null, code: null, usage: null } : { terminal, code, usage };
    },
  };
}

/**
 * Re-exposes the upstream body chunk by chunk (no buffering), erroring with
 * IdleTimeout when no chunk arrives for `idleMs`, cancelling upstream when the
 * client goes away, and noting the last terminal SSE event name for the log.
 */
function passThrough(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  watchSse: boolean,
  onEnd: (outcome: string, terminal: string | null, code: string | null, usage?: ResponseUsage | null) => void,
  abort: AbortController,
  watchError: boolean,
  watchResponses = false,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let sseEvent = '';
  let sseCode: string | null = null;
  let terminal: string | null = null;
  let finished = false;
  const errorChunks: Uint8Array[] = [];
  let errorBytes = 0;
  const responses = watchResponses ? responseTelemetry(watchSse) : undefined;
  const finish = (outcome: string) => {
    if (finished) return;
    finished = true;
    let code: string | null = sseCode;
    if (watchError && errorBytes <= MAX_ERROR_BODY_BYTES) {
      const bytes = new Uint8Array(errorBytes);
      let offset = 0;
      for (const chunk of errorChunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      code = errorCodeOf(bytes);
    }
    const observed = responses?.finish();
    onEnd(outcome, observed ? observed.terminal : terminal, observed ? observed.code : code, observed?.usage);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new IdleTimeout()), idleMs);
        });
        try {
          const next = await Promise.race([reader.read(), idle]);
          if (next.done) {
            finish('eof');
            controller.close();
            return;
          }
          if (watchError) {
            errorBytes += next.value.byteLength;
            if (errorBytes <= MAX_ERROR_BODY_BYTES) errorChunks.push(next.value);
            else errorChunks.length = 0;
          }
          responses?.push(next.value);
          if (watchSse && !responses) {
            const lines = (tail + decoder.decode(next.value, { stream: true })).split('\n');
            tail = lines.pop()!.slice(-MAX_ERROR_BODY_BYTES);
            for (const raw of lines) {
              const line = raw.replace(/\r$/, '');
              if (line === '') sseEvent = '';
              else if (line.startsWith('event:')) {
                sseEvent = line.slice(6).trim();
                if (sseEvent === 'message_stop' || sseEvent === 'error') terminal = sseEvent;
              } else if (sseEvent === 'error' && line.startsWith('data:') && line.length <= MAX_ERROR_BODY_BYTES) {
                sseCode = errorCodeOf(new TextEncoder().encode(line.slice(5)));
              }
            }
          }
          controller.enqueue(next.value);
        } catch (err) {
          abort.abort();
          reader.cancel().catch(() => undefined);
          finish(err instanceof IdleTimeout ? 'idle_timeout' : 'upstream_error');
          controller.error(err);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      cancel(reason) {
        finish('client_cancelled');
        abort.abort();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function errorCodeOf(bytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { error?: { code?: unknown } };
    return typeof parsed?.error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(parsed.error.code) ? parsed.error.code : null;
  } catch {
    return null;
  }
}

const GATEWAY_ERROR_CODES = new Set([
  'unauthorized', 'no_ezil_role', 'insufficient_credits', 'no_live_grant', 'not_a_member', 'role_mismatch',
  'forbidden', 'account_suspended', 'suspended', 'input_too_large', 'body_too_large',
  'unsupported_bedrock_converse_request', 'unsupported_parameter', 'invalid_request', 'max_output_tokens_invalid',
  'idempotency_conflict', 'idempotency_key_required', 'idempotency_replay', 'killswitch', 'paused', 'pause',
  'global_cap_reached', 'daily_budget_reached', 'window_budget_reached', 'no_provider_route', 'model_disabled', 'model_not_found', 'upstream_timeout',
  'rate_limited', 'concurrency_limit', 'tpm_limited', 'internal_error',
]);
const GATEWAY_ERROR_REASONS = new Set(['wrong_issuer', 'bad_signature', 'no_ezil_role', 'expired', 'token_expired',
  'wrong_audience', 'missing_token', 'invalid_token', 'revoked']);

function safeGatewayError(bytes: Uint8Array | null): Record<string, unknown> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = bytes && JSON.parse(new TextDecoder().decode(bytes));
    if (parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)) raw = parsed.error;
  } catch { /* Never return an upstream edge page or an unrecognized body. */ }
  const error: Record<string, unknown> = { code: typeof raw.code === 'string' && GATEWAY_ERROR_CODES.has(raw.code) ? raw.code : 'gateway_error' };
  if (typeof raw.reason === 'string' && GATEWAY_ERROR_REASONS.has(raw.reason)) error.reason = raw.reason;
  if (typeof raw.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.request_id)) error.request_id = raw.request_id;
  if (raw.pause === 'operations' || raw.pause === 'reconciliation') error.pause = raw.pause;
  if (typeof raw.no_live_grant === 'boolean') error.no_live_grant = raw.no_live_grant;
  for (const field of ['available_micro', 'hold_micro', 'input_bound_tokens', 'max_input_tokens']) {
    if (Number.isSafeInteger(raw[field]) && (raw[field] as number) >= 0) error[field] = raw[field];
  }
  return error;
}

/**
 * Handle one request under `/ai` on a code bridge host. Order: route
 * allow-list (404) -> proxy token (401 `os_proxy_unauthorized`) -> stored user
 * token (401 `os_session_missing`) -> one upstream attempt.
 */
export async function handleAiProxyRequest(request: Request, deps: AiProxyDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const url = new URL(request.url);
  const route = matchAiRoute(request.method, url.pathname);
  const idempotencyKey = request.headers.get('idempotency-key');
  const logKey = idempotencyKey !== null && IDEMPOTENCY_KEY.test(idempotencyKey) ? idempotencyKey : null;
  const log = (fields: Record<string, unknown>) =>
    deps.log?.({ event: 'ai_proxy', route: route?.label ?? 'unmatched', idempotency_key: logKey, ...fields, ms: now() - started });

  if (aiProxyDisabled(deps.enabled)) {
    log({ status: 503, code: 'os_ai_unavailable' });
    return proxyError(503, 'os_ai_unavailable');
  }
  if (route === null) {
    log({ status: 404, code: 'not_found' });
    return proxyError(404, 'not_found', 'Not an EZiL AI route.');
  }
  if (!deps.proxySecret) {
    log({ status: 503, code: 'os_ai_unavailable' });
    return proxyError(503, 'os_ai_unavailable', 'EZiL AI is not configured for this computer.');
  }
  if (!(await verifyAiProxyBearer(request.headers.get('authorization'), deps.proxySecret, deps.sandboxId, deps.proxyNonce))) {
    log({ status: 401, code: 'os_proxy_unauthorized' });
    return proxyError(401, 'os_proxy_unauthorized', 'This computer is not authorized to use EZiL AI.');
  }
  const token = await deps.credential();
  if (token === null) {
    log({ status: 401, code: 'os_session_missing' });
    return proxyError(401, 'os_session_missing', 'No EZiL session for this computer yet. Keep EZiL OS open; it refreshes within a minute.');
  }

  let body: Uint8Array | undefined;
  if (route.method === 'POST') {
    const bytes = await readLimited(request.body, AI_PROXY_MAX_BODY_BYTES);
    if (bytes === null) {
      log({ status: 413, code: 'body_too_large' });
      return proxyError(413, 'body_too_large', 'Request body is too large.');
    }
    body = bytes;
  }

  const upstreamUrl = new URL(route.upstreamPath.replace(':id', route.requestId ?? ''), deps.gatewayUrl);
  for (const name of route.query) {
    const value = url.searchParams.get(name);
    if (value !== null) upstreamUrl.searchParams.set(name, value);
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of ['content-type', 'idempotency-key', 'anthropic-version']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const abort = new AbortController();
  const headersTimer = setTimeout(() => abort.abort(), deps.headersTimeoutMs ?? AI_PROXY_HEADERS_TIMEOUT_MS);
  const onDisconnect = () => abort.abort();
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) abort.abort();
  const cleanup = () => request.signal.removeEventListener('abort', onDisconnect);
  let upstream: Response;
  try {
    upstream = await deps.fetch(
      new Request(upstreamUrl.toString(), {
        method: route.method,
        headers,
        body: body as BodyInit | undefined,
        signal: abort.signal,
        redirect: 'manual',
      }),
    );
  } catch {
    cleanup();
    const timedOut = abort.signal.aborted;
    log({ status: timedOut ? 504 : 502, code: 'os_ai_unavailable', detail: timedOut ? 'headers_timeout' : 'fetch_failed' });
    return proxyError(
      timedOut ? 504 : 502,
      'os_ai_unavailable',
      timedOut ? 'EZiL AI did not answer in time.' : 'EZiL AI could not be reached.',
    );
  } finally {
    clearTimeout(headersTimer);
  }

  const outHeaders = new Headers();
  for (const name of PASS_THROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) outHeaders.set(name, value);
  }
  const requestId = upstream.headers.get('x-ezil-request-id');

  if (upstream.body === null) {
    cleanup();
    log({ status: upstream.status, code: null, request_id: requestId });
    return new Response(null, { status: upstream.status, headers: outHeaders });
  }

  if (!upstream.ok) {
    // Gateway errors are a bounded, allow-listed envelope; never echo messages or credentials.
    try {
      const bytes = await readLimited(passThrough(upstream.body, deps.idleTimeoutMs ?? AI_PROXY_IDLE_TIMEOUT_MS,
        false, () => {}, abort, false), MAX_ERROR_BODY_BYTES);
      const error = safeGatewayError(bytes);
      // Configuration/membership failures do not become a misleading OS session failure on the next call.
      if (upstream.status === 401 && (error.reason === 'expired' || error.reason === 'token_expired')) {
        await deps.dropCredential(token).catch(() => undefined);
      }
      cleanup();
      log({ status: upstream.status, code: error.code, reason: error.reason ?? null, request_id: requestId });
      outHeaders.set('content-type', 'application/json; charset=utf-8');
      outHeaders.set('cache-control', 'no-store');
      return new Response(JSON.stringify({ error }), { status: upstream.status, headers: outHeaders });
    } catch {
      cleanup();
      return proxyError(504, 'os_ai_unavailable', 'EZiL AI did not finish its error response. Retry the request.');
    }
  }

  const isSse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
  const responses = route.upstreamPath === '/v1/responses';
  const stream = passThrough(upstream.body, deps.idleTimeoutMs ?? AI_PROXY_IDLE_TIMEOUT_MS, isSse, (outcome, terminal, code, usage) => {
    cleanup();
    log({ status: upstream.status, request_id: requestId, code, stream: isSse, outcome, terminal, ...(responses ? { usage: usage ?? null } : {}) });
  }, abort, !upstream.ok, responses);
  return new Response(stream, { status: upstream.status, headers: outHeaders });
}

/**
 * EZiL AI gateway proxy (`ai.ezil.work`) for code running inside a sandbox.
 *
 * The chat extension in the container (`extensions/ezil-models`, provider type
 * `ezil-gateway`) never holds a Supabase token, a refresh token or a provider
 * key. It calls `/ai/v1/*` on its OWN code bridge host
 * (`https://8443-<sandboxId>-code.<zone>/ai/v1`, same origin as code-server),
 * authenticated by a per-sandbox proxy token. This Worker then forwards the
 * call to the gateway with the signed-in user's Supabase access token, which
 * the Next server pushed into this sandbox's Durable Object over the signed
 * `POST /sandbox/:id/ai-credential` route (on desktop start and on every
 * activity beat). The gateway verifies that token on every request; the
 * Worker only binds it to the sandbox's owner and never logs it.
 *
 * Pure module (no `@cloudflare/sandbox` import) so it runs under `bun test`.
 *
 * Contract: ezil-ai-gateway `docs/OS-INTEGRATION-CONTRACT.md` (sections 2, 4-6,
 * 8, 9, 12). What this file guarantees:
 *   - Allow-list: exactly four routes are forwarded (see AI_ROUTES). Anything
 *     else under `/ai` is a local 404; `/v1/admin/*`, `/v1/integrations/*` and
 *     any path the table does not name can never be reached, because the
 *     upstream path is a constant from the table, never the client's path.
 *   - Headers: only `Authorization: Bearer <user JWT>`, `Content-Type` and the
 *     client's `Idempotency-Key` go upstream. Everything else the container
 *     sent (cookies, its own Authorization, forwarding headers) is dropped.
 *   - Body: the request bytes are forwarded unchanged (the gateway's
 *     idempotency fingerprint is SHA-256 of the raw bytes).
 *   - No retries: one upstream attempt per call. Only the client retries, with
 *     the same Idempotency-Key and the same bytes.
 *   - Responses: status, body and the `x-ezil-*`, `retry-after`,
 *     `content-type`, `cache-control`, `x-accel-buffering` headers are passed
 *     through; an SSE body is streamed, never buffered.
 *   - Timeouts: 185 s for upstream headers and 125 s idle between chunks, each
 *     5 s past the gateway's own 180 s / 120 s deadlines so the gateway's
 *     canonical `upstream_timeout` answer (with its request id) arrives first.
 *   - Logs: route, status, request id, Idempotency-Key, `error.code`, terminal
 *     SSE event and duration. Never the bearer, bodies or SSE payloads.
 */

import { hmacSha256Hex, timingSafeEqualHex, TOKEN_MAX_AGE_MS } from './hmac';

export const DEFAULT_AI_GATEWAY_URL = 'https://ai.ezil.work';
export const AI_PROXY_HEADERS_TIMEOUT_MS = 185_000;
export const AI_PROXY_IDLE_TIMEOUT_MS = 125_000;
/** Local request-body ceiling. The gateway's own limit is 262,144 bytes (413 `body_too_large`). */
export const AI_PROXY_MAX_BODY_BYTES = 1024 * 1024;
/** Error bodies are small JSON; read at most this much of one to log its `error.code`. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** A pushed token closer than this to `exp` is not used (the gateway allows 30 s leeway the other way). */
export const AI_CREDENTIAL_MIN_REMAINING_MS = 30_000;
/** DO storage key for the pushed access token. */
export const AI_CREDENTIAL_STORAGE_KEY = 'ezil:aiCredential';

// ── Routes ───────────────────────────────────────────────────────────────────

export interface AiRoute {
  readonly method: 'GET' | 'POST';
  /** Path on the gateway; a constant, never derived from the client's path. */
  readonly upstreamPath: string;
  /** Query parameters forwarded unchanged (all others are dropped). */
  readonly query: readonly string[];
  /** Label for log lines. */
  readonly label: string;
}

const AI_ROUTES: Readonly<Record<string, AiRoute>> = {
  'GET /ai/v1/models': { method: 'GET', upstreamPath: '/v1/models', query: [], label: 'GET /v1/models' },
  'POST /ai/v1/responses': { method: 'POST', upstreamPath: '/v1/responses', query: [], label: 'POST /v1/responses' },
  'GET /ai/v1/me/balance': { method: 'GET', upstreamPath: '/v1/me/balance', query: [], label: 'GET /v1/me/balance' },
  'GET /ai/v1/me/usage': { method: 'GET', upstreamPath: '/v1/me/usage', query: ['limit', 'before'], label: 'GET /v1/me/usage' },
};

/** True for every path this module owns on the code bridge host (all of `/ai`, so nothing under it reaches code-server). */
export function isAiProxyPath(pathname: string): boolean {
  return pathname === '/ai' || pathname.startsWith('/ai/');
}

/** The allow-listed route for `method pathname`, or `null` (a local 404). Exact match only. */
export function matchAiRoute(method: string, pathname: string): AiRoute | null {
  return AI_ROUTES[`${method.toUpperCase()} ${pathname}`] ?? null;
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

/**
 * The credential the container presents to `/ai/v1/*`:
 * hex HMAC-SHA256(primary secret, `ezil-ai-proxy:<sandboxId>:v1`).
 *
 * Same derivation pattern as `deriveNekoCredentials` (`./hmac.ts`): only the
 * primary binding, deterministic per sandbox, so a container that keeps
 * running across Worker requests keeps a valid value. It is scoped to one
 * sandbox (verified against the sandbox id parsed from the request's own
 * hostname), reaches only the four routes above, and is useless on its own:
 * the Worker forwards a call only while a non-expired user token, pushed by an
 * open EZiL OS session, is stored for that sandbox. Rotating the primary
 * secret revokes every proxy token.
 */
export async function deriveAiProxyToken(secret: string, sandboxId: string): Promise<string> {
  return (await hmacSha256Hex(secret, `ezil-ai-proxy:${sandboxId.toLowerCase()}:v1`)).toLowerCase();
}

/** Verify `Authorization: Bearer <proxy token>` for `sandboxId`. `false` when no secret is configured (fail closed). */
export async function verifyAiProxyBearer(
  authorization: string | null,
  secret: string | null,
  sandboxId: string,
): Promise<boolean> {
  if (!secret) return false;
  const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization?.trim() ?? '');
  if (!match) return false;
  const expected = await deriveAiProxyToken(secret, sandboxId);
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
export const AI_CREDENTIAL_SIGNATURE_PAYLOAD = (timestamp: number, sandboxId: string, bodySha256: string): string =>
  `${timestamp}.POST./sandbox/${sandboxId}/ai-credential.${bodySha256}`;

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
): Promise<string> {
  const sig = await hmacSha256Hex(secret, AI_CREDENTIAL_SIGNATURE_PAYLOAD(now, sandboxId, await sha256HexBytes(body)));
  return `t=${now},v1=${sig}`;
}

/** Verify the `x-ezil-signature` header of a credential push. No secret configured: refused (fail closed, unlike local-dev control routes). */
export async function verifyAiCredentialSignature(
  header: string | null,
  secrets: string[],
  sandboxId: string,
  body: Uint8Array,
  now: number = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const candidates = secrets.filter((s) => s && s.trim());
  if (candidates.length === 0) return { ok: false, error: 'ai_proxy_not_configured' };
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header?.trim() ?? '');
  if (!match) return { ok: false, error: 'ai_credential_signature_missing' };
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > TOKEN_MAX_AGE_MS) {
    return { ok: false, error: 'ai_credential_signature_expired' };
  }
  const payload = AI_CREDENTIAL_SIGNATURE_PAYLOAD(timestamp, sandboxId, await sha256HexBytes(body));
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqualHex(await hmacSha256Hex(candidate, payload), match[2]!)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, error: 'ai_credential_signature_mismatch' };
}

export interface StoredAiCredential {
  readonly token: string;
  /** JWT `exp`, in milliseconds. */
  readonly expiresAt: number;
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

/** Which credential to keep: the later-expiring one (a replayed older push never rolls the token back). */
export function chooseAiCredential(
  current: StoredAiCredential | undefined,
  incoming: StoredAiCredential,
): { keep: StoredAiCredential; stored: boolean } {
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
  'content-type', 'cache-control', 'x-ezil-request-id', 'x-ezil-hold-micro', 'retry-after', 'x-accel-buffering',
] as const;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

/** A proxy-originated error, told apart from gateway codes by the `os_` prefix (plus `not_found`/`body_too_large`, same meaning). */
export function proxyError(status: number, code: string, message: string): Response {
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

const TERMINAL_EVENT = /^event: ?(response\.completed|response\.incomplete|response\.failed|error)\r?$/gm;

/**
 * Re-exposes the upstream body chunk by chunk (no buffering), erroring with
 * IdleTimeout when no chunk arrives for `idleMs`, cancelling upstream when the
 * client goes away, and noting the last terminal SSE event name for the log.
 */
function passThrough(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  watchSse: boolean,
  onEnd: (outcome: string, terminal: string | null) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let terminal: string | null = null;
  let finished = false;
  const finish = (outcome: string) => {
    if (finished) return;
    finished = true;
    onEnd(outcome, terminal);
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
          if (watchSse) {
            const text = tail + decoder.decode(next.value, { stream: true });
            for (const m of text.matchAll(TERMINAL_EVENT)) terminal = m[1]!;
            tail = text.slice(-64);
          }
          controller.enqueue(next.value);
        } catch (err) {
          reader.cancel().catch(() => undefined);
          finish(err instanceof IdleTimeout ? 'idle_timeout' : 'upstream_error');
          controller.error(err);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      cancel(reason) {
        finish('client_cancelled');
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
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
    return typeof parsed?.error?.code === 'string' ? parsed.error.code.slice(0, 64) : null;
  } catch {
    return null;
  }
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

  if (route === null) {
    log({ status: 404, code: 'not_found' });
    return proxyError(404, 'not_found', 'Not an EZiL AI route.');
  }
  if (!deps.proxySecret) {
    log({ status: 503, code: 'os_ai_unavailable' });
    return proxyError(503, 'os_ai_unavailable', 'EZiL AI is not configured for this computer.');
  }
  if (!(await verifyAiProxyBearer(request.headers.get('authorization'), deps.proxySecret, deps.sandboxId))) {
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

  const upstreamUrl = new URL(route.upstreamPath, deps.gatewayUrl);
  for (const name of route.query) {
    const value = url.searchParams.get(name);
    if (value !== null) upstreamUrl.searchParams.set(name, value);
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (route.method === 'POST') {
    headers.set('content-type', request.headers.get('content-type') ?? 'application/json');
    // Forwarded unchanged (even when malformed): the gateway is the one that
    // answers 400 `idempotency_key_required`. The proxy never mints a key.
    if (idempotencyKey !== null) headers.set('idempotency-key', idempotencyKey);
  }

  const abort = new AbortController();
  const headersTimer = setTimeout(() => abort.abort(), deps.headersTimeoutMs ?? AI_PROXY_HEADERS_TIMEOUT_MS);
  request.signal?.addEventListener?.('abort', () => abort.abort());
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

  if (upstream.status === 401) {
    // The pushed token was refused (expired, revoked, missing the role claim):
    // forget it so later calls fail fast as `os_session_missing` until the
    // next push, instead of re-sending a dead token.
    await deps.dropCredential(token).catch(() => undefined);
  }

  if (!upstream.ok || upstream.body === null) {
    const bytes = await readLimited(upstream.body, MAX_ERROR_BODY_BYTES);
    if (bytes === null) {
      log({ status: 502, code: 'os_ai_unavailable', detail: 'error_body_too_large', upstream_status: upstream.status, request_id: requestId });
      return proxyError(502, 'os_ai_unavailable', 'EZiL AI returned an unreadable error.');
    }
    log({ status: upstream.status, code: upstream.ok ? null : errorCodeOf(bytes), request_id: requestId });
    return new Response(bytes, { status: upstream.status, headers: outHeaders });
  }

  const isSse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
  const stream = passThrough(upstream.body, deps.idleTimeoutMs ?? AI_PROXY_IDLE_TIMEOUT_MS, isSse, (outcome, terminal) =>
    log({ status: upstream.status, request_id: requestId, stream: isSse, outcome, terminal }),
  );
  return new Response(stream, { status: upstream.status, headers: outHeaders });
}

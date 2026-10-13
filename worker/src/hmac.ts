/**
 * HMAC preview-token verification (Web Crypto).
 *
 * Factored out of `index.ts` (no `@cloudflare/sandbox` import here) so the
 * signed-API auth contract can be unit-tested with plain `bun test`, without
 * the Workers runtime — mirroring `./desktop-mode` and `./workspace-diag`.
 *
 * Auth model:
 *   - The primary/compatibility secret (`SANDBOX_HMAC_SECRET` /
 *     `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`) is authoritative.
 *   - `SANDBOX_MISSION_HMAC_SECRET` is an OPTIONAL, TEMPORARY additive alias:
 *     when present a signature is accepted if it matches the primary OR the
 *     mission secret. Its ABSENCE changes nothing; it never becomes required
 *     and never replaces primary auth. It must normally be absent in prod.
 */

/** HMAC token freshness window. */
export const TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

/** Canonical signed payload for the preview/diag verification path. */
export const PREVIEW_TOKEN_PAYLOAD = (timestamp: number): string =>
  `${timestamp}.POST./sandbox/preview.`;

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare to avoid leaking signature bytes via timing. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Resolve the ordered list of HMAC secrets a signature may be verified against.
 *
 * The primary/compatibility secret is authoritative. The optional
 * `SANDBOX_MISSION_HMAC_SECRET` alias is appended ONLY when present — its
 * absence yields the exact same single-secret set as before, so it can never
 * become required nor replace primary auth. Empty/whitespace-only values are
 * ignored so a blank binding never accidentally disables verification.
 */
export function resolvePreviewSecrets(env: {
  SANDBOX_HMAC_SECRET?: string;
  CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string;
  SANDBOX_MISSION_HMAC_SECRET?: string;
}): string[] {
  const primary = env.SANDBOX_HMAC_SECRET || env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET;
  const secrets: string[] = [];
  if (primary && primary.trim()) secrets.push(primary);
  const mission = env.SANDBOX_MISSION_HMAC_SECRET;
  if (mission && mission.trim()) secrets.push(mission);
  return secrets;
}

/**
 * Per-sandbox Neko auto-connect credential material.
 *
 * `user` seeds both `NEKO_MEMBER_MULTIUSER_USER_PASSWORD` (V3) and the legacy
 * `NEKO_PASSWORD` (V2) key; `admin` seeds both
 * `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD` (V3) and the legacy
 * `NEKO_PASSWORD_ADMIN` (V2) key. The pinned Neko build defaults `legacy` to
 * true (the bundled client requires it), and `Member.SetV2()` runs after
 * `Member.Set()`, so the V2 keys take precedence and MUST carry the same
 * derived values or auto-connect silently reverts to Neko's `neko`/`admin`
 * defaults. Both roles are opaque, non-reversible, and MUST never be logged or
 * returned to the browser.
 */
export interface NekoCredentials {
  user: string;
  admin: string;
}

/**
 * Resolve ONLY the primary preview HMAC binding used to derive Neko
 * auto-connect credentials.
 *
 * Resolution order: nonblank `SANDBOX_HMAC_SECRET`, then nonblank
 * `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`. The mission alias
 * (`SANDBOX_MISSION_HMAC_SECRET`) is DELIBERATELY excluded — Neko credential
 * derivation must never depend on a throwaway operational key. Returns `null`
 * when no primary/compatibility value is configured (local-dev defaults).
 */
export function resolveNekoDerivationSecret(env: {
  SANDBOX_HMAC_SECRET?: string;
  CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string;
}): string | null {
  const primary = env.SANDBOX_HMAC_SECRET;
  if (primary && primary.trim()) return primary;
  const compat = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET;
  if (compat && compat.trim()) return compat;
  return null;
}

/**
 * Deterministic per-sandbox HMAC-derived value (lowercase, first 32 hex chars)
 * for a fixed Neko role payload. Payloads:
 *   `ezil-neko:user:<sandboxId>:v1`
 *   `ezil-neko:admin:<sandboxId>:v1`
 */
async function deriveNekoValue(secret: string, role: 'user' | 'admin', sandboxId: string): Promise<string> {
  const payload = `ezil-neko:${role}:${sandboxId}:v1`;
  const hex = await hmacSha256Hex(secret, payload);
  return hex.toLowerCase().slice(0, 32);
}

/**
 * Derive the deterministic per-sandbox Neko regular-user + admin credentials
 * from ONLY the primary preview HMAC binding.
 *
 * When no primary/compatibility secret is configured (local dev), the Neko
 * image's built-in local defaults `{ user: 'neko', admin: 'admin' }` are
 * preserved unchanged so a keyless local environment still boots. The mission
 * alias is never consulted. Neither derived value is ever logged or returned.
 */
export async function deriveNekoCredentials(
  env: { SANDBOX_HMAC_SECRET?: string; CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string },
  sandboxId: string,
): Promise<NekoCredentials> {
  const secret = resolveNekoDerivationSecret(env);
  if (!secret) return { user: 'neko', admin: 'admin' };
  const [user, admin] = await Promise.all([
    deriveNekoValue(secret, 'user', sandboxId),
    deriveNekoValue(secret, 'admin', sandboxId),
  ]);
  return { user, admin };
}

/**
 * Verify the preview token minted by `mintSandboxPreviewToken()`.
 *   Token format: `t=<unix_ms>,v1=<hex_hmac_sha256>`
 *   Payload:      `${timestamp}.POST./sandbox/preview.`
 * When no secret is configured the Worker runs in local-dev mode and accepts
 * any token (including the literal `local-dev` placeholder).
 *
 * `secret` may be a single secret (legacy callers) or an ordered list of
 * candidate secrets. A signature is accepted if it matches ANY candidate under
 * a timing-safe comparison; all candidates are evaluated (no early return) so
 * the acceptance decision does not leak which secret matched via timing. Token
 * freshness and canonicalization are enforced once, independent of the secret.
 */
// ── Preview-bootstrap token + cookie (Option D reverse-proxy auth) ──────────
//
// Ports the Azure control-plane daemon's Option D security envelope
// (`infra/sandbox-desktop/atspi_daemon.py` configure; the actual reverse-proxy
// logic lives in the sibling `Sandboxes` repo's `preview_bridge.py` — see
// `docs/PREVIEW_MIGRATION_PLAN.md`) to this Worker.
//
// Azure's daemon verifies against a PER-SESSION secret (`session.hmacSecret`,
// minted once per sandbox session and stored in the `sandboxSessions` DB row),
// so a bootstrap token is implicitly scoped to the one daemon that holds that
// secret. This Worker has no per-session secret store — it only has the same
// Worker-wide `SANDBOX_HMAC_SECRET` / `CLOUDFLARE_GUACAMOLE_HMAC_SECRET` (+
// optional mission alias) already used to gate `/sandbox/preview`. Reusing
// that Worker-wide secret verbatim for the bootstrap token, WITHOUT binding
// the request to a specific `sandboxId`, would let a token minted for one
// user's sandbox be replayed against any other sandbox (every sandbox shares
// the same verifying secret) — a cross-tenant auth bypass. So unlike Azure's
// payload (`${ts}.GET./preview-bootstrap.`), this Worker's payload ALSO binds
// `sandboxId`: `${ts}.GET./preview-bootstrap.${sandboxId}.` — the minting
// server (the "second worker"'s tRPC procedure) MUST include the exact
// `sandboxId` the token is meant to unlock, and this Worker only accepts the
// token when verified against the SAME sandboxId parsed out of the request's
// own preview-proxy hostname. This is the one deliberate deviation from the
// Azure contract, and it is a strengthening (narrows a token to one sandbox),
// not a weakening.

/** Bootstrap token freshness window — mirrors Azure's `BOOTSTRAP_TOKEN_TTL_MS` (5 min). */
export const PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

/** Canonical signed payload for the `/preview-bootstrap` token. Binds `sandboxId` — see module doc above. */
export const PREVIEW_BOOTSTRAP_TOKEN_PAYLOAD = (timestamp: number, sandboxId: string): string =>
  `${timestamp}.GET./preview-bootstrap.${sandboxId}.`;

/**
 * Mint a `/preview-bootstrap?token=...` token. Format: `t=<ts_ms>,v1=<hex>`
 * (identical envelope shape to `mintSandboxPreviewToken`/`verifyPreviewToken`,
 * a distinct payload/secret-scope). Used by tests and documented here as the
 * exact contract the client-side minting code (owned by the second worker)
 * must replicate.
 */
export async function mintPreviewBootstrapToken(
  secret: string,
  sandboxId: string,
  now: number = Date.now(),
): Promise<string> {
  const payload = PREVIEW_BOOTSTRAP_TOKEN_PAYLOAD(now, sandboxId);
  const sig = await hmacSha256Hex(secret, payload);
  return `t=${now},v1=${sig}`;
}

/**
 * Verify a `/preview-bootstrap?token=...` token against the resolved secret
 * candidates (see `resolvePreviewSecrets`) AND the `sandboxId` parsed from the
 * request's own hostname. When no secret is configured (local dev), any
 * (including absent/malformed) token is accepted, matching
 * `verifyPreviewToken`'s local-dev behavior.
 */
export async function verifyPreviewBootstrapToken(
  token: string | undefined,
  secrets: string[],
  sandboxId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const candidates = secrets.filter((s) => s && s.trim());
  if (candidates.length === 0) return { ok: true }; // local dev: verification disabled

  if (!token) {
    return { ok: false, error: 'preview_bootstrap_token_missing' };
  }
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(token);
  if (!match) return { ok: false, error: 'preview_bootstrap_token_malformed' };

  const timestamp = Number(match[1]);
  const provided = match[2];
  const now = Date.now();
  // Reject tokens from the future (clock skew tolerance) or older than the TTL.
  if (!Number.isFinite(timestamp) || timestamp > now + 10_000 || timestamp < now - PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS) {
    return { ok: false, error: 'preview_bootstrap_token_expired' };
  }

  const payload = PREVIEW_BOOTSTRAP_TOKEN_PAYLOAD(timestamp, sandboxId);
  let matched = false;
  for (const candidate of candidates) {
    const expected = await hmacSha256Hex(candidate, payload);
    if (timingSafeEqualHex(expected, provided)) matched = true;
  }
  if (!matched) return { ok: false, error: 'preview_bootstrap_token_signature_mismatch' };
  return { ok: true };
}

/** Cookie name carrying the preview session — identical name to the Azure daemon's contract. */
export const PREVIEW_COOKIE_NAME = 'ezil_preview';

/** Preview cookie lifetime (seconds) — identical to Azure's `COOKIE_TTL_S` (1 hour). */
export const PREVIEW_COOKIE_TTL_S = 60 * 60;

/**
 * Mint the `ezil_preview` cookie value: `<sandboxId>.<ts>.<hex_hmac>`,
 * `hmac = sha256(secret, "<sandboxId>.<ts>")` — same shape as Azure's
 * `<session_id>.<ts>.<hmac>`, with `sandboxId` standing in for `session_id`.
 * When no secret is configured (local dev), returns an unsigned placeholder
 * (`dev.<ts>.nohmac`) that `verifyPreviewCookie` also accepts in that mode.
 */
export async function mintPreviewCookie(
  secret: string | undefined,
  sandboxId: string,
  now: number = Date.now(),
): Promise<string> {
  if (!secret || !secret.trim()) {
    return `dev.${now}.nohmac`;
  }
  const payload = `${sandboxId}.${now}`;
  const sig = await hmacSha256Hex(secret, payload);
  return `${sandboxId}.${now}.${sig}`;
}

/**
 * Verify the `ezil_preview` cookie against the resolved secret candidates AND
 * the expected `sandboxId` (parsed from the request's own hostname — the
 * cookie can never be presented to a different sandbox's origin because each
 * sandbox has its own preview subdomain, but this check is defense in depth).
 * When no secret is configured, any well-formed-or-not cookie is accepted
 * (local dev).
 */
export async function verifyPreviewCookie(
  cookie: string | undefined,
  secrets: string[],
  sandboxId: string,
): Promise<boolean> {
  const candidates = secrets.filter((s) => s && s.trim());
  if (candidates.length === 0) return true; // local dev: verification disabled
  if (!cookie) return false;

  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [cookieSandboxId, tsRaw, sig] = parts;
  if (cookieSandboxId !== sandboxId) return false;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > PREVIEW_COOKIE_TTL_S * 1000) return false;

  const payload = `${cookieSandboxId}.${tsRaw}`;
  let matched = false;
  for (const candidate of candidates) {
    const expected = await hmacSha256Hex(candidate, payload);
    if (timingSafeEqualHex(expected, sig)) matched = true;
  }
  return matched;
}

export async function verifyPreviewToken(
  token: string | undefined,
  secret: string | string[] | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const secrets = (Array.isArray(secret) ? secret : secret ? [secret] : []).filter(
    (s) => s && s.trim(),
  );
  if (secrets.length === 0) return { ok: true }; // local dev: verification disabled

  if (!token || token === 'local-dev') {
    return { ok: false, error: 'hmac_required: worker configured with a secret but request was unsigned' };
  }

  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(token);
  if (!match) return { ok: false, error: 'hmac_malformed_token' };

  const timestamp = Number(match[1]);
  const provided = match[2];

  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > TOKEN_MAX_AGE_MS) {
    return { ok: false, error: 'hmac_token_expired' };
  }

  const payload = PREVIEW_TOKEN_PAYLOAD(timestamp);
  let matched = false;
  for (const candidate of secrets) {
    const expected = await hmacSha256Hex(candidate, payload);
    // Fold into `matched` without short-circuiting so timing does not reveal
    // which (if any) candidate secret produced the match.
    if (timingSafeEqualHex(expected, provided)) matched = true;
  }
  if (!matched) {
    return { ok: false, error: 'hmac_signature_mismatch' };
  }
  return { ok: true };
}

// ── Preview token v2: a signed envelope that binds the request (C-5, R13) ────
//
// v1 signs the constant `${ts}.POST./sandbox/preview.`, so a v1 token binds no
// sandbox, user, route or body: any fresh v1 token authorizes every route for
// every sandbox. v2 signs
//
//   v2|ts|METHOD|path|sandboxId|computerId|userId|provider|store|generation|leaseEpoch|sha256hex(body)
//
// where METHOD, path (the URL pathname exactly as sent, no query) and the body
// digest are recomputed by the VERIFIER from the request it actually received,
// never read from the token. The token therefore carries only the claims.
//
// Wire format (header `x-ezil-auth`, never the body: the body is digested):
//   v2.<base64url(JSON claims)>.<hex hmac_sha256>
//
// Field rules (shared with the app minter through
// `contracts/preview-token-v2.vectors.json`):
//   - ids (sandboxId, computerId, userId): 1..256 chars of [A-Za-z0-9._:@-], so
//     the `|` separator can never appear inside a field;
//   - provider: 'cloudflare' | 'aws-ec2'; anything else fails closed (R13);
//   - store: 'r2' | 's3' | '' (empty = no store claim; the Worker then applies
//     its own per-computer choice);
//   - generation, leaseEpoch: non-negative safe integers, written in decimal;
//     a Cloudflare computer sends 0 and 0;
//   - ts: unix ms, same 5-minute window as v1.
//
// Query strings are NOT signed: a request authenticated by v2 must carry no
// query at all (the Worker refuses one with `hmac_v2_query_not_allowed`).
// Replay: there is no nonce (C-5 does not require one), so a captured token
// can be replayed for the SAME method, path and body within the 5-minute TTL.
//
// Unlike v1, v2 has NO local-dev bypass: no secret configured => refused
// (`hmac_secret_not_configured`), matching #166's fail-closed rule.

export const PREVIEW_TOKEN_V2_HEADER = 'x-ezil-auth';
export const PREVIEW_TOKEN_V2_PREFIX = 'v2.';
export const PREVIEW_TOKEN_V2_PROVIDERS = ['cloudflare', 'aws-ec2'] as const;
export const PREVIEW_TOKEN_V2_STORES = ['r2', 's3'] as const;
export type PreviewTokenV2Provider = (typeof PREVIEW_TOKEN_V2_PROVIDERS)[number];
export type PreviewTokenV2Store = (typeof PREVIEW_TOKEN_V2_STORES)[number];

export interface PreviewTokenV2Claims {
  ts: number;
  sandboxId: string;
  computerId: string;
  userId: string;
  provider: PreviewTokenV2Provider;
  /** '' = no store claim. */
  store: PreviewTokenV2Store | '';
  generation: number;
  leaseEpoch: number;
}

export interface PreviewTokenV2Request {
  method: string;
  /** URL pathname as received (no query string). */
  path: string;
  /** The exact request body bytes ('' / empty for a body-less request). */
  body: Uint8Array | string;
}

const V2_ID = /^[A-Za-z0-9._:@-]{1,256}$/;
const V2_PATH = /^\/[\x21-\x7e]{0,2047}$/;
const V2_METHOD = /^[A-Z]{1,16}$/;

export function isPreviewTokenV2(token: unknown): boolean {
  return typeof token === 'string' && token.startsWith(PREVIEW_TOKEN_V2_PREFIX);
}

function validV2Claims(c: unknown): c is PreviewTokenV2Claims {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'computerId,generation,leaseEpoch,provider,sandboxId,store,ts,userId') return false;
  return Number.isSafeInteger(o.ts) && (o.ts as number) > 0
    && typeof o.sandboxId === 'string' && V2_ID.test(o.sandboxId)
    && typeof o.computerId === 'string' && V2_ID.test(o.computerId)
    && typeof o.userId === 'string' && V2_ID.test(o.userId)
    && (PREVIEW_TOKEN_V2_PROVIDERS as readonly unknown[]).includes(o.provider)
    && (o.store === '' || (PREVIEW_TOKEN_V2_STORES as readonly unknown[]).includes(o.store))
    && Number.isSafeInteger(o.generation) && (o.generation as number) >= 0
    && Number.isSafeInteger(o.leaseEpoch) && (o.leaseEpoch as number) >= 0;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The canonical v2 signed string. Throws on a field that could break the framing. */
export function previewTokenV2Payload(c: PreviewTokenV2Claims, method: string, path: string, bodySha256: string): string {
  if (!validV2Claims(c)) throw new Error('invalid v2 claims');
  if (!V2_METHOD.test(method) || !V2_PATH.test(path) || path.includes('|') || !/^[0-9a-f]{64}$/.test(bodySha256)) {
    throw new Error('invalid v2 request binding');
  }
  return ['v2', c.ts, method, path, c.sandboxId, c.computerId, c.userId, c.provider, c.store,
    c.generation, c.leaseEpoch, bodySha256].join('|');
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Claims are serialized in this fixed key order so both minters emit identical tokens. */
function encodeV2Claims(c: PreviewTokenV2Claims): string {
  return base64UrlEncode(JSON.stringify({
    ts: c.ts, sandboxId: c.sandboxId, computerId: c.computerId, userId: c.userId,
    provider: c.provider, store: c.store, generation: c.generation, leaseEpoch: c.leaseEpoch,
  }));
}

export async function mintPreviewTokenV2(
  secret: string,
  claims: PreviewTokenV2Claims,
  req: PreviewTokenV2Request,
): Promise<string> {
  if (!secret || !secret.trim()) throw new Error('hmac_secret_not_configured');
  const payload = previewTokenV2Payload(claims, req.method.toUpperCase(), req.path, await sha256Hex(req.body));
  return `${PREVIEW_TOKEN_V2_PREFIX}${encodeV2Claims(claims)}.${await hmacSha256Hex(secret, payload)}`;
}

export async function verifyPreviewTokenV2(
  token: string | null | undefined,
  secret: string | string[] | undefined,
  req: PreviewTokenV2Request,
  now: number = Date.now(),
): Promise<{ ok: true; claims: PreviewTokenV2Claims } | { ok: false; error: string }> {
  const secrets = (Array.isArray(secret) ? secret : secret ? [secret] : []).filter((s) => s && s.trim());
  // Fail closed: v2 never has a local-dev bypass.
  if (secrets.length === 0) return { ok: false, error: 'hmac_secret_not_configured' };
  if (!token) return { ok: false, error: 'hmac_v2_token_missing' };
  const m = /^v2\.([A-Za-z0-9_-]{1,4096})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return { ok: false, error: 'hmac_v2_malformed_token' };
  const decoded = base64UrlDecode(m[1]!);
  let claims: unknown;
  try { claims = decoded === null ? null : JSON.parse(decoded); } catch { claims = null; }
  if (!validV2Claims(claims)) return { ok: false, error: 'hmac_v2_invalid_claims' };
  if (Math.abs(now - claims.ts) > TOKEN_MAX_AGE_MS) return { ok: false, error: 'hmac_token_expired' };
  let payload: string;
  try {
    payload = previewTokenV2Payload(claims, req.method.toUpperCase(), req.path, await sha256Hex(req.body));
  } catch {
    return { ok: false, error: 'hmac_v2_invalid_request' };
  }
  let matched = false;
  for (const candidate of secrets) {
    if (timingSafeEqualHex(await hmacSha256Hex(candidate, payload), m[2]!)) matched = true;
  }
  if (!matched) return { ok: false, error: 'hmac_signature_mismatch' };
  return { ok: true, claims };
}

/**
 * Whether a v1 (`t=…,v1=…`) preview token may still be accepted.
 * `EZIL_PREVIEW_TOKEN_V1_UNTIL` is an ISO timestamp: absent/blank => v1 is
 * accepted (today's behaviour); a parseable instant in the future => accepted;
 * at/after it => refused. An unparseable value fails closed (refused).
 * Applies to the preview/control envelope only, never to the
 * `/preview-bootstrap` token or the `ezil_preview` cookie.
 */
export function previewTokenV1Accepted(until: string | undefined, now: number = Date.now()): boolean {
  const raw = until?.trim();
  if (!raw) return true;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return false;
  const cutoff = Date.parse(raw);
  if (!Number.isFinite(cutoff)) return false;
  return now < cutoff;
}

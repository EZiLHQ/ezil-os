/**
 * Worker forward for `EZIL-COMPUTER-TOOLS/1` (frozen contract sections 3.3 + 3.4).
 *
 * The EZiL OS server signs a v2 request to
 *   POST https://api-desktop-staging.ezil.work/sandbox/<guac-id>/computer-tools
 * carrying `{ binding, op, input }`. This module checks the v2 claims exactly as
 * `browser-observe` does, re-derives the per-boot toolsd key, MAC-signs the
 * `input`, forwards it to the in-computer daemon on port 9224, and relays the
 * daemon's status and body.
 *
 * 🔴 THE CONTAINER IS NEVER STARTED. The contract (3.3) requires that a stopped
 * computer is answered 503 `computer_unavailable` rather than cold-started. The
 * brief's shorthand says "containerFetch", but `Sandbox.containerFetch()`
 * auto-starts a stopped container (it calls `startAndWaitForPorts` — see
 * PLATFORM-NOTES §22). So this uses `runningContainerFetch`, the DO RPC that
 * checks `containerIsRunning()` under the runtime lock and reaches the port with
 * `getTcpPort(port).fetch()` — which does NOT start it — exactly as
 * `observeExistingBrowser` / `openBrowserUrl` avoid starting one. A null boot
 * nonce (never booted) is caught first, before any RPC; a container that stopped
 * after booting makes `runningContainerFetch` answer 409, which maps to 503.
 *
 * 🔴 NO `AbortSignal` crosses the RPC boundary. `runningContainerFetch` applies
 * its own `AbortSignal.timeout` INSIDE the Durable Object; the Worker's deadline
 * is `withDeadline`, which races the RPC against a timer (see
 * `container-fetch-no-signal.test.ts`). Passing a signal in the `RequestInit`
 * would throw `AbortSignal serialization is not enabled` at the isolate boundary.
 */

import { deriveAiProxyToken } from './ai-proxy';
import { resolveNekoDerivationSecret } from './hmac';
import type { PreviewTokenV2Claims } from './hmac';

/** The one origin this route answers (a fixed staging constant). */
export const COMPUTER_TOOLS_ORIGIN = 'https://api-desktop-staging.ezil.work';

/** The six ops toolsd serves; anything else is refused before any RPC. */
export const COMPUTER_TOOLS_OPS = ['list', 'refresh', 'call', 'exec', 'job', 'cancel'] as const;
export type ComputerToolsOp = (typeof COMPUTER_TOOLS_OPS)[number];

/** toolsd's bind port. Never `exposePort`'d and never carried by preview routes. */
export const TOOLSD_PORT = 9224;

/** The OS→Worker request body is bounded here (contract 3.3). */
export const MAX_REQUEST_BODY_BYTES = 40_960;
/** The relayed toolsd reply is bounded here; larger is `computer_unavailable`. */
export const MAX_REPLY_BYTES = 524_288;
/** End-to-end budget for the toolsd round trip. */
export const TOOLSD_DEADLINE_MS = 12_000;

const BINDING_RE = /^[0-9a-f]{64}$/;

/** The minimal environment this module needs: the Neko derivation secret source. */
export interface ComputerToolsEnv {
  SANDBOX_HMAC_SECRET?: string;
  CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string;
}

/** The sandbox-stub methods used here (both are `EzilWorkspacePersistRpc` members). */
export interface ComputerToolsSandbox {
  getAiProxyNonce(): Promise<string | null>;
  runningContainerFetch(url: string, init?: RequestInit, port?: number): Promise<Response>;
}

/** Functions owned by `index.ts`, passed in so this module stays unit-testable. */
export interface ComputerToolsDeps {
  deriveSandboxId(userId: string, scopeId?: string): string;
  withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T>;
}

const enc = new TextEncoder();

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(keyBytes: BufferSource, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}

/**
 * Derive the `x-ezil-toolsd` header value for `op` and `bodyStr` (contract 3.4):
 *   K   = HMAC-SHA256(UTF-8(proxyToken), "EZIL-TOOLSD-KEY/1")
 *   mac = HMAC-SHA256(K, "EZIL-TOOLSD/1\n<ts>\nPOST\n/v1/<op>\n<sha256 hex of body>")
 * The `proxyToken` is this boot's `EZIL_AI_PROXY_TOKEN` (`deriveAiProxyToken`).
 */
export async function toolsdAuthHeader(proxyToken: string, op: string, bodyStr: string, ts: number): Promise<string> {
  const kRaw = await hmac(enc.encode(proxyToken), 'EZIL-TOOLSD-KEY/1');
  const bodyHash = toHex(await crypto.subtle.digest('SHA-256', enc.encode(bodyStr)));
  const macPayload = `EZIL-TOOLSD/1\n${ts}\nPOST\n/v1/${op}\n${bodyHash}`;
  const mac = toHex(await hmac(kRaw, macPayload));
  return `v1.${ts}.${mac}`;
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | 'too_large'> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { void reader.cancel().catch(() => undefined); return 'too_large'; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/**
 * Handle one `POST /sandbox/<guac-id>/computer-tools`. `sandboxId` is the
 * path's guac id; `claims` are the v2 claims `preauthorizeV2` verified for this
 * request; `sandbox` is `openSandbox(env, sandboxId)`.
 */
export async function handleComputerTools(
  request: Request,
  env: ComputerToolsEnv,
  origin: string,
  sandboxId: string,
  claims: PreviewTokenV2Claims | undefined,
  sandbox: ComputerToolsSandbox,
  deps: ComputerToolsDeps,
): Promise<Response> {
  // 3.3: the one fixed origin.
  if (origin !== COMPUTER_TOOLS_ORIGIN) return reply(404, { ok: false, error: 'tools_unavailable' });

  // 3.3: v2 claims, exactly as browser-observe/open check them.
  const now = Date.now();
  if (!claims || claims.provider !== 'cloudflare' || claims.sandboxId !== sandboxId
    || sandboxId !== deps.deriveSandboxId(claims.userId, claims.computerId)
    || claims.generation !== 0 || claims.leaseEpoch !== 0 || claims.store !== ''
    || claims.ts < now - 30_000 || claims.ts > now + 10_000) {
    return reply(401, { ok: false, error: 'tools_unauthorized' });
  }

  // 3.3: body ≤ 40,960 bytes, then `{ binding, op, input }` strictly.
  const raw = await readBounded(request.clone().body, MAX_REQUEST_BODY_BYTES);
  if (raw === 'too_large') return reply(400, { ok: false, error: 'tools_invalid_request' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return reply(400, { ok: false, error: 'tools_invalid_request' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return reply(400, { ok: false, error: 'tools_invalid_request' });
  }
  const { binding, op, input } = parsed as { binding?: unknown; op?: unknown; input?: unknown };
  if (typeof binding !== 'string' || !BINDING_RE.test(binding)
    || typeof op !== 'string' || !(COMPUTER_TOOLS_OPS as readonly string[]).includes(op)
    || input === null || typeof input !== 'object' || Array.isArray(input)) {
    return reply(400, { ok: false, error: 'tools_invalid_request' });
  }

  // 3.4: re-derive this boot's toolsd key material. No secret or no boot nonce
  // (never booted) → unavailable, and nothing is sent.
  const secret = resolveNekoDerivationSecret(env);
  if (!secret) return reply(503, { ok: false, error: 'computer_unavailable' });
  const nonce = await sandbox.getAiProxyNonce();
  if (!nonce) return reply(503, { ok: false, error: 'computer_unavailable' });

  const proxyToken = await deriveAiProxyToken(secret, sandboxId, nonce);
  const bodyStr = JSON.stringify(input);
  const ts = Date.now();
  const header = await toolsdAuthHeader(proxyToken, op, bodyStr, ts);

  // 3.4: forward to toolsd. `runningContainerFetch` never starts a stopped
  // container; a stopped one answers 409 → 503. No AbortSignal crosses the RPC.
  const deadline = Date.now() + TOOLSD_DEADLINE_MS;
  let upstream: Response;
  try {
    upstream = await deps.withDeadline(
      sandbox.runningContainerFetch(
        `http://toolsd.ezil.invalid/v1/${op}`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-ezil-toolsd': header }, body: bodyStr },
        TOOLSD_PORT,
      ),
      TOOLSD_DEADLINE_MS,
      `computerTools.${op}`,
    );
  } catch {
    return reply(503, { ok: false, error: 'computer_unavailable' });
  }
  // 409 is `runningContainerFetch`'s "not running" sentinel — toolsd itself
  // never answers 409, so this is unambiguous.
  if (upstream.status === 409) return reply(503, { ok: false, error: 'computer_unavailable' });

  // Relay the toolsd status and body, bounded. Larger than the bound → 503.
  const remaining = deadline - Date.now();
  if (remaining <= 0) return reply(503, { ok: false, error: 'computer_unavailable' });
  let bytes: Uint8Array | 'too_large';
  try {
    bytes = await deps.withDeadline(readBounded(upstream.body, MAX_REPLY_BYTES), remaining, 'computerTools.reply');
  } catch {
    return reply(503, { ok: false, error: 'computer_unavailable' });
  }
  if (bytes === 'too_large') return reply(503, { ok: false, error: 'computer_unavailable' });
  return new Response(bytes, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

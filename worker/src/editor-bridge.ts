/**
 * Container -> OS editor-bridge sync (EZiL MCP CONTRACT.md v3.0).
 *
 * The EZiL extension in a computer's editor calls ONE fixed route on its code
 * host, `POST /editor-bridge/v1/sync`, with its own boot-scoped bearer
 * `EZIL_EDITOR_BRIDGE_TOKEN`: HMAC of a distinct label, this sandbox id and its
 * current boot nonce, so a restarted or replaced container's token is dead and
 * the AI proxy token (`EZIL_AI_PROXY_TOKEN`) never authorizes chat control, nor
 * this token AI calls. It is provisioned only while the bridge is enabled
 * (EZIL_OS_BRIDGE_URL). This Worker verifies it, then forwards the body
 * unchanged to OS, signed with the Worker secret over the timestamp, the
 * sandbox name and the body hash (OS: app/src/server/agent-session/sync-route.ts).
 * Like the AI token it is readable by anything running as root in that
 * computer; it identifies the computer, not a trusted editor, and OS rechecks
 * the computer, its current owner, the lease and every session itself.
 *
 * Nothing else is forwarded: no client headers, no other path or method, no
 * query string, bounded bodies both ways. OS decides what the sync may do; it
 * can only sync THIS computer's sessions and never enqueue work. Off (404)
 * unless EZIL_OS_BRIDGE_URL is a valid https origin. No tokens or bodies are logged.
 */
import { hmacSha256Hex, timingSafeEqualHex } from './hmac';
import { readLimited } from './ai-proxy';

export const EDITOR_BRIDGE_SYNC_PATH = '/editor-bridge/v1/sync';
export const EDITOR_BRIDGE_OS_PATH = '/api/editor-bridge/v1/sync';
export const EDITOR_BRIDGE_MAX_BODY_BYTES = 256 * 1024;
export const EDITOR_BRIDGE_MAX_RESPONSE_BYTES = 256 * 1024;
export const EDITOR_BRIDGE_TIMEOUT_MS = 15_000;

export function isEditorBridgePath(pathname: string): boolean {
  return pathname === '/editor-bridge' || pathname.startsWith('/editor-bridge/');
}

/** The OS origin to forward to, or null (bridge off): https only, origin only, localhost allowed for tests. */
export function resolveOsBridgeUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return url.origin;
}

/** HMAC-SHA256(primary secret, `ezil-editor-bridge:<sandboxId>:<nonce>:v1`): never equal to the AI proxy token. */
export async function deriveEditorBridgeToken(secret: string, sandboxId: string, nonce: string): Promise<string> {
  return (await hmacSha256Hex(secret, `ezil-editor-bridge:${sandboxId.toLowerCase()}:${nonce}:v1`)).toLowerCase();
}

/** Verify `Authorization: Bearer <editor-bridge token>` for `sandboxId` at this boot. False without a secret or nonce. */
export async function verifyEditorBridgeBearer(authorization: string | null, secret: string | null, sandboxId: string, nonce: string | null): Promise<boolean> {
  if (!secret || !nonce) return false;
  const match = /^Bearer ([0-9a-f]{64})$/.exec(authorization?.trim() ?? '');
  if (!match) return false;
  return timingSafeEqualHex(await deriveEditorBridgeToken(secret, sandboxId, nonce), match[1]!);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `v1=hex(HMAC-SHA256(secret, editor-bridge.v1.<ts>.<sandbox>.<sha256 hex of body>))`, matching OS. */
export async function signEditorBridgeSync(secret: string, timestamp: string, sandboxId: string, body: Uint8Array): Promise<string> {
  return `v1=${await hmacSha256Hex(secret, `editor-bridge.v1.${timestamp}.${sandboxId}.${await sha256Hex(body)}`)}`;
}

export interface EditorBridgeDeps {
  sandboxId: string;
  osUrl: string | null;
  /** The primary Worker secret: derives the editor-bridge token and signs the forward. */
  secret: string | null;
  /** This boot's AI proxy nonce (Cloudflare DO, or the AWS tunnel record). */
  nonce: string | null;
  fetch: (request: Request) => Promise<Response>;
  now: () => number;
  log: (fields: Record<string, unknown>) => void;
}

const fail = (status: number, code: string) =>
  Response.json({ error: { code, source: 'ezil-os-bridge' } }, { status, headers: { 'cache-control': 'no-store' } });

export async function handleEditorBridgeRequest(request: Request, deps: EditorBridgeDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!deps.osUrl) return fail(404, 'not_found');
  if (url.pathname !== EDITOR_BRIDGE_SYNC_PATH || url.search) return fail(404, 'not_found');
  if (request.method !== 'POST') return fail(405, 'method_not_allowed');
  if (!deps.secret) return fail(503, 'os_bridge_unavailable');
  if (!(await verifyEditorBridgeBearer(request.headers.get('authorization'), deps.secret, deps.sandboxId, deps.nonce))) {
    return fail(401, 'os_bridge_unauthorized');
  }
  if (Number(request.headers.get('content-length') ?? 0) > EDITOR_BRIDGE_MAX_BODY_BYTES) return fail(413, 'body_too_large');
  const body = await readLimited(request.body, EDITOR_BRIDGE_MAX_BODY_BYTES);
  if (body === null) return fail(413, 'body_too_large');

  const timestamp = String(Math.floor(deps.now() / 1000));
  const sandboxId = deps.sandboxId.toLowerCase();
  let upstream: Response;
  const started = deps.now();
  try {
    upstream = await deps.fetch(new Request(`${deps.osUrl}${EDITOR_BRIDGE_OS_PATH}`, {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(EDITOR_BRIDGE_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-ezil-sandbox': sandboxId,
        'x-ezil-timestamp': timestamp,
        'x-ezil-signature': await signEditorBridgeSync(deps.secret, timestamp, sandboxId, body),
      },
    }));
  } catch {
    deps.log({ event: 'ezil_editor_bridge', sandbox: sandboxId, outcome: 'upstream_unreachable' });
    return fail(502, 'os_bridge_unreachable');
  }
  const reply = await readLimited(upstream.body, EDITOR_BRIDGE_MAX_RESPONSE_BYTES);
  deps.log({ event: 'ezil_editor_bridge', sandbox: sandboxId, status: upstream.status, ms: deps.now() - started });
  if (reply === null || upstream.status >= 300 && upstream.status < 400) return fail(502, 'os_bridge_bad_response');
  return new Response(reply, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

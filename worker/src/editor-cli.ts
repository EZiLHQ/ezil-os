/**
 * Container -> OS editor Chat CLI channel (`ws2-contract-cfda97e.md` §7, item 3).
 *
 * The EZiL extension in a computer's editor calls ONE fixed route on its code
 * host, `POST /editor-bridge/v1/cli`, carrying the SAME boot-scoped bearer the
 * sync uses (`EZIL_EDITOR_BRIDGE_TOKEN` = `deriveEditorBridgeToken(secret,
 * sandboxId, nonce)`); this Worker verifies it, then forwards the body to OS
 * signed with the Worker secret over a DISTINCT label `editor-cli.v1.<ts>.
 * <sandbox>.<sha256 hex body>`. The distinct label is load-bearing: a sync
 * signature (`editor-bridge.v1.…`) never verifies on the OS CLI route and a CLI
 * signature never verifies on the sync route (OS:
 * app/src/server/agent-session/cli-channel.ts).
 *
 * This is a sibling of `./editor-bridge.ts`: same eligibility (staging bridge
 * environment, `EZIL_OS_BRIDGE_URL` = os-staging, a target in
 * `EZIL_EDITOR_BRIDGE_TARGETS`), Cloudflare only (the AWS path is not dispatched
 * here, so an AWS `/editor-bridge/v1/cli` falls to the sync handler and 404s).
 * Nothing else is forwarded: no client headers, no other path/method, no query
 * string, bounded bodies both ways. OS decides what the CLI may do; it can only
 * touch THIS computer's sessions. Off (404) unless the staging Worker pins the
 * staging OS origin. No tokens or bodies are logged.
 */
import type { SandboxEnv } from '@cloudflare/sandbox';

import { readLimited } from './ai-proxy';
import { resolveOsBridgeUrl, verifyEditorBridgeBearer, type EditorBridgeDeps } from './editor-bridge';
import { hmacSha256Hex, resolveNekoDerivationSecret } from './hmac';

export const EDITOR_CLI_PATH = '/editor-bridge/v1/cli';
export const EDITOR_CLI_OS_PATH = '/api/editor-bridge/v1/cli';
export const EDITOR_CLI_MAX_BODY_BYTES = 32 * 1024;
export const EDITOR_CLI_MAX_RESPONSE_BYTES = 64 * 1024;
export const EDITOR_CLI_TIMEOUT_MS = 20_000;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `v1=hex(HMAC-SHA256(secret, editor-cli.v1.<ts>.<sandbox>.<sha256 hex of body>))`, matching OS
 * (`cli-channel.ts` `signEditorCli`). The `editor-cli` label is DELIBERATELY distinct from the
 * sync's `editor-bridge` label so the two signatures are never interchangeable.
 */
export async function signEditorCli(secret: string, timestamp: string, sandboxId: string, body: Uint8Array): Promise<string> {
  return `v1=${await hmacSha256Hex(secret, `editor-cli.v1.${timestamp}.${sandboxId}.${await sha256Hex(body)}`)}`;
}

const fail = (status: number, code: string) =>
  Response.json({ error: { code, source: 'ezil-os-bridge' } }, { status, headers: { 'cache-control': 'no-store' } });

/**
 * The testable core: it is handed an already-resolved `osUrl`, `secret` and boot
 * `nonce` (the same `EditorBridgeDeps` `handleEditorBridgeRequest` takes). It
 * verifies the bearer, bounds the body, and forwards to OS under the editor-cli
 * signature, relaying OS's status and bounded body.
 */
export async function handleEditorCliRequest(request: Request, deps: EditorBridgeDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!deps.osUrl) return fail(404, 'not_found');
  if (url.pathname !== EDITOR_CLI_PATH || url.search) return fail(404, 'not_found');
  if (request.method !== 'POST') return fail(405, 'method_not_allowed');
  if (!deps.secret) return fail(503, 'os_bridge_unavailable');
  if (!(await verifyEditorBridgeBearer(request.headers.get('authorization'), deps.secret, deps.sandboxId, deps.nonce))) {
    return fail(401, 'os_bridge_unauthorized');
  }
  if (Number(request.headers.get('content-length') ?? 0) > EDITOR_CLI_MAX_BODY_BYTES) return fail(413, 'body_too_large');
  const body = await readLimited(request.body, EDITOR_CLI_MAX_BODY_BYTES);
  if (body === null) return fail(413, 'body_too_large');

  const timestamp = String(Math.floor(deps.now() / 1000));
  const sandboxId = deps.sandboxId.toLowerCase();
  let upstream: Response;
  const started = deps.now();
  try {
    upstream = await deps.fetch(new Request(`${deps.osUrl}${EDITOR_CLI_OS_PATH}`, {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(EDITOR_CLI_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-ezil-sandbox': sandboxId,
        'x-ezil-timestamp': timestamp,
        'x-ezil-signature': await signEditorCli(deps.secret, timestamp, sandboxId, body),
      },
    }));
  } catch {
    deps.log({ event: 'ezil_editor_cli', sandbox: sandboxId, outcome: 'upstream_unreachable' });
    return fail(502, 'os_bridge_unreachable');
  }
  const reply = await readLimited(upstream.body, EDITOR_CLI_MAX_RESPONSE_BYTES);
  deps.log({ event: 'ezil_editor_cli', sandbox: sandboxId, status: upstream.status, ms: deps.now() - started });
  if (reply === null || (upstream.status >= 300 && upstream.status < 400)) return fail(502, 'os_bridge_bad_response');
  return new Response(reply, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** The Env fields this handler reads. `Env` in index.ts (extends `SandboxEnv`) satisfies it structurally. */
interface EditorCliEnv extends Pick<SandboxEnv, 'Sandbox'> {
  EZIL_OS_BRIDGE_URL?: string;
  EZIL_EDITOR_BRIDGE_ENVIRONMENT?: string;
  EZIL_EDITOR_BRIDGE_TARGETS?: string;
  SANDBOX_HMAC_SECRET?: string;
  CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string;
}

/**
 * Reads only this boot's editor-bridge nonce from the Sandbox DO's storage (never starts a
 * container), exactly as index.ts `openSandbox(...).getEditorBridgeNonce()` does. `normalizeId`
 * is REQUIRED so the DO key matches the lowercase preview-URL token; the container-lifecycle
 * options (`sleepAfter`/`keepAlive`) are irrelevant to a storage read and are deliberately not
 * duplicated here.
 */
async function editorBridgeNonce(env: EditorCliEnv, sandboxId: string): Promise<string | null> {
  // Dynamic so this module loads without the workerd-only SDK (as index.ts:8621 does for aws-restart);
  // the SDK is already in the bundle via index.ts, so this resolves the cached module.
  const { getSandbox } = await import('@cloudflare/sandbox');
  const stub = getSandbox(env.Sandbox, sandboxId, { normalizeId: true }) as unknown as { getEditorBridgeNonce(): Promise<string | null> };
  return stub.getEditorBridgeNonce();
}

/**
 * The lead's dispatch target on the Cloudflare code host (mirrors index.ts `handleEditorBridge`).
 * The CLI channel is Cloudflare only, so a defined `aws` (the AWS path) 404s.
 */
export async function handleEditorCli(request: Request, env: EditorCliEnv, sandboxId: string, aws?: unknown): Promise<Response> {
  if (aws !== undefined) return fail(404, 'not_found');
  const osUrl = resolveOsBridgeUrl(env.EZIL_OS_BRIDGE_URL, env.EZIL_EDITOR_BRIDGE_ENVIRONMENT);
  const nonce = osUrl && env.EZIL_EDITOR_BRIDGE_TARGETS ? await editorBridgeNonce(env, sandboxId) : null;
  return handleEditorCliRequest(request, {
    sandboxId,
    osUrl: !nonce ? null : osUrl,
    secret: resolveNekoDerivationSecret(env),
    nonce,
    fetch: (upstream) => fetch(upstream),
    now: () => Date.now(),
    log: (fields) => console.log(JSON.stringify(fields)),
  });
}

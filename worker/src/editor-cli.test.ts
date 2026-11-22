/**
 * Worker Chat CLI forward (`./editor-cli.ts`), driven through its DI core
 * `handleEditorCliRequest`: eligibility, the shared editor-bridge bearer,
 * method/query/size, the EXACT upstream URL/headers/signature bytes (with an
 * independent node:crypto oracle and the distinct editor-cli label proven
 * apart from the sync label), the unreachable path, and the relay bound.
 */
import { createHash, createHmac } from 'node:crypto';

import { afterEach, describe, expect, it } from 'bun:test';

import { deriveEditorBridgeToken, signEditorBridgeSync, type EditorBridgeDeps } from './editor-bridge';
import {
  EDITOR_CLI_MAX_BODY_BYTES,
  EDITOR_CLI_OS_PATH,
  EDITOR_CLI_PATH,
  EDITOR_CLI_TIMEOUT_MS,
  handleEditorCliRequest,
  signEditorCli,
} from './editor-cli';

const SECRET = 'worker-secret-for-tests-only';
const SANDBOX = 'guac-0123456789abcdef-fedcba9876543210';
const OTHER_SANDBOX = 'guac-1111111111111111-2222222222222222';
const NONCE = 'boot-nonce-one';
const OS_URL = 'https://os-staging.ezil.work';
const NOW_MS = 1_700_000_000_000;
const TS = '1700000000';

const bearer = async (nonce = NONCE, sandbox = SANDBOX) => `Bearer ${await deriveEditorBridgeToken(SECRET, sandbox, nonce)}`;

/** The label an OS CLI route verifies, computed independently of ./editor-cli.ts. */
const oracle = (secret: string, ts: string, sandbox: string, body: Uint8Array) =>
  `v1=${createHmac('sha256', secret).update(`editor-cli.v1.${ts}.${sandbox}.${createHash('sha256').update(body).digest('hex')}`).digest('hex')}`;

let captured: Request | undefined;
afterEach(() => { captured = undefined; });

const okFetch = (body = '{"ok":true,"result":{"sessions":[]}}', status = 200): EditorBridgeDeps['fetch'] =>
  async (req) => { captured = req; return new Response(body, { status, headers: { 'content-type': 'application/json' } }); };

const deps = (over: Partial<EditorBridgeDeps> = {}): EditorBridgeDeps => ({
  sandboxId: SANDBOX, osUrl: OS_URL, secret: SECRET, nonce: NONCE,
  fetch: okFetch(), now: () => NOW_MS, log: () => {}, ...over,
});

const req = async (opts: { method?: string; path?: string; query?: string; auth?: string | null; body?: string | null; headers?: Record<string, string> } = {}) => {
  const headers = new Headers(opts.headers);
  const auth = opts.auth === undefined ? await bearer() : opts.auth;
  if (auth !== null) headers.set('authorization', auth);
  return new Request(`https://8443-${SANDBOX}-code.example.org${opts.path ?? EDITOR_CLI_PATH}${opts.query ?? ''}`, {
    method: opts.method ?? 'POST', headers, body: opts.body === undefined ? '{"op":"chat.list","args":{},"requestId":"11111111-1111-4111-8111-111111111111"}' : opts.body,
  });
};
const status = async (r: Request, d?: EditorBridgeDeps) => (await handleEditorCliRequest(r, d ?? deps())).status;
const errorCode = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

describe('eligibility (Cloudflare pin + bridge target)', () => {
  it('404s when OS is not pinned or the target is unknown (osUrl null), without calling upstream', async () => {
    let called = false;
    const res = await handleEditorCliRequest(await req(), deps({ osUrl: null, fetch: async (r) => { called = true; captured = r; return new Response('{}'); } }));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(called).toBe(false);
  });

  it('503s when the Worker secret is absent (a positive control: present -> proceeds)', async () => {
    expect(await status(await req(), deps({ secret: null }))).toBe(503);
    expect(await status(await req(), deps({ secret: '' }))).toBe(503);
    expect(await status(await req())).toBe(200);
  });
});

describe('path, method and query', () => {
  it('only POST /editor-bridge/v1/cli with no query is accepted', async () => {
    expect(await status(await req({ path: '/editor-bridge/v1/sync' }))).toBe(404);
    expect(await status(await req({ path: '/editor-bridge/v1/cli/x' }))).toBe(404);
    expect(await status(await req({ query: '?x=1' }))).toBe(404);
    expect(await status(await req({ method: 'GET', body: null }))).toBe(405);
    expect(await status(await req({ method: 'PUT' }))).toBe(405);
    expect(await status(await req())).toBe(200);
  });
});

describe('the shared editor-bridge bearer', () => {
  it('accepts this boot\'s token and refuses a missing, wrong, other-boot or other-sandbox one', async () => {
    expect(await status(await req({ auth: null }))).toBe(401);
    expect(await status(await req({ auth: `Bearer ${'f'.repeat(64)}` }))).toBe(401);
    expect(await status(await req({ auth: 'not-bearer' }))).toBe(401);
    expect(await status(await req({ auth: await bearer('a-different-boot-nonce') }))).toBe(401);
    expect(await status(await req({ auth: await bearer(NONCE, OTHER_SANDBOX) }))).toBe(401);
    // A present-but-invalid bearer is 401, never a silent pass:
    const res = await handleEditorCliRequest(await req({ auth: `Bearer ${'0'.repeat(64)}` }), deps());
    expect(await errorCode(res)).toBe('os_bridge_unauthorized');
    expect(await status(await req())).toBe(200);
  });

  it('a null nonce (bridge not provisioned this boot) refuses every bearer', async () => {
    expect(await status(await req(), deps({ nonce: null }))).toBe(401);
  });
});

describe('body size', () => {
  it('413s a declared oversize body and an understated stream that overruns', async () => {
    expect(await status(await req({ headers: { 'content-length': String(EDITOR_CLI_MAX_BODY_BYTES + 1) } }))).toBe(413);
    // content-length says 0 but the stream is larger than the bound: readLimited still refuses it.
    const big = `{"op":"chat.send","args":{"sessionId":"x","text":"${'a'.repeat(EDITOR_CLI_MAX_BODY_BYTES)}"}}`;
    expect(await status(await req({ body: big, headers: { 'content-length': '0' } }))).toBe(413);
  });
});

describe('the forward to OS', () => {
  it('sends POST <os>/api/editor-bridge/v1/cli with the exact sandbox, timestamp and editor-cli signature, manual redirect, aborting signal', async () => {
    const bodyText = '{"op":"chat.list","args":{},"requestId":"11111111-1111-4111-8111-111111111111"}';
    const res = await handleEditorCliRequest(await req({ body: bodyText }), deps());
    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    expect(captured!.url).toBe(`${OS_URL}${EDITOR_CLI_OS_PATH}`);
    expect(captured!.method).toBe('POST');
    expect(captured!.redirect).toBe('manual');
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
    expect(EDITOR_CLI_TIMEOUT_MS).toBe(20_000);
    expect(captured!.headers.get('content-type')).toBe('application/json');
    expect(captured!.headers.get('x-ezil-sandbox')).toBe(SANDBOX);
    expect(captured!.headers.get('x-ezil-timestamp')).toBe(TS);

    const bytes = new TextEncoder().encode(bodyText);
    const sig = captured!.headers.get('x-ezil-signature')!;
    expect(sig).toBe(await signEditorCli(SECRET, TS, SANDBOX, bytes));
    expect(sig).toBe(oracle(SECRET, TS, SANDBOX, bytes));            // independent node:crypto oracle
    // The forwarded body is the bytes that were signed.
    expect(new Uint8Array(await captured!.arrayBuffer())).toEqual(bytes);
  });

  it('uses a label distinct from the sync, so a sync signature never equals the CLI one', async () => {
    const bytes = new TextEncoder().encode('{"op":"chat.list","args":{},"requestId":"11111111-1111-4111-8111-111111111111"}');
    const cli = await signEditorCli(SECRET, TS, SANDBOX, bytes);
    const sync = await signEditorBridgeSync(SECRET, TS, SANDBOX, bytes);     // editor-bridge.v1.<...>
    expect(cli).not.toBe(sync);
  });

  it('lowercases the sandbox it forwards', async () => {
    const mixed = SANDBOX.toUpperCase().replace('GUAC', 'guac');
    await handleEditorCliRequest(await req({ auth: await bearer(NONCE, mixed) }), deps({ sandboxId: mixed }));
    expect(captured!.headers.get('x-ezil-sandbox')).toBe(SANDBOX);
  });
});

describe('relaying OS back to the extension', () => {
  it('relays OS status and body verbatim with no-store, including an OS {ok:false}', async () => {
    const res = await handleEditorCliRequest(await req(), deps({ fetch: okFetch('{"ok":false,"error":"cli_unauthorized"}', 401) }));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"ok":false,"error":"cli_unauthorized"}');
  });

  it('502s an unreachable OS, a redirect, or a reply over the relay bound', async () => {
    expect(await status(await req(), deps({ fetch: async () => { throw new Error('network'); } }))).toBe(502);
    expect(await status(await req(), deps({ fetch: okFetch('', 302) }))).toBe(502);
    const huge = `{"ok":true,"result":"${'a'.repeat(64 * 1024 + 1)}"}`;
    expect(await status(await req(), deps({ fetch: okFetch(huge, 200) }))).toBe(502);
    const unreachable = await handleEditorCliRequest(await req(), deps({ fetch: async () => { throw new Error('network'); } }));
    expect(await errorCode(unreachable)).toBe('os_bridge_unreachable');
  });
});

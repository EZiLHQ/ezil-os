/**
 * `./ai-proxy.ts` against a mock gateway: route allow-list, header and body
 * passthrough, streaming without buffering, no retry, timeouts, credential
 * binding and the push signature. No network, no Workers runtime.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import {
  aiProxyBaseUrl,
  chooseAiCredential,
  deriveAiProxyToken,
  handleAiProxyRequest,
  isAiProxyPath,
  matchAiRoute,
  mintAiCredentialSignature,
  parsePushedAccessToken,
  resolveGatewayUrl,
  sandboxBelongsToUser,
  usableAiCredential,
  verifyAiCredentialSignature,
  verifyAiProxyBearer,
  type AiProxyDeps,
} from './ai-proxy';

const NONCE = 'boot-one';
const SECRET = 'ai-proxy-test-secret';
const USER_ID = 'abcdef01-2345-6789-abcd-ef0123456789';
const SANDBOX = 'guac-abcdef0123456789-fedcba9876543210';
const HOST = `https://8443-${SANDBOX}-code.ezil.org`;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'ES256', kid: 'k1', typ: 'JWT' })}.${b64url(claims)}.c2ln`;
}

const USER_JWT = jwt({ sub: USER_ID, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, app_metadata: { ezil_role: 'builder' } });

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function mockGateway(respond: (req: Request) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetch = async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: req.url, method: req.method, headers, body: new Uint8Array(await req.clone().arrayBuffer()) });
    return respond(req);
  };
  return { calls, fetch };
}

async function deps(overrides: Partial<AiProxyDeps> & Pick<AiProxyDeps, 'fetch'>): Promise<AiProxyDeps & { logs: Record<string, unknown>[]; dropped: string[] }> {
  const logs: Record<string, unknown>[] = [];
  const dropped: string[] = [];
  return {
    gatewayUrl: 'https://ai.ezil.work',
    sandboxId: SANDBOX,
    proxySecret: SECRET,
    proxyNonce: NONCE,
    credential: async () => USER_JWT,
    dropCredential: async (token) => {
      dropped.push(token);
    },
    log: (fields) => logs.push(fields),
    ...overrides,
    logs,
    dropped,
  };
}

async function proxyAuth(sandboxId = SANDBOX): Promise<string> {
  return `Bearer ${await deriveAiProxyToken(SECRET, sandboxId, NONCE)}`;
}

describe('route allow-list', () => {
  it('forwards exactly the five member routes', () => {
    expect(matchAiRoute('GET', '/ai/v1/requests/1b4e28ba-2fa1-11d2-883f-0016d3cca427')?.upstreamPath).toBe('/v1/requests/:id');
    expect(matchAiRoute('GET', '/ai/v1/models')?.upstreamPath).toBe('/v1/models');
    expect(matchAiRoute('POST', '/ai/v1/messages')?.upstreamPath).toBe('/v1/messages');
    expect(matchAiRoute('GET', '/ai/v1/me/balance')?.upstreamPath).toBe('/v1/me/balance');
    expect(matchAiRoute('GET', '/ai/v1/me/usage')?.upstreamPath).toBe('/v1/me/usage');
  });

  it('refuses admin, integrations, invalid request ids, other methods and lookalikes', () => {
    for (const [method, path] of [
      ['GET', '/ai/v1/admin/pending'],
      ['POST', '/ai/v1/admin/killswitch'],
      ['POST', '/ai/v1/admin/grants'],
      ['POST', '/ai/v1/integrations/entitlements'],
      ['GET', '/ai/v1/requests/not-a-uuid'],
      ['GET', '/ai/v1/requests/:id'],
      ['GET', '/ai/v1/requests/1b4e28ba-2fa1-11d2-883f-0016d3cca427/extra'],
      ['POST', '/ai/v1/responses'],
      ['GET', '/ai/v1/messages'],
      ['POST', '/ai/v1/models'],
      ['GET', '/ai/v1/models/'],
      ['GET', '/ai/v1//models'],
      ['GET', '/ai/v1/me/balance/../../admin/pending'],
      ['GET', '/ai/v1/%61dmin/pending'],
      ['GET', '/ai/health'],
      ['GET', '/v1/models'],
    ] as const) {
      expect(matchAiRoute(method, path)).toBeNull();
    }
  });

  it('owns every path under /ai on the code host and nothing else', () => {
    expect(isAiProxyPath('/ai')).toBe(true);
    expect(isAiProxyPath('/ai/v1/admin/pending')).toBe(true);
    expect(isAiProxyPath('/aiv1')).toBe(false);
    expect(isAiProxyPath('/preview/ai/v1/models')).toBe(false);
  });

  it('answers 404 for an unlisted route before any auth or upstream call', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const d = await deps({ fetch: gw.fetch });
    for (const path of ['/ai/v1/admin/pending', '/ai/v1/admin/killswitch', '/ai/v1/integrations/entitlements']) {
      const res = await handleAiProxyRequest(new Request(`${HOST}${path}`, { method: 'POST', headers: { authorization: await proxyAuth() } }), d);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
    // URL normalisation cannot smuggle a dot-segment past the table either.
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/me/../admin/pending`, { headers: { authorization: await proxyAuth() } }), d);
    expect(res.status).toBe(404);
    expect(gw.calls).toHaveLength(0);
  });
});

describe('proxy authentication', () => {
  it('derives a per-sandbox token and verifies it only for that sandbox', async () => {
    const token = await deriveAiProxyToken(SECRET, SANDBOX, NONCE);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveAiProxyToken(SECRET, SANDBOX.toUpperCase(), NONCE)).toBe(token);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, SECRET, SANDBOX, NONCE)).toBe(true);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, SECRET, 'guac-abcdef0123456789-0000000000000000', NONCE)).toBe(false);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, 'other-secret', SANDBOX, NONCE)).toBe(false);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, null, SANDBOX, NONCE)).toBe(false);
    expect(await verifyAiProxyBearer(token, SECRET, SANDBOX, NONCE)).toBe(false);
    expect(await verifyAiProxyBearer(null, SECRET, SANDBOX, NONCE)).toBe(false);
  });

  it('refuses a missing or wrong proxy token with 401 and never calls upstream', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const d = await deps({ fetch: gw.fetch });
    for (const authorization of [undefined, `Bearer ${USER_JWT}`, await proxyAuth('guac-abcdef0123456789-0000000000000000')]) {
      const res = await handleAiProxyRequest(
        new Request(`${HOST}/ai/v1/models`, { headers: authorization ? { authorization } : {} }),
        d,
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('os_proxy_unauthorized');
    }
    expect(gw.calls).toHaveLength(0);
  });

  it('fails closed (503) when no primary secret is configured', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`), await deps({ fetch: gw.fetch, proxySecret: null }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('os_ai_unavailable');
    expect(gw.calls).toHaveLength(0);
  });

  it('answers os_session_missing when no user token has been pushed yet', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }),
      await deps({ fetch: gw.fetch, credential: async () => null }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('os_session_missing');
    expect(gw.calls).toHaveLength(0);
  });
});

describe('forwarding', () => {
  it('sends only the user bearer, content-type and the client Idempotency-Key, with the body bytes unchanged', async () => {
    const gw = mockGateway(() => new Response('{"id":"resp_1"}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-ezil-request-id': 'req-1', 'x-ezil-hold-micro': '42', 'x-ezil-trace-id': 'trace-1', traceparent: '00-trace-parent', 'set-cookie': 'a=b', server: 'x' },
    }));
    const d = await deps({ fetch: gw.fetch });
    // Deliberately odd whitespace and key order: any re-serialisation would change these bytes.
    const raw = '{ "model":"ezil-code",  "input":"héllo", "stream":false }';
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: await proxyAuth(),
          'content-type': 'application/json',
          'idempotency-key': 'turn-0123456789',
          cookie: 'ezil_preview=secret',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'unsupported',
          'x-api-key': 'must-drop',
          forwarded: 'for=1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
          origin: 'https://evil.example',
          'x-ezil-user': 'someone-else',
        },
        body: raw,
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"resp_1"}');
    expect(res.headers.get('x-ezil-request-id')).toBe('req-1');
    expect(res.headers.get('x-ezil-hold-micro')).toBe('42');
    expect(res.headers.get('x-ezil-trace-id')).toBe('trace-1');
    expect(res.headers.get('traceparent')).toBe('00-trace-parent');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('server')).toBeNull();

    expect(gw.calls).toHaveLength(1);
    const call = gw.calls[0]!;
    expect(call.url).toBe('https://ai.ezil.work/v1/messages');
    expect(call.method).toBe('POST');
    for (const name of Object.keys(call.headers)) expect(['authorization', 'content-type', 'idempotency-key', 'content-length', 'anthropic-version']).toContain(name);
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers.origin).toBeUndefined();
    expect(call.headers.authorization).toBe(`Bearer ${USER_JWT}`);
    expect(call.headers['idempotency-key']).toBe('turn-0123456789');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(call.body)).toBe(raw);
  });

  it('forwards a malformed or missing Idempotency-Key as is (the gateway answers 400) and never mints one', async () => {
    const gw = mockGateway(() => new Response('{"error":{"code":"idempotency_key_required","message":"x","request_id":"r"}}', { status: 400, headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'r' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth() }, body: '{}' }),
      d,
    );
    expect(res.status).toBe(400);
    expect(gw.calls[0]!.headers['idempotency-key']).toBeUndefined();
    await res.text();
    expect(d.logs.at(-1)).toMatchObject({ status: 400, code: 'idempotency_key_required', request_id: 'r' });
  });

  it('passes only limit and before through to /v1/me/usage', async () => {
    const gw = mockGateway(() => new Response('{"object":"list","data":[]}', { headers: { 'content-type': 'application/json' } }));
    await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/me/usage?limit=5&before=2026-10-01T00%3A00%3A00Z&user=other`, { headers: { authorization: await proxyAuth() } }),
      await deps({ fetch: gw.fetch }),
    );
    const url = new URL(gw.calls[0]!.url);
    expect(url.pathname).toBe('/v1/me/usage');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('before')).toBe('2026-10-01T00:00:00Z');
    expect(url.searchParams.get('user')).toBeNull();
  });

  it('passes gateway errors through unchanged, with Retry-After and the request id', async () => {
    const body = '{"error":{"code":"rate_limited","message":"m","request_id":"req-9","limit":30,"window_seconds":60}}';
    const gw = mockGateway(() => new Response(body, { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60', 'x-ezil-request-id': 'req-9' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('x-ezil-request-id')).toBe('req-9');
    expect(await res.json()).toEqual({ error: { code: 'rate_limited', request_id: 'req-9' } });
    expect(d.logs.at(-1)).toMatchObject({ event: 'ai_proxy', route: 'POST /v1/messages', status: 429, code: 'rate_limited', request_id: 'req-9', idempotency_key: 'turn-0123456789' });
  });

  it('passes the credit-window refusal through with Retry-After, in one upstream call', async () => {
    const body = '{"error":{"code":"window_budget_reached","message":"m","request_id":"req-w"}}';
    const gw = mockGateway(() => new Response(body, { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '7200' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-window-0001' }, body: '{}' }),
      d,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7200');
    expect(await res.json()).toEqual({ error: { code: 'window_budget_reached', request_id: 'req-w' } });
    expect(gw.calls).toHaveLength(1);
  });

  it('does not retry a POST when the gateway is unreachable', async () => {
    let attempts = 0;
    const d = await deps({ fetch: async () => { attempts += 1; throw new TypeError('network down'); } });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(attempts).toBe(1);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('os_ai_unavailable');
  });

  it('answers 504 when upstream headers do not arrive in time, after one attempt', async () => {
    let attempts = 0;
    const d = await deps({
      headersTimeoutMs: 20,
      fetch: (req) => {
        attempts += 1;
        return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      },
    });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(attempts).toBe(1);
    expect(res.status).toBe(504);
  });

  it('retains a role-refused token and passes the Gateway reason through', async () => {
    const gw = mockGateway(() => new Response('{"error":{"code":"unauthorized","message":"m","reason":"no_ezil_role","request_id":"r"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), d);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('no_ezil_role');
    expect(d.dropped).toEqual([]);
  });

  it('refuses an oversized request body locally without calling upstream', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth() }, body: 'x'.repeat(160 * 1024 + 1) }),
      await deps({ fetch: gw.fetch }),
    );
    expect(res.status).toBe(413);
    expect(gw.calls).toHaveLength(0);
  });

  it('never logs the bearer, the proxy token or the body', async () => {
    const gw = mockGateway(() => new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{"input":"top secret prompt"}' }),
      d,
    );
    await res.text();
    const text = JSON.stringify(d.logs);
    expect(text).not.toContain(USER_JWT);
    expect(text).not.toContain(await deriveAiProxyToken(SECRET, SANDBOX, NONCE));
    expect(text).not.toContain('top secret prompt');
  });
});

describe('streaming', () => {
  const enc = new TextEncoder();

  it('streams SSE chunk by chunk before upstream finishes, and logs the terminal event', async () => {
    let push!: (s: string) => void;
    let close!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (s) => controller.enqueue(enc.encode(s));
        close = () => controller.close();
      },
    });
    const gw = mockGateway(() => new Response(upstreamBody, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-ezil-request-id': 'req-s', 'x-accel-buffering': 'no' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{"stream":true}' }),
      d,
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    push('event: message_start\ndata: {"type":"message_start"}\n\n');
    const first = await reader.read();
    // Received while upstream is still open: nothing is buffered to EOF.
    expect(dec.decode(first.value)).toContain('message_start');

    push('event: content_block_delta\ndata: {"delta":"hi"}\n\n');
    expect(dec.decode((await reader.read()).value)).toContain('"hi"');

    push('event: message_');
    push('stop\ndata: {"type":"message_stop"}\n\n');
    close();
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += dec.decode(r.value);
    expect(rest).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(d.logs.at(-1)).toMatchObject({ status: 200, request_id: 'req-s', stream: true, outcome: 'eof', terminal: 'message_stop' });
  });

  it('passes the gateway error event through byte for byte', async () => {
    const tail = 'event: error\ndata: {"type":"error","error":{"code":"stream_interrupted"},"message":"m","request_id":"req-e"}\n\n';
    const gw = mockGateway(() => new Response(tail, { headers: { 'content-type': 'text/event-stream' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(await res.text()).toBe(tail);
    expect(d.logs.at(-1)).toMatchObject({ terminal: 'error', code: 'stream_interrupted' });
  });

  it('errors the stream after the idle deadline and cancels upstream', async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: message_start\ndata: {}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gw = mockGateway(() => new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }));
    const d = await deps({ fetch: gw.fetch, idleTimeoutMs: 20 });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    const reader = res.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow('idle');
    expect(cancelled).toBe(true);
    expect(d.logs.at(-1)).toMatchObject({ outcome: 'idle_timeout' });
  });

  it('cancels upstream when the client goes away', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: message_start\ndata: {}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gw = mockGateway((req) => { upstreamSignal = req.signal; return new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }); });
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(d.logs.at(-1)).toMatchObject({ outcome: 'client_cancelled' });
  });
});

describe('pushed credential', () => {
  const now = Date.now();

  it('binds the token to the sandbox owner and requires a live authenticated token', () => {
    expect(parsePushedAccessToken(USER_JWT, SANDBOX, now).ok).toBe(true);
    expect(parsePushedAccessToken(USER_JWT, 'guac-0000000000000000-fedcba9876543210', now)).toEqual({ ok: false, error: 'access_token_wrong_user' });
    expect(parsePushedAccessToken(jwt({ sub: USER_ID, role: 'anon', exp: now / 1000 + 3600 }), SANDBOX, now)).toEqual({ ok: false, error: 'access_token_not_authenticated' });
    expect(parsePushedAccessToken(jwt({ sub: USER_ID, role: 'authenticated', exp: now / 1000 + 10 }), SANDBOX, now)).toEqual({ ok: false, error: 'access_token_expired' });
    expect(parsePushedAccessToken(jwt({ sub: 'not-a-uuid', role: 'authenticated', exp: now / 1000 + 3600 }), SANDBOX, now).ok).toBe(false);
    expect(parsePushedAccessToken('a.b', SANDBOX, now).ok).toBe(false);
    expect(parsePushedAccessToken(42, SANDBOX, now).ok).toBe(false);
  });

  it('matches deriveSandboxId (first 16 alphanumerics of the user id)', () => {
    expect(sandboxBelongsToUser(SANDBOX, USER_ID)).toBe(true);
    expect(sandboxBelongsToUser(SANDBOX.toUpperCase(), USER_ID)).toBe(true);
    expect(sandboxBelongsToUser('guac-abcdef0123456789x-1', USER_ID)).toBe(false);
  });

  it('keeps the later-expiring token, so a replayed older push cannot roll it back', () => {
    const a = { token: 'a', expiresAt: now + 1000 };
    const b = { token: 'b', expiresAt: now + 2000 };
    expect(chooseAiCredential(undefined, a)).toEqual({ keep: a, stored: true });
    expect(chooseAiCredential(a, b)).toEqual({ keep: b, stored: true });
    expect(chooseAiCredential(b, a)).toEqual({ keep: b, stored: false });
    expect(chooseAiCredential(a, a)).toEqual({ keep: a, stored: true });
  });

  it('stops using a token 30 s before it expires', () => {
    expect(usableAiCredential({ token: 't', expiresAt: now + 31_000 }, now)).toBe('t');
    expect(usableAiCredential({ token: 't', expiresAt: now + 29_000 }, now)).toBeNull();
    expect(usableAiCredential(undefined, now)).toBeNull();
  });

  it('orders pushes by signed time even for the same JWT, and makes exact replays idempotent', () => {
    const current = { token: 'current', expiresAt: now + 2000, signedAt: now };
    for (const incoming of [
      { token: 'older', expiresAt: now + 3000, signedAt: now - 1 },
      { ...current, signedAt: now - 1 },
      { ...current, token: 'different', expiresAt: now + 3000 },
    ]) {
      expect(chooseAiCredential(current, incoming)).toEqual({ keep: current, stored: false });
    }
    expect(chooseAiCredential(current, { ...current })).toEqual({ keep: current, stored: true });
    expect(chooseAiCredential(current, { ...current }).keep).toBe(current);
    const newer = { ...current, signedAt: now + 1 };
    expect(chooseAiCredential(current, newer)).toEqual({ keep: newer, stored: true });
  });

  it('verifies the push signature over sandbox id and body bytes', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ accessToken: USER_JWT }));
    const sig = await mintAiCredentialSignature(SECRET, SANDBOX, body, now);
    expect(await verifyAiCredentialSignature(sig, [SECRET], SANDBOX, body, now)).toEqual({ ok: true, timestamp: now });
    expect(await verifyAiCredentialSignature(sig, ['other', SECRET], SANDBOX, body, now)).toEqual({ ok: true, timestamp: now });
    expect((await verifyAiCredentialSignature(sig, [SECRET], 'guac-abcdef0123456789-0000000000000000', body, now)).ok).toBe(false);
    expect((await verifyAiCredentialSignature(sig, [SECRET], SANDBOX, new TextEncoder().encode('{"accessToken":"x"}'), now)).ok).toBe(false);
    expect((await verifyAiCredentialSignature(sig, [SECRET], SANDBOX, body, now + 6 * 60_000)).ok).toBe(false);
    expect(await verifyAiCredentialSignature(sig, [], SANDBOX, body, now)).toEqual({ ok: false, error: 'ai_proxy_not_configured' });
    expect((await verifyAiCredentialSignature(null, [SECRET], SANDBOX, body, now)).ok).toBe(false);
  });
});

describe('configuration', () => {
  it('defaults to ai.ezil.work and refuses non-https gateways', () => {
    expect(resolveGatewayUrl(undefined)).toBe('https://ai.ezil.work');
    expect(resolveGatewayUrl(' https://ai.ezil.work/ ')).toBe('https://ai.ezil.work');
    expect(resolveGatewayUrl('http://localhost:8788')).toBe('http://localhost:8788');
    expect(() => resolveGatewayUrl('http://ai.ezil.work')).toThrow();
  });

  it('builds the base URL the SDK uses for the code bridge host', () => {
    expect(aiProxyBaseUrl('ezil.org', 'Guac-ABC-def', 8443, 'code')).toBe('https://8443-guac-abc-def-code.ezil.org/ai/v1');
    expect(aiProxyBaseUrl('localhost:8787', 'guac-a-b', 8443, 'code')).toBe('http://8443-guac-a-b-code.localhost:8787/ai/v1');
  });
});

describe('v2 guards', () => {
  it('refuses a previous boot token and a missing nonce', async () => {
    const gw = mockGateway(() => new Response('{}'));
    for (const proxyNonce of ['boot-two', null]) {
      const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, {
        headers: { authorization: await proxyAuth() },
      }), await deps({ fetch: gw.fetch, proxyNonce }));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: 'os_proxy_unauthorized' } });
    }
    expect(gw.calls).toHaveLength(0);
  });

  it('implements the off/on kill switch without reaching upstream while off', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const off = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`), await deps({ fetch: gw.fetch, enabled: 'off' }));
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: { code: 'os_ai_unavailable', source: 'ezil-os-proxy' } });
    const on = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), await deps({ fetch: gw.fetch, enabled: 'on' }));
    expect(on.status).toBe(200);
    await on.text();
    expect(gw.calls).toHaveLength(1);
  });

  it('polls only a validated id, dropping all polling query parameters', async () => {
    const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
    const gw = mockGateway(() => new Response('{}'));
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/requests/${id}?path=/v1/admin/pending`, { headers: { authorization: await proxyAuth() } }), await deps({ fetch: gw.fetch }));
    await res.text();
    expect(gw.calls[0]!.url).toBe(`https://ai.ezil.work/v1/requests/${id}`);
  });

  it('lets the gateway 413 win up to the inclusive 160 KiB local ceiling', async () => {
    const raw = 'x'.repeat(160 * 1024);
    const gw = mockGateway(() => new Response('{"error":{"code":"input_too_large"}}', { status: 413, headers: { 'x-ezil-request-id': 'size-id' } }));
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth() }, body: raw }), await deps({ fetch: gw.fetch }));
    expect(res.status).toBe(413);
    expect(res.headers.get('x-ezil-request-id')).toBe('size-id');
    expect(await res.json()).toMatchObject({ error: { code: 'input_too_large' } });
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]!.body.byteLength).toBe(raw.length);
  });

  it('binds DELETE signatures to method as well as path and empty body', async () => {
    const now = Date.now();
    const body = new Uint8Array();
    const signature = await mintAiCredentialSignature(SECRET, SANDBOX, body, now, 'DELETE');
    expect(await verifyAiCredentialSignature(signature, [SECRET], SANDBOX, body, now, 'DELETE')).toEqual({ ok: true, timestamp: now });
    expect((await verifyAiCredentialSignature(signature, [SECRET], SANDBOX, body, now, 'POST')).ok).toBe(false);
    expect((await verifyAiCredentialSignature(signature, [SECRET], 'other', body, now, 'DELETE')).ok).toBe(false);
  });

  it('propagates a client disconnect while awaiting upstream headers, without retry', async () => {
    const client = new AbortController();
    let signal: AbortSignal | undefined;
    const d = await deps({ fetch: async (req) => {
      signal = req.signal;
      client.abort();
      throw new DOMException('aborted', 'AbortError');
    } });
    await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { signal: client.signal, headers: { authorization: await proxyAuth() } }), d);
    expect(signal?.aborted).toBe(true);
  });

  it('limits error bodies while preserving status', async () => {
    const raw = 'x'.repeat(70 * 1024);
    const gw = mockGateway(() => new Response(raw, { status: 502 }));
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), await deps({ fetch: gw.fetch }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'gateway_error' } });
  });
});

describe('Gateway refusal identity', () => {
  for (const reason of ['wrong_issuer', 'bad_signature', 'no_ezil_role', 'expired', 'token_expired']) {
    it(`passes allow-listed ${reason} unchanged without leaking tokens or retrying`, async () => {
      const gw = mockGateway(() => Response.json({ error: { code: 'unauthorized', reason, message: USER_JWT, token: USER_JWT } }, { status: 401 }));
      const d = await deps({ fetch: gw.fetch });
      const req = () => new Request(`${HOST}/ai/v1/models`, { headers: { authorization: '' } });
      for (let i = 0; i < 2; i++) {
        const request = req(); request.headers.set('authorization', await proxyAuth());
        const response = await handleAiProxyRequest(request, d);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { code: 'unauthorized', reason } });
      }
      expect(gw.calls).toHaveLength(2);
      expect(d.dropped).toHaveLength(reason === 'expired' || reason === 'token_expired' ? 2 : 0);
      expect(JSON.stringify(d.logs)).not.toContain(USER_JWT);
    });
  }
  it('drops unrecognized code, reason and arbitrary error fields', async () => {
    const gw = mockGateway(() => Response.json({ error: { code: USER_JWT, reason: USER_JWT, message: USER_JWT } }, { status: 403 }));
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), await deps({ fetch: gw.fetch }));
    expect(await response.json()).toEqual({ error: { code: 'gateway_error' } });
    expect(gw.calls).toHaveLength(1);
  });
  it('passes insufficient credits and safe numeric metadata unchanged', async () => {
    const gw = mockGateway(() => Response.json({ error: { code: 'insufficient_credits', available_micro: 42, no_live_grant: true } }, { status: 402 }));
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), await deps({ fetch: gw.fetch }));
    expect(await response.json()).toEqual({ error: { code: 'insufficient_credits', available_micro: 42, no_live_grant: true } });
  });
});

describe('production timeout budgets with fake timers', () => {
  it('default header deadline aborts at 30 seconds with no retry', async () => {
    let fire!: () => void;
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    let attempts = 0;
    const d = await deps({ fetch: request => {
      attempts++;
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
        ready();
      });
    } });
    const request = new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } });
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(30_000); fire = callback; return 0;
    }) as typeof setTimeout);
    try {
      const result = handleAiProxyRequest(request, d);
      await entered; fire();
      expect((await result).status).toBe(504); expect(attempts).toBe(1);
    } finally { timer.mockRestore(); }
  });
  it('default stream idle deadline aborts at 30 seconds', async () => {
    let cancelled = false;
    const d = await deps({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), d);
    let fire!: () => void;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(30_000); fire = callback; return 0;
    }) as typeof setTimeout);
    try {
      const result = response.body!.getReader().read().catch(error => error);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      fire();
      expect((await result).message).toContain('idle timeout'); expect(cancelled).toBe(true);
    } finally { timer.mockRestore(); }
  });
});

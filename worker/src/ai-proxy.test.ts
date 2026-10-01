/**
 * `./ai-proxy.ts` against a mock gateway: route allow-list, header and body
 * passthrough, streaming without buffering, no retry, timeouts, credential
 * binding and the push signature. No network, no Workers runtime.
 */

import { describe, expect, it } from 'bun:test';
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
  return `Bearer ${await deriveAiProxyToken(SECRET, sandboxId)}`;
}

describe('route allow-list', () => {
  it('forwards exactly the four member routes', () => {
    expect(matchAiRoute('GET', '/ai/v1/models')?.upstreamPath).toBe('/v1/models');
    expect(matchAiRoute('POST', '/ai/v1/responses')?.upstreamPath).toBe('/v1/responses');
    expect(matchAiRoute('GET', '/ai/v1/me/balance')?.upstreamPath).toBe('/v1/me/balance');
    expect(matchAiRoute('GET', '/ai/v1/me/usage')?.upstreamPath).toBe('/v1/me/usage');
  });

  it('refuses admin, integrations, requests, other methods and lookalikes', () => {
    for (const [method, path] of [
      ['GET', '/ai/v1/admin/pending'],
      ['POST', '/ai/v1/admin/killswitch'],
      ['POST', '/ai/v1/admin/grants'],
      ['POST', '/ai/v1/integrations/entitlements'],
      ['GET', '/ai/v1/requests/1b4e28ba-2fa1-11d2-883f-0016d3cca427'],
      ['GET', '/ai/v1/responses'],
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
    const token = await deriveAiProxyToken(SECRET, SANDBOX);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveAiProxyToken(SECRET, SANDBOX.toUpperCase())).toBe(token);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, SECRET, SANDBOX)).toBe(true);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, SECRET, 'guac-abcdef0123456789-0000000000000000')).toBe(false);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, 'other-secret', SANDBOX)).toBe(false);
    expect(await verifyAiProxyBearer(`Bearer ${token}`, null, SANDBOX)).toBe(false);
    expect(await verifyAiProxyBearer(token, SECRET, SANDBOX)).toBe(false);
    expect(await verifyAiProxyBearer(null, SECRET, SANDBOX)).toBe(false);
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
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-ezil-request-id': 'req-1', 'x-ezil-hold-micro': '42', 'set-cookie': 'a=b', server: 'x' },
    }));
    const d = await deps({ fetch: gw.fetch });
    // Deliberately odd whitespace and key order: any re-serialisation would change these bytes.
    const raw = '{ "model":"ezil-code",  "input":"héllo", "stream":false }';
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: await proxyAuth(),
          'content-type': 'application/json',
          'idempotency-key': 'turn-0123456789',
          cookie: 'ezil_preview=secret',
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
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('server')).toBeNull();

    expect(gw.calls).toHaveLength(1);
    const call = gw.calls[0]!;
    expect(call.url).toBe('https://ai.ezil.work/v1/responses');
    expect(call.method).toBe('POST');
    for (const name of Object.keys(call.headers)) expect(['authorization', 'content-type', 'idempotency-key', 'content-length']).toContain(name);
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers.origin).toBeUndefined();
    expect(call.headers.authorization).toBe(`Bearer ${USER_JWT}`);
    expect(call.headers['idempotency-key']).toBe('turn-0123456789');
    expect(new TextDecoder().decode(call.body)).toBe(raw);
  });

  it('forwards a malformed or missing Idempotency-Key as is (the gateway answers 400) and never mints one', async () => {
    const gw = mockGateway(() => new Response('{"error":{"code":"idempotency_key_required","message":"x","request_id":"r"}}', { status: 400, headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'r' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth() }, body: '{}' }),
      d,
    );
    expect(res.status).toBe(400);
    expect(gw.calls[0]!.headers['idempotency-key']).toBeUndefined();
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
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('x-ezil-request-id')).toBe('req-9');
    expect(await res.text()).toBe(body);
    expect(d.logs.at(-1)).toMatchObject({ event: 'ai_proxy', route: 'POST /v1/responses', status: 429, code: 'rate_limited', request_id: 'req-9', idempotency_key: 'turn-0123456789' });
  });

  it('does not retry a POST when the gateway is unreachable', async () => {
    let attempts = 0;
    const d = await deps({ fetch: async () => { attempts += 1; throw new TypeError('network down'); } });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
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
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(attempts).toBe(1);
    expect(res.status).toBe(504);
  });

  it('drops the stored token after a gateway 401 and passes the 401 through', async () => {
    const gw = mockGateway(() => new Response('{"error":{"code":"unauthorized","message":"m","reason":"no_ezil_role","request_id":"r"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), d);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe('no_ezil_role');
    expect(d.dropped).toEqual([USER_JWT]);
  });

  it('refuses an oversized request body locally without calling upstream', async () => {
    const gw = mockGateway(() => new Response('{}'));
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth() }, body: 'x'.repeat(1024 * 1024 + 1) }),
      await deps({ fetch: gw.fetch }),
    );
    expect(res.status).toBe(413);
    expect(gw.calls).toHaveLength(0);
  });

  it('never logs the bearer, the proxy token or the body', async () => {
    const gw = mockGateway(() => new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{"input":"top secret prompt"}' }),
      d,
    );
    await res.text();
    const text = JSON.stringify(d.logs);
    expect(text).not.toContain(USER_JWT);
    expect(text).not.toContain(await deriveAiProxyToken(SECRET, SANDBOX));
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
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{"stream":true}' }),
      d,
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    push('event: response.created\ndata: {"type":"response.created"}\n\n');
    const first = await reader.read();
    // Received while upstream is still open: nothing is buffered to EOF.
    expect(dec.decode(first.value)).toContain('response.created');

    push('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n');
    expect(dec.decode((await reader.read()).value)).toContain('"hi"');

    push('event: response.comp');
    push('leted\ndata: {"type":"response.completed"}\n\n');
    close();
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += dec.decode(r.value);
    expect(rest).toBe('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    expect(d.logs.at(-1)).toMatchObject({ status: 200, request_id: 'req-s', stream: true, outcome: 'eof', terminal: 'response.completed' });
  });

  it('passes the gateway error event through byte for byte', async () => {
    const tail = 'event: error\ndata: {"type":"error","code":"stream_interrupted","message":"m","request_id":"req-e"}\n\n';
    const gw = mockGateway(() => new Response(tail, { headers: { 'content-type': 'text/event-stream' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    expect(await res.text()).toBe(tail);
    expect(d.logs.at(-1)).toMatchObject({ terminal: 'error' });
  });

  it('errors the stream after the idle deadline and cancels upstream', async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: response.created\ndata: {}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gw = mockGateway(() => new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }));
    const d = await deps({ fetch: gw.fetch, idleTimeoutMs: 20 });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    const reader = res.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow('idle');
    expect(cancelled).toBe(true);
    expect(d.logs.at(-1)).toMatchObject({ outcome: 'idle_timeout' });
  });

  it('cancels upstream when the client goes away', async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: response.created\ndata: {}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gw = mockGateway(() => new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } }));
    const d = await deps({ fetch: gw.fetch });
    const res = await handleAiProxyRequest(
      new Request(`${HOST}/ai/v1/responses`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-0123456789' }, body: '{}' }),
      d,
    );
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
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

  it('verifies the push signature over sandbox id and body bytes', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ accessToken: USER_JWT }));
    const sig = await mintAiCredentialSignature(SECRET, SANDBOX, body, now);
    expect(await verifyAiCredentialSignature(sig, [SECRET], SANDBOX, body, now)).toEqual({ ok: true });
    expect(await verifyAiCredentialSignature(sig, ['other', SECRET], SANDBOX, body, now)).toEqual({ ok: true });
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

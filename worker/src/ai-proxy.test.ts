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
  exactCacheEligible,
  exactCacheScope,
  AI_PROXY_COMPLETION_TIMEOUT_MS,
  AI_PROXY_HEADERS_TIMEOUT_MS,
  handleAiProxyRequest,
  isAiProxyPath,
  isNonStreamBody,
  matchAiRoute,
  mintAiCredentialSignature,
  parsePushedAccessToken,
  parsePushedModelAccess,
  requestModel,
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
  it('forwards exactly the seven member routes', () => {
    expect(matchAiRoute('GET', '/ai/v1/requests/1b4e28ba-2fa1-11d2-883f-0016d3cca427')?.upstreamPath).toBe('/v1/requests/:id');
    expect(matchAiRoute('GET', '/ai/v1/models')?.upstreamPath).toBe('/v1/models');
    expect(matchAiRoute('POST', '/ai/v1/messages')?.upstreamPath).toBe('/v1/messages');
    expect(matchAiRoute('POST', '/ai/v1/responses')).toEqual({ method: 'POST', upstreamPath: '/v1/responses', query: [], label: 'POST /v1/responses' });
    expect(matchAiRoute('GET', '/ai/v1/me/balance')?.upstreamPath).toBe('/v1/me/balance');
    expect(matchAiRoute('GET', '/ai/v1/me/limits')).toEqual({ method: 'GET', upstreamPath: '/v1/me/limits', query: [], label: 'GET /v1/me/limits' });
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
      ['GET', '/ai/v1/responses'],
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

  it('refuses Responses methods and lookalikes before credentials or upstream', async () => {
    const gw = mockGateway(() => Response.json({}));
    let credentialReads = 0;
    const d = await deps({ fetch: gw.fetch, credential: async () => { credentialReads++; return USER_JWT; } });
    const denied = [
      ...['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(method => [method, '/ai/v1/responses']),
      ...['/ai/v1/responses/', '/ai/v1/responses/extra', '/ai/v1/responses-other', '/ai/v1//responses',
        '/ai/v1/%72esponses', '/ai/v1/responses%2f', '/ai/v1/Responses', '/ai/responses'].map(path => ['POST', path]),
    ];
    for (const [method, path] of denied) {
      expect(matchAiRoute(method!, path!)).toBeNull();
      const response = await handleAiProxyRequest(new Request(`${HOST}${path}`, { method }), d);
      expect(response.status).toBe(404);
      await response.text();
    }
    expect(credentialReads).toBe(0);
    expect(gw.calls).toHaveLength(0);
  });

  it('allows only exact GET limits, refusing mutations and lookalikes before credentials or upstream', async () => {
    const gw = mockGateway(() => Response.json({}));
    let credentialReads = 0;
    const d = await deps({ fetch: gw.fetch, credential: async () => { credentialReads++; return USER_JWT; } });
    const denied = [
      ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(method => [method, '/ai/v1/me/limits']),
      ...['/ai/v1/me/limits/', '/ai/v1/me/limits/extra', '/ai/v1/me/limits-other', '/ai/v1/me//limits',
        '/ai/v1/me/%6cimits', '/ai/v1/me/limits%2f', '/ai/v1/me/limits/../admin', '/ai/v1/admin/limits',
        '/ai/v1/me/consumer-limits', '/ai/v1/me/Limits'].map(path => ['GET', path]),
    ];
    for (const [method, path] of denied) {
      expect(matchAiRoute(method!, path!)).toBeNull();
      const response = await handleAiProxyRequest(new Request(`${HOST}${path}`, { method }), d);
      expect(response.status).toBe(404);
      await response.text();
    }
    expect(credentialReads).toBe(0);
    expect(gw.calls).toHaveLength(0);
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
  it('forwards Responses once with exact body bytes, the original stored bearer and existing header allow-list', async () => {
    const raw = '{ "model":"azure-ready", "input":"private prompt", "stream":false, "store":false }';
    const gw = mockGateway(() => Response.json({ id: 'resp-1', status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 3 } }));
    const d = await deps({ fetch: gw.fetch });
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/responses?api-version=evil&model=other&path=/v1/admin`, {
      method: 'POST', body: raw, headers: {
        authorization: await proxyAuth(), 'content-type': 'application/json', 'idempotency-key': 'turn-responses',
        'anthropic-version': '2023-06-01', 'api-key': 'private', 'x-api-key': 'private', cookie: 'private',
        'openai-organization': 'private', 'x-ezil-user-id': 'other', 'anthropic-beta': 'private',
      },
    }), d);
    await response.text();
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]).toEqual({ url: 'https://ai.ezil.work/v1/responses', method: 'POST',
      headers: { authorization: `Bearer ${USER_JWT}`, 'content-type': 'application/json', 'idempotency-key': 'turn-responses', 'anthropic-version': '2023-06-01' },
      body: new TextEncoder().encode(raw) });
    expect(d.logs.at(-1)).toMatchObject({ route: 'POST /v1/responses', terminal: 'response.completed', usage: { input_tokens: 8, output_tokens: 3 } });
    expect(JSON.stringify(d.logs)).not.toContain('private');
    expect(JSON.stringify(d.logs)).not.toContain(USER_JWT);
    expect(d.dropped).toEqual([]);
  });

  it('retains the original credential across all four status reads after configuration refusal', async () => {
    const gw = mockGateway(() => Response.json({ error: { code: 'unauthorized', reason: 'wrong_issuer' } }, { status: 401 }));
    const d = await deps({ fetch: gw.fetch });
    for (const path of ['/me/balance', '/me/usage?limit=5', '/me/limits', '/models']) {
      const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1${path}`, { headers: { authorization: await proxyAuth() } }), d);
      expect(await response.json()).toEqual({ error: { code: 'unauthorized', reason: 'wrong_issuer' } });
    }
    expect(gw.calls).toHaveLength(4);
    expect(gw.calls.map(call => call.headers.authorization)).toEqual(Array(4).fill(`Bearer ${USER_JWT}`));
    expect(d.dropped).toEqual([]);
  });

  it('preserves sanitized Responses HTTP refusal codes without interpreting them as response objects', async () => {
    for (const [status, code, reason] of [[400, 'unsupported_parameter', undefined], [401, 'unauthorized', 'wrong_issuer'], [402, 'insufficient_credits', undefined]] as const) {
      const error = { code, ...(reason ? { reason } : {}) };
      const gw = mockGateway(() => Response.json({ error: { ...error, message: USER_JWT, token: 'private' } }, {
        status, headers: { 'x-ezil-request-id': 'refusal-1', 'retry-after': '17' },
      }));
      const d = await deps({ fetch: gw.fetch });
      const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/responses`, {
        method: 'POST', body: '{"input":"private"}', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-refusal' },
      }), d);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(response.headers.get('x-ezil-request-id')).toBe('refusal-1');
      expect(response.headers.get('retry-after')).toBe('17');
      expect(d.logs.at(-1)).toMatchObject({ status, code, reason: reason ?? null, request_id: 'refusal-1', route: 'POST /v1/responses' });
      expect(d.logs.at(-1)).not.toHaveProperty('terminal');
      expect(JSON.stringify(d.logs)).not.toContain(USER_JWT);
      expect(JSON.stringify(d.logs)).not.toContain('private');
      expect(d.dropped).toEqual([]);
      expect(gw.calls).toHaveLength(1);
    }
  });

  it('relays the Gemini adapter refusal code on Messages, never its message (it names a schema keyword)', async () => {
    const gw = mockGateway(() => Response.json({ type: 'error', error: { type: 'invalid_request_error', code: 'unsupported_gemini_request',
      message: 'Tool input_schema keyword "pattern" is not supported by Gemini (refused, not dropped).', request_id: 'gem-refusal-1' } }, {
      status: 400, headers: { 'x-ezil-request-id': 'gem-refusal-1' },
    }));
    const d = await deps({ fetch: gw.fetch });
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/messages`, {
      method: 'POST', body: '{"model":"gemini-3.8-flash"}', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-gemini' },
    }), d);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'unsupported_gemini_request', request_id: 'gem-refusal-1' } });
    expect(d.logs.at(-1)).toMatchObject({ status: 400, code: 'unsupported_gemini_request', request_id: 'gem-refusal-1' });
    expect(JSON.stringify(d.logs)).not.toContain('pattern');
  });

  it('forwards member limits once with the stored bearer, dropping all caller queries and private headers', async () => {
    const body = '{"policy":{"policy":{"rpm":3},"sources":{"rpm":"user"}},"ceilings":{"rpm":60,"concurrency":2}}';
    const gw = mockGateway(() => new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
    const d = await deps({ fetch: gw.fetch });
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/me/limits?user=other&account=other&model=other&limit=5&before=now`, {
      headers: { authorization: await proxyAuth(), cookie: 'session=private', 'x-api-key': 'private' },
    }), d);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]).toMatchObject({ url: 'https://ai.ezil.work/v1/me/limits', method: 'GET', headers: { authorization: `Bearer ${USER_JWT}` } });
    expect(gw.calls[0]!.body.byteLength).toBe(0);
    expect(gw.calls[0]!.headers.cookie).toBeUndefined();
    expect(gw.calls[0]!.headers['x-api-key']).toBeUndefined();
    expect(d.logs.at(-1)).toMatchObject({ route: 'GET /v1/me/limits', status: 200 });
    expect(JSON.stringify(d.logs)).not.toContain(USER_JWT);
    expect(JSON.stringify(d.logs)).not.toContain(body);

    const unauthorized = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/me/limits`), d);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { code: 'os_proxy_unauthorized' } });
    const missing = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/me/limits`, { headers: { authorization: await proxyAuth() } }),
      await deps({ fetch: gw.fetch, credential: async () => null }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: 'os_session_missing' } });
    expect(gw.calls).toHaveLength(1);
  });

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

  it('passes routing and entitlement refusals through by code, so the editor can re-list', async () => {
    for (const [status, code] of [[503, 'model_unavailable'], [402, 'no_entitlement'], [403, 'model_not_allowed'],
      [502, 'upstream_error'], [502, 'upstream_unavailable']] as const) {
      const gw = mockGateway(() => Response.json({ error: { code, message: USER_JWT, request_id: 'req-r', attempts: 2 } }, { status }));
      const d = await deps({ fetch: gw.fetch });
      const res = await handleAiProxyRequest(
        new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth(), 'idempotency-key': 'turn-route-0001' }, body: '{}' }),
        d,
      );
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: { code, request_id: 'req-r' } });
      expect(gw.calls).toHaveLength(1);
    }
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

describe('Responses terminal telemetry', () => {
  const enc = new TextEncoder();
  const terminal = (status: string, usage: unknown = { input_tokens: 11, output_tokens: 7, total_tokens: 18 }) => ({
    type: `response.${status}`, response: { id: 'resp-1', status, output: [{ type: 'message', content: [{ type: 'output_text', text: 'private output' }] }], usage },
  });
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  async function request(body: BodyInit, sse = true) {
    const gw = mockGateway(() => new Response(body, { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } }));
    const d = await deps({ fetch: gw.fetch });
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/responses`, {
      method: 'POST', headers: { authorization: await proxyAuth() }, body: '{"stream":true,"store":false}',
    }), d);
    return { response, d, gw };
  }

  for (const status of ['completed', 'incomplete', 'failed']) {
    it(`observes ${status} JSON and complete SSE terminals without computing cost`, async () => {
      for (const sse of [true, false]) {
        const value = terminal(status);
        const raw = sse ? event(value) : JSON.stringify(value.response);
        const { response, d, gw } = await request(raw, sse);
        expect(await response.text()).toBe(raw);
        expect(d.logs.at(-1)).toMatchObject({ outcome: 'eof', terminal: `response.${status}`, usage: { input_tokens: 11, output_tokens: 7 } });
        expect(d.logs.at(-1)).not.toHaveProperty('cost');
        expect(JSON.stringify(d.logs)).not.toContain('private output');
        expect(gw.calls).toHaveLength(1);
      }
    });
  }

  it('streams deltas immediately and assembles a terminal split across arbitrary byte boundaries', async () => {
    let push!: (text: string) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      push = text => controller.enqueue(enc.encode(text)); close = () => controller.close();
    } });
    const { response, d, gw } = await request(body);
    const reader = response.body!.getReader();
    const delta = event({ type: 'response.output_text.delta', delta: 'hi' });
    push(delta);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(delta);
    expect(d.logs).toHaveLength(0);
    const raw = `event: response.completed\r\ndata: ${JSON.stringify(terminal('completed'))}\r\n\r\n`;
    for (let i = 0; i < raw.length; i += 3) push(raw.slice(i, i + 3));
    close();
    let tail = '';
    for (let next = await reader.read(); !next.done; next = await reader.read()) tail += new TextDecoder().decode(next.value);
    expect(tail).toBe(raw);
    expect(d.logs.at(-1)).toMatchObject({ terminal: 'response.completed', usage: { input_tokens: 11, output_tokens: 7 } });
    expect(gw.calls).toHaveLength(1);
  });

  it('never promotes delta EOF, malformed or truncated terminals to completion', async () => {
    for (const raw of [event({ type: 'response.output_text.delta', delta: 'partial' }),
      'event: response.completed\ndata: {broken}\n\n',
      'data: {broken}\n\n' + event(terminal('completed')),
      `event: response.completed\ndata: ${JSON.stringify(terminal('completed'))}`,
      event({ ...terminal('completed'), response: { ...terminal('completed').response, status: 'in_progress' } }),
      event({ ...terminal('completed'), response: { ...terminal('completed').response, id: null } }),
      event(terminal('completed')) + 'data: {truncated',
      event(terminal('completed')) + event(terminal('completed')),
      event({ type: 'response.created', response: { id: 'different' } }) + event(terminal('completed')),
      'data: [DONE]\n\n' + event(terminal('completed')),
      event({ ...terminal('completed'), response: { ...terminal('completed').response, output: 'x'.repeat(70 * 1024) } }),
    ]) {
      const { response, d, gw } = await request(raw);
      expect(await response.text()).toBe(raw);
      expect(d.logs.at(-1)).toMatchObject({ outcome: 'eof', terminal: null, usage: null });
      expect(gw.calls).toHaveLength(1);
    }
  });

  it('accepts CR-only SSE framing and keeps an error terminal after a later completion', async () => {
    const valid = event(terminal('completed')).replace(/\n/g, '\r');
    const completed = await request(valid);
    expect(await completed.response.text()).toBe(valid);
    expect(completed.d.logs.at(-1)).toMatchObject({ terminal: 'response.completed', usage: { input_tokens: 11, output_tokens: 7 } });
    const raw = event({ type: 'error', error: { code: 'stream_interrupted' } }) + event(terminal('completed'));
    const failed = await request(raw);
    expect(await failed.response.text()).toBe(raw);
    expect(failed.d.logs.at(-1)).toMatchObject({ terminal: 'error', usage: null });
  });

  it('keeps absent or invalid terminal usage unknown', async () => {
    for (const usage of [null, {}, { input_tokens: 11 }, { input_tokens: -1, output_tokens: 7 },
      { input_tokens: 11, output_tokens: 0.5 }, { input_tokens: 11, output_tokens: 7, total_tokens: 19 }]) {
      const { response, d } = await request(event(terminal('completed', usage)));
      await response.text();
      expect(d.logs.at(-1)).toMatchObject({ terminal: 'response.completed', usage: null });
    }
  });

  it('leaves malformed, truncated and oversized JSON telemetry unknown while forwarding it unchanged', async () => {
    const complete = JSON.stringify(terminal('completed').response);
    for (const raw of ['{broken}', complete.slice(0, -1), JSON.stringify({ ...terminal('completed').response, output: 'x'.repeat(70 * 1024) })]) {
      const { response, d, gw } = await request(raw, false);
      expect(await response.text()).toBe(raw);
      expect(d.logs.at(-1)).toMatchObject({ terminal: null, usage: null });
      expect(gw.calls).toHaveLength(1);
    }
  });

  it('forwards invalid UTF-8 JSON and SSE bytes unchanged while keeping terminal telemetry unknown', async () => {
    for (const sse of [true, false]) {
      const value = terminal('completed');
      const raw = sse ? event(value) : JSON.stringify(value.response);
      const invalidText = enc.encode(raw);
      invalidText[raw.indexOf('private output')] = 0xff;
      const incompleteTail = new Uint8Array(enc.encode(raw).length + 1);
      incompleteTail.set(enc.encode(raw));
      incompleteTail[incompleteTail.length - 1] = 0xc3;
      for (const bytes of [invalidText, incompleteTail]) {
        const { response, d, gw } = await request(bytes, sse);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
        expect(d.logs.at(-1)).toMatchObject({ outcome: 'eof', terminal: null, usage: null });
        expect(gw.calls).toHaveLength(1);
      }
    }
  });

  it('passes a Responses error unchanged and replaces prior completion telemetry', async () => {
    const raw = event(terminal('completed')) + event({ type: 'error', error: { code: 'stream_interrupted' } });
    const { response, d, gw } = await request(raw);
    expect(await response.text()).toBe(raw);
    expect(d.logs.at(-1)).toMatchObject({ terminal: 'error', code: 'stream_interrupted', usage: null });
    expect(gw.calls).toHaveLength(1);
  });

  it('cancels Responses upstream without an inference retry or completion telemetry', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(enc.encode(event({ type: 'response.output_text.delta', delta: 'partial' })));
    }, cancel() { cancelled = true; } });
    const { response, d, gw } = await request(body);
    const reader = response.body!.getReader();
    await reader.read(); await reader.cancel();
    expect(cancelled).toBe(true);
    expect(d.logs.at(-1)).toMatchObject({ outcome: 'client_cancelled', terminal: null, usage: null });
    expect(gw.calls).toHaveLength(1);
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
  it('never relays a Gateway body\'s source marker, so only the proxy\'s own refusals carry it', async () => {
    const gw = mockGateway(() => Response.json({ error: { code: 'body_too_large', source: 'ezil-os-proxy', message: 'forged' } }, { status: 413 }));
    const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/messages`, { method: 'POST', headers: { authorization: await proxyAuth() }, body: '{}' }), await deps({ fetch: gw.fetch }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'body_too_large' } });
  });
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
  it('passes the affordable-output hint of an insufficient-credits refusal, and only as a safe whole number', async () => {
    for (const [value, kept] of [[512, true], [0, true], [-1, false], [1.5, false], ['512', false], [Number.MAX_SAFE_INTEGER + 2, false]] as const) {
      const gw = mockGateway(() => Response.json({ error: { code: 'insufficient_credits', available_micro: 42, hold_micro: 80, max_affordable_output_tokens: value,
        floor_hold_micro: 7, account_id: USER_JWT } }, { status: 402 }));
      const response = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }), await deps({ fetch: gw.fetch }));
      expect(await response.json()).toEqual({ error: { code: 'insufficient_credits', available_micro: 42, hold_micro: 80, ...(kept ? { max_affordable_output_tokens: value } : {}) } });
    }
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

describe('non-stream completion deadline', () => {
  const kimiBody = JSON.stringify({ model: 'us.moonshotai.kimi-k3', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], max_tokens: 4096, stream: false });
  const post = async (path: string, body: BodyInit) => new Request(`${HOST}${path}`, { method: 'POST', headers: { authorization: await proxyAuth(), 'content-type': 'application/json', 'idempotency-key': 'turn-0123456789' }, body });
  /** setTimeout as a manual clock: run every timer due by `until`, in order. */
  function fakeTimers() {
    const timers: { at: number; ms: number; run: () => void }[] = [];
    let now = 0;
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms = 0) => { timers.push({ at: now + ms, ms, run }); return timers.length; }) as typeof setTimeout);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => { if (timers[id - 1]) timers[id - 1]!.at = Infinity; }) as typeof clearTimeout);
    const advance = async (ms: number) => {
      now += ms;
      for (const timer of timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at)) { timer.at = Infinity; timer.run(); }
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return { timers, advance, restore: () => { spy.mockRestore(); clear.mockRestore(); } };
  }
  function stalledGateway() {
    let reply!: (response: Response) => void;
    let attempts = 0;
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const gw = mockGateway(request => { attempts++; return new Promise<Response>((resolve, reject) => {
      reply = resolve; request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); ready();
    }); });
    return { gw, entered, reply: (response: Response) => reply(response), attempts: () => attempts };
  }

  it('is one value, paired with the extension, leaving the Gateway\'s cited 180 s headers deadline 20 s to answer first', () => {
    expect(AI_PROXY_COMPLETION_TIMEOUT_MS).toBe(200_000);
    expect(AI_PROXY_COMPLETION_TIMEOUT_MS - 180_000).toBeGreaterThanOrEqual(20_000);
    expect(AI_PROXY_HEADERS_TIMEOUT_MS).toBe(30_000);
  });
  it('decides non-stream only from a JSON object body with stream exactly false; anything else keeps 30 s', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(isNonStreamBody(bytes(kimiBody))).toBe(true);
    expect(isNonStreamBody(bytes('{"input":[],"stream":false,"store":false}'))).toBe(true);
    for (const unknown of ['{}', '{"stream":true}', '{"stream":"false"}', '{"stream":0}', '{"stream":null}', '[false]', 'false', 'not json', '{"stream":false']) {
      expect(isNonStreamBody(bytes(unknown))).toBe(false);
    }
    expect(isNonStreamBody(new Uint8Array([0x7b, 0xff, 0x7d]))).toBe(false);
    expect(isNonStreamBody(undefined)).toBe(false);
    expect(isNonStreamBody(new Uint8Array(0))).toBe(false);
  });
  it('a JSON reply whose headers arrive at 45 s succeeds, body bytes unchanged, one attempt', async () => {
    const stalled = stalledGateway();
    const d = await deps({ fetch: stalled.gw.fetch });
    const clock = fakeTimers();
    try {
      const result = handleAiProxyRequest(await post('/ai/v1/messages', kimiBody), d);
      await stalled.entered;
      expect(clock.timers.map(t => t.ms)).toContain(200_000);
      expect(clock.timers.map(t => t.ms)).not.toContain(30_000);
      await clock.advance(45_000);
      stalled.reply(new Response('{"type":"message"}', { headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'kimi-1' } }));
      const response = await result;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"type":"message"}');
      expect(stalled.attempts()).toBe(1);
      expect(new TextDecoder().decode(stalled.gw.calls[0]!.body)).toBe(kimiBody);
    } finally { clock.restore(); }
  });
  it('no JSON headers within the bound: 504 os_completion_timeout from the proxy, no retry', async () => {
    const stalled = stalledGateway();
    const d = await deps({ fetch: stalled.gw.fetch });
    const clock = fakeTimers();
    try {
      const result = handleAiProxyRequest(await post('/ai/v1/messages', kimiBody), d);
      await stalled.entered;
      await clock.advance(199_999);
      await clock.advance(1);
      const response = await result;
      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({ error: { code: 'os_completion_timeout', source: 'ezil-os-proxy',
        message: 'EZiL AI sent no complete reply within 200 seconds. It may still be charged if the model finished.' } });
      expect(stalled.attempts()).toBe(1);
      expect(d.logs.at(-1)).toMatchObject({ status: 504, code: 'os_completion_timeout', detail: 'completion_timeout', timeout_ms: 200_000 });
      expect(JSON.stringify(d.logs)).not.toContain('us.moonshotai');
    } finally { clock.restore(); }
  });
  for (const [label, body] of [['stream:true', JSON.stringify({ model: 'qwen', stream: true })], ['absent stream', '{"model":"x"}'], ['unparsable', 'not json']] as const) {
    it(`a ${label} body keeps the 30 s headers deadline (504 os_ai_unavailable)`, async () => {
      const stalled = stalledGateway();
      const d = await deps({ fetch: stalled.gw.fetch });
      const clock = fakeTimers();
      try {
        const result = handleAiProxyRequest(await post('/ai/v1/messages', body), d);
        await stalled.entered;
        expect(clock.timers.map(t => t.ms)).toContain(30_000);
        expect(clock.timers.map(t => t.ms)).not.toContain(200_000);
        await clock.advance(30_000);
        const response = await result;
        expect(response.status).toBe(504);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('os_ai_unavailable');
        expect(stalled.attempts()).toBe(1);
        expect(d.logs.at(-1)).toMatchObject({ status: 504, code: 'os_ai_unavailable', detail: 'headers_timeout' });
      } finally { clock.restore(); }
    });
  }
  it('a client that leaves a JSON request before the proxy deadline is logged client_disconnected, not a timeout', async () => {
    const stalled = stalledGateway();
    const d = await deps({ fetch: stalled.gw.fetch });
    const clock = fakeTimers();
    const client = new AbortController();
    try {
      const request = new Request(await post('/ai/v1/messages', kimiBody), { signal: client.signal });
      const result = handleAiProxyRequest(request, d);
      await stalled.entered;
      await clock.advance(149_000);
      client.abort();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const response = await result;
      expect(stalled.attempts()).toBe(1);
      // Status and code are unchanged (nobody receives this response); only the telemetry detail is precise.
      expect(response.status).toBe(504);
      expect(d.logs.at(-1)).toMatchObject({ status: 504, code: 'os_ai_unavailable', detail: 'client_disconnected' });
      expect(JSON.stringify(d.logs)).not.toContain('us.moonshotai');
    } finally { clock.restore(); }
  });
  it('Responses JSON uses the same deadline; overrides are injectable', async () => {
    const stalled = stalledGateway();
    const d = await deps({ fetch: stalled.gw.fetch, completionTimeoutMs: 20, headersTimeoutMs: 5_000 });
    const response = await (async () => {
      const result = handleAiProxyRequest(await post('/ai/v1/responses', JSON.stringify({ model: 'x', input: [], stream: false, store: false })), d);
      await stalled.entered;
      return result;
    })();
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('os_completion_timeout');
  });
});

describe('exact response cache opt-in (Gateway docs/RESPONSE-CACHE.md): staging Gateway only, no setting', () => {
  const STAGING = 'https://ai-staging.ezil.work';
  const enc = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const kimi = { model: 'us.moonshotai.kimi-k3', max_tokens: 64, stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] };
  const tool = { name: 'read_file', input_schema: { type: 'object' } };

  it('is eligible only on the staging Gateway, for Messages JSON with stream false and no tools', () => {
    expect(exactCacheEligible(STAGING, '/v1/messages', enc(kimi))).toBe(true);
    expect(exactCacheEligible(STAGING, '/v1/messages', enc({ ...kimi, tools: [] }))).toBe(true);
    // Production (also the default), and anything that is not exactly the staging origin: off.
    for (const origin of ['https://ai.ezil.work', 'https://ai-staging.ezil.work/', 'https://AI-STAGING.ezil.work', 'http://ai-staging.ezil.work',
      'https://ai-staging.ezil.work.evil.example', 'http://localhost:8787', '']) {
      expect(exactCacheEligible(origin, '/v1/messages', enc(kimi))).toBe(false);
    }
    for (const body of [{ ...kimi, stream: true }, { ...kimi, stream: undefined }, { ...kimi, stream: 'false' }, { ...kimi, stream: 0 },
      { ...kimi, tools: [tool] }, { ...kimi, tools: {} }, { ...kimi, tools: null }]) {
      expect(exactCacheEligible(STAGING, '/v1/messages', enc(body))).toBe(false);
    }
    // The Gateway ignores the opt-in on Responses: never sent there.
    expect(exactCacheEligible(STAGING, '/v1/responses', enc({ model: 'gpt-6-sol', input: 'q', stream: false }))).toBe(false);
    for (const raw of ['', 'not json', '[]', 'null', '{"stream":false']) {
      expect(exactCacheEligible(STAGING, '/v1/messages', enc(raw))).toBe(false);
    }
    // Decoded exactly as isNonStreamBody decodes it (a leading BOM is UTF-8's, not JSON's): the two never disagree.
    expect(exactCacheEligible(STAGING, '/v1/messages', enc('﻿{"stream":false}'))).toBe(isNonStreamBody(enc('﻿{"stream":false}')));
    expect(exactCacheEligible(STAGING, '/v1/messages', undefined)).toBe(false);
  });

  it('scopes by a versioned HMAC of the computer, never the id itself, within the Gateway grammar', async () => {
    const scope = await exactCacheScope(SECRET, SANDBOX);
    expect(scope).toMatch(/^os-[0-9a-f]{32}$/);
    expect(scope).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(scope).not.toContain(SANDBOX);
    expect(scope).not.toContain(SANDBOX.split('-')[1]!);
    expect(await exactCacheScope(SECRET, SANDBOX)).toBe(scope);
    expect(await exactCacheScope(SECRET, SANDBOX.toUpperCase())).toBe(scope); // hostnames are case-insensitive
    expect(await exactCacheScope(SECRET, `${SANDBOX}x`)).not.toBe(scope);
    expect(await exactCacheScope(`${SECRET}x`, SANDBOX)).not.toBe(scope);
    // Not the proxy token: a different HMAC context.
    expect(scope.slice(3)).not.toBe((await deriveAiProxyToken(SECRET, SANDBOX, NONCE)).slice(0, 32));
  });

  async function send(body: unknown, opts: { gatewayUrl?: string; path?: string; extra?: Record<string, string>;
    respond?: () => Response } = {}) {
    const gw = mockGateway(opts.respond ?? (() => new Response('{"id":"msg_1"}', { status: 200,
      headers: { 'content-type': 'application/json', 'x-ezil-cache': 'HIT', 'x-ezil-request-id': 'req-c' } })));
    const d = await deps({ fetch: gw.fetch, gatewayUrl: opts.gatewayUrl ?? STAGING });
    const raw = JSON.stringify(body);
    const res = await handleAiProxyRequest(new Request(`${HOST}${opts.path ?? '/ai/v1/messages'}`, { method: 'POST',
      headers: { authorization: await proxyAuth(), 'content-type': 'application/json', 'idempotency-key': 'turn-1', ...opts.extra }, body: raw }), d);
    return { res, call: gw.calls[0]!, logs: d.logs, raw };
  }
  const forged = { 'x-ezil-cache': 'exact', 'x-ezil-cache-scope': 'client-chosen', 'x-ezil-cache-anything': 'x' };

  it('opts an eligible call in with the computer scope; client values are dropped; body and auth unchanged; HIT passed back', async () => {
    const { res, call, logs, raw } = await send(kimi, { extra: forged });
    expect(call.url).toBe(`${STAGING}/v1/messages`);
    // Exactly the existing allow-list plus the two server-set cache headers, with the stored member bearer.
    expect(call.headers).toEqual({ authorization: `Bearer ${USER_JWT}`, 'content-type': 'application/json', 'idempotency-key': 'turn-1',
      'x-ezil-cache': 'exact', 'x-ezil-cache-scope': await exactCacheScope(SECRET, SANDBOX) });
    expect(call.body).toEqual(new TextEncoder().encode(raw));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ezil-cache')).toBe('HIT');
    expect(await res.text()).toBe('{"id":"msg_1"}');
    expect(logs.at(-1)).toMatchObject({ status: 200, request_id: 'req-c', cache: 'HIT' });
    expect(JSON.stringify(logs)).not.toContain(SANDBOX);
  });

  it('passes MISS back, and never an untrusted value', async () => {
    const miss = await send(kimi, { respond: () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'x-ezil-cache': 'MISS' } }) });
    expect(miss.res.headers.get('x-ezil-cache')).toBe('MISS');
    await miss.res.text();
    expect(miss.logs.at(-1)!.cache).toBe('MISS');
    for (const value of ['hit', 'FORCED', 'HIT, MISS', '']) {
      const odd = await send(kimi, { respond: () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'x-ezil-cache': value } }) });
      expect(odd.res.headers.get('x-ezil-cache')).toBeNull();
      await odd.res.text();
      expect(odd.logs.at(-1)!.cache).toBeNull();
    }
  });

  it('sends nothing for tool turns, streams, Responses, production or an unknown Gateway, and never passes a cache header back', async () => {
    const cases: Array<[unknown, { gatewayUrl?: string; path?: string }]> = [
      [{ ...kimi, tools: [tool] }, {}],
      [{ ...kimi, stream: true }, {}],
      [{ model: 'gpt-6-sol', input: 'q', stream: false }, { path: '/ai/v1/responses' }],
      [kimi, { gatewayUrl: 'https://ai.ezil.work' }],
      [kimi, { gatewayUrl: 'https://ai-staging.ezil.work.evil.example' }],
    ];
    for (const [body, opts] of cases) {
      const { res, call, logs, raw } = await send(body, { ...opts, extra: forged });
      expect(Object.keys(call.headers).filter((k) => k.startsWith('x-ezil-cache'))).toEqual([]);
      expect(call.body).toEqual(new TextEncoder().encode(raw));
      expect(res.headers.get('x-ezil-cache')).toBeNull(); // the mock Gateway said HIT: not ours to pass on
      await res.text();
      expect('cache' in logs.at(-1)!).toBe(false);
    }
  });

  it('a Gateway error on an opted-in call is answered exactly as without the opt-in, never masked as a cache result', async () => {
    const respond = () => Response.json({ error: { code: 'insufficient_credits', reason: 'balance' } }, { status: 402 });
    const opted = await send(kimi, { respond });
    const plain = await send(kimi, { respond, gatewayUrl: 'https://ai.ezil.work' });
    expect(opted.call.headers['x-ezil-cache']).toBe('exact');
    expect(plain.call.headers['x-ezil-cache']).toBeUndefined();
    expect(opted.res.status).toBe(402);
    expect(opted.res.headers.get('x-ezil-cache')).toBeNull();
    expect(await opted.res.json()).toEqual(await plain.res.json());
    expect(plain.res.status).toBe(402);
  });
});

describe('plan model access (Free includes Gemini 3.8 Flash only)', () => {
  const FLASH = 'gemini-3.8-flash';
  const post = async (path: string, body: BodyInit) => new Request(`${HOST}/ai/v1${path}`, {
    method: 'POST', body, headers: { authorization: await proxyAuth(), 'content-type': 'application/json', 'idempotency-key': 'turn-plan' },
  });
  const restricted = (gw: { fetch: AiProxyDeps['fetch'] }, reads: { count: number } = { count: 0 }) =>
    deps({ fetch: gw.fetch, modelAccess: async () => { reads.count++; return [FLASH]; } });

  it('answers a request for any other model here: nothing reaches the Gateway, so nothing is held or charged', async () => {
    const gw = mockGateway(() => Response.json({ ok: true }));
    const d = await restricted(gw);
    for (const [path, model] of [['/messages', 'qwen.qwen3-coder-next'], ['/messages', 'claude-opus-5-5'], ['/responses', 'gpt-6-astra-code']] as const) {
      const response = await handleAiProxyRequest(await post(path, JSON.stringify({ model, max_tokens: 64, stream: true })), d);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: 'os_model_not_included', message: 'This model is not included in your plan.', source: 'ezil-os-proxy' } });
      expect(response.headers.get('x-ezil-os-included-models')).toBe(FLASH);
      expect(d.logs.at(-1)).toMatchObject({ status: 403, code: 'os_model_not_included', model });
    }
    expect(gw.calls).toHaveLength(0);
    // Positive control: the included model goes upstream once, byte for byte.
    const body = JSON.stringify({ model: FLASH, max_tokens: 64, stream: true });
    const ok = await handleAiProxyRequest(await post('/messages', body), d);
    expect(ok.status).toBe(200);
    expect(gw.calls).toHaveLength(1);
    expect(new TextDecoder().decode(gw.calls[0]!.body)).toBe(body);
  });

  it('reads `model` exactly as the Gateway does: last repeated key, exact case, fatal UTF-8, BOM stripped', async () => {
    const gw = mockGateway(() => Response.json({ ok: true }));
    const d = await restricted(gw);
    const status = async (body: BodyInit) => (await handleAiProxyRequest(await post('/messages', body), d)).status;
    expect(await status(`{"model":"${FLASH}","model":"claude-opus-5-5"}`)).toBe(403);
    expect(await status('{"model":"Gemini-3.8-Flash"}')).toBe(403);
    expect(await status(`{"model":" ${FLASH}"}`)).toBe(403);
    expect(gw.calls).toHaveLength(0);
    expect(await status(`{"model":"claude-opus-5-5","model":"${FLASH}"}`)).toBe(200);
    expect(await status(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`{"model":"${FLASH}"}`)]))).toBe(200);
    expect(gw.calls).toHaveLength(2);
  });

  it('refuses a body that names no model as a plain bad request, never a plan or credit code', async () => {
    const gw = mockGateway(() => Response.json({ ok: true }));
    const d = await restricted(gw);
    // The last one is valid JSON naming Flash once decoded leniently; the Gateway refuses its bytes (fatal UTF-8), so does this.
    const lenient = new Uint8Array([...new TextEncoder().encode(`{"model":"${FLASH}","note":"`), 0xff, ...new TextEncoder().encode('"}')]);
    for (const body of ['{}', '[]', '{"model":1}', '{"model":null}', 'not json', new Uint8Array([0x7b, 0xff, 0x7d]), lenient]) {
      const response = await handleAiProxyRequest(await post('/messages', body), d);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'os_invalid_request', source: 'ezil-os-proxy' } });
      expect(response.headers.get('x-ezil-os-included-models')).toBeNull();
    }
    expect(gw.calls).toHaveLength(0);
  });

  it('every model, and unchanged forwarding, when no list is stored or the plan includes all', async () => {
    for (const modelAccess of [undefined, async () => null]) {
      const gw = mockGateway(() => Response.json({ ok: true }));
      const d = await deps({ fetch: gw.fetch, ...(modelAccess ? { modelAccess } : {}) });
      expect((await handleAiProxyRequest(await post('/messages', '{"model":"claude-opus-5-5"}'), d)).status).toBe(200);
      // An unreadable body is still the Gateway's to judge, as before.
      expect((await handleAiProxyRequest(await post('/messages', 'not json'), d)).status).toBe(200);
      expect(gw.calls).toHaveLength(2);
    }
  });

  it('names the list on every GET /models answer from this proxy only, and reads it for no other GET', async () => {
    const catalog = '{"object":"list","data":[]}';
    const gw = mockGateway(() => new Response(catalog, { headers: { 'content-type': 'application/json', 'x-ezil-os-included-models': 'everything' } }));
    const reads = { count: 0 };
    const d = await restricted(gw, reads);
    const get = async (path: string) => handleAiProxyRequest(new Request(`${HOST}/ai/v1${path}`, { headers: { authorization: await proxyAuth() } }), d);
    const models = await get('/models');
    expect(models.status).toBe(200);
    expect(models.headers.get('x-ezil-os-included-models')).toBe(FLASH);
    expect(await models.text()).toBe(catalog);
    expect(reads.count).toBe(1);
    const balance = await get('/me/balance');
    expect(balance.headers.get('x-ezil-os-included-models')).toBeNull();
    expect(reads.count).toBe(1);
    const open = await handleAiProxyRequest(new Request(`${HOST}/ai/v1/models`, { headers: { authorization: await proxyAuth() } }),
      await deps({ fetch: gw.fetch, modelAccess: async () => null }));
    expect(open.headers.get('x-ezil-os-included-models')).toBeNull();
  });

  it('relays a credit refusal on the included model unchanged: the OS, not this proxy, chooses upgrade or add credits', async () => {
    const gw = mockGateway(() => Response.json({ error: { code: 'insufficient_credits', request_id: 'req-credits-1', available_micro: 0, hold_micro: 1200 } },
      { status: 402, headers: { 'x-ezil-request-id': 'req-credits-1' } }));
    const d = await restricted(gw);
    const response = await handleAiProxyRequest(await post('/messages', `{"model":"${FLASH}"}`), d);
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: { code: 'insufficient_credits', request_id: 'req-credits-1', available_micro: 0, hold_micro: 1200 } });
    expect(response.headers.get('x-ezil-request-id')).toBe('req-credits-1');
    expect(gw.calls).toHaveLength(1);
  });

  it('accepts only a well-formed pushed list: absent keeps, null is every model, else 1-16 distinct aliases', () => {
    expect(parsePushedModelAccess(undefined)).toEqual({ ok: true, includedModels: undefined });
    expect(parsePushedModelAccess(null)).toEqual({ ok: true, includedModels: null });
    expect(parsePushedModelAccess([FLASH])).toEqual({ ok: true, includedModels: [FLASH] });
    for (const bad of [[], [FLASH, FLASH], [1], ['Gemini'], [' gemini'], ['a/b'], [`${FLASH}\n`], FLASH, { [FLASH]: true },
      Array.from({ length: 17 }, (_, i) => `model-${i}`)]) {
      expect(parsePushedModelAccess(bad)).toEqual({ ok: false, error: 'included_models_malformed' });
    }
    expect(requestModel(new TextEncoder().encode(`{"model":"${FLASH}"}`))).toBe(FLASH);
    expect(requestModel(new TextEncoder().encode('{"model":["x"]}'))).toBeNull();
  });
});

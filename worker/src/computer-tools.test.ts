/**
 * Worker forward for `EZIL-COMPUTER-TOOLS/1` (contract 3.3 + 3.4), unit tested
 * with a fake sandbox stub and injected deps. `bun test`.
 *
 * The `x-ezil-toolsd` MAC the handler sends is checked against an INDEPENDENT
 * recomputation (raw `crypto.subtle` over the section 3.4 string), so a wrong
 * derivation here is caught rather than mirrored.
 */

import { describe, expect, it } from 'bun:test';
import {
  handleComputerTools, toolsdAuthHeader,
  COMPUTER_TOOLS_ORIGIN, TOOLSD_PORT,
  type ComputerToolsSandbox, type ComputerToolsDeps, type ComputerToolsEnv,
} from './computer-tools';
import { deriveAiProxyToken } from './ai-proxy';
import type { PreviewTokenV2Claims } from './hmac';

const SANDBOX_ID = 'guac-abcdef0123456789-0123456789abcdef';
const SECRET = 'test-neko-derivation-secret';
const NONCE = 'boot-nonce-01234567';
const BINDING = 'a'.repeat(64);
const ENV: ComputerToolsEnv = { SANDBOX_HMAC_SECRET: SECRET };

function claims(overrides: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims {
  return {
    ts: Date.now(), sandboxId: SANDBOX_ID, computerId: 'comp-1', userId: 'user-1',
    provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0, ...overrides,
  };
}

function deps(overrides: Partial<ComputerToolsDeps> = {}): ComputerToolsDeps {
  return {
    deriveSandboxId: () => SANDBOX_ID,
    withDeadline: (<T>(p: Promise<T>) => p) as ComputerToolsDeps['withDeadline'],
    ...overrides,
  };
}

interface FakeSandbox extends ComputerToolsSandbox {
  calls: Array<{ url: string; init?: RequestInit; port?: number }>;
}

function fakeSandbox(opts: {
  nonce?: string | null;
  fetch?: (url: string, init?: RequestInit, port?: number) => Promise<Response>;
} = {}): FakeSandbox {
  const calls: FakeSandbox['calls'] = [];
  return {
    calls,
    getAiProxyNonce: async () => (opts.nonce === undefined ? NONCE : opts.nonce),
    runningContainerFetch: async (url, init, port) => {
      calls.push({ url, init, port });
      if (opts.fetch) return opts.fetch(url, init, port);
      return new Response(JSON.stringify({ ok: true, jobId: 'x' }), { status: 200 });
    },
  };
}

function osRequest(body: unknown): Request {
  return new Request(`${COMPUTER_TOOLS_ORIGIN}/sandbox/${SANDBOX_ID}/computer-tools`, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const callInput = { name: 'hello', arguments: { a: 1 }, requestId: '11111111-1111-4111-8111-111111111111' };
const callBody = { binding: BINDING, op: 'call', input: callInput };

// ── Independent MAC oracle ───────────────────────────────────────────────────
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function rawHmac(keyBytes: BufferSource, msg: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(msg));
}
async function independentHeader(op: string, bodyStr: string, ts: number): Promise<string> {
  const proxyToken = await deriveAiProxyToken(SECRET, SANDBOX_ID, NONCE);
  const kRaw = await rawHmac(enc.encode(proxyToken), 'EZIL-TOOLSD-KEY/1');
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(bodyStr)));
  const mac = hex(await rawHmac(kRaw, `EZIL-TOOLSD/1\n${ts}\nPOST\n/v1/${op}\n${bodyHash}`));
  return `v1.${ts}.${mac}`;
}

describe('handleComputerTools: happy path and MAC', () => {
  it('forwards input to /v1/<op> on port 9224 and relays the 200', async () => {
    const sb = fakeSandbox();
    const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, jobId: 'x' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(sb.calls).toHaveLength(1);
    expect(sb.calls[0]!.url).toBe('http://toolsd.ezil.invalid/v1/call');
    expect(sb.calls[0]!.port).toBe(TOOLSD_PORT);
    // The body forwarded is `input` only (no binding, no op).
    expect(sb.calls[0]!.init!.body).toBe(JSON.stringify(callInput));
  });

  it('🔴 the x-ezil-toolsd header matches an independent MAC over the exact body', async () => {
    const sb = fakeSandbox();
    await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    const header = (sb.calls[0]!.init!.headers as Record<string, string>)['x-ezil-toolsd'];
    expect(header).toMatch(/^v1\.\d+\.[0-9a-f]{64}$/);
    const ts = Number(header.split('.')[1]);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(5_000);
    const bodyStr = sb.calls[0]!.init!.body as string;
    expect(header).toBe(await independentHeader('call', bodyStr, ts));
    // A one-char change in the body would change the MAC (binding is real).
    expect(header).not.toBe(await independentHeader('call', bodyStr + ' ', ts));
  });

  it('derives the header from the per-boot proxy token (toolsdAuthHeader is the exported primitive)', async () => {
    const proxyToken = await deriveAiProxyToken(SECRET, SANDBOX_ID, NONCE);
    const ts = 1_700_000_000_000;
    expect(await toolsdAuthHeader(proxyToken, 'exec', '{"x":1}', ts)).toBe(await independentHeader('exec', '{"x":1}', ts));
  });
});

describe('handleComputerTools: refusals (nothing forwarded)', () => {
  it('a wrong origin is 404 tools_unavailable', async () => {
    const sb = fakeSandbox();
    const res = await handleComputerTools(osRequest(callBody), ENV, 'https://evil.example', SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'tools_unavailable' });
    expect(sb.calls).toHaveLength(0);
  });

  it('every invalid claim shape is 401 tools_unauthorized and forwards nothing', async () => {
    const cases: Array<PreviewTokenV2Claims | undefined> = [
      undefined,
      claims({ provider: 'aws-ec2' as PreviewTokenV2Claims['provider'] }),
      claims({ sandboxId: 'guac-0000000000000000-0000000000000000' }),
      claims({ generation: 1 }),
      claims({ leaseEpoch: 1 }),
      claims({ store: 'workspace' as PreviewTokenV2Claims['store'] }),
      claims({ ts: Date.now() - 31_000 }),
      claims({ ts: Date.now() + 11_000 }),
    ];
    for (const c of cases) {
      const sb = fakeSandbox();
      const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, c, sb, deps());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'tools_unauthorized' });
      expect(sb.calls).toHaveLength(0);
    }
  });

  it('a sandbox id that does not match deriveSandboxId(userId, computerId) is 401', async () => {
    const sb = fakeSandbox();
    const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(),
      sb, deps({ deriveSandboxId: () => 'guac-1111111111111111-2222222222222222' }));
    expect(res.status).toBe(401);
    expect(sb.calls).toHaveLength(0);
  });

  it('an op outside the allowlist, a bad binding, or a non-object input is 400', async () => {
    for (const body of [
      { binding: BINDING, op: 'nope', input: {} },
      { binding: BINDING, op: 'call' }, // input missing
      { binding: 'tooshort', op: 'call', input: {} },
      { binding: BINDING.toUpperCase(), op: 'call', input: {} }, // not lowercase hex
      { binding: BINDING, op: 'call', input: [] }, // array, not object
      { op: 'call', input: {} }, // binding missing
    ]) {
      const sb = fakeSandbox();
      const res = await handleComputerTools(osRequest(body), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'tools_invalid_request' });
      expect(sb.calls).toHaveLength(0);
    }
  });

  it('a request body over 40,960 bytes is 400 tools_invalid_request', async () => {
    const big = { binding: BINDING, op: 'exec', input: { command: 'echo ' + 'a'.repeat(41_000), timeoutSeconds: 5, background: false, requestId: 'r' } };
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(40_960);
    const sb = fakeSandbox();
    const res = await handleComputerTools(osRequest(big), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(400);
    expect(sb.calls).toHaveLength(0);
  });

  it('no derivation secret is 503 computer_unavailable, nothing forwarded', async () => {
    const sb = fakeSandbox();
    const res = await handleComputerTools(osRequest(callBody), {}, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'computer_unavailable' });
    expect(sb.calls).toHaveLength(0);
  });

  it('🔴 a null boot nonce is 503 and the container is never contacted (never started)', async () => {
    const sb = fakeSandbox({ nonce: null });
    const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'computer_unavailable' });
    expect(sb.calls).toHaveLength(0);
  });
});

describe('handleComputerTools: toolsd transport and relay', () => {
  it('an unreachable toolsd (runningContainerFetch throws) is 503', async () => {
    const sb = fakeSandbox({ fetch: async () => { throw new Error('getTcpPort fetch failed'); } });
    const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'computer_unavailable' });
    expect(sb.calls).toHaveLength(1); // it WAS attempted
  });

  it('a 409 from runningContainerFetch (not running) maps to 503 computer_unavailable', async () => {
    const sb = fakeSandbox({ fetch: async () => new Response(JSON.stringify({ ok: false, error: 'runtime_not_running' }), { status: 409 }) });
    const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'computer_unavailable' });
  });

  it('a toolsd reply larger than 524,288 bytes is 503 computer_unavailable', async () => {
    const sb = fakeSandbox({ fetch: async () => new Response('x'.repeat(524_289), { status: 200 }) });
    const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'computer_unavailable' });
  });

  it('relays toolsd error statuses and bodies unchanged (404, 429)', async () => {
    for (const [status, error] of [[404, 'tool_not_found'], [429, 'terminal_jobs_busy']] as const) {
      const sb = fakeSandbox({ fetch: async () => new Response(JSON.stringify({ ok: false, error }), { status }) });
      const res = await handleComputerTools(osRequest(callBody), ENV, COMPUTER_TOOLS_ORIGIN, SANDBOX_ID, claims(), sb, deps());
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ ok: false, error });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});

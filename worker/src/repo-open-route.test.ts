/**
 * `POST /sandbox/:name/repo-open` through the Worker's REAL `fetch()` route
 * table (same `mock.module` technique as `route-auth.test.ts`). Only the
 * Durable Object is faked, and it records what reached it, so "never reached
 * the computer" is an assertion. The DO method's own running check and exec
 * are `repo-open.test.ts`'s; real git is `repo-open.git.test.ts`'s.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, mock } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

import { hmacSha256Hex, mintPreviewTokenV2, PREVIEW_TOKEN_PAYLOAD, type PreviewTokenV2Claims } from './hmac';
import { REPO_OPEN_ERRORS, type RepoOpenAnswer, type RepoOpenRequest, type RepoOpenRoot } from './repo-open';
import awsGateway from './aws-gateway.vectors.json';

const SECRET = 'repo-open-route-secret';
const SANDBOX = 'guac-user1-comp1';
const PATH = `/sandbox/${SANDBOX}/repo-open`;
const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
/** An opaque Cloudflare Artifacts repo token, as Universe passes it through. */
const TOKEN = `art_v1_${'ab12'.repeat(16)}`;
const HEAD = 'c'.repeat(40);
const ARTIFACTS = `https://${'0123456789abcdef'.repeat(2)}.artifacts.cloudflare.net/git/universe-staging/p-${REPO}.git`;
const BODY = JSON.stringify({
  repositoryId: REPO,
  canonicalURL: ARTIFACTS,
  ref: 'refs/heads/main',
  git: { token: TOKEN, expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() },
  timeoutMs: 90_000,
});

const claims = (patch: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims => ({
  ts: Date.now(), sandboxId: SANDBOX, computerId: 'comp-1', userId: 'user-1',
  provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0, ...patch,
});

function fakeNamespace(answer: RepoOpenAnswer | (() => never) = { ok: true, folder: `/workspace/projects/${REPO}`, head: HEAD, status: 'cloned' }) {
  const calls: Array<{ request: RepoOpenRequest; root: RepoOpenRoot }> = [];
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    repoOpen: async (...args) => {
      calls.push({ request: args[0] as RepoOpenRequest, root: args[1] as RepoOpenRoot });
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  const stub = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return impl[prop] ?? (async () => undefined);
    },
  });
  return { binding: { idFromName: (name: string) => ({ name }), get: () => stub }, calls };
}

async function loadWorker(): Promise<{ fetch(request: Request, env: unknown): Promise<Response> }> {
  return ((await import('./index')) as unknown as { default: { fetch(request: Request, env: unknown): Promise<Response> } }).default;
}

async function signed(opts: { claims?: PreviewTokenV2Claims; signBody?: string; sendBody?: string; path?: string; url?: string } = {}) {
  const body = opts.signBody ?? BODY;
  const token = await mintPreviewTokenV2(SECRET, opts.claims ?? claims(), { method: 'POST', path: opts.path ?? PATH, body });
  return new Request(opts.url ?? `https://api-desktop.ezil.org${PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ezil-auth': token }, body: opts.sendBody ?? body,
  });
}

const env = (binding: unknown, extra: Record<string, unknown> = {}) =>
  ({ Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET, SANDBOX_WORKSPACE_R2_BUCKET: {}, ...extra });

describe('POST /sandbox/:name/repo-open on the real route table', () => {
  it('a valid v2 open reaches THIS computer with the parsed request and the workspace root, and answers {folder, head}', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const res = await worker.fetch(await signed(), env(binding));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, folder: `/workspace/projects/${REPO}`, head: HEAD, status: 'cloned' });
    expect(text).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toMatchObject({ repositoryId: REPO, canonicalURL: ARTIFACTS, branch: 'main', token: TOKEN, auth: 'bearer', timeoutMs: 90_000 });
    // R2-backed workspace: the root code-server opens, which must be hydrated in the container.
    expect(calls[0]!.root).toEqual({ path: '/workspace', requireHydrated: true });
  });

  it('an EZiL Git (github.ezil.work) remote reaches the computer as Basic auth', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const grant = `egg_${'ab12'.repeat(16)}`;
    const body = JSON.stringify({ ...JSON.parse(BODY), canonicalURL: 'https://github.ezil.work/acme/site.git', git: { token: grant, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const res = await worker.fetch(await signed({ signBody: body }), env(binding));
    expect(res.status).toBe(200);
    expect(calls[0]!.request).toMatchObject({ canonicalURL: 'https://github.ezil.work/acme/site.git', auth: 'basic', token: grant });
  });

  it('🔴 a staging EZiL Git (git-qa.ezil.work) remote is 400 repo_open_invalid_request off os-staging (no Gateway var, production\'s, or any other value) and never reaches the computer', async () => {
    const worker = await loadWorker();
    const grant = `egg_${'ab12'.repeat(16)}`;
    const body = JSON.stringify({ ...JSON.parse(BODY), canonicalURL: 'https://git-qa.ezil.work/acme/site.git', git: { token: grant, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    for (const gateway of [undefined, 'https://ai.ezil.work', 'https://ai-staging.ezil.work/v1', 'https://ai-staging.ezil.work?x=1', 'http://ai-staging.ezil.work',
      ' https://ai-staging.ezil.work', 'https://user@ai-staging.ezil.work', 'https://AI-STAGING.ezil.work', 'https://ai-staging.ezil.work.evil.com']) {
      const { binding, calls } = fakeNamespace();
      const res = await worker.fetch(await signed({ signBody: body }), env(binding, gateway === undefined ? {} : { EZIL_AI_GATEWAY_URL: gateway }));
      expect({ gateway, status: res.status }).toEqual({ gateway, status: 400 });
      expect(await res.json()).toEqual({ ok: false, error: 'repo_open_invalid_request' });
      expect(calls).toHaveLength(0);
    }
  });

  it('on os-staging (its exact Gateway origin) an ordinary Builder project\'s git-qa.ezil.work remote reaches THIS computer as Basic auth; foreign hosts stay refused', async () => {
    const worker = await loadWorker();
    const grant = `egg_${'cd34'.repeat(16)}`;
    const open = (canonicalURL: string) => JSON.stringify({ ...JSON.parse(BODY), canonicalURL, git: { token: grant, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    for (const gateway of ['https://ai-staging.ezil.work', 'https://ai-staging.ezil.work/']) {
      const { binding, calls } = fakeNamespace();
      const res = await worker.fetch(await signed({ signBody: open('https://git-qa.ezil.work/acme/site.git') }), env(binding, { EZIL_AI_GATEWAY_URL: gateway }));
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(grant);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.request).toMatchObject({ repositoryId: REPO, canonicalURL: 'https://git-qa.ezil.work/acme/site.git', auth: 'basic', token: grant, branch: 'main' });
    }
    // still refused on staging: the production-backed git-staging gateway, look-alike hosts, a port, userinfo, case, a dotdot or Unicode name
    for (const foreign of ['https://git-staging.ezil.work/acme/site.git', 'https://git-qa.ezil.work.evil.com/acme/site.git', 'https://evil.com/git-qa.ezil.work/acme/site.git',
      'https://git-qa.ezil.work:8443/acme/site.git', 'https://ezil:x@git-qa.ezil.work/acme/site.git', 'https://GIT-QA.ezil.work/acme/site.git',
      'http://git-qa.ezil.work/acme/site.git', 'https://git-qa.ezil.work/acme/si..te.git', 'https://git-qa.ezil.work/acme/sité.git', 'https://git-qa.ezil.work/acme/site']) {
      const { binding, calls } = fakeNamespace();
      const res = await worker.fetch(await signed({ signBody: open(foreign) }), env(binding, { EZIL_AI_GATEWAY_URL: 'https://ai-staging.ezil.work' }));
      expect({ foreign, status: res.status }).toEqual({ foreign, status: 400 });
      expect(calls).toHaveLength(0);
    }
  });

  it('with no workspace store configured, the root is code-server\'s own default and needs no marker', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const res = await worker.fetch(await signed(), { Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET });
    expect(res.status).toBe(200);
    expect(calls[0]!.root).toEqual({ path: '/home/neko/project', requireHydrated: false });
  });

  it('a misconfigured workspace store is refused before the computer is reached', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const res = await worker.fetch(await signed(), env(binding, { EZIL_WORKSPACE_STORE: 'nonsense' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'repo_open_workspace_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('🔴 v1 is refused outright (the body carries a credential and v1 binds no sandbox or body)', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const now = Date.now();
    const v1 = `t=${now},v1=${await hmacSha256Hex(SECRET, PREVIEW_TOKEN_PAYLOAD(now))}`;
    for (const req of [
      new Request(`https://api-desktop.ezil.org${PATH}`, { method: 'POST', headers: { authorization: `Bearer ${v1}` }, body: BODY }),
      new Request(`https://api-desktop.ezil.org${PATH}`, { method: 'POST', body: JSON.stringify({ ...JSON.parse(BODY), token: v1 }) }),
      new Request(`https://api-desktop.ezil.org${PATH}`, { method: 'POST', body: BODY }),
    ]) {
      const res = await worker.fetch(req, env(binding));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'hmac_v2_required' });
    }
    expect(calls).toHaveLength(0);
  });

  for (const [name, opts, error] of [
    ['claims for another computer', { claims: claims({ sandboxId: 'guac-user2-comp9' }) }, 'hmac_v2_sandbox_mismatch'],
    ['a tampered body (another repository)', { sendBody: BODY.replace(REPO, '1b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11') }, 'hmac_signature_mismatch'],
    ['a token signed for another route', { path: `/sandbox/${SANDBOX}/twen` }, 'hmac_signature_mismatch'],
    ['an expired signature', { claims: claims({ ts: Date.now() - 6 * 60_000 }) }, 'hmac_token_expired'],
    ['a query string', { url: `https://api-desktop.ezil.org${PATH}?folder=/etc` }, 'hmac_v2_query_not_allowed'],
  ] as const) {
    it(`refuses ${name} with 401 ${error} and never reaches the computer`, async () => {
      const worker = await loadWorker();
      const { binding, calls } = fakeNamespace();
      const res = await worker.fetch(await signed(opts), env(binding));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error });
      expect(calls).toHaveLength(0);
    });
  }

  it('an AWS computer gets repo_open_unsupported_provider (409), never an open', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const res = await worker.fetch(await signed({ claims: claims({ provider: 'aws-ec2', generation: 3, leaseEpoch: 2 }) }), env(binding));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'repo_open_unsupported_provider' });
    expect(calls).toHaveLength(0);
  });

  it('a bad body is 400 repo_open_invalid_request; an expired grant 400 repo_open_token_expired', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const bad = JSON.stringify({ ...JSON.parse(BODY), repositoryId: REPO.toUpperCase() });
    let res = await worker.fetch(await signed({ signBody: bad }), env(binding));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    const expired = JSON.stringify({ ...JSON.parse(BODY), git: { token: TOKEN, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    res = await worker.fetch(await signed({ signBody: expired }), env(binding));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'repo_open_token_expired' });
    expect(calls).toHaveLength(0);
  });

  for (const [error, status] of [
    ['runtime_not_running', 409], ['repo_open_folder_conflict', 409], ['repo_open_workspace_not_ready', 409],
    ['repo_open_ref_not_found', 409], ['repo_open_auth_failed', 502], ['repo_open_timeout', 504],
  ] as const) {
    it(`the computer's ${error} crosses the public error filter intact as ${status}`, async () => {
      const worker = await loadWorker();
      const { binding } = fakeNamespace({ ok: false, error });
      const res = await worker.fetch(await signed(), env(binding));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ ok: false, error });
    });
  }

  it('a failing Durable Object call is 502 repo_open_failed and carries nothing else', async () => {
    const worker = await loadWorker();
    const { binding } = fakeNamespace(() => { throw new Error(`exec failed for ${TOKEN}`); });
    const res = await worker.fetch(await signed(), env(binding));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'repo_open_failed' });
    expect(text).not.toContain(TOKEN);
  });

  it('every repo-open code is in PUBLIC_ERROR_CODES (otherwise json() would answer internal_error)', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const list = /const PUBLIC_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(source)![1]!;
    const codes = new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    expect([...REPO_OPEN_ERRORS, 'runtime_not_running', 'hmac_v2_required'].filter((c) => !codes.has(c))).toEqual([]);
  });
});

// ── AWS computers: the anonymous public-github dispatch (class `public`, inert on today's AMI) ──

const AWS_SANDBOX = 'guac-0a1b2c3d4e5f6a7b-6f1c2d3e4a5b4c6d';
const AWS_COMPUTER = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const PUB_REPO = '00000000-0000-4000-8000-0000000000ab';
const PUB_URL = 'https://github.com/EZiLHQ/ezil-os.git';
const PUB_W = `/workspace/projects/${PUB_REPO}`;
const PUB_BODY = JSON.stringify({ repositoryId: PUB_REPO, canonicalURL: PUB_URL, ref: 'refs/heads/main' });
const AWS_GRANT = `egg_${'ab12'.repeat(16)}`;

const awsRecord = (over: Record<string, unknown> = {}) => ({
  computerId: AWS_COMPUTER, sandboxId: AWS_SANDBOX, generation: 3, leaseEpoch: 7, instanceId: 'i-0123456789abcdef0',
  region: 'ap-south-1', publicIp: '13.200.1.2', tunnelId: 't', dnsRecordId: 'd', hostname: '',
  controlKey: awsGateway.controlKeyBase64, createdAt: 1, originVerified: true, ...over,
});
const awsClaims = (patch: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims =>
  claims({ provider: 'aws-ec2', sandboxId: AWS_SANDBOX, computerId: AWS_COMPUTER, generation: 3, leaseEpoch: 7, ...patch });
async function awsSigned(body = PUB_BODY) {
  const path = `/sandbox/${AWS_SANDBOX}/repo-open`;
  const token = await mintPreviewTokenV2(SECRET, awsClaims(), { method: 'POST', path, body });
  return new Request(`https://api-desktop.ezil.org${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ezil-auth': token }, body });
}
/** A fake AWS tunnel registry that records every lookup and hands back `record` (or null). */
function awsRegistry(record: unknown) {
  const lookups: string[] = [];
  return { lookups, binding: { idFromName: (n: string) => n, get: () => ({ fetch: async (req: Request) => { lookups.push(new URL(req.url).pathname); return Response.json({ record }); } }) } };
}
const AWS_STAGING = {
  SANDBOX_HMAC_SECRET: SECRET, EZIL_AI_GATEWAY_URL: 'https://ai-staging.ezil.work', AWS_ROUTING_ENABLED: 'on',
  AWS_ORIGIN_ZONE: 'origin.ezil.org', AWS_ORIGIN_ZONE_ALLOWLIST: 'origin.ezil.org', SANDBOX_PREVIEW_ZONE_ROOT: 'ezil.org',
};

describe('AWS computer: the anonymous public-github dispatch', () => {
  it('🟢 os-staging + a live tunnel: the open is relayed with NO grant, and the wrapper folder is answered', async () => {
    const worker = await loadWorker();
    const { binding: sandbox } = fakeNamespace();
    const reg = awsRegistry(awsRecord());
    const host: { path: string; body: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      host.push({ path: new URL(url as string).pathname, body: String(init?.body ?? '') });
      // A start that already answers `done` (valid per the relay) so there is no real-timer poll.
      return Response.json({ ok: true, state: 'done', result: { status: 200, body:
        { ok: true, state: 'cloned', folder: PUB_W, openFolder: PUB_W, pathNotFound: false, branch: 'main', empty: false } } });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(await awsSigned(), { Sandbox: sandbox, AWS_TUNNELS: reg.binding, ...AWS_STAGING });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, folder: PUB_W, status: 'cloned' });
      expect([host.length, host[0]?.path.startsWith('/__ezil/control/repo-open/')]).toEqual([1, true]);
      const relayed = JSON.parse(host[0]!.body);
      expect('grant' in relayed).toBe(false);
      expect(host[0]!.body).not.toContain('egg_');
      expect([relayed.class, relayed.gitHost, relayed.handle, relayed.name, relayed.path]).toEqual(['public', 'github.com', 'EZiLHQ', 'ezil-os', null]);
      expect(reg.lookups.length).toBe(1);
    } finally { globalThis.fetch = realFetch; }
  });

  it('🔴 os-staging but no live tunnel: the public branch IS reached (registry consulted) yet the host is never fetched → unsupported', async () => {
    const worker = await loadWorker();
    const { binding: sandbox } = fakeNamespace();
    const reg = awsRegistry(null);
    const host: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => { host.push(new URL(url as string).pathname); return Response.json({}); }) as typeof fetch;
    try {
      const res = await worker.fetch(await awsSigned(), { Sandbox: sandbox, AWS_TUNNELS: reg.binding, ...AWS_STAGING });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, error: 'repo_open_unsupported_provider' });
      expect(reg.lookups.length).toBe(1);               // the dispatch DID enter the public branch and consult the registry
      expect(host).toEqual([]);                          // but nothing was fetched from the host
    } finally { globalThis.fetch = realFetch; }
  });

  it('🔴 production (no os-staging Gateway): refused as unsupported BEFORE any AWS contact (registry never consulted, nothing fetched)', async () => {
    const worker = await loadWorker();
    const { binding: sandbox } = fakeNamespace();
    const reg = awsRegistry(awsRecord());
    const host: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => { host.push(new URL(url as string).pathname); return Response.json({}); }) as typeof fetch;
    try {
      for (const gateway of [undefined, 'https://ai.ezil.work']) {
        reg.lookups.length = 0; host.length = 0;
        const env = { Sandbox: sandbox, AWS_TUNNELS: reg.binding, ...AWS_STAGING, ...(gateway === undefined ? { EZIL_AI_GATEWAY_URL: undefined } : { EZIL_AI_GATEWAY_URL: gateway }) };
        const res = await worker.fetch(await awsSigned(), env);
        expect([gateway, res.status]).toEqual([gateway, 409]);
        expect(await res.json()).toEqual({ ok: false, error: 'repo_open_unsupported_provider' });
        expect([gateway, reg.lookups.length, host.length]).toEqual([gateway, 0, 0]);
      }
    } finally { globalThis.fetch = realFetch; }
  });

  it('🔴 os-staging but a grant-bearing body (auth ≠ none): refused as unsupported before any AWS contact', async () => {
    const worker = await loadWorker();
    const { binding: sandbox } = fakeNamespace();
    const reg = awsRegistry(awsRecord());
    const host: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => { host.push(new URL(url as string).pathname); return Response.json({}); }) as typeof fetch;
    try {
      // a public URL carrying a grant, and a staging git-qa remote (basic auth): neither is auth 'none'
      for (const body of [
        JSON.stringify({ repositoryId: PUB_REPO, canonicalURL: PUB_URL, ref: 'refs/heads/main', git: { token: AWS_GRANT, expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
        JSON.stringify({ repositoryId: PUB_REPO, canonicalURL: 'https://git-qa.ezil.work/acme/site.git', ref: 'refs/heads/main', git: { token: AWS_GRANT, expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
      ]) {
        reg.lookups.length = 0; host.length = 0;
        const res = await worker.fetch(await awsSigned(body), { Sandbox: sandbox, AWS_TUNNELS: reg.binding, ...AWS_STAGING });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ ok: false, error: 'repo_open_unsupported_provider' });
        expect([reg.lookups.length, host.length]).toEqual([0, 0]);
      }
    } finally { globalThis.fetch = realFetch; }
  });
});

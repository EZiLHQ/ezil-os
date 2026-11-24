/**
 * `POST /sandbox/:name/repo-open` through the Worker's REAL `fetch()` route
 * table (same `mock.module` technique as `route-auth.test.ts`). Only the
 * Durable Object is faked, and it records what reached it, so "never reached
 * the computer" is an assertion. The DO method's own running check and exec
 * are `repo-open.test.ts`'s; real git is `repo-open.git.test.ts`'s.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, mock, spyOn } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

import { hmacSha256Hex, mintPreviewTokenV2, PREVIEW_TOKEN_PAYLOAD, type PreviewTokenV2Claims } from './hmac';
import { REPO_OPEN_ERRORS, type RepoOpenAnswer, type RepoOpenRequest, type RepoOpenRoot } from './repo-open';

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
  const calls: Array<{ request: RepoOpenRequest; root: RepoOpenRoot; preload?: unknown }> = [];
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    repoOpen: async (...args) => {
      calls.push({ request: args[0] as RepoOpenRequest, root: args[1] as RepoOpenRoot, preload: args[3] });
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

describe('staging assignment repo-open preload', () => {
  const attemptId = '33ac68a4-750a-400b-a2ca-512e3975a849';
  const eventId = '46fc47ce-b0af-4d4f-81b9-3b1f23c3061e';
  const subject = 'auth0|assignment-fixture';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const ownerSha256 = digest(subject);
  const canonicalURL = `https://github.ezil.work/default/u-${ownerSha256.slice(0, 16)}-a-${attemptId}.git`;
  const gitPassword = 'fixtureGitGrant0123456789';
  const nonce = 'de'.repeat(32);
  const manifestSha256 = 'ab'.repeat(32);
  const challenge = { eventId, attemptId, nonce, manifestSha256 };
  const ref = 'refs/heads/main';
  const hex = digest(`ezil-os/repo-url/v1|${canonicalURL}`).slice(0, 32);
  const folderId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16]!, 16) & 3]}${hex.slice(17, 20)}-${hex.slice(20)}`;
  const stage = { EZIL_AI_GATEWAY_URL: 'https://ai-staging.ezil.work' };
  const packet = () => ({
    version: 2,
    repository: { id: 'fixture1', canonicalURL, ref },
    identity: { issuer: 'https://id.ezil.work/', subject },
    git: { username: 'ezil', token: gitPassword, scope: 'write', expiresAt: new Date(Date.now() + 240_000).toISOString() },
  });
  const body = (patch: Record<string, unknown> = {}) => JSON.stringify({
    repositoryId: folderId, privatePacket: packet(), assignmentPreload: challenge, ...patch,
  });
  const folder = `/workspace/projects/${folderId}`;
  const checkoutFolder = folder + '/' + canonicalURL.split('/').at(-1)!.slice(0,-4);

  it('only a matching signed assignment checkout can return the correlated empty-of-credentials ack', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace({ ok: true, folder, checkoutFolder, status: 'cloned', assignmentPreloadAcknowledged: true });
    const res = await worker.fetch(await signed({ signBody: body() }), env(binding, stage));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, folder, checkoutFolder, status: 'cloned',
      assignmentPreload: { eventId, nonce, port: 5679, status: 'acknowledged' } });
    expect(text).not.toContain(gitPassword);
    expect(calls[0]?.preload).toEqual({ eventId, attemptId, ownerSha256, canonicalURL, repositoryId: folderId, ref, manifestSha256 });
    expect(JSON.stringify(calls[0]?.preload)).not.toContain(nonce);
  });

  it('production opt-in binds the authenticated control host, production gateway and canonical owner packet', async () => {
    const worker = await loadWorker();
    const production = { EZIL_AI_GATEWAY_URL: 'https://ai.ezil.work', EZIL_PRODUCTION_ASSIGNMENT_PRELOAD: '1' };
    const desk = 'https://api-desktop.ezil.org';
    for (const [settings, origin, allowed] of [
      [production, desk, true], [{ ...production, EZIL_PRODUCTION_ASSIGNMENT_PRELOAD:'0' }, desk, false],
      [{ ...production, EZIL_AI_GATEWAY_URL:'https://ai-staging.ezil.work' }, desk, false],
      [production, 'https://api-desktop-staging.ezil.work', false],
    ] as const) {
      const { binding, calls } = fakeNamespace({ ok:true, folder, checkoutFolder, status:'cloned', assignmentPreloadAcknowledged:true });
      const res = await worker.fetch(await signed({ signBody:body(), url:origin + PATH }), env(binding,settings));
      const response = await res.json() as { assignmentPreload?: unknown };
      expect(!!response.assignmentPreload).toBe(allowed);
      expect(!!calls[0]?.preload).toBe(allowed);
    }
  });

  it('gates AWS assignment checkout on production authority and the enrolled host acknowledgment', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const userId = '11111111-1111-4111-8111-111111111111';
    const computerId = '22222222-2222-4222-8222-222222222222';
    const sandboxId = 'guac-1111111111114111-2222222222224222';
    const path = `/sandbox/${sandboxId}/repo-open`;
    const record = { computerId, sandboxId, generation: 2, leaseEpoch: 4, originVerified: true, controlKey: btoa('k'.repeat(32)) };
    const request = (origin = 'https://api-desktop.ezil.org') => signed({
      claims: claims({ userId, computerId, sandboxId, provider: 'aws-ec2', generation: 2, leaseEpoch: 4 }),
      path, url: origin + path, signBody: body(),
    });
    const routes = {
      AWS_ROUTING_ENABLED: 'on', AWS_STANDALONE_REPO_OPEN_ENABLED: 'on',
      AWS_ORIGIN_ZONE: 'ezil.org', AWS_ORIGIN_ZONE_ALLOWLIST: 'ezil.org',
      AWS_TUNNELS: { idFromName: (id: string) => id, get: () => ({ fetch: async () => Response.json({ record }) }) },
    };
    const production = { EZIL_AI_GATEWAY_URL: 'https://ai.ezil.work', EZIL_PRODUCTION_ASSIGNMENT_PRELOAD: '1' };
    const ordinary = { ok: true, folder, status: 'cloned' };
    const qualified = { ...ordinary, checkoutFolder,
      assignmentPreload: { eventId, nonce, port: 5679, status: 'acknowledged' } };
    let result = ordinary;
    const host = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => init?.method === 'POST'
      ? Response.json({ ok: true, state: 'running' }, { status: 202 })
      : Response.json({ ok: true, state: 'done', result }));
    try {
      for (const [origin, gateway] of [
        ['https://api-desktop-staging.ezil.work', production.EZIL_AI_GATEWAY_URL],
        ['https://api-desktop.ezil.org', 'https://ai-staging.ezil.work'],
      ]) {
        const refused = await worker.fetch(await request(origin), env(binding, { ...routes, ...production, EZIL_AI_GATEWAY_URL: gateway }));
        expect(refused.status).toBe(400);
        expect(host).not.toHaveBeenCalled();
      }

      const disabled = await worker.fetch(await request(), env(binding, { ...routes, ...production, EZIL_PRODUCTION_ASSIGNMENT_PRELOAD: '0' }));
      expect(await disabled.json()).toEqual(ordinary);
      expect(JSON.parse(String(host.mock.calls[0]![1]?.body))).not.toHaveProperty('assignmentPreload');
      host.mockClear();

      const missingAck = await worker.fetch(await request(), env(binding, { ...routes, ...production }));
      expect(missingAck.status).toBe(502);
      host.mockClear();

      result = qualified;
      const response = await worker.fetch(await request(), env(binding, { ...routes, ...production }));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(qualified);
      expect(text).not.toContain(gitPassword);
      expect(calls).toHaveLength(0);
      expect(host.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
      const [target, init] = host.mock.calls[0]!;
      expect(new URL(String(target)).hostname).toBe(`c-${sandboxId}-g2-e4.ezil.org`);
      expect(JSON.parse(String(init?.body)).assignmentPreload).toEqual({
        eventId, attemptId, nonce, ownerSha256, canonicalURL, repositoryId: folderId, ref, manifestSha256,
      });
    } finally {
      host.mockRestore();
    }
  });

  it('keeps Code open when the runtime has no loopback ack; no inferred receipt from a repo or a port', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace({ ok: true, folder, status: 'fetched' });
    const res = await worker.fetch(await signed({ signBody: body() }), env(binding, stage));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, folder, status: 'fetched' });
    expect(calls[0]?.preload).toBeDefined();
  });

  it('ordinary, non-stage, mismatched, read-only, refresh and malformed requests never signal preload', async () => {
    const worker = await loadWorker();
    const base = packet();
    const alternatives: Array<[string, Record<string, string>]> = [
      [BODY, stage],
      [body({ assignmentPreload: undefined }), stage],
      [body(), { EZIL_AI_GATEWAY_URL: 'https://ai.ezil.work' }],
      [body({ assignmentPreload: { ...challenge, attemptId: eventId } }), stage],
      [body({ assignmentPreload: { ...challenge, nonce: 'short' } }), stage],
      [body({ assignmentPreload: { ...challenge, executable: true } }), stage],
      [body({ privatePacket: { ...base, identity: { ...base.identity, subject: 'auth0|different' } } }), stage],
      [body({ privatePacket: { ...base, repository: { ...base.repository, ref: 'refs/heads/ordinary' } } }), stage],
      [body({ privatePacket: { ...base, git: { ...base.git, scope: 'read' } } }), stage],
      [body({ repositoryId: REPO }), stage],
      [body({ refreshOnly: true }), stage],
    ];
    for (const [value, settings] of alternatives) {
      const { binding, calls } = fakeNamespace();
      const res = await worker.fetch(await signed({ signBody: value }), env(binding, settings));
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('assignmentPreload');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.preload).toBeUndefined();
    }
  });

  it('refuses a modified signed challenge before the runtime is reached', async () => {
    const worker = await loadWorker();
    const { binding, calls } = fakeNamespace();
    const signBody = body();
    const res = await worker.fetch(await signed({ signBody, sendBody: signBody.replace(nonce, 'ff'.repeat(32)) }), env(binding, stage));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('never forwards the reserved port through direct or nested Code HTTP and websocket entries', async () => {
    const worker = await loadWorker();
    const { binding } = fakeNamespace();
    for (const target of [
      'https://5679-guac-user1-comp1-code.ezil.org/',
      'https://aws-5679-guac-user1-comp1-aws.ezil.org/',
      'https://8443-guac-user1-comp1-code.ezil.org/proxy/5679/',
      'https://8443-guac-user1-comp1-code.ezil.org/preview/absproxy/%35%36%37%39/',
      'https://aws-8443-guac-user1-comp1-aws.ezil.org/preview/proxy/5679/',
    ]) {
      for (const upgrade of [false, true]) {
        const res = await worker.fetch(new Request(target, { headers: upgrade ? { upgrade: 'websocket' } : {} }), env(binding));
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ ok: false, error: 'not_found' });
      }
    }
  });
});

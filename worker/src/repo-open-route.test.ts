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

const SECRET = 'repo-open-route-secret';
const SANDBOX = 'guac-user1-comp1';
const PATH = `/sandbox/${SANDBOX}/repo-open`;
const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
const TOKEN = `egg_${'ab12'.repeat(16)}`;
const HEAD = 'c'.repeat(40);
const BODY = JSON.stringify({
  repositoryId: REPO,
  canonicalURL: 'https://github.ezil.work/acme/site.git',
  ref: 'refs/heads/main',
  git: { token: TOKEN, expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() },
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
    expect(calls[0]!.request).toMatchObject({ repositoryId: REPO, branch: 'main', token: TOKEN });
    // R2-backed workspace: the root code-server opens, which must be hydrated in the container.
    expect(calls[0]!.root).toEqual({ path: '/workspace', requireHydrated: true });
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

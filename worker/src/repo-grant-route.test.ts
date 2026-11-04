/**
 * `POST /sandbox/:name/repo-grant` and the open's grant subject, through the Worker's REAL `fetch()` route table
 * (the `mock.module` technique of repo-open-route.test.ts). Only the Durable Object is faked; it records what
 * reached it, so "never reached the computer" is an assertion.
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

import { mintPreviewTokenV2, type PreviewTokenV2Claims } from './hmac';
import { repoGrantSubject, REPO_GRANT_ERRORS, type RepoGrantAnswer, type RepoGrantRequest } from './repo-grant';
import type { RepoOpenAnswer, RepoOpenRoot } from './repo-open';

const SECRET = 'repo-grant-route-secret';
const SANDBOX = 'guac-user1-comp1';
const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
const EGG = `egg_${'cd34'.repeat(16)}`;
const path = (op: string) => `/sandbox/${SANDBOX}/${op}`;
const claims = (patch: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims => ({
  ts: Date.now(), sandboxId: SANDBOX, computerId: 'comp-1', userId: 'user-1', provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0, ...patch,
});
const grantBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git',
  git: { token: EGG, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'write' }, ...over,
});

function fakeNamespace(grantAnswer: RepoGrantAnswer = { ok: true, expiresAt: '2026-11-03T14:04:00.000Z' }) {
  const grants: Array<{ request: RepoGrantRequest; root: RepoOpenRoot; subject: string }> = [];
  const opens: Array<{ subject: unknown }> = [];
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    repoGrant: async (...args) => { grants.push({ request: args[0] as RepoGrantRequest, root: args[1] as RepoOpenRoot, subject: args[2] as string }); return grantAnswer; },
    repoOpen: async (...args) => {
      opens.push({ subject: args[2] });
      return { ok: true, folder: `/workspace/projects/${REPO}`, head: 'c'.repeat(40), status: 'cloned' } satisfies RepoOpenAnswer;
    },
  };
  const stub = new Proxy({}, { get(_t, prop) { if (typeof prop !== 'string' || prop === 'then') return undefined; return impl[prop] ?? (async () => undefined); } });
  return { binding: { idFromName: (name: string) => ({ name }), get: () => stub }, grants, opens };
}
async function loadWorker(): Promise<{ fetch(request: Request, env: unknown): Promise<Response> }> {
  return ((await import('./index')) as unknown as { default: { fetch(request: Request, env: unknown): Promise<Response> } }).default;
}
async function signed(op: string, body: string, c: PreviewTokenV2Claims = claims()) {
  const token = await mintPreviewTokenV2(SECRET, c, { method: 'POST', path: path(op), body });
  return new Request(`https://api-desktop.ezil.org${path(op)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ezil-auth': token }, body });
}
const env = (binding: unknown, extra: Record<string, unknown> = {}) => ({ Sandbox: binding, SANDBOX_HMAC_SECRET: SECRET, SANDBOX_WORKSPACE_R2_BUCKET: {}, ...extra });

describe('POST /sandbox/:name/repo-grant on the real route table', () => {
  it('a valid refresh reaches THIS computer with the parsed grant, the workspace root and the subject digest; the answer holds no token', async () => {
    const worker = await loadWorker();
    const { binding, grants } = fakeNamespace();
    const res = await worker.fetch(await signed('repo-grant', grantBody()), env(binding));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, expiresAt: '2026-11-03T14:04:00.000Z' });
    expect(text).not.toContain(EGG);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.request).toMatchObject({ repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', token: EGG, scope: 'write' });
    expect(grants[0]!.root).toEqual({ path: '/workspace', requireHydrated: true });
    expect(grants[0]!.subject).toBe(await repoGrantSubject('user-1'));
  });

  it('v2 only, Cloudflare only, the body checked before the computer is reached', async () => {
    const worker = await loadWorker();
    const cases: Array<[Request | (() => Promise<Request>), Record<string, unknown>, number, string]> = [
      [new Request(`https://api-desktop.ezil.org${path('repo-grant')}`, { method: 'POST', body: grantBody() }), {}, 401, 'hmac_v2_required'],
      [() => signed('repo-grant', grantBody(), claims({ provider: 'aws-ec2' })), {}, 409, 'repo_open_unsupported_provider'],
      [() => signed('repo-grant', grantBody(), claims({ sandboxId: 'guac-other-comp' })), {}, 401, 'hmac_v2_sandbox_mismatch'],
      [() => signed('repo-grant', grantBody({ ref: 'refs/heads/main' })), {}, 400, 'repo_open_invalid_request'],
      [() => signed('repo-grant', grantBody({ canonicalURL: `https://${'0123456789abcdef'.repeat(2)}.artifacts.cloudflare.net/git/universe-staging/p-${REPO}.git` })), {}, 400, 'repo_grant_unsupported_remote'],
      [() => signed('repo-grant', grantBody({ canonicalURL: 'https://git-qa.ezil.work/acme-qa/site.git' })), {}, 400, 'repo_open_invalid_request'],
      [() => signed('repo-grant', grantBody({ git: { token: EGG, expiresAt: new Date(Date.now() + 10_000).toISOString(), scope: 'write' } })), {}, 409, 'repo_open_token_expired'],
    ];
    for (const [make, extra, status, error] of cases) {
      const { binding, grants } = fakeNamespace();
      const res = await worker.fetch(typeof make === 'function' ? await make() : make, env(binding, extra));
      expect({ error, status: res.status, body: await res.json() }).toMatchObject({ error, status, body: { ok: false, error } });
      expect(grants).toHaveLength(0);
    }
  });

  it('on os-staging a Builder project\'s git-qa remote refreshes too', async () => {
    const worker = await loadWorker();
    const { binding, grants } = fakeNamespace();
    const res = await worker.fetch(await signed('repo-grant', grantBody({ canonicalURL: 'https://git-qa.ezil.work/acme-qa/site.git' })),
      env(binding, { EZIL_AI_GATEWAY_URL: 'https://ai-staging.ezil.work' }));
    expect(res.status).toBe(200);
    expect(grants[0]!.request.canonicalURL).toBe('https://git-qa.ezil.work/acme-qa/site.git');
  });

  it('the computer\'s refusals are codes with their statuses; nothing else leaks', async () => {
    const worker = await loadWorker();
    for (const [error, status] of [['repo_grant_not_open', 409], ['repo_grant_conflict', 409], ['runtime_not_running', 409], ['repo_grant_failed', 502]] as const) {
      const { binding } = fakeNamespace({ ok: false, error });
      const res = await worker.fetch(await signed('repo-grant', grantBody()), env(binding));
      expect({ error, status: res.status, body: await res.json() }).toEqual({ error, status, body: { ok: false, error } });
    }
  });

  it('repo-open hands the computer the same subject digest (the slot owner for the grant an open installs)', async () => {
    const worker = await loadWorker();
    const { binding, opens } = fakeNamespace();
    const body = JSON.stringify({ repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main',
      git: { token: EGG, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'write' } });
    const res = await worker.fetch(await signed('repo-open', body, claims({ userId: 'user-7' })), env(binding));
    expect(res.status).toBe(200);
    expect(opens[0]!.subject).toBe(await repoGrantSubject('user-7'));
  });

  it('every repo-grant code is in PUBLIC_ERROR_CODES (otherwise json() would answer internal_error)', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const list = /const PUBLIC_ERROR_CODES = \[([\s\S]*?)\] as const;/.exec(source)![1]!;
    const codes = new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    expect([...REPO_GRANT_ERRORS, 'runtime_not_running'].filter((c) => !codes.has(c))).toEqual([]);
  });
});

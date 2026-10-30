import { describe, expect, it, mock } from 'bun:test';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));
import { mintPreviewTokenV2, type PreviewTokenV2Claims } from './hmac';
import { realR2KeyPrefix } from './workspace-seed';
import { DEFAULT_WORKSPACE_BRANCH, importWorkspacePrefix, workspaceMountPrefix, workspacePrefixOverride } from './workspace-prefix';

const SECRET = 'workspace-prefix-tests-only';
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '9a3f0c1e-5b7d-4e2a-8c6b-0d1e2f3a4b5c';
const NAME = `guac-${USER.replace(/-/g, '').slice(0, 16)}-${COMPUTER.replace(/-/g, '').slice(0, 16)}`;

/** The real `/sandbox/preview` route, stopped at its hydrate: returns the prefix the open hands the Durable Object. */
async function hydratedPrefix(extraEnv: Record<string, unknown> = {}, bodyExtra: Record<string, unknown> = {}): Promise<string> {
  const mod = await import('./index');
  const hydrations: Array<{ prefix: string; mountPath: string }> = [];
  const stub = new Proxy({}, { get(_target, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (prop === 'hydrateWorkspace') {
      return async (params: { prefix: string; mountPath: string }) => { hydrations.push(params); return { mounted: false, detail: 'migrating' }; };
    }
    return async () => undefined;
  } });
  const body = JSON.stringify({ projectId: COMPUTER, userId: USER, desktopMode: 'neko', ...bodyExtra });
  const claims: PreviewTokenV2Claims = { ts: Date.now(), sandboxId: NAME, computerId: COMPUTER, userId: USER,
    provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0 };
  const token = await mintPreviewTokenV2(SECRET, claims, { method: 'POST', path: '/sandbox/preview', body });
  const response = await mod.default.fetch(new Request('https://api-desktop.ezil.org/sandbox/preview', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ezil-auth': token }, body,
  }), { Sandbox: { idFromName: (name: string) => ({ name }), get: () => stub }, SANDBOX_WORKSPACE_R2_BUCKET: {},
    SANDBOX_HMAC_SECRET: SECRET, ...extraEnv } as never);
  expect(response.status).toBe(409);
  expect(hydrations).toHaveLength(1);
  return hydrations[0]!.prefix;
}

describe('workspace prefix (reverse-move contract §4.1, P)', () => {
  it('pins P to the computer id and the main branch', () => {
    expect(importWorkspacePrefix(COMPUTER)).toBe(`${COMPUTER}/branches/main`);
    expect(DEFAULT_WORKSPACE_BRANCH).toBe('main');
  });

  it('keeps the open route\'s `??` semantics: only an absent override falls back to the computer prefix', () => {
    const scope = { projectId: COMPUTER, branch: 'main' };
    expect(workspaceMountPrefix(undefined, scope)).toBe(`/${COMPUTER}/branches/main`);
    expect(workspaceMountPrefix('/fixed/scope', scope)).toBe('/fixed/scope');
    // An empty override is still an override (never the per-computer default).
    expect(workspaceMountPrefix('', scope)).toBe('');
  });

  it('reads the deployment-wide override exactly as the mount config does (trimmed, present at all)', () => {
    expect(workspacePrefixOverride({})).toBeUndefined();
    expect(workspacePrefixOverride({ SANDBOX_WORKSPACE_S3_PREFIX: ' /fixed/scope ' })).toBe('/fixed/scope');
    expect(workspacePrefixOverride({ SANDBOX_WORKSPACE_S3_PREFIX: '' })).toBe('');
    expect(workspacePrefixOverride({ SANDBOX_WORKSPACE_S3_PREFIX: '   ' })).toBe('');
  });

  it('the open route hydrates exactly P for this computer (no branch sent, no override)', async () => {
    expect(realR2KeyPrefix(await hydratedPrefix())).toBe(importWorkspacePrefix(COMPUTER));
  });

  it('an explicit main branch hydrates P too', async () => {
    expect(realR2KeyPrefix(await hydratedPrefix({}, { branch: 'main' }))).toBe(importWorkspacePrefix(COMPUTER));
  });

  it('with any override present the open hydrates something else, and the import refuses on exactly that condition', async () => {
    for (const value of ['/fixed/scope', '', '  ', `/${COMPUTER}/branches/main`]) {
      const env = { SANDBOX_WORKSPACE_S3_PREFIX: value };
      const hydrated = await hydratedPrefix(env);
      expect(hydrated).toBe(workspaceMountPrefix(workspacePrefixOverride(env), { projectId: COMPUTER, branch: 'main' }));
      // Deployment-wide: even an override that happens to equal P is refused (`prefix_mismatch`).
      expect(workspacePrefixOverride(env)).not.toBeUndefined();
    }
  });
});

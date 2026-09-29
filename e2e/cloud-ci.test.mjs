import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deployedTarget, configureAppContext } from './deployed-target.mjs';
import { assertVercelDeployment, assertWorkerDeployment, verifyCloudDeployment } from './verify-cloud-deployment.mjs';

const sha = 'a'.repeat(40);
const target = { sha, app: 'https://preview-test.vercel.app', project: 'prj_test', target: 'preview' };
const deployment = {
  id: 'dpl_test', url: 'preview-test.vercel.app', readyState: 'READY',
  target: null, projectId: 'prj_test', meta: { githubCommitSha: sha },
};
const deployments = [{ versions: [{ version_id: 'version-test', percentage: 100 }] }];
const version = { id: 'version-test', annotations: { 'workers/message': `git:${sha}` } };
const env = {
  EZIL_DEPLOY_SHA: sha, EZIL_DEPLOY_TARGET: 'preview', EZIL_E2E_APP: target.app,
  EZIL_E2E_WORKER: 'https://worker.staging.example', EZIL_WORKER_NAME: 'os-staging',
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-test-token',
  VERCEL_TOKEN: 'vercel-test-token', VERCEL_ORG_ID: 'team_test', VERCEL_PROJECT_ID: 'prj_test',
};

test('Vercel identity requires exact project, URL, full SHA, target and READY', () => {
  assert.equal(assertVercelDeployment(deployment, target), 'dpl_test');
  for (const patch of [
    { readyState: 'BUILDING' }, { projectId: 'another-project' }, { url: 'other.vercel.app' },
    { meta: { githubCommitSha: 'c'.repeat(40) } }, { meta: {} }, { target: 'production' }, { id: '' },
  ]) assert.throws(() => assertVercelDeployment({ ...deployment, ...patch }, target));
  assert.equal(assertVercelDeployment({ ...deployment, target: 'production' }, { ...target, target: 'production' }), 'dpl_test');
});

test('Worker identity refuses missing, stale and split deployments', () => {
  assert.equal(assertWorkerDeployment(deployments, version, sha), 'version-test');
  for (const list of [undefined, [], [{ versions: [] }],
    [{ versions: [{ version_id: version.id, percentage: 10 }] }],
    [{ versions: [{ version_id: version.id, percentage: 100 }, { version_id: 'old', percentage: 0 }] }],
  ]) assert.throws(() => assertWorkerDeployment(list, version, sha));
  assert.throws(() => assertWorkerDeployment(deployments, { ...version, id: 'old' }, sha));
  assert.throws(() => assertWorkerDeployment(deployments, { ...version, annotations: {} }, sha));
  assert.throws(() => assertWorkerDeployment(deployments, version, 'c'.repeat(40)));
});

function fakeAPI(overrides = {}) {
  const calls = [];
  return { calls, fetch: async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    let value;
    if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/deployments')) {
      value = { success: true, result: { deployments } };
    } else if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/versions/version-test')) {
      value = { success: true, result: version };
    } else if (url.hostname === 'worker.staging.example' && url.pathname === '/health') {
      value = { ok: true, build: 'ezil-os', supportedDesktopModes: ['neko'] };
    } else if (url.hostname === 'api.vercel.com' && url.pathname.startsWith('/v13/deployments/')) {
      value = deployment;
    } else if (url.hostname === 'api.vercel.com' && url.pathname.startsWith('/v9/projects/')) {
      value = { id: 'prj_test', rootDirectory: 'app' };
    } else throw new Error(`Unexpected request: ${url}`);
    const response = overrides[url.pathname] ?? value;
    return { ok: true, json: async () => response };
  } };
}

test('provider readbacks bind both deployments to one SHA without forwarding API tokens', async () => {
  const api = fakeAPI();
  const result = await verifyCloudDeployment(env, api.fetch);
  assert.deepEqual(result, { worker_version: version.id, vercel_deployment: deployment.id, sha, url: target.app });
  assert.equal(api.calls.length, 4);
  for (const { url, options } of api.calls) {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.authorization, url.hostname === 'api.cloudflare.com'
      ? 'Bearer cf-test-token' : url.hostname === 'api.vercel.com' ? 'Bearer vercel-test-token' : undefined);
    if (url.hostname === 'api.vercel.com') assert.equal(url.searchParams.get('teamId'), 'team_test');
  }
});

test('Worker-only gate does not need Vercel or an app URL', async () => {
  const api = fakeAPI();
  const result = await verifyCloudDeployment({ ...env, VERCEL_TOKEN: '', EZIL_E2E_APP: '' }, api.fetch, 'worker');
  assert.deepEqual(result, { worker_version: version.id, sha });
  assert.equal(api.calls.length, 3);
});

test('project preflight refuses the wrong source root before deployment', async () => {
  const api = fakeAPI();
  assert.deepEqual(await verifyCloudDeployment(env, api.fetch, 'project'), { project: 'prj_test', root_directory: 'app' });
  assert.equal(api.calls.length, 1);
  const wrong = fakeAPI({ '/v9/projects/prj_test': { id: 'prj_test', rootDirectory: null } });
  await assert.rejects(verifyCloudDeployment(env, wrong.fetch, 'project'), /rootDirectory/);
});

test('missing inputs, API errors, bad health and stale Vercel metadata fail closed', async () => {
  for (const patch of [{ EZIL_DEPLOY_SHA: 'abc' }, { CLOUDFLARE_API_TOKEN: '' },
    { EZIL_E2E_WORKER: 'http://worker.staging.example' }, { EZIL_E2E_APP: '' }, { VERCEL_TOKEN: '' }]) {
    await assert.rejects(verifyCloudDeployment({ ...env, ...patch }, fakeAPI().fetch));
  }
  await assert.rejects(verifyCloudDeployment(env, async () => ({ ok: false, status: 403 })), /HTTP 403/);
  await assert.rejects(verifyCloudDeployment(env, fakeAPI({ '/health': { ok: true, build: 'legacy' } }).fetch), /different application/);
  await assert.rejects(verifyCloudDeployment(env, fakeAPI({ '/v13/deployments/preview-test.vercel.app': {
    ...deployment, meta: { githubCommitSha: 'c'.repeat(40) },
  } }).fetch), /SHA differs/);
});

test('target selection preserves legacy default but requires explicit cloud CI URL', () => {
  assert.equal(deployedTarget({}).app, 'https://ezil-os.vercel.app');
  assert.equal(deployedTarget({ EZIL_E2E_APP: `${target.app}/` }).app, target.app);
  assert.equal(deployedTarget({ EZIL_E2E_APP: 'http://127.0.0.1:3000' }).app, 'http://127.0.0.1:3000');
  assert.throws(() => deployedTarget({ EZIL_E2E_REQUIRE_TARGET: '1' }), /required/);
  for (const app of ['', 'http://remote.example', 'https://user:secret@example.com',
    'https://example.com/os', 'https://example.com/?token=test', 'https://example.com/#fragment']) {
    assert.throws(() => deployedTarget({ EZIL_E2E_APP: app }));
  }
});

test('Vercel browser bypass is scoped to the app and cannot follow a redirect', async () => {
  let handler;
  const context = { route: async (_pattern, callback) => { handler = callback; } };
  const headers = { 'x-vercel-protection-bypass': 'test-bypass' };
  await configureAppContext(context, { app: target.app, headers });
  for (const url of [`${target.app}/login`, 'https://worker.staging.example/frame', 'https://third-party.example/']) {
    const calls = [];
    await handler({
      request: () => ({ url: () => url, headers: () => ({ accept: '*/*' }) }),
      continue: async (...args) => calls.push(['continue', ...args]),
      fetch: async (options) => { calls.push(['fetch', options]); return 'response'; },
      fulfill: async (options) => calls.push(['fulfill', options]),
    });
    if (url.startsWith(target.app)) {
      assert.equal(calls[0][1].maxRedirects, 0);
      assert.deepEqual(calls[0][1].headers, { accept: '*/*', ...headers });
      assert.deepEqual(calls[1], ['fulfill', { response: 'response' }]);
    } else assert.deepEqual(calls, [['continue']]);
  }
});

test('Vercel bypass route tolerates context disposal but surfaces live request errors', async () => {
  let handler;
  await configureAppContext({ route: async (_pattern, callback) => { handler = callback; } }, {
    app: target.app, headers: { 'x-vercel-protection-bypass': 'test-bypass' },
  });
  const route = (error) => ({
    request: () => ({ url: () => `${target.app}/os`, headers: () => ({}) }),
    fetch: async () => { throw error; },
    fulfill: async () => { throw new Error('fulfill should not run'); },
  });
  await assert.doesNotReject(handler(route(new Error('route.fetch: Request context disposed.'))));
  await assert.rejects(handler(route(new Error('origin fetch failed'))), /origin fetch failed/);
});

test('bundle gate accepts matching bytes, rejects stale bytes and bounds hung requests', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-cloud-ci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (source) => {
    // File descriptors also work in restricted runners that disallow the
    // socket pairs Node uses for subprocess stdio pipes.
    const log = path.join(dir, 'bundle.log');
    const fd = fs.openSync(log, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(source)}`, 'e2e/await-deployed-bundle.mjs',
      ], {
        env: { ...process.env, EZIL_E2E_APP: target.app, EZIL_DEPLOY_WAIT_MS: '100' },
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', fd, fd],
      });
    } finally { fs.closeSync(fd); }
    return { ...result, stderr: fs.readFileSync(log, 'utf8') };
  };
  const exact = run("import fs from 'node:fs'; globalThis.fetch = async () => new Response(fs.readFileSync('app/public/os/bundle.min.js'));");
  assert.ifError(exact.error);
  assert.equal(exact.status, 0, exact.stderr);
  const stale = run("globalThis.fetch = async () => new Response('old bundle');");
  assert.ifError(stale.error);
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /DIFFERENT build/);
  const hung = run("globalThis.fetch = async (_, {signal}) => new Promise((_, reject) => { const timer = setTimeout(() => {}, 2000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }); });");
  assert.ifError(hung.error);
  assert.equal(hung.status, 1, hung.stderr);
  assert.match(hung.stderr, /aborted/);
});

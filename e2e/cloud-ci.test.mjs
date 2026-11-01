import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import './desktop-resize-ready.test.mjs';
import './viewer-progress.test.mjs';
import './process-continuity.test.mjs';
import './isolated-computer.test.mjs';
import './cleanup-hosted-computer.test.mjs';
import './prepare-hosted-computer.test.mjs';
import './editor-shortcut.test.mjs';
import './relay-lifetime.test.mjs';
import './await-container-rollout.test.mjs';
import './vercel-api.test.mjs';
import { awaitContainerRollout } from './await-container-rollout.mjs';
import http from 'node:http';
import { deployedTarget, configureAppContext, APP_FETCH_TIMEOUT_MS, APP_STOP_FETCH_TIMEOUT_MS, appFetchTimeout, appRequest } from './deployed-target.mjs';
import './sign-in.test.mjs';
import './code-picker.test.mjs';
import { assertVercelDeployment, assertWorkerDeployment, verifyCloudDeployment } from './verify-cloud-deployment.mjs';
import { outline, parseWorkflow } from '../.github/scripts/env-contract.mjs';
import { MAX_CHECK_MS, FINAL_STOP_TIMEOUT_MS, MAX_RUN_MS } from './live-check.mjs';

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
  assert.equal(deployedTarget({}).app, 'https://os.ezil.work');
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
      request: () => ({ url: () => url, method: () => 'GET', headers: () => ({ accept: '*/*' }) }),
      continue: async (...args) => calls.push(['continue', ...args]),
      fetch: async (options) => { calls.push(['fetch', options]); return 'response'; },
      fulfill: async (options) => calls.push(['fulfill', options]),
    });
    if (url.startsWith(target.app)) {
      assert.equal(calls[0][1].maxRedirects, 0);
      assert.equal(calls[0][1].timeout, 240_000, 'a cold desktop start must not be cut off by the harness');
      assert.deepEqual(calls[0][1].headers, { accept: '*/*', ...headers });
      assert.deepEqual(calls[1], ['fulfill', { response: 'response' }]);
    } else assert.deepEqual(calls, [['continue']]);
  }
});

test('checkpoint stop bypass leaves room for the provider budget and bounds hung requests', async () => {
  assert.ok(APP_STOP_FETCH_TIMEOUT_MS > 270000 && APP_STOP_FETCH_TIMEOUT_MS < 300000);
  const request = (method, path) => ({ method: () => method, url: () => `${target.app}${path}`, headers: () => ({}) });
  assert.equal(appFetchTimeout(request('POST', '/api/shell/stop')), APP_STOP_FETCH_TIMEOUT_MS);
  for (const [method, path] of [['GET', '/api/shell/stop'], ['POST', '/api/shell/desktop'], ['POST', '/api/shell/stop-other']]) {
    assert.equal(appFetchTimeout(request(method, path)), APP_FETCH_TIMEOUT_MS);
  }
  let handler, sent, fulfilled;
  await configureAppContext({ route: async (_pattern, callback) => { handler = callback; },
    cookies: async (url) => { assert.equal(url, `${target.app}/api/shell/stop`); return [{ name: 'sb', value: 'session' }]; } },
  { app: target.app, headers: { 'x-vercel-protection-bypass': 'test-bypass' },
    send: async (url, options) => { sent = [url, options]; return { status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'], connection: 'close', 'content-length': '2' }, body: Buffer.from('{}') }; } });
  await handler({ request: () => ({ ...request('POST', '/api/shell/stop'), headers: () => ({ 'content-type': 'application/json' }),
    postDataBuffer: () => Buffer.from('{"computerId":"x"}') }),
  fetch: async () => { throw new Error('API calls must not use the keep-alive client'); }, fulfill: async value => { fulfilled = value; } });
  const { signal, ...options } = sent[1];
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.deepEqual([sent[0], options], [`${target.app}/api/shell/stop`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-protection-bypass': 'test-bypass', cookie: 'sb=session' },
    body: Buffer.from('{"computerId":"x"}'), timeout: APP_STOP_FETCH_TIMEOUT_MS }]);
  assert.deepEqual(fulfilled, { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'a=1\nb=2' }, body: Buffer.from('{}') });
});

test('a public target without a bypass still sends API calls over the probe-free transport', async () => {
  let handler, close, sent;
  const context = { route: async (_pattern, callback) => { handler = callback; }, on: (event, callback) => { if (event === 'close') close = callback; },
    cookies: async () => [] };
  await configureAppContext(context, { app: target.app, headers: {},
    send: async (url, options) => { sent = options; return { status: 200, headers: {}, body: Buffer.from('{}') }; } });
  assert.ok(handler, 'route must be installed without a bypass');
  const calls = [];
  const route = path => ({ request: () => ({ url: () => `${target.app}${path}`, method: () => 'GET', headers: () => ({}), postDataBuffer: () => null }),
    continue: async () => calls.push(['continue', path]), fetch: async () => { throw new Error('no route.fetch without a bypass'); },
    fulfill: async () => calls.push(['fulfill', path]) });
  await handler(route('/os'));
  await handler(route('/api/shell/desktop'));
  assert.deepEqual(calls, [['continue', '/os'], ['fulfill', '/api/shell/desktop']]);
  assert.equal(sent.headers['x-vercel-protection-bypass'], undefined);
  // Closing the context aborts an API call still in flight, and its failure stays quiet.
  close();
  assert.equal(sent.signal.aborted, true);
  const aborted = { ...route('/api/shell/stop'), fulfill: async () => { throw new Error('fulfill should not run'); } };
  await configureAppContext({ ...context, route: async (_p, cb) => { handler = cb; } }, { app: target.app, headers: {},
    send: async () => { throw new Error('This operation was aborted'); } });
  close();
  await assert.doesNotReject(handler(aborted));
});

test('app API transport sends a fresh connection, never follows redirects and bounds silent responses', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/silent') return;
      res.writeHead(302, { location: 'https://elsewhere.example/', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      res.end('moved');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await appRequest(`${origin}/api/shell/stop`, { method: 'POST', body: '{"computerId":"x"}', timeout: 5000,
    headers: { ':authority': 'x', host: 'spoofed', connection: 'keep-alive', 'content-length': '1', 'accept-encoding': 'gzip', cookie: 'sb=1', 'x-vercel-protection-bypass': 'b' } });
  assert.equal(response.status, 302);
  assert.deepEqual(response.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(response.body.toString(), 'moved');
  assert.equal(seen.length, 1, 'redirect must not be followed');
  assert.equal(seen[0].body, '{"computerId":"x"}');
  assert.equal(seen[0].headers.host, `127.0.0.1:${server.address().port}`);
  assert.equal(seen[0].headers.connection, 'close', 'no pooled keep-alive socket');
  assert.equal(seen[0].headers['accept-encoding'], 'identity');
  assert.equal(seen[0].headers.cookie, 'sb=1');
  assert.equal(seen[0].headers['x-vercel-protection-bypass'], 'b');
  const error = await appRequest(`${origin}/silent`, { headers: { cookie: 'sb=SECRET', 'x-vercel-protection-bypass': 'BYPASS' }, timeout: 300 })
    .then(() => null, e => e);
  assert.ok(error, 'a silent response must time out');
  const controller = new AbortController();
  const pending = appRequest(`${origin}/silent`, { timeout: 60_000, signal: controller.signal }).then(() => null, e => e);
  controller.abort();
  assert.ok(await pending, 'an aborted request must reject promptly');
  for (const secret of ['SECRET', 'BYPASS']) assert.equal(`${error.message}${error.stack}${error.cause ?? ''}`.includes(secret), false);
});

test('Vercel bypass route tolerates context disposal but surfaces live request errors', async () => {
  let handler;
  await configureAppContext({ route: async (_pattern, callback) => { handler = callback; } }, {
    app: target.app, headers: { 'x-vercel-protection-bypass': 'test-bypass' },
  });
  const route = (error) => ({
    request: () => ({ url: () => `${target.app}/os`, method: () => 'POST', headers: () => ({}) }),
    fetch: async () => { throw error; },
    fulfill: async () => { throw new Error('fulfill should not run'); },
  });
  await assert.doesNotReject(handler(route(new Error('route.fetch: Request context disposed.'))));
  await assert.rejects(handler(route(new Error('origin fetch failed'))), /bypass fetch failed POST \/os: origin fetch failed/);
});

test('🔴 a failed bypass fetch never prints request headers (public CI logs)', async () => {
  let handler;
  await configureAppContext({ route: async (_pattern, callback) => { handler = callback; } }, {
    app: target.app, headers: { 'x-vercel-protection-bypass': 'test-bypass' },
  });
  // The shape Playwright really throws: a reason line, then a call log that
  // repeats every header of the request.
  const playwright = Object.assign(new Error([
    'route.fetch: Timeout 30000ms exceeded.',
    'Call log:',
    `  - → GET ${target.app}/os`,
    '    - cookie: __Host-ezil-os-auth=base64-SESSION-WITH-REFRESH-TOKEN',
    '    - x-vercel-protection-bypass: test-bypass',
  ].join('\n')), { name: 'TimeoutError' });
  const error = await handler({
    request: () => ({ url: () => `${target.app}/os`, method: () => 'GET', headers: () => ({}) }),
    fetch: async () => { throw playwright; },
    fulfill: async () => { throw new Error('fulfill should not run'); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'the failure must still surface');
  assert.equal(error.name, 'TimeoutError');
  assert.match(error.message, /GET \/os: route\.fetch: Timeout 30000ms exceeded\.$/);
  for (const secret of ['SESSION-WITH-REFRESH-TOKEN', 'test-bypass', 'cookie', 'Call log']) {
    assert.equal(error.message.includes(secret), false, `leaked ${secret}`);
    assert.equal(String(error.stack ?? '').includes(secret), false, `leaked ${secret} via stack`);
  }
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

test('production requires both production aliases to resolve the exact returned deployment', async () => {
  const prod = { ...deployment, target: 'production' };
  const prodEnv = { ...env, EZIL_DEPLOY_TARGET: 'production', EZIL_E2E_WORKER: 'https://api-desktop.ezil.org' };
  const api = (alias = prod, legacy = prod) => async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api-desktop.ezil.org') return { ok:true, json:async()=>({ok:true,build:'ezil-os',supportedDesktopModes:['neko']}) };
    if (url.pathname.endsWith('/os.ezil.work')) return {ok:true,json:async()=>alias};
    if (url.pathname.endsWith('/ezil-os-preview-ezil1.vercel.app')) return {ok:true,json:async()=>legacy};
    return fakeAPI({ '/v13/deployments/preview-test.vercel.app': prod }).fetch(input, options);
  };
  const result = await verifyCloudDeployment(prodEnv, api());
  assert.equal(result.canonical_url, 'https://os.ezil.work');
  await assert.rejects(verifyCloudDeployment(prodEnv, api({...prod, id:'other-deployment'})), /os\.ezil\.work points at another deployment/);
  await assert.rejects(verifyCloudDeployment(prodEnv, api(prod, {...prod, id:'other-deployment'})), /ezil-os-preview-ezil1\.vercel\.app points at another deployment/);
  await assert.rejects(verifyCloudDeployment(prodEnv, api({...prod, meta:{githubCommitSha:'b'.repeat(40)}})), /SHA differs/);
  await assert.rejects(verifyCloudDeployment(prodEnv, api({...prod, readyState:'ERROR'})), /not ready/);
});

const { imagePlan } = await import('../.github/scripts/image-plan.mjs');
const { readState, pullCloudflareImage, restoreVercel, captureContainerVersion, candidateRolloutDigest, releaseDockerfile, releasePreflight } = await import('../.github/scripts/release-state.mjs');

test('image keys rebuild changed base and branding independently without changing local pins', () => {
  const tree = p => `${p}-original`;
  const original = imagePlan(sha, tree);
  const branding = imagePlan('b'.repeat(40), p => p.includes('neko-branding') ? 'changed' : tree(p));
  assert.equal(branding.base, original.base);
  assert.notEqual(branding.overlay, original.overlay);
  assert.notEqual(branding.desktop, original.desktop);
  const base = imagePlan(sha, p => p === 'docker/neko' ? 'new-base' : tree(p));
  assert.notEqual(base.base, original.base);
  assert.notEqual(base.overlay, original.overlay);
  assert.deepEqual(imagePlan(sha, tree), original);
  assert.match(original.desktop, /:sha-[a-f0-9]{40}$/);
  assert.throws(() => imagePlan('short', tree));
});

test('release capture separates provider/container identities and strips configuration', async () => {
  const prod = {...deployment,target:'production',env:{SECRET:'do-not-store'}};
  const fetchState = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/os.ezil.work')) return {ok:true,json:async()=>prod};
    if (url.pathname.endsWith('/containers/applications')) return {ok:true,json:async()=>[
      {id:'container-id',name:'ezil-os-worker-sandbox',configuration:{image:`registry.cloudflare.com/account/image@sha256:${'d'.repeat(64)}`,env:{SECRET:'do-not-store'}}},
    ]};
    return fakeAPI().fetch(input, options);
  };
  const result = await readState(env, fetchState);
  assert.equal(result.worker_source, sha);
  assert.equal(result.vercel_source, sha);
  assert.equal(result.vercel_url, deployment.url);
  assert.equal(result.cloudflare_container.digest, `sha256:${'d'.repeat(64)}`);
  assert.equal(JSON.stringify(result).includes('do-not-store'), false);
  await assert.rejects(readState(env, async()=>({ok:false,status:403})), /HTTP 403/);
});

test('container rollout preflight accepts only the prepared tested build of the checked-out release', () => {
  const other = 'b'.repeat(40), digest = `sha256:${'d'.repeat(64)}`;
  const images = {source:sha, tested:true, desktop:`ghcr.io/ezilhq/ezil-os-desktop:sha-${sha}`, desktop_digest:digest};
  const dockerfile = `FROM ghcr.io/ezilhq/ezil-os-desktop@${digest}\nLABEL org.opencontainers.image.revision="${sha}"\n`;
  assert.equal(releaseDockerfile(images, sha), dockerfile);
  // The real configuration with prepare's replacement: production first, staging after it.
  const original = fs.readFileSync('worker/wrangler.toml', 'utf8');
  const config = original.replace('image = "./Dockerfile"', 'image = "./Dockerfile.release"');
  const stagingOnly = original.replace(/(\[\[env\.staging\.containers\]\][^[]*?)image = "\.\/Dockerfile"/, '$1image = "./Dockerfile.release"');
  assert.notEqual(stagingOnly, original);
  const ready = {sha, head:sha, images, dockerfile, config};
  releasePreflight(ready);
  for (const [patch, message] of [
    [{sha:other}, /another commit/], [{head:other}, /not the release commit/],
    [{sha:undefined, head:undefined}, /release source SHA/], [{sha:'A'.repeat(40), head:'A'.repeat(40)}, /release source SHA/],
    [{images:{...images, source:other}}, /another commit/], [{images:{...images, tested:false}}, /not tested/],
    [{images:{...images, tested:'true'}}, /not tested/], [{images:{...images, desktop_digest:undefined}}, /desktop digest/],
    [{images:{...images, desktop:`ghcr.io/ezilhq/ezil-os-desktop:sha-${other}`}}, /tag differs/],
    [{dockerfile:dockerfile.replace(digest, `sha256:${'e'.repeat(64)}`)}, /Dockerfile\.release is not/],
    [{dockerfile:dockerfile.replace(/^LABEL .*\n/m, '')}, /Dockerfile\.release is not/],
    [{dockerfile:dockerfile.replace(`"${sha}"`, `"${other}"`)}, /Dockerfile\.release is not/],
    [{dockerfile:`${dockerfile}RUN true\n`}, /Dockerfile\.release is not/],
    [{config:original}, /does not build Dockerfile\.release/],
    [{config:stagingOnly}, /does not build Dockerfile\.release/],
    [{config:config.replace('[[containers]]', '[[env.other.containers]]')}, /one top-level/],
    [{config:`${config}\n[[containers]]\nimage = "./Dockerfile.release"\n`}, /one top-level/],
    [{config:config.replace('image = "./Dockerfile.release"', 'image = "./Dockerfile.release"\nimage = "./Dockerfile"')}, /one \[\[containers\]\] image/],
  ]) assert.throws(() => releasePreflight({...ready, ...patch}), message);
});

test('release-state prepare writes what preflight accepts, and preflight refuses a moved or unswitched checkout', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-release-preflight-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const gitEnv = {PATH:process.env.PATH, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_AUTHOR_NAME:'ci', GIT_AUTHOR_EMAIL:'ci@example.invalid', GIT_COMMITTER_NAME:'ci', GIT_COMMITTER_EMAIL:'ci@example.invalid'};
  const created = runWorkflowScript('bash', ['-euo', 'pipefail', '-c', `
    git -c init.defaultBranch=main init -q "$0" && cd "$0" && mkdir worker && cp "$1" worker/wrangler.toml
    git add -A && git commit -q -m release && git rev-parse HEAD
  `, dir, path.resolve('worker/wrangler.toml')], {env:gitEnv});
  assert.equal(created.status, 0, created.output);
  const head = created.output.trim();
  fs.writeFileSync(path.join(dir, 'tested-images.json'), JSON.stringify({source:head, tested:true,
    desktop:`ghcr.io/ezilhq/ezil-os-desktop:sha-${head}`, desktop_digest:`sha256:${'d'.repeat(64)}`}));
  const script = path.resolve('.github/scripts/release-state.mjs');
  const release = (mode, extra = {}) => runWorkflowScript(process.execPath, [script, mode],
    {cwd:dir, env:{...gitEnv, EZIL_DEPLOY_SHA:head, ...extra}});
  assert.notEqual(release('preflight').status, 0, 'preflight requires a prepared Dockerfile.release');
  assert.equal(release('prepare').status, 0);
  const passed = release('preflight');
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, new RegExp(`preflight passed for ${head}`));
  assert.match(release('preflight', {EZIL_DEPLOY_SHA:'b'.repeat(40)}).output, /another commit/);
  const toml = path.join(dir, 'worker/wrangler.toml'), prepared = fs.readFileSync(toml, 'utf8');
  fs.writeFileSync(toml, prepared.replace('image = "./Dockerfile.release"', 'image = "./Dockerfile"'));
  assert.match(release('preflight').output, /does not build Dockerfile\.release/);
  fs.writeFileSync(toml, prepared);
  assert.equal(release('preflight').status, 0);
  assert.equal(runWorkflowScript('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'next'], {env:gitEnv}).status, 0);
  assert.match(release('preflight').output, /not the release commit/);
});

test('Vercel rollback resolves legacy receipts and promotes the verified ID through the team API', async () => {
  const old = {...deployment, target:'production', meta:{githubCommitSha:'b'.repeat(40)}, env:{SECRET:'do-not-store'}};
  const previous = {vercel_deployment:old.id, vercel_source:old.meta.githubCommitSha};
  for (const receipt of [previous, {...previous, vercel_url:old.url}]) {
    const calls = [];
    let promoted = false;
    const result = await restoreVercel(receipt, env, async (input, options) => {
      const url = new URL(input);
      calls.push([options.method ?? 'GET', url.pathname]);
      assert.equal(url.hostname, 'api.vercel.com');
      assert.equal(url.searchParams.get('teamId'), env.VERCEL_ORG_ID);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.authorization, `Bearer ${env.VERCEL_TOKEN}`);
      if (options.method === 'POST') {
        promoted = true;
        return {ok:true, status:202};
      }
      const value = promoted || url.pathname.endsWith(`/${old.id}`) ? old : {...deployment, id:'dpl_new', target:'production'};
      return {ok:true, status:200, json:async()=>value};
    });
    assert.deepEqual(result, {...previous, vercel_url:old.url});
    assert.equal(JSON.stringify(result).includes('do-not-store'), false);
    assert.deepEqual(calls, [
      ['GET', `/v13/deployments/${old.id}`], ['GET', '/v13/deployments/os.ezil.work'],
      ['POST', `/v10/projects/${env.VERCEL_PROJECT_ID}/promote/${old.id}`], ['GET', '/v13/deployments/os.ezil.work'],
    ]);
  }
});

test('Vercel rollback refuses mismatched identities, untrusted hostnames and lost ownership before promotion', async () => {
  const old = {...deployment, target:'production', meta:{githubCommitSha:'b'.repeat(40)}};
  const previous = {vercel_deployment:old.id, vercel_source:old.meta.githubCommitSha};
  let promoted = false;
  const api = (target = old, current = {...deployment, target:'production'}) => async (input, options) => {
    if (options.method === 'POST') {
      promoted = true;
      throw new Error(`token=${env.VERCEL_TOKEN}`);
    }
    return {ok:true, status:200, json:async()=>new URL(input).pathname.endsWith(`/${old.id}`) ? target : current};
  };
  for (const patch of [{id:'dpl_other'}, {projectId:'prj_other'}, {readyState:'ERROR'}, {target:null}, {meta:{}},
    {meta:{githubCommitSha:sha}}, ...['ezil-os-preview-ezil1.vercel.app', 'os.ezil.work', 'https://preview-test.vercel.app', 'evil.example',
      'preview-test.vercel.app.evil.example', 'user@preview-test.vercel.app', 'preview-test.vercel.app/?token=x',
      '--yes', 'preview-test.vercel.app:443'].map(url=>({url}))]) {
    await assert.rejects(restoreVercel(previous, env, api({...old,...patch})));
  }
  await assert.rejects(restoreVercel({...previous,vercel_url:'different.vercel.app'}, env, api()), /URL differs/);
  await assert.rejects(restoreVercel(previous, {...env,VERCEL_ORG_ID:''}, api()), /team scope/);
  await assert.rejects(restoreVercel({...previous,vercel_source:null}, env, api()), /source SHA/);
  await assert.rejects(restoreVercel(previous, env, api(old, {...old,id:'dpl_other'})), /Another Vercel/);
  await assert.rejects(restoreVercel(previous, env, async()=>({ok:false,status:404})), /HTTP 404/);
  assert.equal(promoted, false);
  await assert.rejects(restoreVercel(previous, env, api()), error => {
    assert.match(error.message, /promotion failed/);
    assert.equal(`${error.message}${error.stack}${error.cause ?? ''}`.includes(env.VERCEL_TOKEN), false);
    return true;
  });
  assert.equal(promoted, true);
});

const workflowText = fs.readFileSync('.github/workflows/preview.yml','utf8');
const previewWorkflow = parseWorkflow(workflowText);

test('Vercel workflow alias and promotion use the API helper from the repository root with env credentials', () => {
  assert.doesNotMatch(workflowText, /--scope "\$VERCEL_ORG_ID"|\bvercel\s+(?:alias\s+set|promote)\b/);
  const staging = previewWorkflow.jobs.find(job => job.name === 'preview').steps.find(step => step.text.includes('id: preview_app\n'));
  const recovery = previewWorkflow.jobs.find(job => job.name === 'production').steps.find(step => step.line === '- name: Restore previous Vercel production deployment');
  assert.match(staging.text, /working-directory: app/);
  assert.match(staging.text, /cd \.\.\nnode \.github\/scripts\/vercel-api\.mjs alias "\$url" ezil-os-staging\.vercel\.app/);
  assert.doesNotMatch(recovery.text, /working-directory:/);
  assert.match(recovery.text, /node \.github\/scripts\/vercel-api\.mjs promote '\$\{\{ steps\.previous_app\.outputs\.deployment \}\}'/);
  for (const step of [staging, recovery]) {
    for (const key of ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']) {
      assert.ok(step.text.includes(`${key}: \${{ secrets.${key} }}`));
    }
    const command = step.text.split('\n').find(line => line.includes('node .github/scripts/vercel-api.mjs'));
    assert.doesNotMatch(command, /--token|VERCEL_/);
  }
});

test('image baseline lookup selects successful deployments on the target branch only', async () => {
  const step = previewWorkflow.jobs.find(j => j.name === 'changes').steps.find(s => s.text.includes('id: deployed\n'));
  const script = step.text.match(/script: \|\n([\s\S]*)$/)[1];
  const outputs = {};
  const valid = {id:10, updated_at:'2026-10-20T02:00:00Z', run_attempt:2, path:'.github/workflows/preview.yml',
    head_branch:'main', head_sha:sha, conclusion:'success', event:'push'};
  const probed = [];
  const github = {rest:{actions:{listWorkflowRuns:async args => {
    assert.equal(args.branch, 'main');
    assert.equal(args.status, 'success');
    return {data:{workflow_runs:[
      // A rerun of an older run can be the most recent successful deployment.
      {...valid,id:20,updated_at:'2026-10-20T01:00:00Z'}, {...valid,id:11,conclusion:'failure'},
      {...valid,id:12,run_number:12,head_branch:'preview'}, {...valid,id:13,run_number:13,event:'pull_request'},
      {...valid,id:14,run_number:14,path:'.github/workflows/image.yml'}, valid,
    ]}};
  }, listWorkflowRunArtifacts:async args => {
    probed.push(args.run_id);
    assert.deepEqual(args, {owner:'test', repo:'os', run_id:args.run_id, name:`live-evidence-main-${args.run_id}-2`, per_page:100});
    return {data:{artifacts:[{name:`live-evidence-main-${args.run_id}-2`, expired:false}]}};
  }}}};
  const execute = new (Object.getPrototypeOf(async function(){}).constructor)('github', 'context', 'core', script);
  await execute(github, {ref:'refs/heads/main', repo:{owner:'test',repo:'os'}, runId:15},
    {setOutput:(key,value) => { outputs[key] = value; }, warning:assert.fail});
  assert.deepEqual(outputs, {run:'10', sha, artifact:'live-evidence-main-10-2'});
  // The newest qualifying run had a receipt, so no older run was consulted.
  assert.deepEqual(probed, [10]);
  let warnings = 0;
  await execute({rest:{actions:{listWorkflowRuns:async () => { throw new Error('unavailable'); }}}},
    {ref:'refs/heads/main'}, {setOutput:assert.fail, warning:() => warnings++});
  assert.equal(warnings, 1);
});

test('failed image push remains drift on an app-only successor; untrusted or absent receipts rebuild', t => {
  const step = previewWorkflow.jobs.find(j => j.name === 'changes').steps.find(s => s.text.includes('id: image_changes\n'));
  const script = step.text.match(/run: \|\n([\s\S]*)$/)[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-deployed-source-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.mkdirSync(path.join(dir, 'deployed-evidence/live-evidence'), {recursive:true});
  const receiptFile = path.join(dir, 'deployed-evidence/live-evidence/image-source.json');
  // Push A changed the image but failed. B contains A's image plus an app change.
  // Both differ from the deployed image source even though A -> B is app-only.
  const deployed = 'b'.repeat(40), pushA = 'c'.repeat(40), pushB = 'd'.repeat(40);
  const base = {source:sha, deployment:deployed, branch:'main', tested:true};
  const shim = `
    git() {
      if [[ "$1" == cat-file ]]; then [[ "$3" == '${sha}^{commit}' ]]; return; fi
      [[ "$1" == diff && "$3" == --no-renames && "$4" == '${sha}' && "$5" == '${pushB}' ]] || return 42
      if [[ "$2" == --name-only ]]; then echo worker/Dockerfile; return; fi
      [[ "$6" == -- && "$7" == worker/Dockerfile ]] || return 42
      return "$TEST_IMAGE_DRIFT"
    }
  `;
  for (const [receipt, downloaded, drift, ref, changed] of [
    [base, 'true', '1', 'refs/heads/main', 'true'],
    [base, 'true', '0', 'refs/heads/main', 'false'],
    [base, 'true', '1', 'refs/tags/v1.2.3', 'false'],
    [null, 'true', '0', 'refs/heads/main', 'true'],
    [base, 'false', '0', 'refs/heads/main', 'true'],
    [{...base,source:pushA}, 'true', '0', 'refs/heads/main', 'true'],
    [{...base,deployment:pushA}, 'true', '0', 'refs/heads/main', 'true'],
    [{...base,branch:'preview'}, 'true', '0', 'refs/heads/main', 'true'],
    [{...base,tested:false}, 'true', '0', 'refs/heads/main', 'true'],
    [{...base,source:'invalid'}, 'true', '0', 'refs/heads/main', 'true'],
  ]) {
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const output = path.join(dir, 'github-output'); fs.writeFileSync(output, '');
    const result = runWorkflowScript('bash', ['-e', '-c', shim + script], {cwd:dir, env:{PATH:process.env.PATH,
      DEPLOYED_SHA:deployed, EVIDENCE_DOWNLOADED:downloaded, IMAGE_INPUTS:'worker/Dockerfile',
      GITHUB_SHA:pushB, GITHUB_EVENT_BEFORE:pushA, GITHUB_REF:ref, GITHUB_REF_NAME:'main',
      GITHUB_OUTPUT:output, TEST_IMAGE_DRIFT:drift}});
    assert.equal(result.status, 0, result.output);
    assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`^changed=${changed}$`, 'm'));
  }
});

test('image change detection baselines on the newest deployment receipt, never a run that deployed nothing', async t => {
  // Chain the shipped steps: baseline lookup -> artifact download -> change detection
  // over a real repository, with the workflow's own IMAGE_INPUTS list.
  const changes = previewWorkflow.jobs.find(j => j.name === 'changes');
  const step = id => changes.steps.find(s => s.text.includes(`id: ${id}\n`)).text;
  const lookup = new (Object.getPrototypeOf(async function(){}).constructor)('github', 'context', 'core',
    step('deployed').match(/script: \|\n([\s\S]*)$/)[1]);
  assert.match(step('deployed_evidence'), /if: steps\.deployed\.outputs\.run != ''/);
  assert.match(step('deployed_evidence'), /\nrun-id: \$\{\{ steps\.deployed\.outputs\.run \}\}\nname: \$\{\{ steps\.deployed\.outputs\.artifact \}\}\npath: deployed-evidence$/);
  const detect = step('image_changes').match(/run: \|\n([\s\S]*)$/)[1];
  // The fake artifacts below carry the names the two deploy jobs upload.
  for (const name of ['preview', 'production']) {
    const upload = previewWorkflow.jobs.find(j => j.name === name).steps.find(s => s.line === '- name: Upload live evidence');
    assert.match(upload.text, /\nname: live-evidence-\$\{\{ github\.ref_name \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n/, name);
  }
  const imageInputs = workflowText.match(/^ {2}IMAGE_INPUTS: \|-\n((?: {4}\S.*\n)+)/m)[1].split('\n').map(line => line.trim()).filter(Boolean);
  assert.ok(imageInputs.includes('worker/Dockerfile') && imageInputs.includes('worker/scripts') && !imageInputs.some(p => /^(?:app|worker\/src)\b/.test(p)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-image-baseline-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const repo = path.join(dir, 'repo');
  const gitEnv = {PATH:process.env.PATH, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_AUTHOR_NAME:'ci', GIT_AUTHOR_EMAIL:'ci@example.invalid', GIT_COMMITTER_NAME:'ci', GIT_COMMITTER_EMAIL:'ci@example.invalid'};
  // S0 is a deployed image source; D, A, B are app-only; I changes the Dockerfile;
  // J is Worker-only; K changes another image input.
  const created = runWorkflowScript('bash', ['-euo', 'pipefail', '-c', `
    git -c init.defaultBranch=main init -q "$0" && cd "$0" && mkdir -p app worker/src worker/scripts
    commit() { git add -A && git commit -q -m "$1" && git rev-parse HEAD; }
    echo 'FROM scratch' > worker/Dockerfile; echo 'exit 0' > worker/scripts/start.sh
    echo 0 > app/page.txt; echo 0 > worker/src/index.ts; commit S0
    echo 1 > app/page.txt; commit D
    echo 2 > app/page.txt; commit A
    echo 3 > app/page.txt; commit B
    echo 'FROM scratch AS desktop' > worker/Dockerfile; commit I
    echo 1 > worker/src/index.ts; commit J
    echo 'exit 1' > worker/scripts/start.sh; commit K
  `, repo], {env:gitEnv});
  assert.equal(created.status, 0, created.output);
  const [S0, D, A, B, I, J, K] = created.output.split('\n').filter(line => /^[a-f0-9]{40}$/.test(line));
  assert.ok(K, created.output);

  const run = (id, event, head_sha, minute, extra = {}) => ({id, event, head_sha, run_attempt:1, conclusion:'success',
    path:'.github/workflows/preview.yml', updated_at:`2026-10-29T10:${String(minute).padStart(2, '0')}:00Z`, ...extra});
  // A run that only detected changes or built images uploads these, never live evidence.
  const buildOnly = (branch, id, head) => [{name:`live-changes-${branch}-${id}-1`}, {name:`os-images-${head}`}];
  const deployedRun = (branch, id, receipt, attempt = 1) =>
    [{name:`live-changes-${branch}-${id}-${attempt}`}, {name:`live-evidence-${branch}-${id}-${attempt}`, receipt}];
  const receipt = (branch, source, deployment) => ({source, deployment, branch, tested:true});

  async function detectImageChange({ref, sha, runs, artifacts, failArtifacts = false}) {
    const branch = ref.replace('refs/heads/', '');
    const outputs = {}; let warnings = 0;
    const github = {rest:{actions:{
      listWorkflowRuns:async args => {
        assert.deepEqual(args, {owner:'test', repo:'os', workflow_id:'preview.yml', branch, status:'success', per_page:100, page:args.page});
        // `runs` is in API order (newest first); serve it 100 per page like GitHub.
        const page = runs.slice((args.page - 1) * 100, args.page * 100);
        return {data:{workflow_runs:page.map(r => ({head_branch:branch, ...r}))}};
      },
      // Every artifact of the run comes back, so only an exact name can select a receipt.
      listWorkflowRunArtifacts:async ({run_id}) => {
        if (failArtifacts) throw new Error('rate limited');
        return {data:{artifacts:(artifacts[run_id] ?? []).map(({name, expired = false}) => ({name, expired}))}};
      },
    }}};
    await lookup(github, {ref, repo:{owner:'test', repo:'os'}, runId:99},
      {setOutput:(key, value) => { outputs[key] = value; }, warning:() => warnings++});
    // actions/download-artifact fails (continue-on-error) unless that run holds that live artifact.
    fs.rmSync(path.join(repo, 'deployed-evidence'), {recursive:true, force:true});
    let downloaded = false;
    if (outputs.run) {
      const artifact = (artifacts[outputs.run] ?? []).find(a => a.name === outputs.artifact && !a.expired);
      if (artifact) {
        downloaded = true;
        fs.mkdirSync(path.join(repo, 'deployed-evidence/live-evidence'), {recursive:true});
        if (artifact.receipt) fs.writeFileSync(path.join(repo, 'deployed-evidence/live-evidence/image-source.json'), JSON.stringify(artifact.receipt));
      }
    }
    const output = path.join(dir, 'github-output'); fs.writeFileSync(output, '');
    const result = runWorkflowScript('bash', ['-e', '-c', detect], {cwd:repo, env:{...gitEnv,
      DEPLOYED_SHA:outputs.sha ?? '', EVIDENCE_DOWNLOADED:String(downloaded), IMAGE_INPUTS:imageInputs.join('\n'),
      GITHUB_SHA:sha, GITHUB_REF:ref, GITHUB_REF_NAME:branch, GITHUB_OUTPUT:output}});
    assert.equal(result.status, 0, result.output);
    const out = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split('=')));
    return {changed:out.changed, source:out.source, run:outputs.run, warnings};
  }

  const main = 'refs/heads/main', preview = 'refs/heads/preview';
  // (a) A main push after push-only runs: they built images but deployed nothing.
  const pushOnly = {
    runs:[run(21, 'push', A, 30), run(20, 'workflow_dispatch', D, 20)],
    artifacts:{21:buildOnly('main', 21, A), 20:deployedRun('main', 20, receipt('main', S0, D))},
  };
  // (b) A dispatch after a dispatch deploy that rolled out image I, with a newer
  // unconfirmed dispatch (deploy_production=false) and a push in between.
  const dispatched = {
    runs:[run(32, 'workflow_dispatch', J, 40), run(31, 'push', J, 35), run(30, 'workflow_dispatch', I, 30)],
    artifacts:{32:buildOnly('main', 32, J), 31:buildOnly('main', 31, J), 30:deployedRun('main', 30, receipt('main', I, I))},
  };
  // (c) A preview push after a staging deployment.
  const staged = {runs:[run(41, 'push', D, 20)], artifacts:{41:deployedRun('preview', 41, receipt('preview', S0, D))}};
  for (const [label, scenario, ref, sha, expected] of [
    ['(a) app-only main push after a push-only run', pushOnly, main, B, {changed:'false', source:S0, run:'20'}],
    ['(a) image-changing main push after a push-only run', pushOnly, main, I, {changed:'true', source:S0, run:'20'}],
    // An image built by a push but never deployed is still drift for its app-only successor.
    ['(a) app-only push after an undeployed image build', {runs:[run(22, 'push', I, 40), ...pushOnly.runs],
      artifacts:{...pushOnly.artifacts, 22:buildOnly('main', 22, I)}}, main, J, {changed:'true', source:S0, run:'20'}],
    // A pre-cutover main push that deployed holds a receipt: the artifact decides, not the event.
    ['(a) legacy main push deployment', {runs:[run(21, 'push', A, 30), run(20, 'push', D, 20)], artifacts:pushOnly.artifacts},
      main, B, {changed:'false', source:S0, run:'20'}],
    ['(b) Worker-only dispatch after a dispatch deploy', dispatched, main, J, {changed:'false', source:I, run:'30'}],
    ['(b) image-changing dispatch after a dispatch deploy', dispatched, main, K, {changed:'true', source:I, run:'30'}],
    ['(b) rerun dispatch deploy uses its own attempt', {runs:[run(60, 'workflow_dispatch', D, 20, {run_attempt:2})],
      artifacts:{60:[{name:'live-evidence-main-60-1'}, ...deployedRun('main', 60, receipt('main', S0, D), 2)]}},
      main, B, {changed:'false', source:S0, run:'60'}],
    // The receipt sits behind 150 newer push-only runs: the lookup pages past the first 100.
    ['(a) receipt older than the newest 100 runs', (() => {
      const pushes = Array.from({length:150}, (_, i) => run(1000 + 150 - i, 'push', A, 0,
        {updated_at:new Date(Date.UTC(2026, 9, 29, 12) - i * 1000).toISOString()}));
      return {runs:[...pushes, ...pushOnly.runs.slice(1)],
        artifacts:{...Object.fromEntries(pushes.map(r => [r.id, buildOnly('main', r.id, A)])), 20:pushOnly.artifacts[20]}};
    })(), main, B, {changed:'false', source:S0, run:'20'}],
    ['(c) app-only preview push', staged, preview, B, {changed:'false', source:S0, run:'41'}],
    ['(c) image-changing preview push', staged, preview, I, {changed:'true', source:S0, run:'41'}],
    // Negative controls: no receipt, an expired newest receipt, or an API failure rebuild.
    ['no deployment receipt anywhere', {runs:[run(21, 'push', A, 30)], artifacts:{21:buildOnly('main', 21, A)}},
      main, B, {changed:'true'}],
    ['expired newest receipt never falls back to an older deployment', {
      runs:[run(71, 'workflow_dispatch', I, 30), run(70, 'workflow_dispatch', D, 20)],
      artifacts:{71:[{name:'live-evidence-main-71-1', expired:true, receipt:receipt('main', I, I)}],
                 70:deployedRun('main', 70, receipt('main', S0, D))}}, main, B, {changed:'true'}],
  ]) {
    const {warnings, ...result} = await detectImageChange({ref, sha, ...scenario});
    assert.equal(warnings, 0, label);
    assert.deepEqual(Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined)), expected, label);
  }
  const unavailable = await detectImageChange({ref:main, sha:B, ...pushOnly, failArtifacts:true});
  assert.deepEqual(unavailable, {changed:'true', source:undefined, run:undefined, warnings:1});
});

test('successful deployment receipts preserve reused image source instead of the app-only commit', () => {
  for (const name of ['preview', 'production']) {
    const job = previewWorkflow.jobs.find(j => j.name === name);
    const step = job.steps.find(s => s.line === '- name: Record successfully deployed image source');
    assert.match(step.text, new RegExp(`steps.live_${name}.outcome == 'success'`));
    const script = step.text.match(/<<'JS'\n([\s\S]*?)\nJS/)[1].replace(/^import .*;\n/gm, '');
    for (const changed of ['true', 'false']) {
      let saved;
      const source = 'b'.repeat(40);
      new Function('assert', 'fs', 'process', script)(assert, {
        readFileSync:() => JSON.stringify({source:sha,tested:true}),
        writeFileSync:(file, body) => { assert.equal(file, 'live-evidence/image-source.json'); saved = JSON.parse(body); },
      }, {env:{IMAGE_CHANGED:changed, REUSED_IMAGE_SOURCE:source, EZIL_DEPLOY_SHA:sha, GITHUB_REF_NAME:name}});
      assert.deepEqual(saved, {source:changed === 'true' ? sha : source, tested:true, deployment:sha, branch:name});
    }
  }
});

test('staging hostname validation rejects production and unrelated origins before deployment', () => {
  const job = previewWorkflow.jobs.find(j => j.name === 'preview');
  const step = job.steps.find(s => s.line === '- name: Validate staging Worker hostname and routes');
  assert.ok(job.steps.indexOf(step) < job.steps.findIndex(s => /wrangler deploy\b/.test(s.text)));
  // The lightweight contract parser flattens indentation; Python needs the raw block.
  const script = workflowText.slice(workflowText.indexOf('      - name: Validate staging Worker hostname and routes'))
    .match(/<<'PY'\n([\s\S]*?)\n          PY/)[1].replace(/^          /gm, '');
  for (const [url, success] of [
    ['https://api-desktop-staging.ezil.work', true], ['https://api-desktop-staging.ezil.work/', true],
    ['https://api-desktop.ezil.org', false], ['https://os.ezil.work', false],
    ['https://other.example', false], ['https://os-staging.test.workers.dev', false],
    ['http://api-desktop-staging.ezil.work', false], ['https://api-desktop-staging.ezil.work/path', false],
    ['https://user@api-desktop-staging.ezil.work', false], ['https://api-desktop-staging.ezil.work:444', false],
    ['https://api-desktop-staging.ezil.work?foo=bar', false],
  ]) {
    const result = runWorkflowScript('python3', ['-c', script], {env:{PATH:process.env.PATH,
      EZIL_WORKER_NAME:'ezil-os-worker-staging', EZIL_E2E_WORKER:url}});
    assert.equal(result.status === 0, success, `${url}: ${result.output}`);
  }
});

test('recovery mutations are skipped when ownership is lost, but release failure is preserved', () => {
  const job = previewWorkflow.jobs.find(j => j.name === 'production');
  const guard = job.steps.find(s => s.text.includes('id: rollback_guard\n'));
  const mutations = job.steps.filter(s => /wrangler rollback|release-state.mjs container-rollback|vercel-api.mjs promote/.test(s.text));
  assert.equal(mutations.length, 3);
  for (const outcome of ['failure', 'skipped', 'cancelled', 'success']) {
    const steps = Object.fromEntries(['previous_worker','previous_app','previous_container','worker','production_app',
      'rollout','identity','live_production'].map(id => [id,{outcome:'success'}]));
    steps.live_production.outcome = 'failure'; steps.rollback_guard = {outcome};
    for (const step of [...mutations, job.steps.find(s => s.line === '- name: Fail after production recovery')]) {
      assert.ok(job.steps.indexOf(guard) < job.steps.indexOf(step));
      const condition = step.text.match(/^if: (.+)$/m)[1];
      const admitted = new Function('github','steps','needs','always', `return (${condition})`)(
        {ref:'refs/heads/main'}, steps, {changes:{outputs:{image_changed:'true'}}}, () => true);
      assert.equal(admitted, step.line.includes('Fail after') || outcome === 'success');
    }
  }
  const script = guard.text.match(/run: \|\n([\s\S]*)$/)[1];
  const failure = runWorkflowScript('bash', ['-e', '-c', 'node() { return 1; };\n' + script]);
  assert.equal(failure.status, 1);
  assert.match(failure.output, /another release may own production; no rollback mutations will run/);
});

const rolloutEnv = {...env, EZIL_WORKER_NAME:'ezil-os-worker-staging', EZIL_CONTAINER_APPLICATION_ID:'container',
  EZIL_PREVIOUS_CONTAINER_VERSION:'7', EZIL_EXPECTED_CONTAINER_DIGEST:`sha256:${'d'.repeat(64)}`};
const rolloutImage = `registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/desktop@${rolloutEnv.EZIL_EXPECTED_CONTAINER_DIGEST}`;
const newRollout = {id:'new-rollout',created_at:'2026-10-20T00:00:00Z',target_version:8,current_version:7,
  status:'completed',target_configuration:{image:rolloutImage},current_configuration:{image:rolloutImage},steps:[{status:'completed'}]};
function fencedRolloutFixture(states) {
  let time = 0, poll = 0;
  return {now:() => time, sleep:async ms => { time += ms; }, pollMs:5, budgetMs:20,
    fetchImpl:async input => {
      const state = states[Math.min(poll, states.length - 1)];
      const application = {id:'container', name:'ezil-os-worker-staging-sandbox', version:state.target_version,
        configuration:state.target_configuration};
      const pathname = new URL(input).pathname;
      const result = pathname.endsWith('/applications') ? [application]
        : pathname.endsWith('/rollouts') ? (poll++, [state]) : application;
      return {ok:true,json:async () => ({result})};
    }};
}
test('fenced rollout waits past old completed rollouts, even when the image digest is identical', async () => {
  const old = {...newRollout,id:'old-rollout',target_version:7,current_version:6};
  const result = await awaitContainerRollout(rolloutEnv, fencedRolloutFixture([old,newRollout]));
  assert.equal(result.rollout, 'new-rollout');
  assert.equal(result.version, 8); assert.equal(result.elapsedMs, 5);
  await assert.rejects(awaitContainerRollout(rolloutEnv, fencedRolloutFixture([old])), /within its budget/);
  await assert.rejects(awaitContainerRollout(rolloutEnv, fencedRolloutFixture([
    {...newRollout,target_configuration:{image:rolloutImage.replace('d'.repeat(64),'e'.repeat(64))}},
  ])), /candidate image digest/);
  for (const patch of [{EZIL_EXPECTED_CONTAINER_DIGEST:''}, {EZIL_PREVIOUS_CONTAINER_VERSION:''},
    {EZIL_PREVIOUS_CONTAINER_VERSION:'NaN'}, {EZIL_CONTAINER_APPLICATION_ID:'replacement'}]) {
    await assert.rejects(awaitContainerRollout({...rolloutEnv,...patch}, fencedRolloutFixture([newRollout])));
  }
});

test('candidate Cloudflare digest is bound to the tested GHCR layers, source and pre-deploy application', async () => {
  const images = {source:sha,tested:true,desktop_digest:`sha256:${'f'.repeat(64)}`};
  const local = {Config:{Labels:{'org.opencontainers.image.revision':sha}},RootFS:{Layers:['tested-layer']}};
  function fixture({cloudflare = local, states = [newRollout], id = 'container'} = {}) {
    let poll = 0;
    const calls = [];
    return {calls, fetchImpl:async (input, options) => {
      const pathname = new URL(input).pathname;
      assert.equal(options.redirect, 'error');
      const result = pathname.endsWith('/applications') ? [{id,version:7,name:'ezil-os-worker-staging-sandbox'}]
        : pathname.endsWith('/rollouts') ? [states[Math.min(poll++,states.length - 1)]]
        : {username:'test',password:'test'};
      return {ok:true,json:async () => ({result})};
    }, sleep:async () => {}, exec:(cmd, args) => {
      calls.push(args);
      if (args[0] === 'image') return JSON.stringify([args.at(-1).startsWith('registry.cloudflare.com/') ? cloudflare : local]);
      return '';
    }};
  }
  const f = fixture({states:[{...newRollout,target_version:7},newRollout]});
  assert.deepEqual(await captureContainerVersion(rolloutEnv, f.fetchImpl), {id:'container',version:7});
  assert.equal(await candidateRolloutDigest(images, rolloutEnv, f), rolloutEnv.EZIL_EXPECTED_CONTAINER_DIGEST);
  assert.ok(f.calls.some(args => args[0] === 'pull' && args[1] === `ghcr.io/ezilhq/ezil-os-desktop@${images.desktop_digest}`));
  for (const config of [{cloudflare:{...local,RootFS:{Layers:['wrong-layer']}}},
    {cloudflare:{...local,Config:{Labels:{'org.opencontainers.image.revision':'b'.repeat(40)}}}},
    {cloudflare:{...local,RootFS:{}}}, {id:'other'}, {states:[{...newRollout,target_version:7}]}]) {
    await assert.rejects(candidateRolloutDigest(images, rolloutEnv, fixture(config)));
  }
  for (const patch of [{source:'b'.repeat(40)}, {tested:false}, {desktop_digest:'tag'}]) {
    await assert.rejects(candidateRolloutDigest({...images,...patch}, rolloutEnv, fixture()));
  }
});

function runWorkflowScript(command, args, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-workflow-script-'));
  const log = path.join(dir, 'output');
  const fd = fs.openSync(log, 'w');
  try {
    // File descriptors avoid subprocess socket pairs in restricted runners.
    const result = spawnSync(command, args, { ...options, timeout: 5000, stdio: ['ignore', fd, fd] });
    assert.ifError(result.error);
    return { status: result.status, output: fs.readFileSync(log, 'utf8') };
  } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('deployment triggers are preview/main and version-tag pushes plus manual dispatch with a production confirmation', () => {
  const triggers = outline(workflowText).children.find(node => node.line === 'on:');
  assert.ok(triggers, 'deployment workflow must declare its triggers');
  assert.deepEqual(triggers.children.map(node => node.line).sort(), ['push:', 'workflow_dispatch:']);
  const push = triggers.children.find(node => node.line === 'push:');
  assert.deepEqual(push.children.map(node => node.line), ['branches: [preview, main]', "tags: ['v*']"]);
  const dispatch = triggers.children.find(node => node.line === 'workflow_dispatch:');
  assert.deepEqual(dispatch.children.map(node => node.line), ['inputs:']);
  assert.deepEqual(dispatch.children[0].children.map(node => node.line), ['deploy_production:']);
  assert.deepEqual(dispatch.children[0].children[0].children.map(node => node.line).filter(line => !line.startsWith('description:')),
    ['type: boolean', 'default: false']);
});

test('a push or merge to main never deploys production; only a confirmed main dispatch or a tag check admits it', () => {
  const jobs = outline(workflowText).children.find(node => node.line === 'jobs:');
  const condition = name => {
    const gate = jobs.children.find(node => node.line === `${name}:`).children.find(node => node.line.startsWith('if:'));
    const text = gate.line === 'if: >-' ? gate.children.map(node => [node.line, ...node.children.map(c => c.line)].join(' ')).join(' ') : gate.line.slice(4);
    return new Function('github', 'inputs', 'needs', 'cancelled', 'startsWith',
      `return (${text.replace(/^\$\{\{|\}\}$/g, '').trim()})`);
  };
  const [images, preview, production] = ['images', 'preview', 'production'].map(condition);
  const startsWith = (value, prefix) => value.startsWith(prefix);
  // [ref, event, inputs, staging deploys, production job runs]
  for (const [ref, event_name, inputs, staging, prod] of [
    ['refs/heads/main', 'push', {}, false, false],
    // Pushes carry no inputs; the event check still refuses one if they ever did.
    ['refs/heads/main', 'push', { deploy_production: true }, false, false],
    ['refs/heads/main', 'workflow_dispatch', {}, false, false],
    ['refs/heads/main', 'workflow_dispatch', { deploy_production: false }, false, false],
    ['refs/heads/main', 'workflow_dispatch', { deploy_production: true }, false, true],
    ['refs/heads/preview', 'push', {}, true, false],
    ['refs/heads/preview', 'workflow_dispatch', { deploy_production: true }, true, false],
    ['refs/heads/feature', 'workflow_dispatch', { deploy_production: true }, false, false],
    ['refs/tags/v1.2.3', 'push', {}, false, true],
  ]) {
    const github = { ref, event_name };
    for (const imagesResult of ['success', 'skipped', 'failure']) {
      const needs = { changes: { result: 'success', outputs: { image_changed: 'true' } }, images: { result: imagesResult } };
      const admitted = imagesResult !== 'failure';
      const label = `${event_name} ${ref} ${JSON.stringify(inputs)} images=${imagesResult}`;
      assert.equal(preview(github, inputs, needs, () => false, startsWith), staging && admitted, `staging: ${label}`);
      assert.equal(production(github, inputs, needs, () => false, startsWith), prod && admitted, `production: ${label}`);
      assert.equal(production(github, inputs, needs, () => true, startsWith), false, `cancelled: ${label}`);
    }
    // Branch pushes and dispatches still build, test and sign changed images.
    const needs = { changes: { outputs: { image_changed: 'true' } } };
    assert.equal(images(github, inputs, needs, () => false, startsWith), /^refs\/heads\/(?:main|preview)$/.test(ref), `images: ${ref}`);
  }
  assert.equal(workflowText.match(/inputs\.deploy_production/g).length, 1);
});

test('both live-check steps require their environment isolated computer secret', () => {
  const jobs = outline(workflowText).children.find(node => node.line === 'jobs:');
  for (const [name, environment] of [['preview', 'staging'], ['production', 'production']]) {
    const job = jobs.children.find(node => node.line === `${name}:`);
    assert.ok(job.children.some(node => node.line === `environment: ${environment}`));
    const steps = job.children.find(node => node.line === 'steps:');
    const live = steps.children.find(node => node.children.some(child => child.line === `id: live_${name}`));
    const env = live.children.find(node => node.line === 'env:').children.map(node => node.line);
    assert.ok(env.includes('EZIL_E2E_COMPUTER_ID: ${{ secrets.EZIL_E2E_COMPUTER_ID }}'), name);
    assert.ok(env.includes("EZIL_E2E_REQUIRE_TARGET: '1'"), name);
  }
});

test('shared leases fence staging and production snapshots, mutations, live checks and evidence', () => {
  const jobs = outline(workflowText).children.find(node => node.line === 'jobs:');
  for (const [name, leaseId, scope, owner, ttl] of [
    ['preview', 'lease', '', 'os-', 10800],
    ['production', 'production_lease', '--scope shared-production ', 'os-prod-', 7200],
  ]) {
    const job = previewWorkflow.jobs.find(job => job.name === name);
    const permissions = jobs.children.find(node => node.line === `${name}:`).children
      .find(node => node.line === 'permissions:');
    assert.ok(permissions.children.some(node => node.line === 'id-token: write'), name);
    const credentials = job.steps.filter(step => step.text.includes('aws-actions/configure-aws-credentials@'));
    const acquisitions = job.steps.filter(step => step.run?.includes('staging-lock.py acquire'));
    const releases = job.steps.filter(step => step.run?.includes('staging-lock.py release'));
    assert.equal(credentials.length, 1);
    assert.equal(acquisitions.length, 1);
    assert.equal(releases.length, 1);
    const [auth] = credentials, [acquire] = acquisitions, [release] = releases;
    assert.equal(auth.line, '- uses: aws-actions/configure-aws-credentials@v4');
    assert.match(auth.text, /^role-to-assume: arn:aws:iam::452630323510:role\/ezil-os-staging-lease$/m);
    assert.match(auth.text, /^aws-region: us-east-1$/m);
    assert.match(auth.text, /^role-duration-seconds: 7200$/m);
    for (const step of [auth, acquire]) {
      assert.ok(!step.keys.some(key => ['if', 'continue-on-error', 'shell'].includes(key)), name);
    }
    assert.ok(acquire.text.includes(`id: ${leaseId}\n`));
    assert.equal(acquire.run, `python3 .github/scripts/staging-lock.py acquire ${scope}--owner "$LEASE_OWNER" --ttl ${ttl} --wait 1200`);
    assert.equal(release.text.match(/^run: (.+)$/m)[1], `python3 .github/scripts/staging-lock.py release ${scope}--owner "$LEASE_OWNER"`);
    for (const step of [acquire, release]) {
      assert.equal(step.text.match(/^LEASE_OWNER: (.+)$/m)[1], `${owner}\${{ github.run_id }}-\${{ github.run_attempt }}`);
    }
    assert.equal(release.text.match(/^if: (.+)$/m)[1], `always() && steps.${leaseId}.outcome == 'success'`);
    assert.ok(!release.keys.includes('continue-on-error'));
    const protectedIds = ['container_before', 'worker', `live_${name}`];
    if (name === 'production') protectedIds.push('previous_worker', 'previous_app', 'previous_container', 'rollback_guard');
    const protectedSteps = protectedIds.map(id => {
      const step = job.steps.find(step => step.text.includes(`id: ${id}\n`));
      assert.ok(step, id);
      return step;
    });
    protectedSteps.push(...job.steps.filter(step => /vercel deploy|vercel-api.mjs promote|wrangler rollback|production-migrations.mjs apply|release-state.mjs (?:container-rollback|rollback-check)|node e2e\/(?:await-container-rollout|verify-cloud-deployment).mjs/.test(step.text)));
    assert.ok(job.steps.indexOf(auth) < job.steps.indexOf(acquire));
    for (const step of protectedSteps) {
      assert.ok(job.steps.indexOf(acquire) < job.steps.indexOf(step), `${name}: ${step.line} must hold the lease`);
    }
    const upload = job.steps.find(step => step.line === '- name: Upload live evidence');
    assert.ok(job.steps.indexOf(upload) > job.steps.indexOf(protectedSteps[2]));
    assert.equal(job.steps.at(-2), upload);
    assert.equal(job.steps.at(-1), release);
  }
});

test('failed lease acquisition skips snapshots, deployments, recovery and live checks on branches and tags', () => {
  for (const [name, ref, leaseId] of [
    ['preview', 'refs/heads/preview', 'lease'],
    ['production', 'refs/heads/main', 'production_lease'],
    ['production', 'refs/tags/v1.2.3', 'production_lease'],
  ]) {
    const job = previewWorkflow.jobs.find(job => job.name === name);
    const acquire = job.steps.findIndex(step => step.text.includes(`id: ${leaseId}\n`));
    for (const imageChanged of ['true', 'false']) {
      const steps = Object.fromEntries(job.steps.flatMap(step => {
        const id = step.text.match(/^id: (.+)$/m)?.[1];
        return id ? [[id, { outcome: 'skipped' }]] : [];
      }));
      steps[leaseId].outcome = 'failure';
      const admitted = job.steps.slice(acquire + 1).filter(step => {
        const condition = step.text.match(/^if: (.+)$/m)?.[1] ?? 'success()';
        // GitHub implicitly adds success() unless a status function is present.
        if (!/\b(?:always|success|failure|cancelled)\(/.test(condition)) return false;
        return new Function('github', 'needs', 'steps', 'always', 'success', 'failure', 'cancelled', 'startsWith', `return (${condition})`)(
          { ref }, { changes: { outputs: { image_changed: imageChanged } } }, steps,
          () => true, () => false, () => true, () => false, (value, prefix) => value.startsWith(prefix));
      });
      assert.deepEqual(admitted.map(step => step.line), ['- name: Upload live evidence'], `${ref}, images=${imageChanged}`);
    }
  }
});

test('lease release runs after failure or cancellation only when this run acquired it', () => {
  for (const [name, leaseId] of [['preview', 'lease'], ['production', 'production_lease']]) {
    const release = previewWorkflow.jobs.find(job => job.name === name).steps.at(-1);
    const condition = release.text.match(/^if: (.+)$/m)[1];
    for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const jobStatus of ['success', 'failure', 'cancelled']) {
        const admitted = new Function('steps', 'always', 'success', 'failure', 'cancelled', `return (${condition})`)(
          { [leaseId]: { outcome } }, () => true, () => jobStatus === 'success',
          () => jobStatus === 'failure', () => jobStatus === 'cancelled');
        assert.equal(admitted, outcome === 'success', `${name}, lease=${outcome}, job=${jobStatus}`);
      }
    }
  }
});

test('workflow deadlines admit a full live run including final stop or refuse to start it', () => {
  assert.ok(MAX_CHECK_MS <= 8 * 60_000);
  assert.equal(FINAL_STOP_TIMEOUT_MS, APP_STOP_FETCH_TIMEOUT_MS);
  assert.ok(MAX_RUN_MS >= MAX_CHECK_MS + APP_STOP_FETCH_TIMEOUT_MS + 15_000);
  const runSeconds = Math.ceil(MAX_RUN_MS / 1000);
  const jobs = outline(workflowText).children.find(node => node.line === 'jobs:');
  for (const name of ['preview', 'production']) {
    const job = previewWorkflow.jobs.find(job => job.name === name);
    const step = job.steps.find(step => step.text.includes(`id: live_${name}\n`));
    const stepMinutes = Number(step.text.match(/^timeout-minutes: (\d+)$/m)[1]);
    const jobMinutes = Number(jobs.children.find(node => node.line === `${name}:`).children
      .find(node => node.line.startsWith('timeout-minutes:')).line.split(':')[1]);
    assert.ok(stepMinutes * 60 > runSeconds + 20);
    assert.ok(jobMinutes > stepMinutes);
    const reserve = name === 'production' ? 15 * 60 : 0;
    for (const available of [runSeconds + 9, runSeconds + 10]) {
      const script = step.text.match(/run: \|\n([\s\S]*)$/)[1]
        .replaceAll('${{ steps.deadline.outputs.at }}', String(1000 + reserve + available));
      const child = runWorkflowScript('bash', ['-e', '-c', `
        date() { echo 1000; }
        timeout() { printf 'START %s\\n' "$*"; }
        ${script}
      `]);
      assert.equal(child.status, available === runSeconds + 10 ? 0 : 1, child.output);
      if (child.status === 0) {
        assert.match(child.output, new RegExp(`START --kill-after=10s ${runSeconds + 10}s node e2e/live-check.mjs`));
      } else assert.doesNotMatch(child.output, /START/);
    }
  }
});

test('production refuses stale main before migrations without admitting any rollback', async () => {
  const job = previewWorkflow.jobs.find(job => job.name === 'production');
  const migration = job.steps.findIndex(step => /production-migrations.mjs apply/.test(step.text));
  const gate = job.steps[migration - 1];
  assert.match(gate.text, /^id: current_main$/m);
  assert.match(gate.text, /^if: github.ref == 'refs\/heads\/main'$/m);
  assert.ok(!gate.keys.includes('continue-on-error'));
  const script = gate.text.match(/script: \|\n([\s\S]*)$/)[1];
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', 'process', script);
  for (const current of [sha, 'b'.repeat(40), undefined, 'api-error']) {
    const failures = [], calls = [];
    const github = { rest: { git: { getRef: async args => {
      calls.push(args);
      if (current === 'api-error') throw new Error('unavailable');
      return { data: { object: { sha: current } } };
    } } } };
    const run = execute(github, { repo: { owner: 'test', repo: 'os' } },
      { setFailed: message => failures.push(message) }, { env: { EZIL_DEPLOY_SHA: sha } });
    if (current === 'api-error') await assert.rejects(run, /unavailable/);
    else {
      await run;
      assert.equal(failures.length, current === sha ? 0 : 1);
    }
    assert.deepEqual(calls, [{ owner: 'test', repo: 'os', ref: 'heads/main' }]);
  }
  const steps = Object.fromEntries(job.steps.filter(step => /^id: /m.test(step.text)).map(step => [
    step.text.match(/^id: (.+)$/m)[1], { outcome: job.steps.indexOf(step) < migration - 1 ? 'success' : 'skipped' },
  ]));
  steps.current_main.outcome = 'failure';
  for (const step of job.steps.filter(step => /^if: always\(\)/m.test(step.text)
      && step.text.includes('steps.previous_worker.outcome'))) {
    const condition = step.text.match(/^if: (.+)$/m)[1];
    const evaluate = new Function('github', 'needs', 'steps', 'always', `return (${condition})`);
    assert.equal(evaluate({ ref: 'refs/heads/main' }, { changes: { outputs: { image_changed: 'true' } } }, steps, () => true), false);
  }
});

test('Worker and Vercel production deploys re-read main and refuse stale or unavailable refs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-current-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = previewWorkflow.jobs.find(job => job.name === 'production');
  const mutations = path.join(dir, 'mutations');
  for (const id of ['worker', 'production_app']) {
    const step = job.steps.find(step => step.text.includes(`id: ${id}\n`));
    const script = step.text.match(/run: \|\n([\s\S]*)$/)[1]
      .replaceAll('${{ steps.deadline.outputs.at }}', '10000')
      .replaceAll('${{ needs.changes.outputs.image_changed }}', 'false');
    for (const current of [sha, 'b'.repeat(40), '', 'api-error']) {
      fs.writeFileSync(mutations, '');
      const child = runWorkflowScript('bash', ['-e', '-c', `
        date() { echo 1000; }
        gh() {
          [[ "$*" == 'api repos/test/os/git/ref/heads/main --jq .object.sha' ]] || return 42
          [[ "$TEST_CURRENT_MAIN" != api-error ]] || return 1
          printf '%s\\n' "$TEST_CURRENT_MAIN"
        }
        timeout() {
          printf 'deploy\\n' >> "$TEST_MUTATIONS"
          printf 'https://new.vercel.app\\n'
        }
        ${script}
      `], { env: { PATH: process.env.PATH, EZIL_DEPLOY_SHA: sha, GITHUB_REPOSITORY: 'test/os',
        GITHUB_OUTPUT: path.join(dir, 'outputs'), TEST_CURRENT_MAIN: current, TEST_MUTATIONS: mutations,
        VERCEL_TOKEN: 'test-token', EZIL_E2E_WORKER: 'https://worker.example.test' } });
      assert.equal(child.status, current === sha ? 0 : 1, child.output);
      assert.equal(fs.readFileSync(mutations, 'utf8'), current === sha ? 'deploy\n' : '');
    }
  }
});

test('both deploy jobs gate live-check on completed rollouts and deployment identity', () => {
  for (const name of ['preview', 'production']) {
    const job = previewWorkflow.jobs.find(job => job.name === name);
    assert.ok(job, `${name} deploy job must exist`);
    const checks = job.steps.filter(step => /\bnode e2e\/live-check\.mjs\s*$/m.test(step.text));
    assert.equal(checks.length, 1, `${name} must run live-check once`);
    assert.ok(!checks[0].keys.includes('if'), `${name} live-check must not have an extra condition`);
    const deploy = job.steps.findIndex(step => /\bvercel deploy\b/.test(step.text));
    const rollout = job.steps.findIndex(step => /node e2e\/await-container-rollout.mjs/.test(step.text));
    const identity = job.steps.findIndex(step => /node e2e\/verify-cloud-deployment.mjs/.test(step.text));
    assert.ok(deploy >= 0 && deploy < rollout && rollout < identity && identity < job.steps.indexOf(checks[0]),
      `${name} must deploy, await rollout, and verify identity before live-check`);
    assert.match(job.steps[rollout].text, /if: .*needs.changes.outputs.image_changed == 'true'/);
    const capture = job.steps.findIndex(step => /release-state.mjs container-version/.test(step.text));
    const worker = job.steps.findIndex(step => /wrangler deploy\b/.test(step.text));
    assert.ok(capture >= 0 && capture < worker && worker < rollout);
    assert.match(job.steps[rollout].text, /EZIL_PREVIOUS_CONTAINER_VERSION: \$\{\{ steps.container_before.outputs.version \}\}/);
    assert.match(job.steps[rollout].text, /EZIL_CONTAINER_APPLICATION_ID: \$\{\{ steps.container_before.outputs.id \}\}/);
    assert.match(job.steps[rollout].text, /EZIL_EXPECTED_CONTAINER_DIGEST="\$\(.*release-state.mjs rollout-target\)"/);
    assert.match(job.steps[rollout].text, /export EZIL_EXPECTED_CONTAINER_DIGEST/);
    for (const index of [rollout, identity]) assert.ok(!job.steps[index].keys.includes('continue-on-error'));
    assert.match(job.steps[identity].text, new RegExp(`EZIL_E2E_APP: \\$\\{\\{ steps\\.${name === 'preview' ? 'preview_app' : 'production_app'}\\.outputs\\.url \\}\\}`));
    assert.match(job.steps[deploy].text, /echo "url=\$url" >> "\$GITHUB_OUTPUT"/);
  }
});

test('production recovery verifies captured identities after all restores and still fails', () => {
  const job = previewWorkflow.jobs.find(job => job.name === 'production');
  const recovery = ['Roll back production Worker', 'Restore previous container image and await rollback rollout', 'Restore previous Vercel production deployment', 'Verify production recovery identities', 'Fail after production recovery']
    .map(name => job.steps.find(step => step.line === `- name: ${name}`));
  for (const step of recovery) {
    assert.ok(step, 'production recovery step must exist');
    assert.match(step.text, /if: always\(\) && github\.ref == 'refs\/heads\/main' && steps\.previous_worker\.outcome == 'success' && steps\.previous_app\.outcome == 'success'/);
    for (const id of ['worker', 'production_app', 'rollout', 'identity', 'live_production']) {
      assert.ok(step.text.includes(`steps.${id}.outcome == 'failure'`));
    }
    assert.ok(!step.keys.includes('continue-on-error'));
  }
  assert.match(recovery[0].text, /wrangler rollback '\$\{\{ steps\.previous_worker\.outputs\.version \}\}' -y/);
  assert.match(recovery[1].text, /release-state\.mjs container-rollback/);
  assert.match(recovery[1].text, /steps\.previous_container\.outcome == 'success'/);
  assert.match(recovery[2].text, /VERCEL_ORG_ID: \$\{\{ secrets\.VERCEL_ORG_ID \}\}/);
  assert.match(recovery[2].text, /node \.github\/scripts\/vercel-api\.mjs promote '\$\{\{ steps\.previous_app\.outputs\.deployment \}\}'/);
  assert.match(recovery[3].text, /release-state\.mjs rollback-check/);
  assert.match(recovery[3].text, /timeout-minutes: 3/);
  assert.match(recovery[4].text, /^exit 1$/m);
  for (let i = 1; i < recovery.length; i++) assert.ok(job.steps.indexOf(recovery[i]) > job.steps.indexOf(recovery[i - 1]));
  const capture = job.steps.find(step => /release-state\.mjs capture/.test(step.text));
  assert.match(capture.text, /^if: github.ref == 'refs\/heads\/main'$/m);
  assert.ok(job.steps.indexOf(capture) < job.steps.findIndex(step => /wrangler deploy\b/.test(step.text)));
});

test('rollout and identity failures recover main with or without a new image, never tags', () => {
  const job = previewWorkflow.jobs.find(job => job.name === 'production');
  const recoveries = job.steps.filter(step => /wrangler rollback|release-state.mjs (?:container-rollback|rollback-check)|vercel-api.mjs promote|Fail after production recovery/.test(step.text));
  assert.equal(recoveries.length, 5);
  for (const imageChanged of ['true', 'false']) {
    for (const failure of ['worker', 'production_app', 'rollout', 'identity', 'live_production', null]) {
      const steps = Object.fromEntries(['previous_worker', 'previous_app', 'previous_container',
        'rollback_guard', 'worker', 'production_app', 'rollout', 'identity', 'live_production'].map(id => [id, { outcome: 'success' }]));
      if (failure) {
        steps[failure].outcome = 'failure';
        // Earlier gate failures skip the default-success live check.
        if (failure !== 'live_production') steps.live_production.outcome = 'skipped';
      }
      for (const recovery of recoveries) {
        const condition = recovery.text.match(/^if: (.+)$/m)[1];
        const evaluate = new Function('github', 'needs', 'steps', 'always', `return (${condition})`);
        const needs = { changes: { outputs: { image_changed: imageChanged } } };
        const expected = failure !== null && (imageChanged === 'true' || !recovery.text.includes('release-state.mjs container-rollback'));
        assert.equal(evaluate({ ref: 'refs/heads/main' }, needs, steps, () => true), expected);
        assert.equal(evaluate({ ref: 'refs/tags/v1.2.3' }, needs, steps, () => true), false);
      }
    }
  }
});

test('post-recovery readback retries convergence and fails after twelve unsuccessful checks', () => {
  const job = previewWorkflow.jobs.find(job => job.name === 'production');
  const step = job.steps.find(step => /release-state.mjs rollback-check/.test(step.text));
  const script = step.text.match(/run: \|\n([\s\S]*)$/)[1];
  for (const succeedsAt of [3, 13]) {
    const child = runWorkflowScript('bash', ['-e', '-c', `
      attempts=0
      node() { attempts=$((attempts + 1)); echo "$attempts"; (( attempts >= ${succeedsAt} )); }
      sleep() { :; }
      ${script}
    `]);
    assert.equal(child.status, succeedsAt === 3 ? 0 : 1, child.output);
    assert.equal(child.output.trim().split('\n').length, Math.min(succeedsAt, 12));
  }
});

test('staging alias readback rejects stale or different deployments before the live check', () => {
  const job = previewWorkflow.jobs.find(job => job.name === 'preview');
  const step = job.steps.find(step => /node e2e\/verify-cloud-deployment.mjs/.test(step.text));
  const script = step.text.match(/<<'JS'\n([\s\S]*?)\nJS/)[1]
    .replace("'./e2e/verify-cloud-deployment.mjs'", JSON.stringify(new URL('./verify-cloud-deployment.mjs', import.meta.url).href));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-alias-readback-'));
  try {
    fs.mkdirSync(path.join(dir, 'live-evidence'));
    fs.writeFileSync(path.join(dir, 'live-evidence/deployment-identity.json'), JSON.stringify({ vercel_deployment: deployment.id }));
    for (const patch of [{}, { id: 'dpl_other' }, { meta: { githubCommitSha: 'c'.repeat(40) } },
      { projectId: 'prj_other' }, { target: 'production' }, { url: 'old.vercel.app' }, { readyState: 'BUILDING' }]) {
      const child = runWorkflowScript(process.execPath, ['--input-type=module', '-e',
        `globalThis.fetch = async (input, options) => {
          const url = new URL(input);
          if (url.hostname !== 'api.vercel.com' || url.pathname !== '/v13/deployments/ezil-os-staging.vercel.app'
            || url.searchParams.get('teamId') !== 'team_test' || options.redirect !== 'error' || !options.signal) throw new Error('Unexpected alias request');
          return { ok: true, json: async () => (${JSON.stringify({ ...deployment, ...patch })}) };
        };\n${script}`,
      ], { cwd: dir, env });
      assert.equal(child.status, Object.keys(patch).length ? 1 : 0, child.output);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const { assertPreviewImage } = await import('../.github/scripts/record-manual-preview.mjs');
test('manual preview verifies the staged image source and exact tested layers', () => {
  const image=`registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/staging@sha256:${'d'.repeat(64)}`;
  const application={name:'ezil-os-worker-staging-sandbox',configuration:{image}};
  const images={source:sha,tested:true,desktop_digest:`sha256:${'e'.repeat(64)}`};
  const config={...env,EZIL_WORKER_NAME:'ezil-os-worker-staging'};
  const local={Config:{Labels:{'org.opencontainers.image.revision':sha}},RootFS:{Layers:['layer-a','layer-b']}};
  assert.equal(assertPreviewImage(application,images,config,local,local),image);
  for (const args of [
    [{...application,name:'ezil-os-worker-sandbox'},images,config,local,local],
    [application,{...images,tested:false},config,local,local],
    [application,images,{...config,EZIL_DEPLOY_TARGET:'production'},local,local],
    [application,images,config,{...local,RootFS:{Layers:['other']}},local],
    [application,images,config,{...local,Config:{Labels:{'org.opencontainers.image.revision':'b'.repeat(40)}}},local],
  ]) assert.throws(()=>assertPreviewImage(...args));
});

const { assertRollbackOwner, restoreContainer } = await import('../.github/scripts/release-state.mjs');
test('rollback refuses another release and restores container image through a completed rollout', async () => {
  const previous = {worker_version:'old-worker',vercel_deployment:'old-app',cloudflare_container:{id:'container',image:`registry.cloudflare.com/a/i@sha256:${'b'.repeat(64)}`}};
  const state = {worker_source:sha,vercel_source:sha,cloudflare_container:{id:'container',image:`registry.cloudflare.com/a/i@sha256:${'a'.repeat(64)}`}};
  assert.doesNotThrow(()=>assertRollbackOwner(previous,state,sha));
  assert.throws(()=>assertRollbackOwner(previous,{...state,worker_source:'c'.repeat(40)},sha),/Another Worker/);
  assert.throws(()=>assertRollbackOwner(previous,{...state,vercel_source:'c'.repeat(40)},sha),/Another Vercel/);
  const calls=[];
  const fake = async (url,options) => {
    calls.push({url,options});
    const value = options.method === 'GET' && url.endsWith('/container') ?
      {id:'container',configuration:{image:state.cloudflare_container.image,memory_mib:2048}} :
      url.endsWith('/rollouts') ? {id:'rollout'} : {status:'completed'};
    return {ok:true,json:async()=>value};
  };
  const result = await restoreContainer(previous,state,{...env,EZIL_DEPLOY_SHA:sha},fake);
  assert.equal(result.status,'completed');
  assert.deepEqual(JSON.parse(calls[1].options.body),{configuration:{image:previous.cloudflare_container.image,memory_mib:2048}});
  assert.equal(JSON.parse(calls[2].options.body).target_configuration.image,previous.cloudflare_container.image);
  assert.equal(calls.length,4);
  await assert.rejects(restoreContainer(previous,state,{...env,EZIL_DEPLOY_SHA:sha},async()=>({ok:false,status:403})),/restore .* manually/);
});

test('registry reuse never overwrites immutable tags and an absent overlay never rebuilds its base', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ezil-image-publish-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const plan = imagePlan(sha,p=>p);
  fs.writeFileSync(path.join(dir,'image-plan.json'),JSON.stringify(plan));
  fs.writeFileSync(path.join(dir,'docker'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$MOCK_CALLS"
if [[ "$1 $2" == "manifest inspect" ]]; then
  if [[ "$MOCK_MODE" == "denied" ]]; then echo 'unauthorized' >&2; exit 1; fi
  if [[ "$MOCK_MODE" == "overlay-missing" && "$3" == *:overlay-* ]]; then echo 'manifest unknown' >&2; exit 1; fi
elif [[ "$1 $2" == "buildx imagetools" ]]; then
  printf '{"digest":"sha256:${'d'.repeat(64)}"}\\n'
elif [[ "$1 $2" == "image inspect" ]]; then
  printf '%s\\n' "$EZIL_DEPLOY_SHA"
fi
`,{mode:0o755});
  const script = path.resolve('.github/scripts/build-images.sh');
  const run = mode => {
    const calls = path.join(dir,`${mode}-calls`), log = path.join(dir,`${mode}-log`);
    const fd=fs.openSync(log,'w');
    let result;
    try { result=spawnSync('bash',[script],{cwd:dir,timeout:10000,
      env:{...process.env,PATH:`${dir}:${process.env.PATH}`,EZIL_DEPLOY_SHA:sha,
        GITHUB_OUTPUT:path.join(dir,`${mode}-outputs`),MOCK_CALLS:calls,MOCK_MODE:mode},stdio:['ignore',fd,fd]});
    } finally { fs.closeSync(fd); }
    assert.ifError(result.error);
    return {status:result.status,calls:fs.readFileSync(calls,'utf8'),log:fs.readFileSync(log,'utf8')};
  };
  const reuse=run('exists');
  assert.equal(reuse.status,0,reuse.log);
  assert.doesNotMatch(reuse.calls,/^build |^push /m);
  const overlay=run('overlay-missing');
  assert.equal(overlay.status,0,overlay.log);
  assert.match(overlay.calls,/^push .*:overlay-/m);
  assert.doesNotMatch(overlay.calls,/^push .*:base-/m);
  assert.match(overlay.calls,/BASE_NEKO_IMAGE=.*@sha256:/);
  const denied=run('denied');
  assert.notEqual(denied.status,0);
  assert.doesNotMatch(denied.calls,/^build |^push /m);
});


test('container readback uses scoped pull credentials and removes temporary Docker authentication', async () => {
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-token'};
  const image=`registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/desktop@sha256:${'b'.repeat(64)}`;
  const calls=[];
  await pullCloudflareImage(image,env,async (url,options)=>{
    assert.equal(new URL(url).hostname,'api.cloudflare.com');
    assert.deepEqual(JSON.parse(options.body),{expiration_minutes:15,permissions:['pull']});
    return {ok:true,json:async()=>({result:{username:'account',password:'scoped-secret'}})};
  },(cmd,args,options)=>{
    calls.push({cmd,args,options});
    if(args.includes('login')) assert.equal(options.input,'scoped-secret');
    assert.ok(!args.includes('scoped-secret'));
  });
  assert.equal(calls.length,2);
  assert.equal(fs.existsSync(calls[0].args[1]),false);
  assert.equal(calls[1].args.at(-1),image);
});

test('image change paths cover desktop inputs without rebuilding for app/Worker source edits', () => {
  const inputs = outline(workflowText).children.find(node => node.line === 'env:')
    .children.find(node => node.line === 'IMAGE_INPUTS: |-').children.map(node => node.line);
  const covered = file => inputs.some(input => file === input || file.startsWith(`${input}/`));
  for (const file of ['docker/neko/build.sh', 'worker/neko/Dockerfile', 'worker/assets/browser-home.html',
    'worker/assets/neko-branding/Dockerfile', 'worker/bootstrap/dist/workspace-bootstrap.mjs',
    'worker/guacamole/root-index.html', 'worker/sandbox-template/package.json', 'worker/sidecar/index.js',
    'worker/scripts/start-neko.sh', 'worker/Dockerfile', 'worker/.dockerignore',
    '.github/scripts/image-plan.mjs', '.github/scripts/build-images.sh', '.github/scripts/test-desktop.sh']) {
    assert.ok(covered(file), `image input omitted: ${file}`);
  }
  for (const file of ['app/src/page.tsx', 'worker/src/index.ts', 'docs/RUNBOOK.md']) assert.equal(covered(file), false, file);
});

test('tag verification never deploys or recovers production, and failed live checks cannot publish', () => {
  const job = previewWorkflow.jobs.find(job => job.name === 'production');
  for (const step of job.steps) {
    if (/wrangler (?:deploy|rollback)|vercel deploy|vercel-api.mjs promote|release-state.mjs (?:prepare|preflight|capture|container-rollback|rollback-check|rollback-guard|container-version|rollout-target)|production-migrations.mjs apply/.test(step.text)) {
      assert.match(step.text, /if: .*github\.ref == 'refs\/heads\/main'/);
    }
    if (/gh release edit|imagetools create|release evidence and wait/.test(step.text)) {
      assert.match(step.text, /if: startsWith\(github.ref, 'refs\/tags\/v'\) && steps.live_production.outcome == 'success'/);
    }
  }
  const fail = job.steps.find(step => step.line === '- name: Fail unverified tag');
  assert.match(fail.text, /always\(\).*steps.live_production.outcome == 'failure'/);
  assert.match(fail.text, /^run: exit 1$/m);
  const migration = job.steps.findIndex(step => /production-migrations.mjs apply/.test(step.text));
  const prepare = job.steps.findIndex(step => /release-state.mjs prepare/.test(step.text));
  assert.ok(migration > 0 && migration < prepare, 'migration authorization needs a clean checkout before prepare');
  assert.ok(!job.steps[migration].keys.includes('continue-on-error'));
  const preflight = job.steps.findIndex(step => /release-state.mjs preflight/.test(step.text));
  assert.ok(prepare < preflight && preflight === job.steps.findIndex(step => /wrangler deploy\b/.test(step.text)) - 1,
    'the Worker deploy must directly follow the container rollout preflight');
});

test('tag receipt accepts a reused tested image but rejects stale production, untested images and different layers', async () => {
  const step = previewWorkflow.jobs.find(job => job.name === 'production').steps
    .find(step => step.line === '- name: Record verified tag production identities and image layers');
  const source = step.text.match(/<<'JS'\n([\s\S]*?)\nJS(?:\n|$)/)[1].replace(/^import .*;\n/gm, '');
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    'assert', 'fs', 'execFileSync', 'canonical', 'readState', 'process', source);
  const imageSource = 'b'.repeat(40);
  const state = {worker_source:sha, vercel_source:sha, cloudflare_container:{image:'registry.cloudflare.com/test/desktop@sha256:abc'}};
  const receipt = {source:imageSource, tested:true, desktop:`ghcr.io/ezilhq/ezil-os-desktop:sha-${imageSource}`, desktop_digest:`sha256:${'d'.repeat(64)}`};
  const image = {Config:{Labels:{'org.opencontainers.image.revision':imageSource}}, RootFS:{Layers:['layer-one']}};
  const verify = async (patch = {}) => {
    let recorded;
    await run(assert, {
      readFileSync: file => JSON.stringify(file === 'tested-images.json' ? {...receipt, ...patch.receipt} : state),
      writeFileSync: (file, value) => { assert.equal(file, 'production-release.json'); recorded = JSON.parse(value); },
    }, (_command, args) => args[0] === 'pull' ? '' : JSON.stringify([
      args.at(-1).startsWith('registry.cloudflare.com/') ? image : {...image, ...patch.image},
    ]), 'https://os.ezil.work', async () => structuredClone({...state, ...patch.state}),
    {env:{EZIL_DEPLOY_SHA:sha, IMAGE_SOURCE:imageSource, GITHUB_RUN_ID:'123'}});
    return recorded;
  };
  const recorded = await verify();
  assert.equal(recorded.source, sha);
  assert.equal(recorded.ghcr.source, imageSource);
  assert.equal(recorded.cloudflare_container.ghcr_layers_verified, true);
  for (const patch of [
    {receipt:{tested:false}}, {receipt:{source:sha}}, {receipt:{desktop_digest:'not-a-digest'}},
    {state:{worker_source:imageSource}}, {state:{vercel_source:imageSource}},
    {image:{RootFS:{Layers:['different-layer']}}},
    {image:{Config:{Labels:{'org.opencontainers.image.revision':sha}}}},
  ]) await assert.rejects(verify(patch));
});

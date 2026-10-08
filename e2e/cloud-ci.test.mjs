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
import './editor-shortcut.test.mjs';
import './relay-lifetime.test.mjs';
import './await-container-rollout.test.mjs';
import { deployedTarget, configureAppContext, APP_FETCH_TIMEOUT_MS, APP_STOP_FETCH_TIMEOUT_MS, appFetchTimeout } from './deployed-target.mjs';
import './sign-in.test.mjs';
import './code-picker.test.mjs';
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
  assert.equal(deployedTarget({}).app, 'https://os.ezil.org');
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
  let handler, options;
  await configureAppContext({ route: async (_pattern, callback) => { handler = callback; } },
    { app: target.app, headers: { 'x-vercel-protection-bypass': 'test-bypass' } });
  await handler({ request: () => request('POST', '/api/shell/stop'),
    fetch: async value => { options = value; return 'response'; }, fulfill: async () => {} });
  assert.equal(options.timeout, APP_STOP_FETCH_TIMEOUT_MS);
  assert.equal(options.maxRedirects, 0);
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
    `  - → POST ${target.app}/api/shell/desktop`,
    '    - cookie: __Host-ezil-os-auth=base64-SESSION-WITH-REFRESH-TOKEN',
    '    - x-vercel-protection-bypass: test-bypass',
  ].join('\n')), { name: 'TimeoutError' });
  const error = await handler({
    request: () => ({ url: () => `${target.app}/api/shell/desktop`, method: () => 'POST', headers: () => ({}) }),
    fetch: async () => { throw playwright; },
    fulfill: async () => { throw new Error('fulfill should not run'); },
  }).then(() => null, (e) => e);
  assert.ok(error, 'the failure must still surface');
  assert.equal(error.name, 'TimeoutError');
  assert.match(error.message, /POST \/api\/shell\/desktop: route\.fetch: Timeout 30000ms exceeded\.$/);
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
    if (url.pathname.endsWith('/os.ezil.org')) return {ok:true,json:async()=>alias};
    if (url.pathname.endsWith('/ezil-os.vercel.app')) return {ok:true,json:async()=>legacy};
    return fakeAPI({ '/v13/deployments/preview-test.vercel.app': prod }).fetch(input, options);
  };
  const result = await verifyCloudDeployment(prodEnv, api());
  assert.equal(result.canonical_url, 'https://os.ezil.org');
  await assert.rejects(verifyCloudDeployment(prodEnv, api({...prod, id:'other-deployment'})), /os\.ezil\.org points at another deployment/);
  await assert.rejects(verifyCloudDeployment(prodEnv, api(prod, {...prod, id:'other-deployment'})), /ezil-os\.vercel\.app points at another deployment/);
  await assert.rejects(verifyCloudDeployment(prodEnv, api({...prod, meta:{githubCommitSha:'b'.repeat(40)}})), /SHA differs/);
  await assert.rejects(verifyCloudDeployment(prodEnv, api({...prod, readyState:'ERROR'})), /not ready/);
});

const { imagePlan } = await import('../.github/scripts/image-plan.mjs');
const { readState, pullCloudflareImage, restoreVercel } = await import('../.github/scripts/release-state.mjs');

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
    if (url.pathname.endsWith('/os.ezil.org')) return {ok:true,json:async()=>prod};
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

test('Vercel rollback resolves legacy receipts and promotes the verified URL with explicit team scope', async () => {
  const old = {...deployment, target:'production', meta:{githubCommitSha:'b'.repeat(40)}, env:{SECRET:'do-not-store'}};
  const previous = {vercel_deployment:old.id, vercel_source:old.meta.githubCommitSha};
  for (const receipt of [previous, {...previous, vercel_url:old.url}]) {
    const calls = [], commands = [];
    const result = await restoreVercel(receipt, env, async (input, options) => {
      const url = new URL(input);
      calls.push(url.pathname);
      assert.equal(url.hostname, 'api.vercel.com');
      assert.equal(url.searchParams.get('teamId'), env.VERCEL_ORG_ID);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      const value = url.pathname.endsWith(`/${old.id}`) ? old : {...deployment, id:'dpl_new', target:'production'};
      return {ok:true, json:async()=>value};
    }, (...args) => commands.push(args));
    assert.deepEqual(result, {...previous, vercel_url:old.url});
    assert.equal(JSON.stringify(result).includes('do-not-store'), false);
    assert.deepEqual(calls, [`/v13/deployments/${old.id}`, '/v13/deployments/os.ezil.org']);
    assert.deepEqual(commands[0].slice(0,2), ['vercel', ['promote', old.url, '--scope', env.VERCEL_ORG_ID, '--yes', `--token=${env.VERCEL_TOKEN}`]]);
    assert.equal(commands.length, 1);
    assert.ok(commands[0][2].timeout <= 120000);
  }
});

test('Vercel rollback refuses mismatched identities, untrusted hostnames and lost ownership before promotion', async () => {
  const old = {...deployment, target:'production', meta:{githubCommitSha:'b'.repeat(40)}};
  const previous = {vercel_deployment:old.id, vercel_source:old.meta.githubCommitSha};
  let promoted = false;
  const exec = () => { promoted = true; };
  const api = (target = old, current = {...deployment, target:'production'}) => async input => ({
    ok:true, json:async()=>new URL(input).pathname.endsWith(`/${old.id}`) ? target : current,
  });
  for (const patch of [{id:'dpl_other'}, {projectId:'prj_other'}, {readyState:'ERROR'}, {target:null}, {meta:{}},
    {meta:{githubCommitSha:sha}}, ...['ezil-os.vercel.app', 'os.ezil.org', 'https://preview-test.vercel.app', 'evil.example',
      'preview-test.vercel.app.evil.example', 'user@preview-test.vercel.app', 'preview-test.vercel.app/?token=x',
      '--yes', 'preview-test.vercel.app:443'].map(url=>({url}))]) {
    await assert.rejects(restoreVercel(previous, env, api({...old,...patch}), exec));
  }
  await assert.rejects(restoreVercel({...previous,vercel_url:'different.vercel.app'}, env, api(), exec), /URL differs/);
  await assert.rejects(restoreVercel(previous, {...env,VERCEL_ORG_ID:''}, api(), exec), /team scope/);
  await assert.rejects(restoreVercel({...previous,vercel_source:null}, env, api(), exec), /source SHA/);
  await assert.rejects(restoreVercel(previous, env, api(old, {...old,id:'dpl_other'}), exec), /Another Vercel/);
  await assert.rejects(restoreVercel(previous, env, async()=>({ok:false,status:404}), exec), /HTTP 404/);
  assert.equal(promoted, false);
  await assert.rejects(restoreVercel(previous, env, api(), () => { throw new Error('token=do-not-print'); }), error => {
    assert.match(error.message, /promotion failed/);
    assert.doesNotMatch(error.message, /do-not-print/);
    return true;
  });
});

// Execute the actual admission script with fake GitHub readbacks. No checkout or secrets.
const workflowText = fs.readFileSync('.github/workflows/preview.yml','utf8');
test('rollback workflow keeps ownership admission and readback around the scoped Vercel helper', () => {
  const restore = workflowText.split('      - name: Restore previous Vercel production deployment\n')[1].split('      - name:')[0];
  assert.match(restore, /if: failure\(\) && steps\.rollback_guard\.outcome == 'success'/);
  assert.match(restore, /VERCEL_ORG_ID: \$\{\{ secrets\.VERCEL_ORG_ID \}\}/);
  assert.match(restore, /run: node \.github\/scripts\/release-state\.mjs vercel-rollback/);
  assert.match(workflowText, /node \.github\/scripts\/release-state\.mjs rollback-check/);
});
const admissionSource = workflowText.split('          script: |\n')[1].split('\n  preview:')[0]
  .split('\n').filter(line => line.startsWith('            ')).map(line => line.slice(12)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
async function admission({ event='workflow_dispatch', current=sha, conclusion='success', eventSha=sha, path='.github/workflows/ci.yml', previewPR='', prPatch={}, changedPR=false, ciPatch={} } = {}) {
  const outputs = {}, failures = [];
  const run = {head_sha:eventSha,head_branch:'main',path,head_repository:{full_name:'owner/os'},status:'completed',conclusion,event:previewPR?'pull_request':'push',workflow_id:1,...ciPatch};
  const pr = {state:'open',draft:true,base:{ref:'main',repo:{full_name:'owner/os'}},head:{sha,repo:{full_name:'owner/os'}},...prPatch};
  let reads = 0;
  const github = {rest:{git:{getRef:async()=>({data:{object:{sha:current}}})},actions:{
    listWorkflowRuns:async()=>({data:{workflow_runs:[run]}}),getWorkflow:async()=>({data:{path}}),
  },pulls:{get:async()=>({data:changedPR && reads++ > 0 ? {...pr,head:{...pr.head,sha:'b'.repeat(40)}} : pr})}}};
  const core = {setOutput:(k,v)=>outputs[k]=v,warning:()=>{},setFailed:s=>failures.push(s)};
  const context = {repo:{owner:'owner',repo:'os'},eventName:event,payload:{workflow_run:run,repository:{full_name:'owner/os'}}};
  await new AsyncFunction('github','core','context','process','setTimeout',admissionSource)(github,core,context,
    {env:{REQUESTED_SOURCE:sha,PREVIEW_PR:previewPR}}, callback=>callback());
  return {outputs,failures};
}
test('manual, tag and automatic admission require tested current main', async () => {
  for (const event of ['workflow_dispatch','push','workflow_run']) {
    const good = await admission({event});
    assert.equal(good.outputs.allowed,'true');
    assert.equal(good.outputs.production,'true');
    const stale = await admission({event,current:'b'.repeat(40)});
    assert.equal(stale.outputs.allowed,'false');
    assert.ok(stale.outputs.reason);
    const failed = await admission({event,conclusion:'failure'});
    assert.equal(failed.outputs.allowed,'false');
    const wrongWorkflow = await admission({event,path:'.github/workflows/other.yml'});
    assert.equal(wrongWorkflow.outputs.allowed,'false');
  }
});

test('manual preview admits tested current draft PR without admitting production', async () => {
  const result = await admission({ previewPR: '186' });
  assert.equal(result.outputs.allowed, 'true');
  assert.equal(result.outputs.manual_preview, 'true');
  assert.equal(result.outputs.preview_pr, '186');
  assert.equal(result.outputs.production, 'false');
  assert.equal(result.failures.length, 0);
});
test('manual preview rejects invalid PRs, forks, stale source and failed CI', async () => {
  for (const patch of [{ previewPR:'bad' }, { prPatch:{state:'closed'} },
    { prPatch:{head:{sha,repo:{full_name:'fork/os'}}} },
    { prPatch:{head:{sha:'b'.repeat(40),repo:{full_name:'owner/os'}}} },
    { prPatch:{base:{ref:'other',repo:{full_name:'owner/os'}}} },
    { conclusion:'failure' }, { changedPR:true }]) {
    const result = await admission({previewPR:'186',...patch});
    assert.equal(result.outputs.allowed,'false');
    assert.equal(result.outputs.production,'false');
    assert.ok(result.failures.length);
  }
});
test('manual preview ignores a CI run from another repository or event', async () => {
  for (const ciPatch of [{head_repository:{full_name:'fork/os'}},{event:'push'}]) {
    const result=await admission({previewPR:'186',ciPatch});
    assert.equal(result.outputs.allowed,'false');
    assert.equal(result.outputs.production,'false');
    assert.match(result.failures[0],/Timed out/);
  }
});

// A pull request is admitted on its current source so images build during CI;
// staging waits for pr-ci, which executes below with fake readbacks too.
function fakePR({ prPatch = {}, ciPatch = {}, completeAfter = 0 } = {}) {
  const pr = {state:'open',draft:false,base:{ref:'main',repo:{full_name:'owner/os'}},head:{sha,repo:{full_name:'owner/os'}},...prPatch};
  let polls = 0;
  const github = {rest:{actions:{listWorkflowRuns:async()=>{
    const run = {head_sha:sha,path:'.github/workflows/ci.yml',status:polls++ >= completeAfter ? 'completed' : 'in_progress',conclusion:'success',...ciPatch};
    return {data:{workflow_runs:[run]}};
  }},pulls:{get:async()=>({data:pr})}}};
  return { github, polls: () => polls };
}
async function runScript(source, { event='pull_request', fake, env={} }) {
  const outputs = {}, failures = [];
  const core = {setOutput:(k,v)=>outputs[k]=v,warning:()=>{},info:()=>{},setFailed:s=>failures.push(s)};
  const context = {repo:{owner:'owner',repo:'os'},eventName:event,payload:{pull_request:{number:188},repository:{full_name:'owner/os'}}};
  await new AsyncFunction('github','core','context','process','setTimeout',source)(fake.github,core,context,{env},callback=>callback());
  return {outputs,failures};
}
const prCiSource = workflowText.split('\n  pr-ci:\n')[1].split('          script: |\n')[1].split('\n\n  production:')[0]
  .split('\n').filter(line => line.startsWith('            ')).map(line => line.slice(12)).join('\n');
test('pull request admission resolves the current source without waiting for CI', async () => {
  const fake = fakePR({ completeAfter: Infinity });
  const result = await runScript(admissionSource, { fake });
  assert.equal(result.outputs.allowed, 'true');
  assert.equal(result.outputs.sha, sha);
  assert.equal(result.outputs.production, 'false');
  assert.equal(fake.polls(), 0);
  for (const prPatch of [{draft:true},{state:'closed'},{head:{sha,repo:{full_name:'fork/os'}}},{base:{ref:'other',repo:{full_name:'owner/os'}}}]) {
    const denied = await runScript(admissionSource, { fake: fakePR({ prPatch }) });
    assert.equal(denied.outputs.allowed, 'false');
    assert.equal(denied.outputs.sha, undefined);
  }
});
test('pr-ci passes only after successful CI on the unchanged admitted commit', async () => {
  const env = { SOURCE_SHA: sha };
  const passed = await runScript(prCiSource, { fake: fakePR({ completeAfter: 2 }), env });
  assert.deepEqual(passed.failures, []);
  for (const [options, message] of [
    [{ ciPatch: { conclusion: 'failure' } }, /PR CI concluded failure/],
    [{ prPatch: { head: { sha: 'b'.repeat(40), repo: { full_name: 'owner/os' } } } }, /PR changed while CI ran/],
    [{ prPatch: { state: 'closed' } }, /PR changed while CI ran/],
    [{ completeAfter: Infinity }, /Timed out/],
    [{ ciPatch: { path: '.github/workflows/other.yml' } }, /Timed out/],
    [{ ciPatch: { head_sha: 'b'.repeat(40) } }, /Timed out/],
  ]) {
    const result = await runScript(prCiSource, { fake: fakePR(options), env });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], message);
  }
  const missing = await runScript(prCiSource, { fake: fakePR(), env: {} });
  assert.match(missing.failures[0], /Admitted PR source missing/);
  const main = await runScript(prCiSource, { event: 'workflow_run', fake: fakePR({ completeAfter: Infinity }), env });
  assert.deepEqual(main.failures, []);
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

test('manual preview does not run disruptive acceptance or authorize its required PR status', () => {
  const preview=workflowText.split('\n  preview:\n')[1].split('\n  images:\n')[0];
  for (const name of ['Test the returned preview URL','Hosted continuity release gate']) {
    assert.match(preview.split(`      - name: ${name}\n`)[1].split('      - name:')[0],
      /if: needs\.trust\.outputs\.manual_preview != 'true'/);
  }
  assert.match(preview.split('      - name: Stop isolated staging test computer\n')[1],
    /if: always\(\) && steps\.lease\.outcome == 'success' && needs\.trust\.outputs\.manual_preview != 'true'/);
  assert.match(workflowText,/This run cannot satisfy the Hosted continuity PR gate/);
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

test('summary cannot report success when both deployments were skipped', async () => {
  const source = workflowText.slice(workflowText.indexOf('  summary:\n')).split('          script: |\n')[1]
    .split('\n').map(line=>line.slice(12)).join('\n');
  const failures=[];
  const summary={addHeading(){},addRaw(){},addTable(){},async write(){}};
  await new AsyncFunction('core','process',source)({summary,setFailed:s=>failures.push(s)},
    {env:{TRUSTED:'false',PREVIEW_RESULT:'skipped',PRODUCTION_RESULT:'skipped',ADMISSION_REASON:'stale source'}});
  assert.match(failures[0],/No deployment performed: stale source/);
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

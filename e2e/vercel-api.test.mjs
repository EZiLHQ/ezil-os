import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { aliasDeployment, promoteDeployment } from '../.github/scripts/vercel-api.mjs';

const env = { VERCEL_TOKEN: 'secret-vercel-test-token', VERCEL_ORG_ID: 'team_test', VERCEL_PROJECT_ID: 'prj_test' };
const deployment = { id: 'dpl_test', projectId: env.VERCEL_PROJECT_ID, readyState: 'READY' };
const alias = 'ezil-os-staging.vercel.app';
const response = (value, status = 200) => ({ status, json: async () => value });
const mutation = (status = 200) => ({ status, json: async () => { throw new Error('Mutation body must not be read'); } });
function api(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    const next = responses[calls.length - 1];
    if (next instanceof Error) throw next;
    assert.ok(next, 'Unexpected API request');
    return next;
  } };
}
function checkTransport(calls) {
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://api.vercel.com');
    assert.deepEqual([...url.searchParams], [['teamId', env.VERCEL_ORG_ID]]);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const { authorization, ...headers } = options.headers;
    assert.equal(authorization, `Bearer ${env.VERCEL_TOKEN}`);
    assert.deepEqual(headers, options.body ? { 'content-type': 'application/json' } : {});
    assert.equal(`${url}${options.body ?? ''}`.includes(env.VERCEL_TOKEN), false);
  }
}
function fixedError(message) {
  return error => {
    assert.equal(error.message, message);
    for (const secret of Object.values(env)) {
      assert.equal(`${error.message}${error.stack}${error.cause ?? ''}`.includes(secret), false);
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('Vercel alias resolves URL, host or ID, assigns it, then verifies the binding', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  for (const [reference, binding] of [
    ['https://candidate.vercel.app', { deploymentId: deployment.id }],
    ['candidate.vercel.app', { deployment: { id: deployment.id } }],
    [deployment.id, { deploymentId: deployment.id, deployment: { id: deployment.id } }],
  ]) {
    const mock = api([response(deployment), mutation(201), response(binding)]);
    assert.equal(await aliasDeployment(reference, alias, env, mock), deployment.id);
    assert.deepEqual(mock.calls.map(({ url, options }) => [options.method, url.pathname]), [
      ['GET', `/v13/deployments/${reference.replace('https://', '')}`],
      ['POST', `/v2/deployments/${deployment.id}/aliases`], ['GET', `/v4/aliases/${alias}`],
    ]);
    assert.deepEqual(JSON.parse(mock.calls[1].options.body), { alias });
    checkTransport(mock.calls);
  }
  assert.deepEqual(timeouts, Array(9).fill(30_000));
});

test('Vercel alias refuses another project, non-READY and invalid deployment identities before mutation', async () => {
  for (const value of [null, {}, ...[
    { projectId: 'prj_other' }, { readyState: 'BUILDING' }, { readyState: 'ERROR' }, { readyState: undefined },
    { id: 'dpl_other' }, { id: env.VERCEL_TOKEN },
  ].map(patch => ({ ...deployment, ...patch }))]) {
    const mock = api([response(value)]);
    await assert.rejects(aliasDeployment(deployment.id, alias, env, mock), fixedError('Vercel alias failed'));
    assert.equal(mock.calls.length, 1);
  }
});

test('Vercel alias fails on missing, mismatched or contradictory readback', async () => {
  for (const binding of [null, {}, { deploymentId: 'dpl_other' }, { deployment: { id: 'dpl_other' } },
    { deploymentId: deployment.id, deployment: { id: 'dpl_other' } }]) {
    const mock = api([response(deployment), mutation(), response(binding)]);
    await assert.rejects(aliasDeployment(deployment.id, alias, env, mock), fixedError('Vercel alias failed'));
    assert.equal(mock.calls.length, 3);
  }
});

test('Vercel promotion accepts 200/201/202 and polls the production alias until READY on the expected project', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal; });
  for (const status of [200, 201, 202]) {
    const sleeps = [];
    const mock = api([mutation(status), response({ ...deployment, id: 'dpl_old' }),
      response({ ...deployment, readyState: 'BUILDING' }), response({ ...deployment, projectId: 'prj_other' }), response(deployment)]);
    assert.equal(await promoteDeployment(deployment.id, env, { ...mock, sleep: async ms => sleeps.push(ms) }), deployment.id);
    assert.deepEqual(mock.calls.map(({ url, options }) => [options.method, url.pathname]), [
      ['POST', `/v10/projects/${env.VERCEL_PROJECT_ID}/promote/${deployment.id}`],
      ...Array.from({ length: 4 }, () => ['GET', '/v13/deployments/os.ezil.work']),
    ]);
    assert.equal(mock.calls[0].options.body, '{}');
    assert.equal(mock.calls[0].options.headers['content-type'], 'application/json');
    assert.deepEqual(sleeps, [5000, 5000, 5000]);
    checkTransport(mock.calls);
  }
  assert.deepEqual(timeouts, Array(15).fill(30_000));
});

test('Vercel promotion fails after twelve mismatched readbacks without repeating the mutation', async () => {
  const sleeps = [];
  const mock = api([mutation(202), ...Array.from({ length: 12 }, () => response({ ...deployment, id: 'dpl_old' }))]);
  await assert.rejects(promoteDeployment(deployment.id, env, { ...mock, sleep: async ms => sleeps.push(ms) }),
    fixedError('Vercel promotion failed'));
  assert.equal(mock.calls.length, 13);
  assert.equal(mock.calls.filter(({ options }) => options.method === 'POST').length, 1);
  assert.deepEqual(sleeps, Array(11).fill(5000));
});

test('Vercel API HTTP errors and redirects at every stage fail without reading or exposing error bodies', async () => {
  let bodiesRead = 0;
  for (const status of [204, 301, 302, 307, 308, 400, 401, 403, 404, 429, 500]) {
    const rejected = { status, json: async () => { bodiesRead++; return { token: env.VERCEL_TOKEN }; } };
    for (const stage of [0, 1, 2]) {
      const responses = [response(deployment), mutation(), response({ deploymentId: deployment.id })];
      responses[stage] = rejected;
      const mock = api(responses);
      await assert.rejects(aliasDeployment(deployment.id, alias, env, mock), fixedError('Vercel alias failed'));
      assert.equal(mock.calls.length, stage + 1);
    }
    for (const stage of [0, 1]) {
      const responses = [mutation(), response(deployment)];
      responses[stage] = rejected;
      const mock = api(responses);
      await assert.rejects(promoteDeployment(deployment.id, env, mock), fixedError('Vercel promotion failed'));
      assert.equal(mock.calls.length, stage + 1);
    }
  }
  const redirected = { ...response(deployment), redirected: true };
  await assert.rejects(aliasDeployment(deployment.id, alias, env, api([redirected])), fixedError('Vercel alias failed'));
  assert.equal(bodiesRead, 0);
});

test('Vercel fetch and JSON failures cannot leak tokens through messages, stacks or causes', async () => {
  for (const failure of [new Error(`Network failed with ${env.VERCEL_TOKEN}`, { cause: env.VERCEL_TOKEN }),
    { status: 200, json: async () => { throw new Error(`Invalid JSON: ${env.VERCEL_TOKEN}`); } }]) {
    for (const responses of [[failure], [response(deployment), failure], [response(deployment), mutation(), failure]]) {
      // Successful mutation bodies are deliberately ignored.
      if (responses.length === 2 && !(failure instanceof Error)) continue;
      await assert.rejects(aliasDeployment(deployment.id, alias, env, api(responses)), fixedError('Vercel alias failed'));
    }
    await assert.rejects(promoteDeployment(deployment.id, env, api([mutation(), failure])), fixedError('Vercel promotion failed'));
  }
  await assert.rejects(promoteDeployment(deployment.id, env, api([new Error(env.VERCEL_TOKEN)])), fixedError('Vercel promotion failed'));
});

test('Vercel request timeout aborts the request and exposes only the fixed failure', async t => {
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 30_000);
    const controller = new AbortController();
    setImmediate(() => controller.abort(new Error(env.VERCEL_TOKEN)));
    return controller.signal;
  });
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(aliasDeployment(deployment.id, alias, env, { fetchImpl }), fixedError('Vercel alias failed'));
  await assert.rejects(promoteDeployment(deployment.id, env, { fetchImpl }), fixedError('Vercel promotion failed'));
});

test('Vercel env requires a team ID, project ID and token before any request', async () => {
  for (const patch of [{ VERCEL_TOKEN: '' }, { VERCEL_TOKEN: ' ' }, { VERCEL_PROJECT_ID: '' },
    { VERCEL_PROJECT_ID: '../other' }, ...['', 'team_', 'user_test', 'ezil1', 'xteam_test', 'team_test?token=x']
      .map(VERCEL_ORG_ID => ({ VERCEL_ORG_ID }))]) {
    const mock = api([]);
    await assert.rejects(aliasDeployment(deployment.id, alias, { ...env, ...patch }, mock), fixedError('Vercel alias failed'));
    await assert.rejects(promoteDeployment(deployment.id, { ...env, ...patch }, mock), fixedError('Vercel promotion failed'));
    assert.equal(mock.calls.length, 0);
  }
});

test('Vercel input validation rejects credentials, paths, queries and options before requests', async () => {
  for (const input of ['', '--token=secret', 'http://candidate.vercel.app', 'https://user:secret@candidate.vercel.app',
    'candidate.vercel.app:443', 'candidate.vercel.app/path', 'candidate.vercel.app?token=x', 'candidate.vercel.app#x', '../dpl_test']) {
    const mock = api([]);
    await assert.rejects(aliasDeployment(input, alias, env, mock), fixedError('Vercel alias failed'));
    await assert.rejects(aliasDeployment(deployment.id, input, env, mock), fixedError('Vercel alias failed'));
    await assert.rejects(promoteDeployment(input, env, mock), fixedError('Vercel promotion failed'));
    assert.equal(mock.calls.length, 0);
  }
});

test('Vercel CLI fails quietly and does not accept credentials as arguments', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-vercel-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const args of [[], ['unknown', env.VERCEL_TOKEN], ['alias', deployment.id, alias], ['promote', deployment.id],
    ['alias', deployment.id, alias, `--token=${env.VERCEL_TOKEN}`], ['promote', deployment.id, `--token=${env.VERCEL_TOKEN}`]]) {
    // Use files for subprocess output in runners that disallow socket pairs.
    const stdout = path.join(dir, 'stdout'), stderr = path.join(dir, 'stderr');
    const out = fs.openSync(stdout, 'w'), err = fs.openSync(stderr, 'w');
    try {
      const child = spawnSync(process.execPath, ['.github/scripts/vercel-api.mjs', ...args], {
        env: {}, stdio: ['ignore', out, err], timeout: 5000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(fs.readFileSync(stdout, 'utf8'), '');
      assert.equal(fs.readFileSync(stderr, 'utf8'), 'Vercel API command failed\n');
    } finally { fs.closeSync(out); fs.closeSync(err); }
  }
});

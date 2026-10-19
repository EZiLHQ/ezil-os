import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareHostedComputer } from './prepare-hosted-computer.mjs';
import { resetTestRuntime } from './reset-test-runtime.mjs';
import { sandboxIdFor } from './cleanup-hosted-computer.mjs';

const sandbox = 'guac-abcdef0123456789-fedcba9876543210';
const staging = { EZIL_ACCEPTANCE_SANDBOX: sandbox, EZIL_ACCEPTANCE_HMAC_SECRET: 'private-test-hmac', EZIL_E2E_WORKER: 'https://worker.staging.example' };

test('the sandbox name is derived exactly as the OS shell derives it', () => {
  assert.equal(sandboxIdFor({ user: { id: 'abcdef01-2345-6789-aaaa-bbbbbbbbbbbb' }, computer: { id: 'fedcba98-7654-3210-cccc-dddddddddddd' } }), sandbox);
});

test('production preparation stops only; staging stops, verifies the computer, then resets', async () => {
  const calls = [];
  const cleanup = async (env, _c, _s, options) => { calls.push(['cleanup', options]); return { ok: true, phase: 'complete' }; };
  const reset = async args => { calls.push(['reset', args]); };
  assert.equal((await prepareHostedComputer({}, { cleanup, reset })).ok, true);
  assert.deepEqual(calls, [['cleanup', {}]]);
  calls.length = 0;
  const evidence = await prepareHostedComputer(staging, { cleanup, reset });
  assert.equal(evidence.ok, true); assert.equal(evidence.runtimeReset, true);
  assert.deepEqual(calls, [['cleanup', { expectSandbox: sandbox }],
    ['reset', { worker: staging.EZIL_E2E_WORKER, sandbox, secret: staging.EZIL_ACCEPTANCE_HMAC_SECRET }]]);
});

test('a partial staging configuration or a failed stop never resets', async () => {
  let resets = 0;
  const reset = async () => { resets++; };
  for (const key of Object.keys(staging)) {
    const evidence = await prepareHostedComputer({ ...staging, [key]: '' }, { cleanup: async () => ({ ok: true }), reset });
    assert.equal(evidence.ok, false); assert.equal(evidence.missingPrerequisite, key);
  }
  const failed = await prepareHostedComputer(staging, { cleanup: async () => ({ ok: false, failure: 'hosted_computer_cleanup_failed' }), reset });
  assert.equal(failed.ok, false);
  assert.equal(resets, 0);
});

test('a failed reset fails preparation with a fixed code and no private values', async () => {
  const evidence = await prepareHostedComputer(staging, { cleanup: async () => ({ ok: true }),
    reset: async () => { throw Object.assign(new Error(`https://worker.staging.example/sandbox/${sandbox}`), { code: 'runtime_running' }); } });
  assert.equal(evidence.ok, false); assert.equal(evidence.failure, 'test_runtime_reset_failed'); assert.equal(evidence.resetError, 'runtime_running');
  for (const secret of [sandbox, 'worker.staging.example', 'private-test-hmac']) assert.equal(JSON.stringify(evidence).includes(secret), false);
});

function fakeWorker(statuses, resetAnswer = { status: 200, body: { ok: true } }) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET', authorization: init.headers?.authorization, redirect: init.redirect });
    const answer = new URL(url).pathname.endsWith('/acceptance-reset') ? resetAnswer : statuses.shift() ?? { status: 500, body: { ok: false } };
    if (answer instanceof Error) throw answer;
    return { status: answer.status, json: async () => answer.body };
  };
  return { requests, fetchImpl };
}
const clock = () => { let t = 1_000_000; return { now: () => t, sleep: async ms => { t += ms; } }; };

test('reset is signed, never follows redirects, and waits for a fresh stopped object', async () => {
  const w = fakeWorker([new Error('Durable Object reset because its code was updated.'), { status: 500, body: { ok: false } },
    { status: 200, body: { ok: true, desktopRunning: false } }, { status: 200, body: { ok: true, desktopRunning: false } }]);
  const c = clock();
  assert.deepEqual(await resetTestRuntime({ worker: staging.EZIL_E2E_WORKER, sandbox, secret: 'private-test-hmac', fetchImpl: w.fetchImpl, ...c }), { healthy: 2 });
  assert.equal(w.requests[0].url, `${staging.EZIL_E2E_WORKER}/sandbox/${sandbox}/acceptance-reset`);
  assert.equal(w.requests[0].method, 'POST');
  assert.match(w.requests[0].authorization, /^Bearer t=1000000,v1=[a-f0-9]{64}$/);
  assert.ok(w.requests.every(r => r.redirect === 'error'));
  assert.equal(w.requests.length, 5);
});

test('reset refuses a running computer, a desktop that came back and a status that never settles', async () => {
  const running = fakeWorker([], { status: 409, body: { ok: false, error: 'runtime_running' } });
  await assert.rejects(resetTestRuntime({ worker: staging.EZIL_E2E_WORKER, sandbox, secret: 's', fetchImpl: running.fetchImpl, ...clock() }), { code: 'runtime_running' });
  assert.equal(running.requests.length, 1);
  const awake = fakeWorker([{ status: 200, body: { ok: true, desktopRunning: true } }]);
  await assert.rejects(resetTestRuntime({ worker: staging.EZIL_E2E_WORKER, sandbox, secret: 's', fetchImpl: awake.fetchImpl, ...clock() }), { code: 'desktop_running_after_reset' });
  const stuck = fakeWorker([]);
  await assert.rejects(resetTestRuntime({ worker: staging.EZIL_E2E_WORKER, sandbox, secret: 's', fetchImpl: stuck.fetchImpl, ...clock() }), { code: 'reset_status_timeout' });
  for (const bad of [{ worker: 'http://worker.example' }, { sandbox: 'guac-other' }, { secret: '' }]) {
    const w = fakeWorker([]);
    await assert.rejects(resetTestRuntime({ worker: staging.EZIL_E2E_WORKER, sandbox, secret: 's', fetchImpl: w.fetchImpl, ...clock(), ...bad }));
    assert.equal(w.requests.length, 0);
  }
});

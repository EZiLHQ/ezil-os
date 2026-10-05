import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupHostedComputer } from './cleanup-hosted-computer.mjs';

const computerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const env = { EZIL_E2E_APP: 'https://staging.example', EZIL_E2E_COMPUTER_ID: computerId,
  EZIL_E2E_EMAIL: 'test@example.invalid', EZIL_E2E_PASSWORD: 'private-test-password',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'private-test-bypass' };
function fixture({ selected = computerId, stop = { ok: true, terminated: true, outcome: 'destroyed' }, failure } = {}) {
  const calls = [];
  const page = { goto: async url => { calls.push(['goto', url]); },
    fill: async () => {}, waitForURL: async () => { if (failure === 'authentication') throw new Error('authorization: private-test-password'); },
    locator: () => ({ filter: () => ({ locator: () => ({ click: async () => {} }) }) }),
  };
  const response = json => ({ ok: () => true, json: async () => json, dispose: async () => {} });
  const context = { route: async () => {}, newPage: async () => page, request: {
    get: async (url, options) => { calls.push(['get', url, options]); return response({ computer: { id: selected } }); },
    post: async (url, options) => {
      calls.push(['stop', url, options]);
      if (failure === 'stop') throw new Error('cookie: private-test-password');
      return response(stop);
    },
  } };
  const browser = { newContext: async () => context, close: async () => { calls.push(['close']); } };
  return { calls, chromium: { launch: async () => browser } };
}
test('job cleanup authenticates without opening OS, verifies computer and confirms stop', async () => {
  const f = fixture();
  const evidence = await cleanupHostedComputer(env, f.chromium);
  assert.equal(evidence.ok, true); assert.equal(evidence.cleanupStopped, true);
  const url = new URL(f.calls.find(c => c[0] === 'goto')[1]);
  assert.equal(url.pathname, '/login'); assert.equal(url.searchParams.get('returnUrl'), '/computers');
  assert.equal(f.calls.some(c => c[0] === 'goto' && new URL(c[1]).pathname === '/os'), false);
  const request = f.calls.find(c => c[0] === 'stop');
  assert.equal(request[1], `${env.EZIL_E2E_APP}/api/shell/stop`);
  assert.deepEqual(request[2].data, { computerId }); assert.equal(request[2].timeout, 290000);
  assert.equal(request[2].maxRedirects, 0);
  assert.equal(f.calls.at(-1)[0], 'close');
});
test('cleanup requires configured isolated compute and refuses a different authenticated computer', async () => {
  for (const key of ['EZIL_E2E_APP', 'EZIL_E2E_COMPUTER_ID', 'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD']) {
    const f = fixture(); const evidence = await cleanupHostedComputer({ ...env, [key]: '' }, f.chromium);
    assert.equal(evidence.ok, false); assert.equal(evidence.missingPrerequisite, key); assert.equal(f.calls.length, 0);
  }
  const f = fixture({ selected: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
  const evidence = await cleanupHostedComputer(env, f.chromium);
  assert.equal(evidence.ok, false); assert.equal(evidence.phase, 'computer_identity');
  assert.equal(f.calls.some(c => c[0] === 'stop'), false);
});
test('cleanup failures remain explicit and redacted while browser resources close', async () => {
  for (const options of [{ failure: 'authentication' }, { failure: 'stop' },
    { stop: { ok: false, terminated: false, outcome: 'flush_failed' } },
    { stop: { ok: true, terminated: false, outcome: 'still_running' } }]) {
    const f = fixture(options); const evidence = await cleanupHostedComputer(env, f.chromium);
    assert.equal(evidence.ok, false); assert.equal(evidence.failure, 'hosted_computer_cleanup_failed');
    assert.equal(f.calls.at(-1)[0], 'close');
    for (const privateValue of [env.EZIL_E2E_EMAIL, env.EZIL_E2E_PASSWORD, env.VERCEL_AUTOMATION_BYPASS_SECRET, computerId]) {
      assert.equal(JSON.stringify(evidence).includes(privateValue), false);
    }
  }
  const f = fixture({ stop: { ok: true, terminated: false, outcome: 'not_running' } });
  assert.equal((await cleanupHostedComputer(env, f.chromium)).ok, true);
});

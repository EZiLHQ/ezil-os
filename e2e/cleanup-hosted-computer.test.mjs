import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupHostedComputer } from './cleanup-hosted-computer.mjs';

const computerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const env = { EZIL_E2E_APP: 'https://staging.example', EZIL_E2E_COMPUTER_ID: computerId,
  EZIL_E2E_EMAIL: 'test@example.invalid', EZIL_E2E_PASSWORD: 'private-test-password',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'private-test-bypass',
  NEXT_PUBLIC_SUPABASE_URL: 'https://db.staging.example', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-test-anon-key' };
function fixture(t, { selected = computerId, user = 'abcdef01-2345-6789-aaaa-bbbbbbbbbbbb', stop = { ok: true, terminated: true, outcome: 'destroyed' }, failure } = {}) {
  const calls = [];
  // The real sign-in runs against this fake grant and cookie jar.
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(['grant', url]);
    if (failure === 'authentication') return Response.json({ error_code: 'invalid_credentials', msg: env.EZIL_E2E_PASSWORD }, { status: 400 });
    return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 3600, user: { id: user } });
  });
  const jar = new Map();
  let current = 'about:blank';
  const page = { url: () => current, context: () => context, goto: async url => { calls.push(['goto', url]); current = url; } };
  const response = json => ({ ok: () => true, json: async () => json, dispose: async () => {} });
  const context = { route: async () => {}, newPage: async () => page, request: {
    get: async (url, options) => { calls.push(['get', url, options]); return response({ user: { id: user }, computer: { id: selected } }); },
  }, clearCookies: async () => {}, addCookies: async cookies => { for (const c of cookies) jar.set(c.name, c.value); },
  cookies: async () => [...jar].map(([name, value]) => ({ name, value })) };
  const send = async (url, options) => {
    calls.push(['stop', url, options]);
    if (failure === 'stop') throw new Error('cookie: private-test-password');
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(stop)) };
  };
  const browser = { newContext: async () => context, close: async () => { calls.push(['close']); } };
  return { calls, send, chromium: { launch: async () => browser } };
}
test('job cleanup authenticates without opening OS, verifies computer and confirms stop', async t => {
  const f = fixture(t);
  const evidence = await cleanupHostedComputer(env, f.chromium, f.send);
  assert.equal(evidence.ok, true); assert.equal(evidence.cleanupStopped, true);
  assert.equal(f.calls[0][1], `${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`);
  assert.deepEqual(f.calls.filter(c => c[0] === 'goto').map(c => c[1]), [`${env.EZIL_E2E_APP}/computers`]);
  const request = f.calls.find(c => c[0] === 'stop');
  assert.equal(request[1], `${env.EZIL_E2E_APP}/api/shell/stop`);
  assert.equal(request[2].body, JSON.stringify({ computerId })); assert.equal(request[2].timeout, 290000);
  assert.equal(request[2].headers['x-vercel-protection-bypass'], env.VERCEL_AUTOMATION_BYPASS_SECRET);
  assert.equal(f.calls.at(-1)[0], 'close');
});
test('cleanup requires configured isolated compute and refuses a different authenticated computer', async t => {
  for (const key of ['EZIL_E2E_APP', 'EZIL_E2E_COMPUTER_ID', 'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD',
    'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    const f = fixture(t); const evidence = await cleanupHostedComputer({ ...env, [key]: '' }, f.chromium, f.send);
    assert.equal(evidence.ok, false); assert.equal(evidence.missingPrerequisite, key); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t, { selected: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
  const evidence = await cleanupHostedComputer(env, f.chromium, f.send);
  assert.equal(evidence.ok, false); assert.equal(evidence.phase, 'computer_identity');
  assert.equal(f.calls.some(c => c[0] === 'stop'), false);
});
test('cleanup failures remain explicit and redacted while browser resources close', async t => {
  for (const options of [{ failure: 'authentication' }, { failure: 'stop' },
    { stop: { ok: false, terminated: false, outcome: 'flush_failed' } },
    { stop: { ok: true, terminated: false, outcome: 'still_running' } }]) {
    const f = fixture(t, options); const evidence = await cleanupHostedComputer(env, f.chromium, f.send);
    assert.equal(evidence.ok, false); assert.equal(evidence.failure, 'hosted_computer_cleanup_failed');
    assert.equal(f.calls.at(-1)[0], 'close');
    for (const privateValue of [env.EZIL_E2E_EMAIL, env.EZIL_E2E_PASSWORD, env.VERCEL_AUTOMATION_BYPASS_SECRET, computerId]) {
      assert.equal(JSON.stringify(evidence).includes(privateValue), false);
    }
  }
  const failed = fixture(t, { stop: { ok: false, terminated: false, outcome: 'flush_failed', detail: computerId } });
  assert.deepEqual((await cleanupHostedComputer(env, failed.chromium, failed.send)).stop,
    { status: 200, ok: false, outcome: 'flush_failed', error: undefined });
  const f = fixture(t, { stop: { ok: true, terminated: false, outcome: 'not_running' } });
  assert.equal((await cleanupHostedComputer(env, f.chromium, f.send)).ok, true);
});
test('a reset target that is not the signed-in test computer is refused before any stop', async t => {
  const expected = 'guac-abcdef0123456789-aaaaaaaaaaaaaaaa';
  const f = fixture(t);
  const ok = await cleanupHostedComputer(env, f.chromium, f.send, { expectSandbox: expected });
  assert.equal(ok.ok, true); assert.equal(ok.sandboxVerified, true);
  assert.equal(JSON.stringify(ok).includes(expected), false);
  const other = fixture(t, { user: 'bbbbbbbb-2345-6789-aaaa-bbbbbbbbbbbb' });
  const refused = await cleanupHostedComputer(env, other.chromium, other.send, { expectSandbox: expected });
  assert.equal(refused.ok, false); assert.equal(refused.phase, 'computer_identity');
  assert.equal(other.calls.some(c => c[0] === 'stop'), false);
});

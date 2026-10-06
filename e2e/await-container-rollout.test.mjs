import assert from 'node:assert/strict';
import { test } from 'node:test';
import { awaitContainerRollout } from './await-container-rollout.mjs';

const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-test-token', EZIL_WORKER_NAME: 'ezil-os-worker-staging' };
const application = { id: 'application', name: `${env.EZIL_WORKER_NAME}-sandbox`, version: 65,
  configuration: { image: `registry.cloudflare.com/test/desktop@sha256:${'b'.repeat(64)}` } };
const rollout = { id: 'rollout', created_at: '2026-10-06T00:56:33Z', status: 'completed',
  current_version: 64, current_configuration: { image: `registry.cloudflare.com/test/desktop@sha256:${'c'.repeat(64)}` },
  target_version: 65, target_configuration: application.configuration, steps: [{ status: 'completed' }] };

function fixture({ states = [rollout], changeApplication, status = 200 } = {}) {
  let time = 0, poll = 0;
  const calls = [];
  return { calls, options: { now: () => time, sleep: async ms => { time += ms; }, pollMs: 5, budgetMs: 20,
    fetchImpl: async (input, options) => {
      const url = new URL(input); calls.push({ url, options });
      const result = url.pathname.endsWith('/applications') ? [application]
        : url.pathname.endsWith('/rollouts') ? [states[Math.min(poll++, states.length - 1)]]
          : changeApplication ?? application;
      return { ok: status === 200, status, json: async () => ({ success: true, result }) };
    } } };
}

test('waits for the exact image rollout and all steps before cloud acceptance', async () => {
  const f = fixture({ states: [{ ...rollout, status: 'progressing' }, rollout] });
  const result = await awaitContainerRollout(env, f.options);
  assert.deepEqual(result, { application: application.name, version: 65, image: `sha256:${'b'.repeat(64)}`,
    rollout: 'rollout', status: 'completed', elapsedMs: 5 });
  assert.equal(f.calls.length, 5);
  for (const { url, options } of f.calls) {
    assert.equal(url.hostname, 'api.cloudflare.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.authorization, 'Bearer private-test-token');
  }
  assert.ok(!JSON.stringify(result).includes(env.CLOUDFLARE_API_TOKEN));
});

test('missing, stale, failed, changed and incomplete rollouts fail explicitly', async () => {
  for (const patch of [{ status: 'failed' }, { status: 'replaced' }, { status: 'unexpected' },
    { target_version: 64 }, { target_configuration: { image: 'other' } }, { steps: [] },
    { steps: [{ status: 'progressing' }] }]) {
    await assert.rejects(awaitContainerRollout(env, fixture({ states: [{ ...rollout, ...patch }] }).options));
  }
  await assert.rejects(awaitContainerRollout(env, fixture({ status: 403 }).options), /HTTP 403/);
  await assert.rejects(awaitContainerRollout(env, fixture({ changeApplication: { ...application, version: 66 } }).options), /changed/);
  await assert.rejects(awaitContainerRollout(env, fixture({ states: [
    { ...rollout, status: 'progressing' }, { ...rollout, id: 'replacement' },
  ] }).options), /changed/);
  const empty = fixture(); empty.options.fetchImpl = async () => ({ ok: true, json: async () => ({ result: [] }) });
  await assert.rejects(awaitContainerRollout(env, empty.options), /identity missing/);
});

test('application may retain current version while rollout progresses, then advance to target', async () => {
  const f = fixture({ states: [{ ...rollout, status: 'progressing' }, rollout] });
  const original = f.options.fetchImpl;
  let applicationReads = 0;
  f.options.fetchImpl = async (input, options) => {
    const response = await original(input, options);
    if (new URL(input).pathname.endsWith('/application') && applicationReads++ === 0) {
      return { ok: true, json: async () => ({ result: { ...application, version: 64,
        configuration: rollout.current_configuration } }) };
    }
    return response;
  };
  const result = await awaitContainerRollout(env, f.options);
  assert.equal(result.version, 65);
  assert.equal(result.elapsedMs, 5);
});

test('a stuck rollout is bounded and prerequisites fail before provider requests', async () => {
  const f = fixture({ states: [{ ...rollout, status: 'progressing' }] });
  await assert.rejects(awaitContainerRollout(env, f.options), /within its budget/);
  assert.equal(f.calls.length, 9);
  for (const patch of [{ CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: 'invalid' }, { EZIL_WORKER_NAME: 'other' }]) {
    const f = fixture();
    await assert.rejects(awaitContainerRollout({ ...env, ...patch }, f.options));
    assert.equal(f.calls.length, 0);
  }
});

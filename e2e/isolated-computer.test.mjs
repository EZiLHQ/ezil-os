import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySelectedComputer, stopIsolatedComputer } from './isolated-computer.mjs';

const computerId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
test('cloud selection refuses missing or mismatched IDs before any computer operation', async () => {
  let reads = 0;
  const page = { waitForFunction: async () => {}, evaluate: async () => { reads++; return otherId; } };
  await assert.rejects(verifySelectedComputer(page, { required: true, computerId: '' }), /Missing prerequisite/);
  await assert.rejects(verifySelectedComputer(page, { required: true, computerId: 'invalid' }), /UUID/);
  assert.equal(reads, 0);
  await assert.rejects(verifySelectedComputer(page, { required: true, computerId }), error => {
    assert.match(error.message, /another computer/);
    for (const value of [computerId, otherId]) {
      assert.ok(!String(error.stack).includes(value));
      assert.ok(!JSON.stringify(error).includes(value));
    }
    return true;
  });
  page.evaluate = async () => computerId;
  assert.equal(await verifySelectedComputer(page, { required: true, computerId }), computerId);
});
test('cloud selection requires a loaded session, while unconfigured manual read checks retain their scope', async () => {
  assert.equal(await verifySelectedComputer(null, { required: false, computerId: '' }), null);
  await assert.rejects(verifySelectedComputer({ waitForFunction: async () => { throw new Error('session unavailable'); } },
    { required: true, computerId }), /session unavailable/);
});
test('cleanup does not depend on a working page and confirms destroyed or already-stopped compute', async () => {
  for (const result of [{ ok: true, outcome: 'destroyed', terminated: true },
    { ok: true, outcome: 'not_running', terminated: false }]) {
    let disposed = false;
    const context = { request: { post: async (url, options) => {
      assert.equal(url, 'https://staging.example/api/shell/stop');
      assert.deepEqual(options, { data: { computerId }, headers: { 'x-vercel-protection-bypass': 'test-only' },
        maxRedirects: 0, timeout: 290000 });
      return { ok: () => true, json: async () => result, dispose: async () => { disposed = true; } };
    } } };
    await stopIsolatedComputer(context, computerId, 'https://staging.example',
      { 'x-vercel-protection-bypass': 'test-only' }, 290000);
    assert.ok(disposed);
  }
});
test('failed, incomplete and contradictory stop responses fail cleanup instead of passing acceptance', async () => {
  for (const result of [{ ok: false, outcome: 'flush_failed', terminated: false },
    { ok: true, outcome: 'still_running', terminated: false }, { ok: true, terminated: true },
    { ok: true, outcome: 'destroyed', terminated: false }, { ok: true, outcome: 'not_running', terminated: true }]) {
    let disposed = false;
    const context = { request: { post: async () => ({ ok: () => true, json: async () => result,
      dispose: async () => { disposed = true; } }) } };
    await assert.rejects(stopIsolatedComputer(context, computerId, 'https://staging.example', {}, 290000), /unconfirmed/);
    assert.ok(disposed);
  }
  await assert.rejects(stopIsolatedComputer({ request: { post: async () => { throw new Error('timed out'); } } },
    computerId, 'https://staging.example', {}, 290000), /timed out/);
});

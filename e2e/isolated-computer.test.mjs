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
const reply = (result, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(result)) });
const jar = { cookies: async () => [] };
test('cleanup does not depend on a working page and confirms destroyed or already-stopped compute', async () => {
  for (const result of [{ ok: true, outcome: 'destroyed', terminated: true },
    { ok: true, outcome: 'not_running', terminated: false }]) {
    const context = { cookies: async (url) => {
      assert.equal(url, 'https://staging.example');
      return [{ name: 'a', value: '1' }, { name: 'b', value: '2' }];
    } };
    let sent;
    await stopIsolatedComputer(context, computerId, 'https://staging.example',
      { 'x-vercel-protection-bypass': 'test-only' }, 290000, async (url, options) => { sent = [url, options]; return reply(result); });
    assert.deepEqual(sent, ['https://staging.example/api/shell/stop', { method: 'POST',
      headers: { 'x-vercel-protection-bypass': 'test-only', 'content-type': 'application/json', cookie: 'a=1; b=2' },
      body: JSON.stringify({ computerId }), timeout: 290000 }]);
  }
});
test('failed, incomplete and contradictory stop responses fail cleanup instead of passing acceptance', async () => {
  for (const result of [{ ok: false, outcome: 'flush_failed', terminated: false },
    { ok: true, outcome: 'still_running', terminated: false }, { ok: true, terminated: true },
    { ok: true, outcome: 'destroyed', terminated: false }, { ok: true, outcome: 'not_running', terminated: true }]) {
    await assert.rejects(stopIsolatedComputer(jar, computerId, 'https://staging.example', {}, 290000, async () => reply(result)), /unconfirmed/);
  }
  await assert.rejects(stopIsolatedComputer(jar, computerId, 'https://staging.example', {}, 290000,
    async () => ({ status: 200, headers: {}, body: Buffer.from('<html>') })), /unconfirmed/);
  await assert.rejects(stopIsolatedComputer(jar, computerId, 'https://staging.example', {}, 290000,
    async () => reply({ ok: true, outcome: 'destroyed', terminated: true }, 502)), /Cleanup stop failed/);
  await assert.rejects(stopIsolatedComputer(jar, computerId, 'https://staging.example', {}, 290000,
    async () => { throw new Error('timed out'); }), /timed out/);
});

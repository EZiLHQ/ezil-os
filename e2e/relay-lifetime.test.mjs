import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelayLifetime } from './relay-lifetime.mjs';

const state = expiresAt => ({ ok: true, runtimeId: 'current-runtime', expiresAt });
function fixture(samples) {
  let clock = 1000, index = 0, frames = 0;
  const sleeps = [];
  return { options: { durationMs: 300, intervalMs: 100, expectedRuntimeId: 'current-runtime', now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    readRelay: async () => samples[Math.min(index++, samples.length - 1)],
    verifyViewer: async () => { frames++; } }, sleeps, frames: () => frames };
}
test('session hold requires a new expiry and frame progress throughout its duration', async () => {
  const f = fixture([state(2000), state(2000), state(2500), state(2500)]);
  assert.deepEqual(await verifyRelayLifetime(f.options), { elapsedMs: 300, initialExpiresAt: 2000,
    finalExpiresAt: 2500, renewals: 1 });
  assert.equal(f.frames(), 3);
  assert.deepEqual(f.sleeps, [100, 100, 100]);
});
test('an earlier reconnect renewal cannot stand in for renewal during the hold', async () => {
  const f = fixture([state(5000)]);
  await assert.rejects(verifyRelayLifetime(f.options), /did not occur during session hold/);
  assert.equal(f.frames(), 3);
});
test('session hold fails if frame delivery stops or the runtime changes', async () => {
  const f = fixture([state(2000), state(2500)]);
  f.options.verifyViewer = async () => { throw new Error('No decoded frames'); };
  await assert.rejects(verifyRelayLifetime(f.options), /No decoded frames/);
  const replacement = fixture([state(2000), { ...state(2500), runtimeId: 'replacement-runtime' }]);
  await assert.rejects(verifyRelayLifetime(replacement.options), /replaced runtime/);
  const stale = fixture([{ ...state(2000), runtimeId: 'replacement-runtime' }]);
  await assert.rejects(verifyRelayLifetime(stale.options), /changed before session hold/);
  assert.equal(stale.frames(), 0);
});
test('missing, expired and regressing relay metadata cannot pass a session hold', async () => {
  for (const current of [null, { ...state(2500), ok: false }, state(1100), state(1900)]) {
    const f = fixture([state(2000), current]);
    await assert.rejects(verifyRelayLifetime(f.options), /relay unavailable or expired|expiry moved backwards/);
  }
  const f = fixture([null]);
  await assert.rejects(verifyRelayLifetime(f.options), /baseline unavailable/);
});
test('sampling spans the full hold even when its duration is not an interval multiple', async () => {
  const f = fixture([state(2000), state(2500)]);
  f.options.durationMs = 250;
  assert.equal((await verifyRelayLifetime(f.options)).elapsedMs, 250);
  assert.deepEqual(f.sleeps, [100, 100, 50]);
});

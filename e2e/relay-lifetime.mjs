import assert from 'node:assert/strict';

/** Require credential renewal during this hold, after earlier reconnect tests. */
export async function verifyRelayLifetime({ durationMs, expectedRuntimeId, readRelay, verifyViewer,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 30000 }) {
  assert.ok(Number.isSafeInteger(durationMs) && durationMs > 0, 'Session hold duration required');
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > 0, 'Session sampling interval required');
  assert.ok(typeof expectedRuntimeId === 'string' && expectedRuntimeId.length > 0, 'Session hold runtime identity required');
  const valid = state => state?.ok === true && typeof state.runtimeId === 'string' && state.runtimeId.length > 0
    && Number.isSafeInteger(state.expiresAt) && state.expiresAt > now();
  const baseline = await readRelay();
  assert.ok(valid(baseline), 'Session hold relay baseline unavailable or expired');
  assert.ok(baseline.runtimeId === expectedRuntimeId, 'Runtime changed before session hold');
  const startedAt = now(), deadline = startedAt + durationMs;
  let previousExpiry = baseline.expiresAt, renewals = 0;
  while (now() < deadline) {
    await sleep(Math.min(intervalMs, deadline - now()));
    await verifyViewer();
    const current = await readRelay();
    assert.ok(valid(current), 'Session hold relay unavailable or expired');
    assert.ok(current.runtimeId === baseline.runtimeId, 'Session hold replaced runtime');
    assert.ok(current.expiresAt >= previousExpiry, 'Session hold relay expiry moved backwards');
    if (current.expiresAt > previousExpiry) renewals++;
    previousExpiry = current.expiresAt;
  }
  assert.ok(renewals > 0, 'Automatic credential renewal did not occur during session hold');
  return { elapsedMs: now() - startedAt, initialExpiresAt: baseline.expiresAt,
    finalExpiresAt: previousExpiry, renewals };
}

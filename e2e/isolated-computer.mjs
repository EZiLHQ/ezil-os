import assert from 'node:assert/strict';

/** Cloud CI must verify its explicit computer before opening or restarting apps. */
export async function verifySelectedComputer(page, {
  computerId = process.env.EZIL_E2E_COMPUTER_ID,
  required = process.env.EZIL_E2E_REQUIRE_TARGET === '1',
} = {}) {
  if (!required && !computerId) return null;
  assert.ok(computerId, 'Missing prerequisite: EZIL_E2E_COMPUTER_ID');
  assert.match(computerId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    'Explicit isolated computer UUID required');
  await page.waitForFunction(() => !!window.ezil?.session?.payload?.()?.computer?.id,
    null, { timeout: 45000 });
  const selected = await page.evaluate(() => window.ezil.session.payload().computer.id);
  assert.equal(selected, computerId, 'Authenticated session selects another computer; refusing cloud operations');
  return computerId;
}

/** Cleanup works after page failure and treats already-stopped compute as success. */
export async function stopIsolatedComputer(context, computerId, app, headers, timeout) {
  assert.match(computerId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const response = await context.request.post(`${app}/api/shell/stop`, {
    data: { computerId }, headers, maxRedirects: 0, timeout,
  });
  try {
    assert.ok(response.ok(), 'Cleanup stop failed');
    const stopped = await response.json();
    assert.ok(stopped.ok === true && (stopped.outcome === 'destroyed' && stopped.terminated === true
      || stopped.outcome === 'not_running' && stopped.terminated === false), 'Cleanup stop unconfirmed');
  } finally { await response.dispose(); }
}

import assert from 'node:assert/strict';
import { appRequest, cookieHeader } from './deployed-target.mjs';

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
  // Do not let AssertionError print private expected/actual UUIDs in public CI.
  assert.ok(selected === computerId, 'Authenticated session selects another computer; refusing cloud operations');
  return computerId;
}

/** Cleanup works after page failure and treats already-stopped compute as success. */
export async function stopIsolatedComputer(context, computerId, app, headers, timeout, send = appRequest) {
  assert.match(computerId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  // The final checkpoint can hold this response silent for minutes; see appRequest.
  const cookies = await context.cookies(app);
  const response = await send(`${app}/api/shell/stop`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', ...(cookies.length ? { cookie: cookieHeader(cookies) } : {}) },
    body: JSON.stringify({ computerId }),
    timeout,
  });
  let stopped;
  try { stopped = JSON.parse(response.body.toString('utf8')); } catch { stopped = null; }
  try {
    assert.ok(response.status >= 200 && response.status < 300, 'Cleanup stop failed');
    assert.ok(stopped?.ok === true && (stopped.outcome === 'destroyed' && stopped.terminated === true
      || stopped.outcome === 'not_running' && stopped.terminated === false), 'Cleanup stop unconfirmed');
  } catch (error) {
    // Public CI evidence: the status and the server's own codes only, never the body.
    error.stop = stopSummary(response.status, stopped);
    throw error;
  }
}

const CODE = /^[A-Za-z_]{1,40}$/;
function stopSummary(status, body) {
  const code = value => (typeof value === 'string' && CODE.test(value) ? value : undefined);
  return { status, ok: body?.ok === true, outcome: code(body?.outcome), error: code(body?.error) ?? code(body?.error?.code) };
}

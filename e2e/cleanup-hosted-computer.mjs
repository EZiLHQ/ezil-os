import { signIn } from './sign-in.mjs';
/** Final cloud-job cleanup, independent of whether browser acceptance reached its finally block. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { deployedTarget, configureAppContext, APP_STOP_FETCH_TIMEOUT_MS } from './deployed-target.mjs';
import { stopIsolatedComputer } from './isolated-computer.mjs';

export async function cleanupHostedComputer(env = process.env, chromium) {
  const evidence = { ok: false, phase: 'prerequisites' };
  let browser;
  try {
    for (const key of ['EZIL_E2E_APP', 'EZIL_E2E_COMPUTER_ID', 'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD']) {
      if (!env[key]) { evidence.missingPrerequisite = key; throw new Error('missing_cleanup_prerequisite'); }
    }
    const computerId = env.EZIL_E2E_COMPUTER_ID;
    assert.ok(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(computerId));
    const { app, headers } = deployedTarget(env);
    assert.ok(new URL(app).protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(app).hostname));
    evidence.computerHash = createHash('sha256').update(computerId).digest('hex');
    if (!chromium) {
      if (!env.PLAYWRIGHT_REQUIRE_DIR) { evidence.missingPrerequisite = 'PLAYWRIGHT_REQUIRE_DIR'; throw new Error('missing_cleanup_prerequisite'); }
      const require = createRequire(env.PLAYWRIGHT_REQUIRE_DIR + '/test.js');
      ({ chromium } = require('playwright'));
    }
    evidence.phase = 'authentication';
    browser = await chromium.launch();
    const context = await browser.newContext();
    await configureAppContext(context, { app, headers });
    const page = await context.newPage();
    // Login lands on the management page. Loading /os would open applications
    // and start the computer again while its cleanup is being verified.
    await page.goto(`${app}/login?method=email&returnUrl=%2Fcomputers`);
    await signIn(page, { email: env.EZIL_E2E_EMAIL, password: env.EZIL_E2E_PASSWORD, destination: '/computers' });
    evidence.phase = 'computer_identity';
    const session = await context.request.get(`${app}/api/shell/session`, { headers, maxRedirects: 0, timeout: 30000 });
    try {
      assert.ok(session.ok());
      assert.ok((await session.json()).computer?.id === computerId, 'cleanup_computer_mismatch');
    } finally { await session.dispose(); }
    evidence.phase = 'final_stop';
    await stopIsolatedComputer(context, computerId, app, headers, APP_STOP_FETCH_TIMEOUT_MS);
    evidence.cleanupStopped = true;
    evidence.ok = true;
    evidence.phase = 'complete';
  } catch {
    // Browser errors may contain session headers, credentials or computer IDs.
    evidence.failure = 'hosted_computer_cleanup_failed';
  } finally {
    try { await browser?.close(); } catch { evidence.ok = false; evidence.failure = 'cleanup_browser_close_failed'; }
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await cleanupHostedComputer();
  mkdirSync('hosted-continuity-evidence', { recursive: true });
  writeFileSync('hosted-continuity-evidence/final-cleanup.json', JSON.stringify(evidence, null, 2));
  console.log(evidence.ok ? 'PASS final hosted computer cleanup' : 'FAIL final hosted computer cleanup');
  if (!evidence.ok) process.exitCode = 1;
}

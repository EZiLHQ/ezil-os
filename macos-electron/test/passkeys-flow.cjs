'use strict';
// Real product dock/tab navigation, with CDP strictly for a local synthetic
// authenticator. This is not evidence of physical/platform authenticator access.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { assertNativeSession } = require('./product-flow-helpers.cjs');
const { _electron } = require('playwright-core');
const { Workspaces } = require('../src/workspaces.cjs');
const { developmentEnvironment } = require('../src/development-environment.cjs');
const { startFixture } = require('./passkey-fixture.cjs');
const root = path.resolve(__dirname, '../..');
const base = process.env.EZIL_PASSKEY_EVIDENCE;
assert.ok(base && path.isAbsolute(base), 'Set EZIL_PASSKEY_EVIDENCE to an absolute disposable evidence directory');
fs.mkdirSync(base, { recursive: true });
const evidence = fs.realpathSync(fs.mkdtempSync(path.join(base, 'passkeys-')));
const dataRoot = path.join(evidence, 'data'), store = new Workspaces(dataRoot);
store.guest(); const workspace = store.create('Passkeys acceptance'); store.index.activeID = workspace.id; store.save();
const report = { passed: false, checks: [], limitations: ['Development source, not installed release bytes.', 'Synthetic virtual authenticator, not real Touch ID/iCloud/Google.', 'Keychain persistence and physical authenticator approval require a properly signed build and human testing.'] };
let app, site, page, activeStep = 'launch_and_browser_dock', unlocked = false;
const clients = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 15000; do { const value = await check(); if (value) return value; await wait(100); } while (Date.now() < end); throw Error('readiness_timeout'); }
async function step(id, fn) { activeStep = id; await fn(); report.checks.push(id); }
async function authenticator(content) {
  const client = await app.context().newCDPSession(content); clients.push(client);
  await client.send('WebAuthn.enable', { enableUI: true });
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { client, authenticatorId };
}
(async () => {
  try {
    try { assertNativeSession(execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 5000 })); unlocked = true; }
    catch { report.limitations.push('Desktop locked: synthetic browser automation only; screenshots and native input acceptance are unexecuted.'); }
    site = await startFixture();
    const resources = process.env.EZIL_PASSKEY_RESOURCES || root;
    const env = { ...developmentEnvironment(resources), EZIL_NATIVE_RESOURCES: resources, EZIL_NATIVE_APP_DATA: dataRoot, EZIL_NATIVE_SKIP_LEGACY: '1',
      EZIL_BUN_PATH: path.join(root, '.native-tools/bin/bun'), EZIL_SHELL_ASSETS: path.join(root, 'app/public/os'),
      // The helper resolves shell assets relative to its own source location.
      // An old packaged helper would test an old shell even with new host code.
      EZIL_HELPER_PATH: path.join(root, 'native/src/main.ts') };
    app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'macos-electron')], env, timeout: 20000 });
    page = await app.firstWindow(); page.setDefaultTimeout(12000);
    await page.locator('.taskbar-item[data-app="desktop"]').click();
    const browser = page.locator('.window[data-app="desktop"]').last();
    const address = browser.getByRole('textbox', { name: 'Browser address' });
    await step('honest_signing_blocked_status', async () => {
      await until(async () => (await browser.locator('.ezil-native-browser-auth').innerText()).includes('Apple-signed'));
      if (unlocked) await page.screenshot({ path: path.join(evidence, 'passkeys-shell.png'), timeout: 10000 });
    });
    await address.fill(site.origin); await address.press('Enter');
    const content = await until(() => app.context().pages().find(p => p.url() === site.origin + '/'));
    await content.locator('#register').waitFor();
    await step('sandbox_and_real_platform_availability', async () => {
      assert.deepEqual(await content.evaluate(() => [typeof window.ezilNative, typeof window.require, typeof window.process]), ['undefined', 'undefined', 'undefined']);
      report.realPlatformAvailable = await content.evaluate(() => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
      assert.equal(report.realPlatformAvailable, false, 'ad-hoc runtime must not advertise Touch ID');
    });
    const virtual = await authenticator(content);
    await step('registration_and_cryptographically_verified_assertion', async () => {
      await content.locator('#register').click(); await until(async () => await content.locator('#result').innerText() === 'Registration verified');
      await content.locator('#authenticate').click(); await until(async () => await content.locator('#result').innerText() === 'Assertion verified');
      assert.deepEqual(site.results, { registrations: 1, assertions: 1 });
      if (unlocked) await content.screenshot({ path: path.join(evidence, 'passkey-assertion.png'), timeout: 10000 });
    });
    await step('rp_mismatch_rejected_by_chromium', async () => {
      await content.locator('#wrong-rp').click(); await until(async () => await content.locator('#result').innerText() === 'SecurityError');
    });
    await step('pending_request_can_be_canceled', async () => {
      await virtual.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: virtual.authenticatorId, enabled: false });
      await content.locator('#authenticate').click(); await until(async () => await content.locator('#result').innerText() === 'Request pending');
      await content.locator('#cancel').click(); await until(async () => await content.locator('#result').innerText() === 'AbortError');
      await virtual.client.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: virtual.authenticatorId, enabled: true });
    });
    if (unlocked) await step('native_discoverable_account_chooser_with_synthetic_passkey', async () => {
      assertNativeSession(execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 5000 }));
      await content.locator('#discover').click();
      // Fixed synthetic account label and this test process only. Never operate
      // a Google, Touch ID, password-manager or other real credential dialog.
      const pid = app.process().pid; assert.ok(Number.isSafeInteger(pid) && pid > 1);
      const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-e', `tell application "System Events"
set deadline to (current date) + 12
repeat while (current date) < deadline
tell first application process whose unix id is ${pid}
repeat with win in windows
repeat with control in entire contents of win
try
if role of control is "AXButton" and name of control is "1. synthetic@example.invalid" and enabled of control then
click control
return "clicked_synthetic_account"
end if
end try
end repeat
end repeat
end tell
delay 0.2
end repeat
error "synthetic_account_dialog_not_found"
end tell`], { timeout: 15000 });
      assert.equal(stdout.trim(), 'clicked_synthetic_account');
      await until(async () => await content.locator('#result').innerText() === 'Assertion verified');
    });
    await step('second_real_browser_tab_uses_webauthn', async () => {
      await browser.getByRole('button', { name: 'New tab', exact: true }).click();
      await address.fill(site.origin + '/second'); await address.press('Enter');
      const second = await until(() => app.context().pages().find(p => p.url() === site.origin + '/second'));
      await second.locator('#register').waitFor(); await authenticator(second);
      await second.locator('#register').click(); await until(async () => await second.locator('#result').innerText() === 'Registration verified');
      await second.locator('#authenticate').click(); await until(async () => await second.locator('#result').innerText() === 'Assertion verified');
      assert.equal(site.results.assertions, unlocked ? 3 : 2);
    });
    await step('user_link_popup_tab_uses_webauthn', async () => {
      const second = app.context().pages().find(p => p.url() === site.origin + '/second');
      await second.getByRole('link', { name: 'Open passkey test in new tab' }).click();
      const popup = await until(() => app.context().pages().find(p => p.url() === site.origin + '/popup'));
      await popup.locator('#register').waitFor(); await authenticator(popup);
      await popup.locator('#register').click(); await until(async () => await popup.locator('#result').innerText() === 'Registration verified');
      await popup.locator('#authenticate').click(); await until(async () => await popup.locator('#result').innerText() === 'Assertion verified');
    });
    report.passed = true;
  } catch (error) {
    report.failure = { step: activeStep, category: error.code || error.name || 'failed' };
    if (activeStep === 'honest_signing_blocked_status') report.observedHint = await page?.locator('.ezil-native-browser-auth').textContent({ timeout: 1000 }).catch(() => 'unavailable');
    process.exitCode = 1;
  }
  finally {
    for (const client of clients) await client.detach().catch(() => {});
    if (app) {
      // Harness-only cleanup confirmation. Not a native quit-dialog test. Never
      // leave a fixture hanging behind a locked screen or dismiss real accounts.
      const instance = app, exited = new Promise(resolve => instance.process().once('exit', resolve));
      await instance.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); app.quit(); }).catch(() => {});
      let timeout;
      try { await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => { report.cleanupFailed = true; process.exitCode = 1; resolve(); }, 10000); })]); }
      finally { clearTimeout(timeout); }
      if (report.cleanupFailed) await instance.evaluate(({ BrowserWindow, app }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); setTimeout(() => app.exit(1), 2000); }).catch(() => {});
    }
    await site?.close();
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ evidence, ...report }, null, 2));
  }
})();

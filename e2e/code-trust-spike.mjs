// code-trust-spike.mjs — one scenario of e2e/code-trust-spike.sh: open a marker repository as Code's folder and try the
// triggers, never accepting trust. Every trust prompt is answered Cancel and its text logged; keys are pressed only in a
// verified, focused quick-input (Enter on the trust prompt is its default "Trust Folder & Continue", which would
// trust the folder and fake a leak). The markers are the evidence: the payloads write <mark>/<surface> when they run.
//   node code-trust-spike.mjs <ip> <container> <evidence dir> <scenario> <folder> <mark> <run> <trust /workspace first 0|1>
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [IP, NAME, EVID, SCN, FOLDER, MARK, RUN, TW] = process.argv.slice(2);
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
const { chromium } = require('playwright');
mkdirSync(EVID, { recursive: true });
const log = (s) => { console.log(s); appendFileSync(`${EVID}/trust-spike.log`, `${s}\n`); };
const inC = (cmd) => { try { return execFileSync('docker', ['exec', NAME, 'bash', '-lc', cmd], { encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const markers = () => inC(`sh /var/tmp/check_markers.sh ${MARK} ${RUN}`).trim().split('\n').join(' | ');
const settings = inC(`python3 -c "import json;s=json.load(open('/tmp/code-server-data/User/settings.json'));print({k:s.get(k) for k in ['security.workspace.trust.enabled','task.allowAutomaticTasks','chat.mcp.autostart']})"`).trim();
log(`\n== ${SCN}: folder ${FOLDER}; person trusts /workspace first: ${TW === '1'}; settings ${settings}`);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.setDefaultTimeout(30_000);
const shot = (n) => page.screenshot({ path: `${EVID}/${SCN}-${n}.png` }).catch(() => {});
const open = async (folder) => {
  await page.goto(`http://${IP}:8443/?folder=${encodeURIComponent(folder)}`);
  await page.locator('.monaco-workbench').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(15_000);
};
// The status bar entry's label, not its visibility: the entry exists in both states.
const restricted = () => page.locator('[id="status.workspaceTrust"]').getAttribute('aria-label').then((l) => /Restricted Mode/.test(l || ''), () => false);
const palette = async (cmd) => {
  await page.locator('.monaco-workbench .part.editor').click({ position: { x: 600, y: 120 } }).catch(() => {});
  await page.keyboard.press('F1');
  const i = page.locator('.quick-input-widget input');
  await i.waitFor({ timeout: 15_000 });
  await i.fill(`>${cmd}`);
  await page.waitForTimeout(900);
  if (await i.isVisible() && await i.evaluate((el) => el === document.activeElement)) await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
};
const cancelTrustPrompt = async (when) => {
  const d = page.locator('.monaco-dialog-box');
  if (!(await d.isVisible().catch(() => false))) { log(`  ${when}: no trust prompt`); return; }
  const text = (await d.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  await shot(`${when.replace(/\W+/g, '_')}-prompt`);
  await d.getByRole('button', { name: /^Cancel$/ }).click();
  await page.waitForTimeout(1500);
  log(`  ${when}: trust prompt "${text}" -> Cancel`);
};

if (TW === '1') {
  // The person trusts their own files the ordinary way: Manage Workspace Trust → Trust, on /workspace.
  await open('/workspace');
  await palette('Workspaces: Manage Workspace Trust');
  const b = page.locator('.workspace-trust-editor').getByRole('button', { name: /^Trust$/ }).first();
  if (await b.isVisible({ timeout: 10_000 }).catch(() => false)) await b.click();
  await page.waitForTimeout(3000);
  log(`  the person trusted /workspace (their own files): restricted now=${await restricted()}`);
}
await open(FOLDER);
log(`  checkout opened: restricted=${await restricted()} (status bar label)`);
await shot('opened');
log(`  markers after open (+15s): ${markers()}`);
await palette('Terminal: Create New Terminal');
await cancelTrustPrompt('terminal');
for (const f of ['f3.ts', 'f3.php', 'f3.js']) {
  await page.locator('.monaco-workbench .part.editor').click({ position: { x: 600, y: 120 } }).catch(() => {});
  await page.keyboard.press('Control+P');
  const i = page.locator('.quick-input-widget input');
  if (await i.isVisible({ timeout: 8000 }).catch(() => false)) {
    await i.fill(f);
    await page.waitForTimeout(1200);
    if (await i.evaluate((el) => el === document.activeElement)) await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await cancelTrustPrompt(`open ${f}`);
  } else log(`  open ${f}: quick open not shown`);
}
await palette('Tasks: Run Task');
await cancelTrustPrompt('run task');
await page.keyboard.press('Escape').catch(() => {});
await palette('View: Show Source Control');
await page.waitForTimeout(2000);
await shot('after-triggers');
await page.waitForTimeout(30_000);
log(`  restricted after triggers: ${await restricted()}`);
log(`  markers after triggers (+30s): ${markers()}`);
await browser.close();

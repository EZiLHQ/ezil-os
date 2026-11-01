/**
 * Lead-run Playwright half of copilot-ezil-image.sh's history pass. Fresh browser per phase.
 *   EZIL_E2E_PHASE=create  send one chat; its session file must land in <folder>/.ezil/chat
 *                          and nowhere in the editor profile.
 *   EZIL_E2E_PHASE=verify  after a restart (new container /tmp, same workspace), at a different
 *                          address (new workspace-storage id) and in a new browser profile:
 *                          "Chat history" shows on the empty chat, lists the conversation,
 *                          reopens it, and deleting it removes its file. Then `git clean -X` under
 *                          the running editor: .ezil stays out of Git, and capture restores its ignore.
 * Exit 2 means not run.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset (a node_modules with `playwright` and a downloaded chromium)'); process.exit(2); }
let chromium;
try { ({ chromium } = createRequire(REQ_DIR + '/x.js')('playwright')); }
catch { console.error('SKIP: playwright unresolvable from ' + REQ_DIR); process.exit(2); }

const CODE_URL = (process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:8443').replace(/\/$/, '');
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out';
const CONTAINER = process.env.EZIL_E2E_CONTAINER ?? '';
const PHASE = process.env.EZIL_E2E_PHASE ?? '';
const PROMPT = 'EZIL_E2E_HISTORY: remember this conversation';
const T = Number(process.env.EZIL_E2E_TIMEOUT_MS ?? 120_000);
if (!['create', 'verify'].includes(PHASE) || !CONTAINER) { console.error('SKIP: set EZIL_E2E_PHASE=create|verify and EZIL_E2E_CONTAINER'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const info = (name, detail) => { results.push({ name, ok: true, info: true, detail }); console.log(`INFO  ${name}  — ${detail}`); };
const sh = command => execFileSync('docker', ['exec', CONTAINER, 'bash', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// `docker exec` runs as root while the project belongs to the desktop user: Git refuses such a repository
// ("dubious ownership") unless told to trust it, and a refused status would read as an empty, passing one.
const GIT = "git -c safe.directory='*'";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const clean = s => s.replace(/\s+/g, ' ').trim();
const CHAT = join(FOLDER, '.ezil', 'chat');
// Session files that mention the prompt: in the workspace, and anywhere in the editor profile.
const sessionFiles = () => sh(`grep -l -F ${quote(PROMPT)} ${quote(CHAT)}/*.jsonl ${quote(CHAT)}/*.json 2>/dev/null || true`).split('\n').filter(Boolean);
const profileCopies = () => sh(`grep -rl -F ${quote(PROMPT)} /tmp/code-server-data/User 2>/dev/null || true`).split('\n').filter(Boolean);

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Only code-server itself; anything else is aborted (the image suite asserts the sink).
const codeHost = new URL(CODE_URL).host;
await context.route('**/*', route => (new URL(route.request().url()).host === codeHost ? route.continue() : route.abort()));
const page = await context.newPage();
const aux = page.locator('.part.auxiliarybar');
const transcript = async () => clean(await aux.locator('.interactive-list').first().innerText().catch(() => ''));
const rows = async () => (await page.locator('.quick-input-widget .monaco-list-row').allInnerTexts()).map(clean).filter(Boolean);
const until = async (predicate, label, ms = T) => {
  const started = Date.now();
  while (Date.now() - started < ms) { if (await predicate()) return true; await page.waitForTimeout(500); }
  info('timed out waiting', label);
  return false;
};

try {
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: T });
  await aux.locator('.chat-input-container').first().waitFor({ state: 'visible', timeout: T });
  check('the history folder exists before the editor starts', sh(`test -d ${quote(CHAT)} && ! test -L ${quote(CHAT)} && echo yes || echo no`).trim() === 'yes');

  if (PHASE === 'create') {
    const editor = aux.locator('.chat-input-container .monaco-editor').first();
    await until(async () => /Qwen3 Coder Next/.test(await aux.locator('.chat-input-container').first().innerText().catch(() => '')), 'model picker ready', 60_000);
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      await editor.locator('.view-lines').first().click({ force: true });
      await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
      await page.keyboard.type(PROMPT, { delay: 3 });
      if (clean(await editor.innerText()).includes(PROMPT.slice(0, 20))) { await page.keyboard.press('Enter'); sent = true; }
    }
    check('prompt sent', sent);
    check('the gateway answered in the chat', await until(async () => (await transcript()).includes('EZiL Chat'), 'response'), (await transcript()).slice(0, 160));
    // The store writes on its storage flush; give it time, then require exactly one file.
    await until(async () => sessionFiles().length > 0, 'session file in the workspace', 90_000);
    const files = sessionFiles();
    check('the conversation is saved once, in <workspace>/.ezil/chat', files.length === 1, JSON.stringify(files));
    const copies = profileCopies();
    check('no chat session copy in the editor profile', !copies.some(c => c.includes('/chatSessions/')), JSON.stringify(copies));
    info('other editor-profile files that contain the prompt (Copilot traces/transcripts; not removed by a delete)', JSON.stringify(copies));
    const initStatus = sh(`cd ${quote(FOLDER)} && ${GIT} init -q && ${GIT} status --porcelain --untracked-files=all`).split('\n').filter(Boolean);
    check('.ezil is ignored by Git', !initStatus.some(l => l.includes('.ezil')), JSON.stringify(initStatus.slice(0, 8)));
  } else {
    check('the saved conversation survived the restart', sessionFiles().length === 1, JSON.stringify(sessionFiles()));
    info('browser address (a different host:port than the create phase means a different workspace-storage id)', new URL(CODE_URL).host);
    const title = aux.locator('.chat-view-title-container.visible .chat-view-title-label').first();
    const shown = await until(async () => (await title.isVisible().catch(() => false)), '"Chat history" title', 30_000);
    const label = shown ? clean(await title.innerText()) : '';
    check('an empty chat shows the "Chat history" title', /chat history/i.test(label), JSON.stringify(label));
    const notice = clean(await aux.locator('.chat-welcome-view-disclaimer').first().innerText().catch(() => ''));
    check('the EZiL notice still shows on the empty chat', notice.includes('AI responses may be inaccurate'), notice.slice(0, 120));
    await page.screenshot({ path: join(OUT, 'history-empty-chat.png') });
    await aux.locator('.chat-view-title-container.visible .chat-view-title-action-item').first().click();
    await page.locator('.quick-input-widget').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    await until(async () => (await rows()).some(r => r.includes('EZIL_E2E_HISTORY') || /EZiL Chat/.test(r)), 'history rows', 30_000);
    const listed = await rows();
    await page.screenshot({ path: join(OUT, 'history-picker.png') });
    const row = listed.find(r => r.includes('EZIL_E2E_HISTORY')) ?? listed.find(r => /EZiL Chat/.test(r));
    check('a new browser lists the conversation from before the restart', Boolean(row), JSON.stringify(listed.slice(0, 6)));
    if (row) {
      // Match a stable token, not the row's joined text: the row also carries its group label ("Today") and a
      // relative time, and the title is the default "EZiL Chat" when no title was generated.
      const rowText = row.includes('EZIL_E2E_HISTORY') ? 'EZIL_E2E_HISTORY' : /EZiL Chat/;
      await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: rowText }).first().click();
      check('choosing it reopens the conversation', await until(async () => (await transcript()).includes(PROMPT), 'reopened transcript', 30_000), (await transcript()).slice(0, 160));
      await page.screenshot({ path: join(OUT, 'history-reopened.png') });
      // Delete from the picker: the row's own delete button, then the file must be gone.
      await aux.locator('.chat-view-title-container.visible .chat-view-title-action-item').first().click();
      await page.locator('.quick-input-widget').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      const target = page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: rowText }).first();
      await target.hover().catch(() => {});
      const del = target.locator('.action-label[aria-label*="Delete" i], .action-label[title*="Delete" i]').first();
      if (await del.count()) {
        await del.click();
        const confirm = page.locator('.monaco-dialog-box .monaco-button').filter({ hasText: /^Delete$/ }).first();
        if (await confirm.isVisible().catch(() => false)) await confirm.click();
        check('deleting it removes its file from the workspace', await until(async () => sessionFiles().length === 0, 'file deleted', 30_000), JSON.stringify(sessionFiles()));
      } else {
        const buttons = await target.locator('.action-label').evaluateAll(els => els.map(e => e.getAttribute('aria-label') || e.getAttribute('title') || ''));
        info('picker row has no delete button in this build', JSON.stringify(buttons));
      }
      await page.keyboard.press('Escape').catch(() => {});
    }
    // The create phase ran `git init`, so this launch found a repository at the root. `git clean -X`
    // removes the ignored .ezil under the running editor, whose next write recreates .ezil/chat
    // (simulated here; FileService creates missing parents) without .ezil/.gitignore.
    const exclude = join(FOLDER, '.git', 'info', 'exclude');
    check('launch added /.ezil/ to the repository\'s local exclude', sh(`grep -qxF /.ezil/ ${quote(exclude)} && echo yes || echo no`).trim() === 'yes');
    const ezilStatus = () => sh(`cd ${quote(FOLDER)} && ${GIT} status --porcelain --untracked-files=all`).split('\n').filter(Boolean);
    sh(`cd ${quote(FOLDER)} && ${GIT} clean -fdXq && mkdir -p .ezil/chat && echo '{}' > .ezil/chat/after-clean.jsonl && echo x > after-clean.txt`);
    const status = ezilStatus();
    check('after git clean -X, a recreated .ezil/chat stays out of Git before any capture (a normal file is listed)',
      status.some(l => l.includes('after-clean.txt')) && !status.some(l => l.includes('.ezil')), JSON.stringify(status));
    sh(`bash /usr/local/bin/editor-state.sh capture ${quote(FOLDER)}`);
    check('the next capture restores .ezil/.gitignore', sh(`tail -n 1 ${quote(join(FOLDER, '.ezil', '.gitignore'))} 2>/dev/null || true`).trim() === '*');
  }
} catch (e) {
  check('suite completed without an unexpected exception', false, String(e).slice(0, 300));
} finally {
  await page.screenshot({ path: join(OUT, `history-${PHASE}-final.png`) }).catch(() => {});
  await context.close();
  await browser.close();
}
writeFileSync(join(OUT, `history-${PHASE}-checks.json`), JSON.stringify({ codeUrl: CODE_URL, folder: FOLDER, results }, null, 2));
const failed = results.filter(r => !r.ok);
const asserted = results.filter(r => !r.info);
// INFO rows are context, not assertions: count them apart.
console.log(`\n${asserted.length - failed.length}/${asserted.length} history checks passed, ${results.length - asserted.length} info (${PHASE}); artifacts in ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);

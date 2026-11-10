/**
 * Lead-run Playwright half of copilot-ezil-image.sh's compaction pass (founder screenshot 75e327c8: a long Kimi K3
 * chat ended in "Conversation too large or invalid — start a new chat" with a raw stack). Kimi K3, about 24 KB per answer
 * (mock EZIL_E2E_LONG), with Copilot's own summariser off so only ezil-models' compaction can keep the chat going:
 * - every turn is answered in the same chat, with no refusal, stack or "start a new chat";
 * - every chat request is within the byte bound; the ones over it as Copilot built them were compacted (the
 *   extension's metadata line), mark what they left out, and keep every user prompt Copilot sent;
 * - the chat view's title bar shows "Conversation compacted to fit the model";
 * - the saved conversation in <workspace>/.ezil/chat still holds the first answer whole.
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
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const TURNS = Number(process.env.EZIL_E2E_LONG_TURNS ?? 7);
const T = Number(process.env.EZIL_E2E_TIMEOUT_MS ?? 120_000);
const KIMI = 'us.moonshotai.kimi-k3';
const KIMI_NAME = 'Kimi K3';
const BOUND = 131072 - 1056;
const CODEWORD = 'AMBER-7';
const COMPACTED = 'Conversation compacted to fit the model';
if (!CONTAINER) { console.error('SKIP: set EZIL_E2E_CONTAINER'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const info = (name, detail) => { results.push({ name, ok: true, info: true, detail }); console.log(`INFO  ${name}  — ${detail}`); };
const sh = command => execFileSync('docker', ['exec', CONTAINER, 'bash', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const clean = s => s.replace(/\s+/g, ' ').trim();
const prompt = turn => turn === 1
    ? `EZIL_E2E_LONG turn 1: my requirement is that every file keeps the codeword ${CODEWORD}. Answer at length.`
    : `EZIL_E2E_LONG turn ${turn}: continue the same task and answer at length.`;
// What the mock received: the capture directory inside the container.
const captured = () => JSON.parse(sh(`cat ${quote(CAPTURE_DIR)}/captured.json 2>/dev/null || echo '[]'`)).filter(r => r.method === 'POST' && r.path === '/ai/v1/messages');

// Copilot's own summariser off, for this profile only: the chat must continue on ezil-models' compaction alone.
const SETTINGS = '/tmp/code-server-data/User/settings.json';
sh(`node -e 'const fs=require("fs");const f=process.argv[1];let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}s["github.copilot.chat.summarizeAgentConversationHistory.enabled"]=false;fs.writeFileSync(f,JSON.stringify(s,null,2))' ${quote(SETTINGS)}`);

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const codeHost = new URL(CODE_URL).host;
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', route => (new URL(route.request().url()).host === codeHost ? route.continue() : route.abort()));
const page = await context.newPage();
const aux = page.locator('.part.auxiliarybar');
const transcript = async () => clean(await aux.locator('.interactive-list').first().innerText().catch(() => ''));
const busy = async () => (await aux.locator('.interactive-input-part, .chat-input-container').locator('[aria-label*="Cancel" i], [aria-label*="Stop" i], .codicon-stop-circle').count()) > 0;
const until = async (predicate, label, ms = T) => {
  const started = Date.now();
  while (Date.now() - started < ms) { if (await predicate()) return true; await page.waitForTimeout(500); }
  info('timed out waiting', label);
  return false;
};
const pickerRows = page.locator('.context-view .monaco-list-row, .quick-input-widget .monaco-list-row, .action-widget .monaco-list-row, .monaco-menu .action-item');
// The model control may sit in the input toolbar or in the chat header: find it anywhere in the chat view.
const modelButton = () => aux.locator('.action-label, [role="button"]').filter({ hasText: /Qwen3 Coder Next|Kimi K3/ }).first();
const send = async text => {
  const editor = aux.locator('.chat-input-container .monaco-editor, .interactive-input-editor .monaco-editor').first();
  await editor.waitFor({ state: 'visible', timeout: T });
  for (let attempt = 0; attempt < 3; attempt++) {
    await editor.locator('.view-lines').first().click({ force: true });
    await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
    await page.keyboard.type(text, { delay: 2 });
    if (clean(await editor.innerText()).includes(text.slice(0, 24))) { await page.keyboard.press('Enter'); return true; }
  }
  return false;
};

try {
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: T });
  await until(async () => (await modelButton().count()) > 0, 'model control', 60_000);
  await modelButton().click();
  await page.waitForTimeout(800);
  if (!(await pickerRows.filter({ hasText: KIMI_NAME }).count())) {
    await pickerRows.filter({ hasText: /^\s*Other Models/ }).first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
  await pickerRows.filter({ hasText: KIMI_NAME }).first().click();
  check('Kimi K3 is selected', await until(async () => (await modelButton().innerText().catch(() => '')).includes(KIMI_NAME), 'Kimi selected', 15_000));

  let compactedSeen = false;
  for (let turn = 1; turn <= TURNS; turn++) {
    if (!(await send(prompt(turn)))) { check(`turn ${turn} prompt reached the chat input`, false); break; }
    const answered = await until(async () => (await transcript()).includes(`EZIL_LONG_OK_${turn}`) && !(await busy()), `turn ${turn} answer`);
    const text = await transcript();
    const refused = /too large|start a new chat|Sorry, your request failed|Reason:|extension\.js|provideLanguageModelChatResponse/i.test(text);
    check(`turn ${turn} answered in the same chat, no refusal or stack`, answered && !refused, refused ? text.slice(-300) : '');
    if (!compactedSeen && await aux.locator(`[aria-label="${COMPACTED}"], [title="${COMPACTED}"]`).first().isVisible().catch(() => false)) {
      compactedSeen = true;
      await page.screenshot({ path: join(OUT, `compaction-title-bar-turn-${turn}.png`) });
    }
    if (!answered || refused) break;
  }
  await page.screenshot({ path: join(OUT, 'compaction-final.png') });
  check('the chat view title bar showed "Conversation compacted to fit the model"', compactedSeen);

  // Chat turns only (Agent mode, so they carry tools): Copilot's title and progress utility calls quote the prompt but go
  // to Qwen without tools by design (provider.ts isUtilityRequest).
  const turnOf = r => { const users = (r.body?.messages ?? []).filter(m => m.role === 'user'); const text = JSON.stringify(users.at(-1) ?? ''); return Number(/EZIL_E2E_LONG turn (\d+)/.exec(text)?.[1] ?? 0); };
  const posts = captured().filter(r => turnOf(r) > 0 && (r.body?.tools ?? []).length > 0);
  const sizes = posts.map(r => r.bytes);
  info('chat request bytes per turn', JSON.stringify(posts.map(r => [turnOf(r), r.bytes])));
  check('every chat turn reached the gateway as Kimi JSON', posts.length >= TURNS && posts.every(r => r.body?.model === KIMI && r.body?.stream === false), `${posts.length} chat posts`);
  check('every request is within the byte bound', sizes.every(bytes => bytes <= BOUND), `max ${Math.max(...sizes)} of ${BOUND}`);
  const last = posts.filter(r => turnOf(r) === TURNS).at(-1);
  check('the last turn was sent with its question', Boolean(last) && JSON.stringify(last.body).includes(`EZIL_E2E_LONG turn ${TURNS}`));

  // The extension's own metadata lines (sizes only): which turns were compacted, from how many bytes to how many.
  const logs = sh('cat /tmp/code-server-data/logs/*/exthost*/output_logging_*/*EZiL*Models*.log 2>/dev/null || true');
  const compactions = logs.split('\n').filter(line => line.startsWith('{') && line.includes('"compacted"')).map(line => JSON.parse(line));
  info('compactions logged (from, to bytes)', JSON.stringify(compactions.map(line => [line.compacted.from_bytes, line.compacted.to_bytes, line.compacted.folded, line.compacted.shortened])));
  check('the chat outgrew the bound and was compacted, not refused', compactions.length > 0 && compactions.every(line => line.model === KIMI && line.http_status === 200 && line.compacted.from_bytes > BOUND && line.compacted.to_bytes <= BOUND));
  // Compacted bodies are the ones over the bound as Copilot built them; every shortening there is marked.
  const marked = posts.filter(r => compactions.some(line => line.compacted.to_bytes === r.bytes));
  check('every compacted request marks what it left out', marked.length > 0 && marked.every(r => /characters left out by EZiL|\[EZiL compacted/.test(JSON.stringify(r.body))), `${marked.length} compacted requests`);
  check('compacted requests keep every user prompt Copilot sent, whole', marked.every(r => {
    const users = JSON.stringify((r.body.messages ?? []).filter(m => m.role === 'user'));
    return [...users.matchAll(/EZIL_E2E_LONG turn (\d+)/g)].every(([, turn]) => users.includes(turn === '1' ? CODEWORD : `EZIL_E2E_LONG turn ${turn}: continue the same task`));
  }));
  // Copilot itself drops older turns once its own budget is full (its summariser is off here): what it never sends,
  // the extension cannot keep. Recorded, not asserted.
  info('turns Copilot still sent per request', JSON.stringify(posts.map(r => [turnOf(r), [...JSON.stringify(r.body.messages).matchAll(/EZIL_E2E_LONG turn (\d+)/g)].map(m => Number(m[1]))])));

  // The saved conversation is not compacted: Copilot writes it to <workspace>/.ezil/chat.
  const saved = () => sh(`grep -l -F EZIL_LONG_BODY_1 ${quote(join(FOLDER, '.ezil', 'chat'))}/*.json* 2>/dev/null || true`).split('\n').filter(Boolean);
  check('the saved conversation still holds the first answer whole', await until(async () => saved().length > 0, 'saved session with turn 1', 90_000), JSON.stringify(saved()));
  check('no metadata line carries conversation text', logs.trim() !== '' && !logs.includes(CODEWORD) && !logs.includes('quick brown fox'));
} catch (e) {
  check('suite completed without an unexpected exception', false, String(e).slice(0, 300));
} finally {
  await page.screenshot({ path: join(OUT, 'compaction-exit.png') }).catch(() => {});
  await context.close();
  await browser.close();
}
writeFileSync(join(OUT, 'compaction-checks.json'), JSON.stringify({ codeUrl: CODE_URL, folder: FOLDER, turns: TURNS, results }, null, 2));
const failed = results.filter(r => !r.ok);
const asserted = results.filter(r => !r.info);
console.log(`\n${asserted.length - failed.length}/${asserted.length} compaction checks passed, ${results.length - asserted.length} info; artifacts in ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);

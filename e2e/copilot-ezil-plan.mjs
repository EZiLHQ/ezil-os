// Image e2e, pass "plan" (copilot-ezil-image.sh, mock Gateway with EZIL_MOCK_FLASH=1 and EZIL_MOCK_STATE_FILE): Free includes
// Gemini 3.8 Flash only (founder 2026-11-09). With the EZiL OS proxy's plan header the picker lists the other models
// locked. Choosing one by touch (Android, iPhone), mouse or keyboard keeps Flash selected and sends nothing. A model
// saved on a paid plan resolves to Flash once the account is Free, with no dialog, also in a reloaded chat with turns.
// Out of credits, the turn goes once and nothing loops. A used-up credit window (a plan allowance no purchase lifts) is
// never a credit refusal: Code says so with its reset and no purchase action. Framed in a stand-in OS page carrying the
// Worker's own billing bridge, each cause reaches that page as a closed request (a window as window_limit, with its
// reset) and Code shows no notice of its own. No real model is called.
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import http from 'node:http';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/plan';
const CONTAINER = process.env.EZIL_E2E_CONTAINER;
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const STATE_FILE = process.env.EZIL_E2E_STATE_FILE ?? '/tmp/copilot-ezil-mock-state';
mkdirSync(OUT, { recursive: true });
const FLASH = 'gemini-3.8-flash', FLASH_NAME = 'Gemini 3.8 Flash';
const QWEN = 'qwen.qwen3-coder-next', QWEN_NAME = 'Qwen3 Coder Next', KIMI_NAME = 'Kimi K3';
const VIEWS = [
  { name: 'android-412x915', viewport: { width: 412, height: 915 }, touch: true, deviceScaleFactor: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
  { name: 'iphone-390x844', viewport: { width: 390, height: 844 }, touch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, touch: false, deviceScaleFactor: 1, keyboard: true },
];
// The Worker's billing bridge, exactly as it injects it (worker/src/code-billing-bridge.ts), for the framed run.
const bridgeModule = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(readFileSync(new URL('../worker/src/code-billing-bridge.ts', import.meta.url), 'utf8'))).toString('base64')}`);
// Same site as Code (the OS shell and the code host share ezil.work in production), so code-server's own cookie is first-party.
const PARENT = 'http://127.0.0.1:17999';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  plan: ${name}${detail ? ` — ${detail}` : ''}`); };
const rowsSel = '.action-widget .monaco-list-row, .context-view .monaco-list-row';
const state = words => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', `printf '%s' "${words}" > ${STATE_FILE}`]);
const posts = () => {
  // The capture holds every request body (an Agent turn carries its tools), well past execFileSync's 1 MiB default.
  try { return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'cat', `${CAPTURE_DIR}/captured.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 })).filter(r => r.method === 'POST' && r.path === '/ai/v1/messages'); } catch { return []; }
};

/** The workbench helpers for one page, or for Code inside the stand-in OS page's frame. */
function code (page, root, v) {
  const press = locator => v.touch ? locator.tap() : locator.click();
  const model = root.locator('.part.auxiliarybar .action-label[aria-label^="Models, "]').first();
  const label = async () => (await model.getAttribute('aria-label')) ?? '';
  const lines = root.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first();
  const toasts = () => root.locator('.notifications-toasts .notification-toast').allTextContents();
  return {
    press, model, label, lines, toasts,
    ready: async name => {
      await root.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 90_000 });
      await model.waitFor({ state: 'visible', timeout: 60_000 });
      for (let i = 0; i < 60 && !(await label()).includes(name); i++) await page.waitForTimeout(1000);
      await page.waitForTimeout(1500);
    },
    row: async name => {
      let row = root.locator(rowsSel).filter({ hasText: new RegExp(name) }).first();
      if (!(await row.count())) {
        const other = root.locator(rowsSel).filter({ hasText: /^\s*Other Models/ }).first();
        if (await other.count()) { await press(other); await page.waitForTimeout(800); }
        row = root.locator(rowsSel).filter({ hasText: new RegExp(name) }).first();
      }
      return row;
    },
    send: async prompt => {
      const before = posts().length;
      await (v.touch ? lines.tap({ force: true }) : lines.click({ force: true }));
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
      await page.keyboard.type(prompt, { delay: 3 });
      await page.keyboard.press('Enter');
      // Wait for the turn itself, which carries the Agent tools: a first turn's title request quotes the prompt too.
      for (let i = 0; i < 40 && !posts().slice(before).some(r => r.body?.tools?.length && JSON.stringify(r.body.messages ?? '').includes(prompt)); i++) await page.waitForTimeout(500);
      await page.waitForTimeout(3000);
      return posts().slice(before);
    },
    escape: async () => { for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); } },
  };
}

const browser = await chromium.launch();
try {
  if (!CONTAINER) throw new Error('EZIL_E2E_CONTAINER is required');
  // EZIL_E2E_PLAN_ONLY=framed runs only the framed part (iteration aid; the suite runs everything).
  for (const v of process.env.EZIL_E2E_PLAN_ONLY === 'framed' ? [] : VIEWS) {
    const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.touch, hasTouch: v.touch, deviceScaleFactor: v.deviceScaleFactor, ...v.userAgent ? { userAgent: v.userAgent } : {} });
    const page = await ctx.newPage();
    const c = code(page, page, v);
    const at = `${v.name}${v.touch ? ' (touch)' : ''}`;
    try {
      // A paid account picks Qwen and talks to it.
      state('');
      await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
      await c.ready(FLASH_NAME);
      await c.press(c.model); await page.waitForTimeout(1200);
      const paidQwen = await c.row(QWEN_NAME);
      if (await paidQwen.count()) { await c.press(paidQwen); await page.waitForTimeout(1500); }
      check(`${at}: paid: ${QWEN_NAME} is selectable and picked`, (await c.label()) === `Models, ${QWEN_NAME}`, await c.label());
      await c.escape();
      let sent = await c.send(`EZIL_E2E_KIMI ${v.name} paid`);
      check(`${at}: paid: the turn goes to ${QWEN}`, sent.some(r => r.body?.model === QWEN), JSON.stringify(sent.map(r => r.body?.model)));

      // The account is now Free: the saved Qwen resolves to Flash after a reload, in this chat with turns, with no notice.
      state('free');
      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await c.ready(FLASH_NAME);
      await page.screenshot({ path: join(OUT, `${v.name}-free-restored.png`) });
      check(`${at}: Free: the reloaded chat with turns shows ${FLASH_NAME}, not the saved ${QWEN_NAME}`, (await c.label()) === `Models, ${FLASH_NAME}`, await c.label());
      check(`${at}: Free: no upgrade dialog or notice on load`, (await c.toasts()).every(t => !/not included|Upgrade/i.test(t)), JSON.stringify(await c.toasts()));
      sent = await c.send(`EZIL_E2E_KIMI ${v.name} free`);
      // The turn carries the Agent tools; title and summary requests carry none (the image pins them to Flash, and the
      // provider would also serve a Free account's on Flash).
      check(`${at}: Free: every request names ${FLASH}, and titles and summaries are still sent, on Flash`,
        sent.length >= 2 && sent.every(r => r.body?.model === FLASH) && sent.some(r => !r.body?.tools?.length),
        JSON.stringify(sent.map(r => [r.body?.model, r.body?.tools?.length ?? 0])));

      // Locked rows: listed, and choosing one keeps Flash and sends nothing.
      await c.press(c.model); await page.waitForTimeout(1200);
      const qwen = await c.row(QWEN_NAME), kimi = await c.row(KIMI_NAME);
      check(`${at}: Free: ${QWEN_NAME} and ${KIMI_NAME} are listed, each with a lock`, (await qwen.count()) && (await kimi.count())
        && (await qwen.locator('.codicon-lock').count()) > 0 && (await kimi.locator('.codicon-lock').count()) > 0,
        `rows: ${JSON.stringify(await page.locator(rowsSel).allTextContents())}`);
      const before = posts().length;
      if (await qwen.count()) { await c.press(qwen); await page.waitForTimeout(2500); }
      check(`${at}: Free: choosing locked ${QWEN_NAME} keeps ${FLASH_NAME} selected`, (await c.label()) === `Models, ${FLASH_NAME}`, await c.label());
      check(`${at}: Free: choosing it sends nothing`, posts().length === before, `${posts().length - before} request(s)`);
      // The Upgrade action needs the computer's https OS origin (provider.ts osBillingLink); this suite's mock is http.
      check(`${at}: Free: outside an OS window, Code says it is not included`,
        (await c.toasts()).some(t => /Qwen3 Coder Next is not included in your plan\./.test(t)), JSON.stringify((await c.toasts()).map(t => t.slice(0, 120))));
      await page.screenshot({ path: join(OUT, `${v.name}-locked-chosen.png`) });
      await c.escape();
      if (v.keyboard) {
        // Keyboard only: open the picker on the focused button, walk to locked Qwen3 Coder Next, Enter.
        await c.model.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
        let reached = false;
        for (let i = 0; i < 20 && !reached; i++) {
          await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
          reached = /Qwen3 Coder Next/.test((await page.locator(`${rowsSel.split(', ').map(s => `${s}.focused`).join(', ')}`).allTextContents()).join(' '));
        }
        const keyed = posts().length;
        if (reached) { await page.keyboard.press('Enter'); await page.waitForTimeout(2500); }
        check(`${at}: Free: the keyboard reaches locked ${QWEN_NAME}; Enter keeps ${FLASH_NAME} and sends nothing`,
          reached && (await c.label()) === `Models, ${FLASH_NAME}` && posts().length === keyed, `reached ${reached}; ${await c.label()}`);
        await c.escape();
      }

      // Out of credits: one request, no retry (read again after a pause, so a late retry shows), and outside an OS window
      // today's notice with Add credits.
      state('free exhausted');
      const mark = posts().length;
      await c.send(`EZIL_E2E_KIMI ${v.name} exhausted`);
      await page.waitForTimeout(5000);
      sent = posts().slice(mark);
      check(`${at}: Free, no credits: one request for the turn, no retry`, sent.length === 1 && sent[0].body?.model === FLASH, JSON.stringify(sent.map(r => r.body?.model)));
      check(`${at}: Free, no credits: outside an OS window the notice offers Add credits`, (await c.toasts()).some(t => /Add credits/.test(t)), JSON.stringify(await c.toasts()));
      await page.screenshot({ path: join(OUT, `${v.name}-exhausted.png`) });

      // A used-up credit window (a plan allowance no purchase lifts): outside an OS window Code says so itself, with the
      // reset and no purchase action, and sends the turn once.
      state('free window');
      const windowMark = posts().length;
      await c.send(`EZIL_E2E_KIMI ${v.name} window`);
      // Read the notice now: a warning with no action hides by itself after a while.
      const windowToasts = (await c.toasts()).filter(t => /does not lift this window/.test(t));
      await page.waitForTimeout(5000);
      const windowSent = posts().slice(windowMark);
      check(`${at}: Free, credit window used up: Code says no purchase lifts it, with its reset and no purchase action; one request`,
        windowSent.length === 1 && windowToasts.length === 1 && /Resets at /.test(windowToasts[0]) && !/Add credits|Upgrade/.test(windowToasts[0]),
        `${windowSent.length} request(s); ${JSON.stringify(windowToasts)}`);
    } catch (e) {
      check(`${v.name}: completed`, false, String(e).slice(0, 300));
      await page.screenshot({ path: join(OUT, `${v.name}-error.png`) }).catch(() => {});
    } finally { await ctx.close(); }
  }

  // Framed in a stand-in OS page with the Worker's billing bridge: both causes reach the page; Code shows no notice.
  // The workbench document gets what the Worker does to it on the code host: the frame-blocking headers go
  // (preview-bridge.ts stripFrameAncestors) and the real bridge is injected under the page's own script nonce.
  {
    const v = VIEWS.at(-1);
    const ctx = await browser.newContext({ viewport: v.viewport });
    const codeOrigin = new URL(CODE_URL).origin;
    // The rewritten workbench document comes from Playwright routing, so it has no address, and Chromium's local network
    // access checks refuse its own loopback WebSocket. This context alone grants local network access to its two loopback
    // origins, and the stand-in OS page delegates it to its frame. Production's OS and Code hosts are public: no such check.
    for (const origin of [PARENT, codeOrigin]) await ctx.grantPermissions(['local-network-access'], { origin });
    let injected = 0;
    await ctx.route(request => new URL(request).origin === codeOrigin, async route => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['x-frame-options']; delete headers['content-length'];
      if (headers['content-security-policy']) headers['content-security-policy'] = headers['content-security-policy'].split(';')
        .map(part => part.trim()).filter(part => part && !part.toLowerCase().startsWith('frame-ancestors')).join('; ');
      const html = await response.text();
      const body = bridgeModule.injectCodeBillingBridge(html, [PARENT]);
      if (body !== html) injected++;
      return route.fulfill({ response, headers, body });
    });
    // A real loopback server, like the OS host it stands in for, so the page that delegates the permission has an address.
    const parentHtml = `<!doctype html><title>EZiL OS (stand-in)</title>
<body style="margin:0"><iframe id="code" src="${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}" allow="local-network-access; local-network; loopback-network" style="border:0;width:100vw;height:100vh"></iframe>
<script>window.__billing=[];const frame=document.getElementById('code'),origin=new URL(frame.src).origin;
let nonce=null;frame.addEventListener('load',()=>{nonce=Array.from(crypto.getRandomValues(new Uint8Array(22)),b=>'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b%64]).join('');frame.contentWindow.postMessage({type:'ezil.code.billing.hello',v:1,nonce},origin)});
window.addEventListener('message',e=>{if(e.source===frame.contentWindow&&e.origin===origin&&e.data&&e.data.nonce===nonce)window.__billing.push(e.data)});</script>`;
    const parentServer = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(parentHtml); });
    await new Promise(done => parentServer.listen(Number(new URL(PARENT).port), '127.0.0.1', done));
    const page = await ctx.newPage();
    const diagnostics = [];
    page.on('console', m => { if (/error|websocket|refused|failed/i.test(m.text())) diagnostics.push(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
    page.on('requestfailed', r => diagnostics.push(`failed ${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText}`));
    page.on('websocket', ws => { diagnostics.push(`ws open ${ws.url().slice(0, 160)}`); ws.on('close', () => diagnostics.push(`ws close ${ws.url().slice(0, 120)}`)); ws.on('socketerror', e => diagnostics.push(`ws error ${e}`)); });
    const frame = page.frameLocator('#code');
    const c = code(page, frame, v);
    const billing = () => page.evaluate(() => window.__billing);
    try {
      state('free');
      await page.goto(`${PARENT}/os`, { waitUntil: 'domcontentloaded' });
      await c.ready(FLASH_NAME);
      // Ready means connected: the model picker is enabled and shows Flash, the workbench opened its WebSocket to the code
      // host, and none has failed (diagnostics so far).
      const wsFailed = () => diagnostics.filter(line => /^ws (error|close)/.test(line));
      const wsOpened = () => diagnostics.some(line => line.startsWith(`ws open ws://${new URL(CODE_URL).host}/`));
      const pickerEnabled = (await c.model.getAttribute('aria-disabled')) !== 'true' && !/\bdisabled\b/.test((await c.model.getAttribute('class')) ?? '');
      const ready = (await c.label()) === `Models, ${FLASH_NAME}` && pickerEnabled && wsOpened() && wsFailed().length === 0;
      check('framed: the workbench connects inside the OS page (WebSocket open, the picker enabled and showing Flash)',
        ready, `${await c.label()}; enabled ${pickerEnabled}; opened ${wsOpened()}; ${JSON.stringify(wsFailed().slice(0, 3))}`);
      if (!ready) throw new Error('framed workbench not ready');
      check('framed: the Worker\'s injector adds the bridge to the workbench, and it answers the OS page\'s hello',
        injected > 0 && (await billing()).some(m => m.type === 'ezil.code.billing.ready'), `injected ${injected}; ${JSON.stringify(await billing())}`);
      await c.press(c.model); await page.waitForTimeout(1200);
      const qwen = await c.row(QWEN_NAME);
      const before = posts().length;
      if (await qwen.count()) { await c.press(qwen); await page.waitForTimeout(2500); }
      const asked = (await billing()).filter(m => m.type === 'ezil.code.billing.intent');
      check('framed: a locked pick reaches the OS page as { reason: model_locked, model }',
        asked.length === 1 && JSON.stringify(asked[0].intent) === JSON.stringify({ reason: 'model_locked', model: QWEN }), JSON.stringify(asked));
      check('framed: Flash stays selected, nothing is sent, and Code shows no notice of its own',
        (await c.label()) === `Models, ${FLASH_NAME}` && posts().length === before && (await c.toasts()).every(t => !/not included/.test(t)), `${await c.label()}; ${JSON.stringify(await c.toasts())}`);
      await c.escape();
      state('free exhausted');
      const mark = posts().length;
      await c.send('EZIL_E2E_KIMI framed exhausted');
      // Read again after a pause, so a late retry shows.
      await page.waitForTimeout(5000);
      const sent = posts().slice(mark);
      const credit = (await billing()).filter(m => m.type === 'ezil.code.billing.intent' && m.intent.reason === 'credits_exhausted');
      // This chat's first turn: Copilot's own title and progress-message requests go with it, on Flash, each refused with
      // its own request id. The ask names one of them: the minute's first refusal, which can be the title request sent
      // just before the turn (provider.ts). The turn (the one with the Agent tools) goes once, and no request repeats.
      const once = sent.filter(r => r.body?.tools?.length).length === 1 && sent.every(r => r.body?.model === FLASH)
        && new Set(sent.map(r => JSON.stringify(r.body))).size === sent.length;
      const refused = sent.map(r => r.requestId).filter(Boolean);
      check('framed: a credit refusal reaches the OS page once, naming one of this turn\'s refused requests; the turn goes once, nothing repeats, no Code notice',
        credit.length === 1 && refused.includes(credit[0].intent.requestId) && once && (await c.toasts()).every(t => !/Add credits/.test(t)),
        `${JSON.stringify(credit)}; ${JSON.stringify(sent.map(r => [r.n, r.body?.model, r.body?.tools?.length ?? 0, r.requestId]))}; ${JSON.stringify(await c.toasts())}`);
      // A used-up credit window: the OS page gets window_limit with its reset, naming one of this turn's refusals, and
      // never another credit refusal; Code shows no notice of its own.
      state('free window');
      const windowMark = posts().length;
      await c.send('EZIL_E2E_KIMI framed window');
      await page.waitForTimeout(5000);
      const windowSent = posts().slice(windowMark);
      const intents = (await billing()).filter(m => m.type === 'ezil.code.billing.intent');
      const windowAsks = intents.filter(m => m.intent.reason === 'window_limit');
      check('framed: a used-up credit window reaches the OS page as window_limit with its reset, never as a credit refusal; Code shows no notice',
        windowAsks.length === 1 && Date.parse(windowAsks[0].intent.resetsAt ?? '') > Date.now()
          && windowSent.map(r => r.requestId).includes(windowAsks[0].intent.requestId)
          && intents.filter(m => m.intent.reason === 'credits_exhausted').length === 1 && (await c.toasts()).every(t => !/does not lift/.test(t)),
        `${JSON.stringify(windowAsks)}; ${windowSent.length} request(s); ${JSON.stringify(await c.toasts())}`);
      check('framed: the workbench WebSocket opened, and none closed or failed during the run', wsOpened() && wsFailed().length === 0, JSON.stringify(wsFailed().slice(0, 3)));
      await page.screenshot({ path: join(OUT, 'framed.png') });
    } catch (e) {
      check('framed: completed', false, String(e).slice(0, 300));
      await page.screenshot({ path: join(OUT, 'framed-error.png') }).catch(() => {});
    } finally { writeFileSync(join(OUT, 'framed-diagnostics.json'), JSON.stringify(diagnostics.slice(0, 200), null, 1)); await ctx.close(); parentServer.close(); }
  }
} catch (e) {
  check('completed', false, String(e).slice(0, 300));
} finally { await browser.close(); }
writeFileSync(join(OUT, 'checks.json'), JSON.stringify(results, null, 1));
process.exit(results.length > 0 && results.every(r => r.ok) ? 0 : 1);

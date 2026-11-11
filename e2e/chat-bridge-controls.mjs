/**
 * Playwright half of `EZIL_E2E_SUITE=controls e2e/chat-bridge-workbench.sh`: editor-bridge protocol 2 in a real
 * code-server 4.141.0 workbench with Copilot Chat and the real ezil-models extension, against the in-container
 * protocol-2 stand-in OS (chat-bridge-controls-standin.mjs) and the offline messages mock. No paid inference.
 * What reaches the model is judged from the stand-in's view of the model requests (which model, which marker),
 * never from the workbench's own readback alone. Exit 2 means not run.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset'); process.exit(2); }
const { chromium } = createRequire(REQ_DIR + '/x.js')('playwright');
const CODE_URL = (process.env.EZIL_CODE_URL ?? '').replace(/\/$/, '');
const CONTAINER = process.env.EZIL_E2E_CONTAINER ?? '';
const OUT = process.env.EZIL_E2E_OUT ?? './chat-bridge-e2e-out';
const T = 120_000;
const QWEN = 'qwen.qwen3-coder-next';
const KIMI = 'us.moonshotai.kimi-k3';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const inContainer = (args) => execFileSync('docker', ['exec', CONTAINER, ...args], { encoding: 'utf8' });
const bridgeState = () => JSON.parse(inContainer(['curl', '-fsS', 'http://127.0.0.1:4142/bridge-state']));
const enqueue = (spec) => JSON.parse(inContainer(['curl', '-fsS', '-X', 'POST', '-H', 'content-type: application/json', '--data', JSON.stringify(spec), 'http://127.0.0.1:4142/enqueue']));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate, ms = 90_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const s = bridgeState(); if (predicate(s)) return s; await sleep(1000); }
  return bridgeState();
};
const opOf = (s, role) => s.ops.find((o) => o.role === role);
const FINAL = ['completed', 'cancelled', 'finished_unverified', 'failed', 'rejected', 'expired', 'uncertain', 'applied', 'busy'];
const settled = (role, ms) => until((s) => FINAL.includes(opOf(s, role)?.status), ms);
const sessionOf = (s, resource) => s.sessions.find((x) => x.resource === resource);
const upstreamFor = (s, marker) => s.upstream.filter((u) => u.markers?.includes(marker));
const brief = (o) => o && ({ status: o.status, reason: o.reason ?? null, model: o.model ?? null, session: o.sessionResource?.slice(-12) ?? null, response: o.responseText?.slice(0, 50) ?? null });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', (route) => (new URL(route.request().url()).host === new URL(CODE_URL).host ? route.continue() : route.abort()));
let page = await context.newPage();
const aux = () => page.locator('.part.auxiliarybar');
const open = async () => {
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent('/home/neko/project')}`, { waitUntil: 'domcontentloaded' });
  await aux().locator('.chat-input-container .monaco-editor').first().waitFor({ state: 'visible', timeout: T });
};
let failed = false;
try {
  await open();
  const first = await until((s) => s.catalog && s.sessionsAt !== null && (s.protocols['2'] ?? 0) > 0, 90_000);
  check('the extension syncs with the bridge token and switches to protocol 2 only after OS offers it',
    first.refused.length === 0 && (first.protocols['1'] ?? 0) >= 1 && (first.protocols['2'] ?? 0) >= 1, JSON.stringify({ protocols: first.protocols, refused: first.refused }));

  // ── Catalog: exactly the picker's models, effort read-only ───────────────────────────────────────────────────
  const catalog = first.catalog;
  const qwenId = catalog.models?.find((m) => m.label === 'Qwen3 Coder Next')?.id;
  const kimiId = catalog.models?.find((m) => m.label?.startsWith('Kimi K3'))?.id;
  // Two effort probes are configured and never sent: a direct Anthropic model with effort high (sent as
  // output_config.effort) and a Gateway model with effort max (the Gateway body carries no effort, so none is reported).
  const effortOf = (label) => catalog.models?.find((m) => m.label === label)?.configuredEffort;
  // Account evidence: the extension's own /v1/models read with THIS computer's AI token (the stand-in answers no other).
  const ALLOW = (process.env.EZIL_STANDIN_ALLOW ?? '').split(',').filter(Boolean);
  const marked = (s) => Object.fromEntries((s.catalog?.models ?? []).map((m) => [m.label, m.availability ?? null]));
  const expectMarks = {
    'Qwen3 Coder Next': ALLOW.includes(QWEN) ? 'available' : null, 'Effort Probe Gateway (never sent)': ALLOW.includes(QWEN) ? 'available' : null,
    'Kimi K3 (no streaming)': ALLOW.includes(KIMI) ? 'available' : null, 'Effort Probe Direct (never sent)': null };
  // A Gateway-denied model is not offered by the picker at all (the provider hides it), so it is not listed; the static
  // direct model is listed, never marked.
  const expectListed = Object.keys(expectMarks).filter((k) => expectMarks[k] === 'available' || k.startsWith('Effort Probe Direct')).sort();
  check(`catalog: availability only for this account's Gateway-allowed aliases (${ALLOW.join(' ') || 'none'}); the static direct model never`,
    JSON.stringify(Object.keys(marked(first)).sort()) === JSON.stringify(expectListed)
      && JSON.stringify(marked(first)) === JSON.stringify(Object.fromEntries(Object.keys(marked(first)).map((k) => [k, expectMarks[k]])))
      && first.gateway.calls.length > 0 && first.gateway.calls.every((c) => c.token === 'this_computer'),
    JSON.stringify({ marks: marked(first), gatewayCalls: first.gateway.calls.length, tokens: [...new Set(first.gateway.calls.map((c) => c.token))] }));
  if (process.env.EZIL_E2E_CATALOG_ONLY) {
    // The Gateway now fails for this token: once the last good read is older than the evidence window (15 s), the next
    // catalog marks nothing (never the older read).
    const failAt = JSON.parse(inContainer(['curl', '-fsS', '-X', 'POST', '--data', '{"mode":"fail"}', 'http://127.0.0.1:4142/gateway-mode'])).at;
    const after = await until((s) => s.catalogs.some((c) => c.at > failAt && c.models?.every((m) => !m.availability)), 150_000);
    const firstBare = after.catalogs.find((c) => c.at > failAt && c.models?.every((m) => !m.availability));
    const stillMarked = after.catalogs.filter((c) => c.at > failAt && c.models?.some((m) => m.availability)).map((c) => c.at - failAt);
    check('Gateway failing: within the 15 s evidence window the last good read still counts; after it, the catalog marks nothing',
      !!firstBare && firstBare.at - failAt <= 15_000 + 30_000 && stillMarked.every((d) => d <= 16_000) && after.gateway.calls.some((c) => c.mode === 'fail'),
      JSON.stringify({ bareAfterMs: firstBare && firstBare.at - failAt, markedAfterMs: stillMarked, failedReads: after.gateway.calls.filter((c) => c.mode === 'fail').length }));
    writeFileSync(join(OUT, 'bridge-state.json'), JSON.stringify(after, null, 2));
    throw Object.assign(new Error('catalog-only run finished'), { done: true });
  }
  check('catalog: the picker\'s four configured models, engine ezil-chat, no selectable effort; effort is what is really sent',
    catalog.status === 'available' && catalog.models.length === 4 && !!qwenId && !!kimiId
      && catalog.models.every((m) => m.engine === 'ezil-chat' && m.efforts.length === 0 && m.defaultEffort === null)
      && effortOf('Effort Probe Direct (never sent)') === 'high' && effortOf('Effort Probe Gateway (never sent)') === null
      && effortOf('Qwen3 Coder Next') === null && effortOf('Kimi K3 (no streaming)') === null,
    JSON.stringify(catalog.models.map((m) => [m.label, m.configuredEffort])));

  // ── Fresh create, before the chat agent has ever run (cold profile) ──────────────────────────────────────────
  const before = new Set(first.sessions.map((x) => x.resource));
  enqueue({ role: 'A', kind: 'create', model: kimiId, dupDeliver: true });
  enqueue({ role: 'B', kind: 'create', model: qwenId });
  const made = await until((s) => FINAL.includes(opOf(s, 'A')?.status) && FINAL.includes(opOf(s, 'B')?.status), 60_000);
  const A = opOf(made, 'A'); const B = opOf(made, 'B');
  check('create: two NEW sessions (resources not listed before), empty (0 requests), each with its requested model read back',
    A?.status === 'applied' && B?.status === 'applied' && !before.has(A.sessionResource) && !before.has(B.sessionResource) && A.sessionResource !== B.sessionResource
      && A.requestCount === 0 && B.requestCount === 0 && A.model === kimiId && B.model === qwenId, JSON.stringify({ A: brief(A), B: brief(B) }));
  const reportsA = made.reports.filter((r) => r.operationId === A?.id);
  check('create: the same operation handed out twice (lost report) creates ONE session and reports the same one again',
    reportsA.length === 2 && reportsA.every((r) => r.status === 'applied' && r.sessionResource === A.sessionResource), JSON.stringify(reportsA.map((r) => [r.status, r.sessionResource?.slice(-12)])));
  const listed = await until((s) => s.sessionsAt > made.now && s.sessions.some((x) => x.resource === B.sessionResource), 30_000);
  const fresh = listed.sessions.filter((x) => !before.has(x.resource));
  // 4.141.0 shows one chat editor per group: B's tab hides A's (A is listed, not open, and is shown again to act on it).
  check('the editor lists exactly the two created sessions as new; the one shown is idle and empty with its own model',
    fresh.length === 2 && sessionOf(listed, A.sessionResource)?.open === false
      && sessionOf(listed, B.sessionResource)?.open === true && sessionOf(listed, B.sessionResource)?.status === 'idle'
      && sessionOf(listed, B.sessionResource)?.requests === 0 && sessionOf(listed, B.sessionResource)?.model === qwenId,
    JSON.stringify(fresh.map((x) => ({ r: x.resource.slice(-12), model: x.model, open: x.open, status: x.status, requests: x.requests }))));
  enqueue({ role: 'C', kind: 'create', model: qwenId, effort: 'high' });
  const effort = await settled('C', 30_000);
  check('create with an effort: refused (effort_not_per_session), nothing created',
    opOf(effort, 'C')?.status === 'rejected' && opOf(effort, 'C')?.reason === 'effort_not_per_session' && !opOf(effort, 'C')?.sessionResource, JSON.stringify(brief(opOf(effort, 'C'))));
  await page.screenshot({ path: join(OUT, 'created.png') });

  enqueue({ role: 'sendA', kind: 'send', sessionRole: 'A', text: 'EZIL_BRIDGE_A into a session created by OS' });
  const cold = await until((s) => s.reports.some((r) => r.operationId === opOf(s, 'sendA')?.id), 60_000);
  const coldReports = cold.reports.filter((r) => r.operationId === opOf(cold, 'sendA')?.id).map((r) => [r.status, r.reason ?? null]);
  const heldCold = coldReports[0]?.[1] === 'agent_not_ready';
  check('cold agent: the first send into a created session is held (agent_not_ready) or runs, never silently lost',
    heldCold ? upstreamFor(cold, 'EZIL_BRIDGE_A').length === 0 : coldReports[0]?.[0] === 'running', JSON.stringify(coldReports));

  // ── The person uses chat once (panel), which lets Copilot Chat activate in this cold profile ──────────────────
  for (let i = 0; i < 40 && !/Agent|Ask|Auto|Model|Pick/i.test(clean(await aux().locator('.chat-view-title-container').first().innerText().catch(() => ''))); i++) await page.waitForTimeout(750);
  await page.waitForTimeout(Number(process.env.EZIL_E2E_SETTLE_MS ?? 45_000));
  await aux().locator('.chat-input-container .monaco-editor').first().locator('.view-lines').first().click({ force: true });
  await page.keyboard.type('Hello from the person EZIL_PERSON', { delay: 5 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /EZiL Chat/.test(document.querySelector('.part.auxiliarybar .interactive-list')?.textContent ?? ''), null, { timeout: T });
  const afterA = await settled('sendA', 150_000);
  const sendA = opOf(afterA, 'sendA');
  const panel = afterA.sessions.find((x) => x.open && x.resource !== A.sessionResource && x.resource !== B.sessionResource && x.requests > 0);
  check('the send into A completes there, answered by Kimi (its model reached the model service)',
    sendA?.status === 'completed' && /EZIL_KIMI_OK/.test(sendA?.responseText ?? '') && upstreamFor(afterA, 'EZIL_BRIDGE_A').some((u) => u.model === KIMI),
    JSON.stringify({ ...brief(sendA), upstream: upstreamFor(afterA, 'EZIL_BRIDGE_A').map((u) => u.model) }));
  check('the person\'s own panel chat kept its own model (Qwen upstream), untouched by the created sessions',
    !!panel && panel.model === qwenId && upstreamFor(afterA, 'EZIL_PERSON').length > 0 && upstreamFor(afterA, 'EZIL_PERSON').every((u) => u.model === QWEN),
    JSON.stringify({ panel: panel && { model: panel.model, requests: panel.requests }, upstream: upstreamFor(afterA, 'EZIL_PERSON').map((u) => u.model) }));

  enqueue({ role: 'sendB', kind: 'send', sessionRole: 'B', text: 'EZIL_BRIDGE_B into the second created session' });
  const afterB = await settled('sendB', 120_000);
  const sendB = opOf(afterB, 'sendB');
  check('the send into B completes there with Qwen; Kimi never received B\'s instruction',
    sendB?.status === 'completed' && !/EZIL_KIMI_OK/.test(sendB?.responseText ?? '') && upstreamFor(afterB, 'EZIL_BRIDGE_B').length > 0
      && upstreamFor(afterB, 'EZIL_BRIDGE_B').every((u) => u.model === QWEN), JSON.stringify({ ...brief(sendB), upstream: upstreamFor(afterB, 'EZIL_BRIDGE_B').map((u) => u.model) }));

  // ── Duplicate send: handed out twice, sent once ───────────────────────────────────────────────────────────────
  enqueue({ role: 'dup', kind: 'send', sessionRole: 'B', text: 'EZIL_BRIDGE_DUP once only', dupDeliver: true });
  const afterDup = await settled('dup', 120_000);
  check('a send handed out twice (lost report) reaches the model once',
    opOf(afterDup, 'dup')?.status === 'completed' && opOf(afterDup, 'dup')?.attempts === 2 && upstreamFor(afterDup, 'EZIL_BRIDGE_DUP').length === 1,
    JSON.stringify({ ...brief(opOf(afterDup, 'dup')), attempts: opOf(afterDup, 'dup')?.attempts, upstream: upstreamFor(afterDup, 'EZIL_BRIDGE_DUP').length }));

  // ── Configure: busy while running (nothing changes), then applied when idle, read back, isolated ────────────────
  enqueue({ role: 'slowB', kind: 'send', sessionRole: 'B', text: 'EZIL_E2E_SLOW EZIL_BRIDGE_B_SLOW' });
  await until((s) => opOf(s, 'slowB')?.status === 'running', 60_000);
  enqueue({ role: 'cfgBusy', kind: 'configure', sessionRole: 'B', model: kimiId });
  const busy = await settled('cfgBusy', 30_000);
  check('configure while that session runs: busy, never queued, model unchanged',
    opOf(busy, 'cfgBusy')?.status === 'busy' && opOf(busy, 'slowB')?.status === 'running', JSON.stringify({ cfg: brief(opOf(busy, 'cfgBusy')), slow: opOf(busy, 'slowB')?.status }));
  await settled('slowB', 90_000);
  enqueue({ role: 'cfgB', kind: 'configure', sessionRole: 'B', model: kimiId });
  const cfg = await settled('cfgB', 30_000);
  check('configure an idle session: applied with the runtime readback', opOf(cfg, 'cfgB')?.status === 'applied' && opOf(cfg, 'cfgB')?.model === kimiId,
    JSON.stringify(brief(opOf(cfg, 'cfgB'))));
  enqueue({ role: 'sendB2', kind: 'send', sessionRole: 'B', text: 'EZIL_BRIDGE_B2 after the model change' });
  enqueue({ role: 'sendP', kind: 'send', sessionResource: panel.resource, text: 'EZIL_BRIDGE_P into the person\'s chat' });
  const iso = await until((s) => ['sendB2', 'sendP'].every((r) => FINAL.includes(opOf(s, r)?.status)), 150_000);
  const listedIso = await until((s) => s.sessionsAt > iso.now, 30_000);
  // The model is judged upstream: the mock answers from the newest marked prompt in B's history (the slow one).
  check('after the change B runs on Kimi while the person\'s chat stays on Qwen (each session keeps its own model)',
    opOf(iso, 'sendB2')?.status === 'completed' && upstreamFor(iso, 'EZIL_BRIDGE_B2').some((u) => u.model === KIMI)
      && upstreamFor(iso, 'EZIL_BRIDGE_B2').every((u) => u.model === KIMI || u.model === QWEN)
      && opOf(iso, 'sendP')?.status === 'completed' && upstreamFor(iso, 'EZIL_BRIDGE_P').every((u) => u.model === QWEN)
      && sessionOf(listedIso, panel.resource)?.model === qwenId,
    JSON.stringify({ B2: upstreamFor(iso, 'EZIL_BRIDGE_B2').map((u) => u.model), P: upstreamFor(iso, 'EZIL_BRIDGE_P').map((u) => u.model),
      models: listedIso.sessions.filter((x) => x.open).map((x) => [x.resource.slice(-12), x.model]) }));
  await page.screenshot({ path: join(OUT, 'isolated.png') });

  // ── The browser goes away while a bridged request is running ──────────────────────────────────────────────────
  enqueue({ role: 'bg', kind: 'send', sessionResource: panel.resource, text: 'EZIL_E2E_SLOW EZIL_BRIDGE_BG while the browser closes' });
  const running = await until((s) => opOf(s, 'bg')?.status === 'running', 60_000);
  const oldOwner = running.owner;
  await sleep(3000);
  const closedAt = bridgeState().now;
  await page.close();
  const gone = await until((s) => s.now > closedAt + LEASE_WAIT(), LEASE_WAIT() + 30_000);
  const bgUp = upstreamFor(gone, 'EZIL_BRIDGE_BG');
  const oldSyncs = gone.syncs.filter((x) => x.ownerId === oldOwner && x.at > closedAt);
  check('boundary: with the browser closed, the running model request is abandoned (its caller goes away), not finished in the background',
    bgUp.length > 0 && bgUp.every((u) => u.callerGone !== null && u.end === null),
    JSON.stringify({ closedAt, upstream: bgUp.map((u) => ({ start: u.start, end: u.end, callerGone: u.callerGone, bytes: u.bytes })),
      oldOwnerSyncsAfterClose: oldSyncs.length, bg: brief(opOf(gone, 'bg')) }));

  page = await context.newPage();
  await open();
  const back = await until((s) => s.owners.length >= 2 && FINAL.includes(opOf(s, 'bg')?.status) && s.sessionsAt > s.owners.at(-1).at, 120_000);
  const bg = opOf(back, 'bg');
  check('reconnect: a new window takes over only after the lease, at a new epoch; the abandoned request is uncertain, never completed',
    back.owners.length >= 2 && back.owners.at(-1).ownerId !== oldOwner && back.owners.at(-1).epoch > back.owners[0].epoch
      && back.owners.at(-1).at >= closedAt && bg?.status === 'uncertain',
    JSON.stringify({ owners: back.owners, bg: brief(bg), history: bg?.history }));
  // The editor saves a chat once it has a request (an empty one is not kept across a reload).
  check('reconnect: every session that had a request (both created ones and the person\'s) is listed by the new window',
    [A.sessionResource, B.sessionResource, panel.resource].every((r) => back.sessions.some((x) => x.resource === r)), JSON.stringify(back.sessions.map((x) => [x.resource.slice(-12), x.open, x.requests])));
  // What the saved chat holds for the abandoned request, read from the editor's own session files.
  const saved = JSON.parse(inContainer(['node', '-e', `
    const fs=require('fs'),path=require('path');const out=[];
    const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
      if(e.isDirectory()){if(!/\\/logs$|node_modules/.test(p))walk(p);}else if(fs.statSync(p).size<20e6){const t=fs.readFileSync(p,'utf8');
        if(t.includes('EZIL_BRIDGE_BG')&&!/\\.log$/.test(p))out.push({file:p.slice(-90),done:t.includes('EZIL_SLOW_DONE'),parts:(t.match(/ part \\d+\\./g)||[]).length,canceled:/"isCanceled":true|"canceled"/.test(t)});}}};
    for(const root of ['/tmp/code-server-data','/home/neko'])try{walk(root)}catch{};console.log(JSON.stringify(out));`]));
  writeFileSync(join(OUT, 'saved-bg.json'), JSON.stringify(saved, null, 2));
  check('reconnect: the saved chat keeps the abandoned instruction but no completed answer',
    saved.length > 0 && saved.every((f) => !f.done), JSON.stringify(saved));
  enqueue({ role: 'after', kind: 'send', sessionRole: 'A', text: 'EZIL_BRIDGE_AFTER the browser came back' });
  const after = await settled('after', 150_000);
  const afterOp = opOf(after, 'after');
  const reportsAfter = after.reports.filter((r) => r.operationId === afterOp?.id && r.applied);
  check('after reconnect: a new instruction runs in created session A, reported in order by the new owner',
    afterOp?.status === 'completed' && /EZIL_KIMI_OK/.test(afterOp?.responseText ?? '') && reportsAfter.map((r) => r.status).join() === 'running,completed'
      && reportsAfter.every((r) => r.ownerId === after.owners.at(-1).ownerId),
    JSON.stringify({ ...brief(afterOp), reports: reportsAfter.map((r) => [r.status, r.epoch, r.at]) }));
  await page.screenshot({ path: join(OUT, 'reopened.png') });
  writeFileSync(join(OUT, 'bridge-state.json'), JSON.stringify(after, null, 2));
} catch (error) {
  if (error?.done) { await browser.close(); writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2)); process.exit(results.some((r) => !r.ok) ? 1 : 0); }
  failed = true;
  check('run completed', false, String(error?.message ?? error).slice(0, 300));
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  try { writeFileSync(join(OUT, 'bridge-state.json'), JSON.stringify(bridgeState(), null, 2)); } catch { /* container gone */ }
} finally {
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
function LEASE_WAIT() { return Number(process.env.EZIL_STANDIN_LEASE_MS ?? 30_000) + 5_000; }
process.exit(failed || results.some((r) => !r.ok) ? 1 : 0);

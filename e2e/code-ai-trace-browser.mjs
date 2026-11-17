// Run: PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> node e2e/code-ai-trace-browser.mjs
// Real Chromium, real built Code window (code.js wiring of the shell secure-frame collector), the actual Worker
// diag-bridge injection, the exact production `_ezil.aiRequestTrace` registration bytes and the actual Carbon
// producer, at separate local origins. Synthetic metadata only: no real auth, computer, provider, network or DB.
// The one intercepted endpoint is this fixture's local cookie-gated POST /api/shell/ai-traces; the server's
// actual parseBatch accepts each body. Not covered: a live Code container, the real workbench command registry
// and extension-host IPC (a JSON stand-in here), the Next route, auth and PostgreSQL.
// Local experimental harness, deliberately outside the shell CI families: some local runs lost the Chromium page
// (one `page.goto: Page crashed` while opening the second scenario's fresh context, before any of that context's
// trace traffic; one closed page and one unexplained timeout during the flood). Cause unconfirmed. Not a qualification gate until that is explained. Exit 2 = SKIP (no Playwright).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIP playwright not resolvable'); process.exit(2); }
// The producer imports extensionless TypeScript. A missing loader is a broken runtime, never a skip.
if (typeof registerHooks !== 'function' || typeof stripTypeScriptTypes !== 'function') {
    console.error('FAIL this Node lacks module.registerHooks/stripTypeScriptTypes (needs >= 22.15)'); process.exit(1);
}
registerHooks({
    resolve (specifier, context, next) {
        if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith('.ts') && !path.extname(specifier)) specifier += '.ts';
        return next(specifier, context);
    },
    load (url, context, next) {
        if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context);
        return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')), shortCircuit: true };
    },
});
const tree = new URL('../', import.meta.url);
const { InferenceTrace } = await import(new URL('extensions/ezil-models/src/inference-diagnostics.ts', tree));
const { publishInferenceTrace } = await import(new URL('extensions/ezil-models/src/trace-publisher.ts', tree));
const { injectCodeDiagBridge, DIAG_BRIDGE_MARKER } = await import(new URL('worker/src/code-diag-bridge.ts', tree));
const { parseBatch } = await import(new URL('app/src/server/ai-traces/schema.ts', tree));
const registration = readFileSync(new URL('worker/copilot-chat/patch-copilot-chat.sh', tree), 'utf8').match(/^R_AI_REQUEST_TRACE='(.*)'$/m)?.[1];
assert.ok(registration?.includes('qe.registerCommand("_ezil.aiRequestTrace"'), 'production registration found');
assert.ok(!/<\/|<!--/.test(registration), 'registration bytes can be inlined as script text');
const assets = process.env.EZIL_SHELL_OUT_DIR || new URL('../app/public/os/', import.meta.url).pathname;
const computerId = '11111111-1111-4111-8111-111111111111';
const SESSION = 'ezil_fixture_session=synthetic-local-only';
const CSP_NONCE = 'ezilTraceHarness01';
// Content the producer sees and must never forward, retain or log.
const MARKERS = ['PRIVATE_PROMPT', '/PRIVATE/', 'PRIVATE_ARG', 'PRIVATE_ERROR', 'PRIVATE_THINKING', 'PRIVATE_TEXT', 'private-call', 'read_file', 'replace_string_in_file', 'create_file'];
const clean = text => MARKERS.filter(marker => text.includes(marker));

/** Actual Carbon producer → actual publisher; the command value crosses JSON IPC like the workbench's. */
function produce ({ count = 1, usage, write = false, cancelled = false, failed = false } = {}) {
    const calls = Array.from({ length: count }, (_, i) => ({ type: 'tool_call', callId: `private-call-${i}`, name: 'read_file', input: { path: '/PRIVATE/file', arg: 'PRIVATE_ARG' } }));
    const results = calls.map((call, i) => ({ type: 'tool_result', callId: call.callId, ...(i === 0 ? { isError: true } : {}), content: [{ type: 'text', value: 'PRIVATE_ERROR ENOENT /PRIVATE/file' }] }));
    if (write) {
        calls.push({ type: 'tool_call', callId: 'private-call-write', name: 'replace_string_in_file', input: { filePath: '/PRIVATE/out', newString: 'PRIVATE_ARG' } });
        results.push({ type: 'tool_result', callId: 'private-call-write', isError: false, content: [{ type: 'text', value: 'PRIVATE_TEXT wrote /PRIVATE/out' }] });
    }
    const request = { tools: [{ name: 'read_file' }, { name: 'replace_string_in_file' }, { name: 'create_file' }], toolMode: 'auto', modelOptions: {}, messages: [
        { role: 'user', parts: [{ type: 'text', value: 'PRIVATE_PROMPT open /PRIVATE/file' }] },
        { role: 'assistant', parts: calls }, { role: 'user', parts: [...results, { type: 'text', value: 'PRIVATE_PROMPT continue' }] }] };
    const trace = new InferenceTrace('gemini-4-carbon', request);
    trace.event({ type: 'thinking', value: 'PRIVATE_THINKING' });
    trace.event({ type: 'text', value: 'PRIVATE_TEXT' });
    for (let i = 0; i < count; i++) trace.event({ type: 'tool_call', callId: `private-call-next-${i}`, name: 'read_file', input: { path: '/PRIVATE/next' } });
    if (write) trace.event({ type: 'tool_call', callId: 'private-call-next-write', name: 'create_file', input: { filePath: '/PRIVATE/new', content: 'PRIVATE_ARG' } });
    if (usage) trace.event({ type: 'usage', usage });
    trace.event({ type: 'stop', reason: 'end_turn', details: 'PRIVATE_ERROR provider detail' });
    trace.transport({ clientRequestId: trace.record.requestId, gatewayRequestId: trace.record.turnId, offered: { read: 1, search: 0, write: 1, other: 0 },
        attempts: 1, wireBytes: 321, totalWireBytes: 321, replayed: false });
    const record = trace.finish(cancelled, failed);
    let value = null;
    publishInferenceTrace(record, (command, published) => { assert.equal(command, '_ezil.aiRequestTrace'); value = JSON.parse(JSON.stringify(published)); });
    assert.ok(value, 'the actual publisher emitted the command');
    assert.deepEqual(clean(JSON.stringify(value)), [], 'the command value carries no private content');
    return value;
}

// ── Local servers: shell (cookie-gated trace endpoint), editor (Worker-injected workbench), forged origin ──
let editorOrigin = '', shellOrigin = '', mints = 0, hold = null, delayMs = 0, inFlight = 0, maxInFlight = 0;
const posts = [], editorCookies = [];
const shell = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (url.pathname.startsWith('/os/')) {
        const file = url.pathname.slice(4);
        if (!['bundle.min.js', 'bundle.min.css', 'icons.js'].includes(file)) { res.writeHead(404); res.end(); return; }
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(readFileSync(path.join(assets, file))); return;
    }
    if (url.pathname === '/api/shell/ai-traces') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const authenticated = req.method === 'POST' && (req.headers.cookie ?? '').split('; ').includes(SESSION);
            posts.push({ method: req.method, authenticated, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            setTimeout(() => {
                inFlight--;
                res.writeHead(authenticated ? 202 : 401, { 'cache-control': 'no-store' }); res.end();
            }, delayMs);
        });
        return;
    }
    if (url.pathname === '/api/shell/code-preview-url') {
        mints++; json({ ok: true, codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=fixture&folder=/workspace`, expiresAt: Date.now() + 300_000 }); return;
    }
    if (url.pathname === '/api/shell/desktop') {
        json(url.searchParams.get('confirm') === 'frame' ? { ok: true, confirmed: true, status: 200 } : { ok: true, guacamoleRunning: true }); return;
    }
    if (url.pathname.startsWith('/api/')) { json({ ok: true }); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
});
// The workbench stand-in: a scoped `qe` registry running the exact production registration, plus the harness's
// extension-host RPC entry and a read-only hello observer (the only way a test can learn the live nonce).
const workbench = held => injectCodeDiagBridge(`<!doctype html><html><head><meta charset="utf-8"><script nonce="${CSP_NONCE}">{`
    + 'const commands=new Map();const qe={registerCommand:(id,handler)=>{commands.set(id,handler);return{dispose(){commands.delete(id)}}}};'
    + registration
    + ';globalThis.__ezilHarnessCommand=(id,value)=>{const handler=commands.get(id);if(!handler)return false;handler(null,value);return true};'
    + 'addEventListener("message",e=>{if(e.source===parent&&e.data?.type==="ezil.code.diag.hello")globalThis.__ezilHarnessHello=e.data.nonce});'
    + `}</script></head><body>Workbench fixture${held ? '<img src="/hold" alt="">' : ''}</body></html>`, [shellOrigin]);
const editor = createServer((req, res) => {
    const url = new URL(req.url, editorOrigin);
    if (req.headers.cookie) editorCookies.push(req.headers.cookie);
    if (url.pathname === '/preview-bootstrap') { res.writeHead(302, { location: '/?folder=/workspace' }); res.end(); return; }
    if (url.pathname === '/hold') { hold?.requested(); const finish = () => { res.writeHead(204); res.end(); }; if (hold) hold.release = finish; else finish(); return; }
    if (url.pathname === '/') {
        const html = workbench(!!hold);
        assert.ok(html.includes(`<script nonce="${CSP_NONCE}" ${DIAG_BRIDGE_MARKER}="1">`), 'the actual Worker injection ran under the document nonce');
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': `script-src 'nonce-${CSP_NONCE}'` }); res.end(html); return;
    }
    // A same-origin sibling that is not the registered frame.
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body>Sibling fixture</body></html>');
});
const forged = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body>Forged origin fixture</body></html>'); });
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
await listen(shell); await listen(editor); await listen(forged);
shellOrigin = `http://127.0.0.1:${shell.address().port}`;
editorOrigin = `http://localhost:${editor.address().port}`; // Another host too, so the shell cookie cannot reach it.
const forgedOrigin = `http://127.0.0.1:${forged.address().port}`;

const until = async (predicate, label, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!predicate()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(r => setTimeout(r, 50)); }
};
const quiet = ms => new Promise(r => setTimeout(r, ms));
const posted = () => posts.flatMap(post => JSON.parse(post.body).traces);
const envelope = (nonce, trace, extra = {}) => ({ type: 'ezil.code.aiTrace', v: 1, nonce, trace, ...extra });

// Playwright starts Chromium detached (its own session), so a caller's timeout cannot reach it. Own its identity:
// launchServer exposes the process; an optional receipt records "pid starttime pgid sid" from /proc so a supervising
// script can reconcile exactly this browser after a hard kill. The harness never deletes the receipt: only the
// supervisor may, after verifying the browser is gone. Playwright's own signal handlers stay on (they cover the
// launch window before the receipt exists); the harness's handler adds an idempotent bounded browser + HTTP shutdown.
const browserServer = await chromium.launchServer({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const receipt = process.env.EZIL_TRACE_BROWSER_RECEIPT;
if (receipt) {
    const pid = browserServer.process().pid, fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    writeFileSync(receipt, `${pid} ${fields[19]} ${fields[2]} ${fields[3]}\n`);
}
const browser = await chromium.connect(browserServer.wsEndpoint());
const within = (promise, ms) => Promise.race([promise.catch(() => {}), new Promise(r => setTimeout(r, ms).unref())]);
let shuttingDown;
const shutdown = () => shuttingDown ??= (async () => {
    await within(browser.close().then(() => browserServer.close()), 5_000);
    await within(browserServer.kill(), 3_000); // no-op once closed; otherwise SIGKILL and wait
    await within(Promise.all([shell, editor, forged].map(server => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }))), 2_000);
})();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    setTimeout(() => process.exit(143), 12_000).unref();
    void shutdown().finally(() => process.exit(143));
});
let checks = 0;
const pass = label => { checks++; console.log(`PASS ${label}`); };
async function openCode ({ held = false } = {}) {
    mints = 0; posts.length = 0; editorCookies.length = 0; inFlight = 0; maxInFlight = 0;
    const context = await browser.newContext();
    const external = [], console_ = [];
    // Only this run's three fixture origins load; anything else (another local port included) is recorded and aborted.
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if ([shellOrigin, editorOrigin, forgedOrigin].includes(url.origin)) return route.continue();
        external.push({ url: url.href, body: route.request().postData() ?? '' }); return route.abort();
    });
    await context.addCookies([{ name: SESSION.split('=')[0], value: SESSION.split('=')[1], url: shellOrigin }]);
    await context.addInitScript(computerId => {
        if (window.top !== window) return;
        window.__EZIL_BOOT__ = { user: { id: '33333333-3333-4333-8333-333333333333', email: 'fixture@example.test' },
            computer: { id: computerId, name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }],
            desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', ui: { floatingControls: false, feedbackScreenshots: false } } };
        history.replaceState({ ...history.state, __NA: true }, '', location.href);
        // Read-only observer of what crosses the frame boundary (capture phase, never stops propagation).
        window.__traceMessages = [];
        addEventListener('message', e => { if (e.data?.type === 'ezil.code.aiTrace') window.__traceMessages.push({ origin: e.origin, data: JSON.stringify(e.data) }); }, true);
    }, computerId);
    const page = await context.newPage();
    page.on('console', message => console_.push(message.text()));
    const lifecycle = [];
    page.on('crash', () => lifecycle.push('crash'));
    // Uncaught page errors join the console text, so the privacy check covers them too.
    page.on('pageerror', error => { lifecycle.push('pageerror'); console_.push(`pageerror: ${error.message}`); });
    page.on('close', () => lifecycle.push('close'));
    page.on('framenavigated', f => { if (f === page.mainFrame()) lifecycle.push(`navigated ${new URL(f.url()).pathname}`); });
    let requested;
    if (held) hold = { requested: () => requested?.(), release: null };
    const holdRequested = new Promise(r => { requested = r; });
    // A held child frame delays the top document's load event; DOMContentLoaded is enough to proceed.
    await page.goto(`${shellOrigin}/app/code?computer=${computerId}`, { waitUntil: held ? 'domcontentloaded' : 'load' });
    await page.waitForFunction(origin => [...document.querySelectorAll('iframe')].some(f => f.src.startsWith(origin)), editorOrigin);
    if (held) await holdRequested;
    const frame = async () => {
        let found;
        await until(() => (found = page.frames().find(f => f.url().startsWith(`${editorOrigin}/?`))), 'editor frame');
        await found.waitForFunction(() => typeof globalThis.__ezilHarnessCommand === 'function');
        return found;
    };
    const hello = async f => f.waitForFunction(() => globalThis.__ezilHarnessHello).then(h => h.jsonValue());
    const observed = () => page.evaluate(() => window.__traceMessages);
    const send = (f, values) => f.evaluate(list => list.map(value => globalThis.__ezilHarnessCommand('_ezil.aiRequestTrace', value)), values);
    return { context, page, frame, hello, observed, send, external, lifecycle, console: console_ };
}
// `attacks` names only the requestIds of envelopes this harness forged itself (one carries a private key on purpose).
async function privacy (session, attacks = []) {
    const frameMessages = (await session.observed()).filter(m => !attacks.includes(JSON.parse(m.data).trace?.requestId)).map(m => m.data);
    const texts = [...posts.map(p => p.body), ...frameMessages, ...session.console];
    assert.deepEqual(texts.flatMap(clean), [], 'no prompt, path, tool name, argument, result or error text left the producer');
    const stored = [];
    for (const f of session.page.frames()) {
        try {
            stored.push(await f.evaluate(async () => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie,
                (await indexedDB.databases?.() ?? []).map(d => d.name)])));
        } catch { /* a frame that went away holds nothing */ }
    }
    const ids = posted().map(t => t.requestId);
    for (const blob of stored) {
        assert.deepEqual(clean(blob), [], 'no private content in browser storage');
        assert.ok(!blob.includes('ezil.code.aiTrace') && !ids.some(id => blob.includes(id)), 'no trace is retained in browser storage');
    }
    assert.deepEqual(session.external.filter(r => r.body || clean(r.url).length), [], 'no non-local request carried a body or private content');
    assert.ok(posts.every(p => p.method === 'POST' && p.authenticated && p.headers['content-type'] === 'application/json'
        && p.headers.origin === shellOrigin && p.headers['sec-fetch-site'] === 'same-origin'), 'every trace POST was same-origin and carried the shell session');
    assert.ok(editorCookies.every(c => !c.includes('ezil_fixture_session')), 'the editor origin never received the shell session');
}
function accept (values) {
    for (const post of posts) {
        const body = JSON.parse(post.body);
        assert.deepEqual(Object.keys(body), ['v', 'traces']); assert.equal(body.v, 1);
        assert.ok(body.traces.length >= 1 && body.traces.length <= 8, 'batches hold at most 8');
        assert.equal(parseBatch(body)?.length, body.traces.length, 'the server parser accepts the whole batch');
    }
    const ids = posted().map(t => t.requestId);
    assert.equal(new Set(ids).size, ids.length, 'every requestId is posted exactly once');
    assert.deepEqual([...ids].sort(), values.map(v => v.requestId).sort(), 'exactly the expected requestIds were posted');
    for (const trace of posted()) assert.deepStrictEqual(trace, values.find(v => v.requestId === trace.requestId), 'the posted trace is the producer record');
}

try {
    // 1. Pre-hello queue, real load → hello → nonce, delivery, exactly-once, unknown versus zero, privacy.
    {
        const session = await openCode({ held: true });
        const f = await session.frame();
        assert.equal(await f.evaluate(() => globalThis.__ezilHarnessHello ?? null), null, 'no hello before the frame loads');
        const early = Array.from({ length: 18 }, () => produce());
        assert.deepEqual(await session.send(f, early), early.map(() => true));
        await quiet(300); assert.equal((await session.observed()).length, 0, 'nothing crosses the frame before hello');
        hold.release(); hold = null;
        const nonce = await session.hello(f);
        await until(() => posted().length === 16, 'pre-hello traces delivered');
        assert.equal(mints, 1, 'one mint: the delivery is this registration, not a recovery re-mint');
        accept(early.slice(2));
        pass('real load → hello binds the nonce; the bridge pre-hello queue delivers its newest 16 of 18 traces');
        const unknown = produce(), zero = produce({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });
        const wide = produce({ count: 129 }), edit = produce({ write: true, cancelled: true });
        assert.deepEqual(await session.send(f, [unknown, zero, wide, edit, unknown]), [true, true, true, true, true]);
        await f.evaluate(([e, origin]) => parent.postMessage(e, origin), [envelope(nonce, unknown), shellOrigin]); // exact replay
        await until(() => posted().length === 20, 'producer records delivered');
        await quiet(2_500);
        accept([...early.slice(2), unknown, zero, wide, edit]);
        // Independently of the shell's dedup: the bridge sent the republished record once; the second is the replay.
        const crossings = (await session.observed()).filter(m => JSON.parse(m.data).trace.requestId === unknown.requestId);
        assert.equal(crossings.length, 2, 'one workbench publish plus one manual replay; the bridge dropped the republish');
        const byId = id => posted().find(t => t.requestId === id);
        assert.equal(byId(unknown.requestId).usage, null); assert.equal(byId(unknown.requestId).usageSource, 'unknown');
        assert.deepStrictEqual(byId(zero.requestId).usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
        assert.equal(byId(zero.requestId).usageSource, 'provider_reported');
        pass('each local requestId is posted exactly once despite a republish and an exact envelope replay; unknown usage stays null, measured zero stays 0');
        const w = byId(wide.requestId);
        assert.equal(w.observationsTruncated, true); assert.equal(w.requested.read, 129); assert.equal(w.results.matched, 129);
        assert.ok(w.toolCalls.length < 128 && w.toolCalls.every(c => /^[0-9a-f]{64}$/.test(c.call)));
        const e = byId(edit.requestId);
        assert.equal(e.outcome, 'cancelled'); assert.equal(e.writeRequested, true); assert.equal(e.toolReportedSuccess, true);
        assert.equal(e.verifiedFileChange, null); assert.equal(e.results.error, 1);
        assert.ok((await session.observed()).every(m => m.origin === editorOrigin && new TextEncoder().encode(m.data).byteLength <= 4096));
        pass('129 observations are trimmed into the 4096-byte envelope with full counts; acknowledgement is not verification');
        await privacy(session);
        pass('no prompt, path, tool name/argument/result or error text in messages, POSTs, console or storage; the session cookie stays on the shell origin');
        await session.context.close();
    }
    // 2. Forged, stale and malformed traffic never reaches the POST; teardown drops the unsent queue.
    {
        const session = await openCode();
        const f = await session.frame();
        const nonce = await session.hello(f);
        const legit = produce();
        await session.send(f, [legit]);
        await until(() => posted().length === 1, 'baseline trace');
        const rejected = Array.from({ length: 9 }, () => produce());
        const [badNonce, badVersion, badType, extraKey, extraTrace, sibling, foreign, self, stale] = rejected;
        const attacks = { badNonce, badVersion, badType, extraKey, extraTrace, sibling, foreign, self, stale };
        // Names every forged record that reached the POST, so a broken guard fails by name rather than by timeout.
        const leaked = () => Object.entries(attacks).filter(([, v]) => posted().some(t => t.requestId === v.requestId)).map(([name]) => name);
        await f.evaluate(([list, origin]) => { for (const e of list) parent.postMessage(e, origin); }, [[
            envelope('B'.repeat(22), badNonce), { ...envelope(nonce, badVersion), v: 2 }, { ...envelope(nonce, badType), type: 'ezil.code.failure' },
            envelope(nonce, extraKey, { userId: 'spoof' }), envelope(nonce, { ...extraTrace, prompt: 'PRIVATE_PROMPT' })], shellOrigin]);
        // Siblings at the editor origin and a third origin, and the shell window itself, all knowing the live nonce.
        await session.page.evaluate(([a, b]) => Promise.all([a, b].map(src => new Promise(r => {
            const frame = document.createElement('iframe'); frame.src = src; frame.onload = r; frame.style.display = 'none'; document.body.append(frame);
        }))), [`${editorOrigin}/sibling`, `${forgedOrigin}/forged`]);
        const at = url => session.page.frames().find(x => x.url() === url);
        await at(`${editorOrigin}/sibling`).evaluate(e => {
            parent.postMessage(e, '*');
            // A forged hello into every other frame: the bridge must keep its real parent's nonce.
            for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] !== window) parent.frames[i].postMessage({ type: 'ezil.code.diag.hello', v: 1, nonce: 'F'.repeat(22) }, '*');
        }, envelope(nonce, sibling));
        await at(`${forgedOrigin}/forged`).evaluate(e => parent.postMessage(e, '*'), envelope(nonce, foreign));
        await session.page.evaluate(e => postMessage(e, '*'), envelope(nonce, self));
        // Malformed workbench events never become a message.
        const before = (await session.observed()).length;
        await f.evaluate(([a, b]) => {
            for (const detail of [a, 'not json', JSON.stringify({ ...a, prompt: 'PRIVATE_PROMPT' }), JSON.stringify(a).padEnd(5000, ' '), b])
                dispatchEvent(new CustomEvent('ezil-ai-request-trace', { detail }));
        }, [produce(), { ...produce(), modelAlias: 'x'.repeat(200) }]);
        await quiet(300);
        assert.equal((await session.observed()).length, before, 'malformed workbench events are dropped in the frame');
        assert.equal(await f.evaluate(() => globalThis.__ezilHarnessHello), nonce, 'the forged hello was not from the parent');
        const after = produce(); await session.send(f, [after]);
        await until(() => posted().some(t => t.requestId === after.requestId), 'legit trace after forgeries');
        assert.deepEqual(leaked(), [], 'no forged, malformed or cross-source envelope was posted');
        pass('wrong nonce, v2, wrong type, extra envelope/trace keys, forged siblings, a third origin and the top window are rejected; a forged hello cannot rebind the bridge');
        // Stale: a reload rotates the nonce; the old one no longer binds.
        await f.evaluate(() => location.reload());
        let reloaded;
        await until(() => (reloaded = session.page.frames().find(x => x.url().startsWith(`${editorOrigin}/?`))), 'reloaded frame');
        await reloaded.waitForFunction(old => globalThis.__ezilHarnessHello && globalThis.__ezilHarnessHello !== old, nonce);
        const fresh = await reloaded.evaluate(() => globalThis.__ezilHarnessHello);
        await reloaded.evaluate(([e, origin]) => parent.postMessage(e, origin), [envelope(nonce, stale), shellOrigin]);
        const renewed = produce(); await session.send(reloaded, [renewed]);
        await until(() => posted().some(t => t.requestId === renewed.requestId), 'trace under the rotated nonce');
        assert.deepEqual(leaked(), [], 'the stale nonce was not accepted');
        assert.equal(JSON.parse((await session.observed()).at(-1).data).nonce, fresh);
        pass('a frame reload rotates the nonce through the real load lifecycle; the stale nonce is rejected');
        // Teardown: closing the Code window disposes the registration before the 2 s flush.
        const unsent = [produce(), produce()];
        const sent = Date.now();
        await session.send(reloaded, unsent);
        // Full-view Code closes from its tray (the same Close as the window chrome).
        await session.page.focus('.ezil-app-drawer .dashboard-app-drawer-toggle');
        await session.page.locator('.ezil-app-drawer .dashboard-app-drawer-btn[aria-label="Close"]').click();
        await session.page.waitForFunction(() => !document.querySelector('.window-app-iframe'));
        assert.ok(Date.now() - sent < 2_000, 'the window closed before the 2 s flush, so this check is not vacuous');
        await quiet(3_000);
        const seen = (await session.observed()).map(m => JSON.parse(m.data).trace.requestId);
        assert.ok(unsent.every(v => seen.includes(v.requestId)), 'the unsent traces reached the shell before close');
        accept([legit, after, renewed]);
        pass('closing the Code window clears the unsent queue: received traces are never posted after teardown');
        await privacy(session, [extraTrace.requestId]);
        await session.context.close();
    }
    // 3. Flood: the Worker bridge's 120/minute cap, the newest-64 shell queue, batches of 8, one request in flight.
    // (The shell's own 120/minute cap is not isolated here: the bridge cap is reached first.)
    {
        delayMs = 400;
        const session = await openCode();
        const f = await session.frame();
        await session.hello(f);
        const flood = Array.from({ length: 130 }, () => produce());
        await session.send(f, flood);
        await until(() => posts.length === 8, 'eight batches', 60_000).catch(async error => {
            throw new Error(`${error.message}: posts=${posts.length} sizes=${posts.map(p => JSON.parse(p.body).traces.length)} statuses=${posts.map(p => p.authenticated)} mints=${mints} lifecycle=${session.lifecycle} crossed=${await session.observed().then(m => m.length, e => `unavailable (${e.message.split('\n')[0]})`)}`);
        });
        await quiet(3_000);
        assert.equal((await session.observed()).length, 120, 'the Worker bridge posts at most 120 per minute');
        assert.equal(posts.length, 8); assert.ok(posts.every(p => JSON.parse(p.body).traces.length === 8));
        assert.deepEqual(posted().map(t => t.requestId), flood.slice(56, 120).map(v => v.requestId), 'the shell keeps the newest 64, in order');
        accept(flood.slice(56, 120));
        assert.equal(maxInFlight, 1, 'one request in flight at a time');
        pass('a 130-trace flood: 120 cross the frame, the newest 64 are posted as 8 sequential batches of 8');
        await privacy(session);
        await session.context.close();
        delayMs = 0;
    }
} finally {
    await shutdown();
}
console.log(`\n${checks} real-browser AI request-trace checks passed.`);

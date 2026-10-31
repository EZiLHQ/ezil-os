// native-opening-test.mjs — EZiL-authored. The native Browser window's ONE opening surface.
//
// Run: node shell/ezil/apps/native-opening-test.mjs
//
// Round 5 (D5): `apps/native.js` shares one `AppSpinner` across its tabs. When no tab is opening any
// more the open is over and must be concluded on the surface, so the NEXT tab's open starts its own
// elapsed clock. Without that, a tab opened ten minutes after the first one read "Taking longer than
// usual · 10:00" at once (review L5a, A4). The real `app-spinner.js` and `boot-phases.js` are used;
// only the native bridge is a fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div class="window window-active"><div class="window-head-title"></div><div class="window-body"><iframe class="window-app-iframe"></iframe></div></div>',
    { pretendToBeVisual: true, url: 'https://app.example/os' });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
const realNow = Date.now;
let now = 0; Date.now = () => now;

const fileURL = rel => JSON.stringify(new URL(rel, import.meta.url).href);
const runtimeSource = readFileSync(new URL('../native-runtime.js', import.meta.url), 'utf8');
const { NATIVE_CAPABILITIES } = await import(`data:text/javascript;base64,${Buffer.from(runtimeSource).toString('base64')}`);
const ctx = { computer: { id: randomUUID() }, appName: 'Browser', desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES },
    browserTabs: { tabs: ['https://a.example/'], activeIndex: 0 } };
let blockAttach = false, releaseAttach;
const initial = { revision: 1, url: '', title: '', loading: false, error: null, canGoBack: false, canGoForward: false, zoomFactor: 1 };
window.ezilNative = {
    subscribeBrowserState: () => () => {}, subscribeBrowserShortcut: () => () => {}, subscribeBrowserNewTab: () => () => {},
    async operation (op) {
        if (op.op === 'passkeys.status') return { ok: true, embeddedTouchID: false, syncedPasskeys: false, existingPasskeys: 'secure-browser', reason: 'signing_required' };
        if (op.op === 'browser.attach' && blockAttach) { blockAttach = false; await new Promise(resolve => { releaseAttach = resolve; }); }
        return { ...op, ok: true, state: 'ready', ...(op.op === 'browser.attach' ? { browserState: initial } : {}) };
    },
};
const source = readFileSync(new URL('./native.js', import.meta.url), 'utf8')
    .replace("'../native-runtime.js'", fileURL('../native-runtime.js'))
    .replace("'../ui/app-spinner.js'", fileURL('../ui/app-spinner.js'))
    .replace("'../boot-phases.js'", fileURL('../boot-phases.js'));
const { bindNativeBrowser } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });
try {
    const el = document.querySelector('.window');
    blockAttach = true;
    bindNativeBrowser(el, ctx);
    await flush();
    const spinner = el.querySelector('.ezil-app-spinner');
    const meta = () => spinner.querySelector('.ezil-opening-meta');
    push('tab 1 opening: the one surface shows', spinner && spinner.hidden === false && spinner.dataset.state === 'opening', spinner?.dataset.state);
    now = 2_000; releaseAttach(); await flush();
    push('tab 1 ready: the surface hides and its open is concluded (done)', spinner.hidden === true && spinner.dataset.state === 'done', spinner.dataset.state);

    // Ten minutes later a new tab opens.
    now = 600_000; blockAttach = true;
    el.querySelector('.ezil-native-browser-add').click(); await flush();
    now = 601_000; window.dispatchEvent(new window.CustomEvent('ezil:native-composition', { detail: {} })); await flush();
    push('🔴 a tab opened ten minutes later starts its own clock: opening, no "Taking longer"',
        spinner.hidden === false && spinner.dataset.state === 'opening' && ! /Taking longer|10:0/.test(meta().textContent),
        `hidden=${spinner.hidden} state=${spinner.dataset.state} meta="${meta().textContent}"`);
    releaseAttach(); await flush();
    push('tab 2 ready: concluded again', spinner.hidden === true && spinner.dataset.state === 'done', spinner.dataset.state);
    await el.on_before_exit?.(); await flush();
} finally {
    Date.now = realNow;
    dom.window.close();
}

let failed = 0;
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail !== '' ? `  [${c.detail}]` : ''}`);
    if (! c.pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);

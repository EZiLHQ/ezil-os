// load-test.mjs — EZiL-authored. Headless smoke test for the BUILT shell bundle.
//
// Run: cd shell && bun install && node load-test.mjs   (after build-shell.sh)
//
// Not a unit test. It answers the one question a build and a syntax check
// cannot: does the bundle EVALUATE in a DOM and produce a usable window, or
// does it merely parse? It loads app/public/os/{icons.js,bundle.min.js,
// bundle.min.css} into jsdom exactly the way a page would, boots the shell,
// and constructs a real UIWindow, taskbar and context menu.
//
// This is not ceremony — writing it found three defects that `node --check`
// and a green build both passed:
//   1. globalThis.ezil had no boot(); esbuild's --global-name put the exports
//      on globalThis.EzilShell instead.
//   2. UIWindow() appended a window to the DOM and THEN threw on
//      $(...).dragster, so the window rendered and half its constructor never
//      ran. See src/lib/ezil-dragster.js.
//   3. (caught here as a regression guard) the puter.* stubs must REJECT.
//      A stub that resolved would make the shell look like it works.
// See docs/PLATFORM-NOTES.md "Method notes": run it for real.
//
// jsdom is not a browser. It has no layout, so this proves construction and
// wiring, not that anything is positioned correctly on screen.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../app/public/os');
const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

const errors = [];
const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head>
     <body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/' },
);
const { window } = dom;
window.addEventListener('error', e => errors.push(`window error: ${e.message}`));
window.onerror = (m) => errors.push(`onerror: ${m}`);

// jsdom has no crypto.getRandomValues in some configs; uuidv4 needs it.
if (!window.crypto?.getRandomValues) {
    window.crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
}

function run(label, code) {
    try {
        window.eval(code);
        return true;
    } catch (e) {
        errors.push(`${label}: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
        return false;
    }
}

const okIcons = run('icons.js', icons);
const okBundle = run('bundle.min.js', bundle);

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });

push('icons.js evaluates', okIcons);
push('bundle.min.js evaluates', okBundle);
push('globalThis.EzilIcons populated', Object.keys(window.EzilIcons ?? {}).length === 21,
    `${Object.keys(window.EzilIcons ?? {}).length} icons`);
push('window.ezil exposed', typeof window.ezil === 'object');
push('jQuery published as $', typeof window.$ === 'function');
push('jQuery UI loaded (draggable)', typeof window.$?.fn?.draggable === 'function');
push('jQuery UI loaded (resizable)', typeof window.$?.fn?.resizable === 'function');
push('jQuery UI loaded (sortable)', typeof window.$?.fn?.sortable === 'function');
push('html_encode installed', typeof window.html_encode === 'function');
push('isMobile installed', typeof window.isMobile === 'object');
push('i18n installed', typeof window.i18n === 'function');
push('UIWindow exported', typeof window.ezil?.UIWindow === 'function');
push('UITaskbar exported', typeof window.ezil?.UITaskbar === 'function');
push('UIContextMenu exported', typeof window.ezil?.UIContextMenu === 'function');
push('UIAlert exported', typeof window.ezil?.UIAlert === 'function');
push('$.fn.showWindow installed by UIWindow.js', typeof window.$?.fn?.showWindow === 'function');
push('enter_fullpage_mode installed', typeof window.enter_fullpage_mode === 'function');
push('exit_fullpage_mode installed', typeof window.exit_fullpage_mode === 'function');
push('reset_window_size_and_position installed', typeof window.reset_window_size_and_position === 'function');
push('scale_window installed (from whole-file UIWindow)', typeof window.scale_window === 'function');
push('update_window_layout installed (from whole-file UIWindow)', typeof window.update_window_layout === 'function');

// boot() must install globals without throwing.
let booted = false;
try {
    window.ezil.boot();
    booted = true;
} catch (e) {
    errors.push(`boot(): ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
}
push('boot() runs', booted);
push('boot() installed layout globals',
    window.last_window_zindex === 1 && window.window_stack?.length === 0
    && window.taskbar_height === 50 && window.toolbar_height === 0);
push('boot() aliased icons onto window.icons', Object.keys(window.icons ?? {}).length === 21);
push('i18n() resolves a UIWindow key', window.i18n('window_click_to_go_back')?.length > 0,
    JSON.stringify(window.i18n('window_click_to_go_back')));
push('i18n() has no Puter mark in window_title_puter', window.i18n('window_title_puter') === 'EZiL',
    window.i18n('window_title_puter'));

// The stubs must REJECT, not resolve.
const stubChecks = [];
async function stubs() {
    for (const [name, thunk] of [
        ['puter.kv.set', () => window.ezil.puter.kv.set('a', 'b')],
        ['puter.fs.stat', () => window.ezil.puter.fs.stat({ path: '/x' })],
        ['puter.apps.list', () => window.ezil.puter.apps.list()],
        ['puter.auth.whoami', () => window.ezil.puter.auth.whoami()],
        ['puter.anything.nested.deep', () => window.ezil.puter.anything.nested.deep()],
    ]) {
        try {
            await thunk();
            stubChecks.push([name, false, 'RESOLVED — must reject']);
        } catch (e) {
            stubChecks.push([name, e?.name === 'PuterBackendRemovedError', e?.name ?? String(e)]);
        }
    }
}

// Actually create a window — the real test of the whole-file port.
async function makeWindow() {
    const w = await window.ezil.UIWindow({
        title: 'EZiL test window',
        is_visible: true,
        has_head: true,
        body_content: '<p>hello</p>',
        width: 400,
        height: 300,
    });
    return w;
}

await stubs();
for (const [n, p, d] of stubChecks) push(`stub rejects: ${n}`, p, d);

let win = null;
try {
    win = await makeWindow();
} catch (e) {
    errors.push(`UIWindow(): ${e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e}`);
}
push('UIWindow() creates an element', !!win);
push('window element is in the DOM', window.document.querySelectorAll('.window').length === 1,
    `${window.document.querySelectorAll('.window').length} .window nodes`);
push('window has a head with the title', /EZiL test window/.test(window.document.querySelector('.window-head-title')?.textContent ?? ''),
    window.document.querySelector('.window-head-title')?.textContent ?? '(none)');
push('window has close/minimize/scale buttons',
    !!window.document.querySelector('.window-close-btn')
    && !!window.document.querySelector('.window-minimize-btn')
    && !!window.document.querySelector('.window-scale-btn'));
push('window body carries the content', /hello/.test(window.document.querySelector('.window-body')?.innerHTML ?? ''));
push('window_stack tracked the new window', (window.window_stack?.length ?? -1) === 1,
    `len=${window.window_stack?.length}`);

// --- taskbar, context menu, alert, session round-trip -----------------
let tbErr = null;
try {
    await window.ezil.UITaskbar({});
} catch (e) { tbErr = e; errors.push(`UITaskbar(): ${e?.stack?.split('\n').slice(0,4).join(' | ') ?? e}`); }
push('UITaskbar() runs', !tbErr);
push('taskbar element in the DOM', window.document.querySelectorAll('.taskbar').length === 1);
push('taskbar has the Start item', !!window.document.querySelector('.taskbar-item[data-name="Start"]'),
    window.document.querySelector('.taskbar-item')?.getAttribute('data-name') ?? '(none)');
push('taskbar has NO launcher popover markup',
    window.document.querySelectorAll('.launch-popover, .popover-launcher').length === 0);
push('taskbar has NO trash/explorer item',
    !window.document.querySelector('.taskbar-item[data-app="trash"]')
    && !window.document.querySelector('.taskbar-item[data-app="explorer"]'));
push('taskbar_position persisted to localStorage',
    JSON.parse(window.localStorage.getItem('ezil-os:taskbar_position') ?? 'null') !== null,
    window.localStorage.getItem('ezil-os:taskbar_position'));

let startFired = false;
window.addEventListener('ezil:start-click', () => { startFired = true; });
window.$('.taskbar-item[data-name="Start"]').trigger('click');
push('Start button dispatches ezil:start-click', startFired);

let cmErr = null;
try {
    window.ezil.UIContextMenu({ items: [{ html: 'One', onClick: () => {} }, '-', { html: 'Two' }] });
} catch (e) { cmErr = e; errors.push(`UIContextMenu(): ${e?.stack?.split('\n').slice(0,4).join(' | ') ?? e}`); }
push('UIContextMenu() runs', !cmErr);
push('context menu in the DOM', window.document.querySelectorAll('.context-menu').length >= 1);
push('context menu rendered its items',
    window.document.querySelectorAll('.context-menu .context-menu-item').length >= 2,
    `${window.document.querySelectorAll('.context-menu .context-menu-item').length} items`);

// No Puter mark anywhere in the rendered DOM or the shipped bundles.
// The AGPL/attribution banner is REQUIRED to name Puter and is prose, not UI;
// strip CSS comments before checking that no mark leaked into user-visible
// markup (text, titles, alt, class names, data-*).
const domHtml = window.document.documentElement.outerHTML.replace(/\/\*[\s\S]*?\*\//g, '');
push('no "Puter" in the rendered DOM (attribution banner excluded)', !/puter/i.test(domHtml),
    (domHtml.match(/.{0,40}puter.{0,40}/i) ?? [''])[0]);
push('no puter.com URL in the shipped bundle', !/puter\.com/i.test(bundle) && !/puter\.com/i.test(css));

let pass = 0;
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
    if (c.pass) pass++;
}
console.log(`\n${pass}/${checks.length} checks passed`);
if (errors.length) {
    console.log('\n--- errors captured ---');
    for (const e of errors) console.log(e);
}
process.exit(pass === checks.length && errors.length === 0 ? 0 : 1);

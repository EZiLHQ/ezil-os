// current-computer-test.mjs — EZiL-authored. ONE current computer.
//
// Run:  node shell/ezil/ui/Settings/current-computer-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, in jsdom)
//
// Reproduces the 2026-10-18 production mismatch: Settings -> Computers showed
// Computer 1 Current (with Open) while the dock kept opening Code and Desktop
// on the boot payload's Computer 2, because `boot.js` froze the computer into
// the dock's ctx at build time and Settings kept its own last-switched id.
//
// 🔴 It drives the REAL dock, Start menu and App Store, never
// `registry.launch(id, explicitCtx)`: an explicit ctx carries its own computer
// and passes on the broken code, which is exactly how this shipped. That is
// why, unlike settings-test, the payload is set BEFORE the bundle evaluates —
// `build()` only paints a dock when there is a payload to build it from.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    return !! pass;
};
const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div id="ezil-os-root"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(`window error: ${e.message}`));
window.addEventListener('unhandledrejection', e => uncaught.push(`rejection: ${e.reason}`));
const onRejection = reason => uncaught.push(`node rejection: ${reason}`);
process.on('unhandledRejection', onRejection);
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = {
        getRandomValues: a => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; },
    };
}
if ( ! window.AbortSignal?.timeout ) window.AbortSignal = { timeout: () => undefined };

const recent = new Date().toISOString();
const C1 = { id: 'c-1', name: 'Computer 1', slot: 1, createdAt: recent, lastOpenedAt: null, isNew: false };
const C2 = { id: 'c-2', name: 'Computer 2', slot: 2, createdAt: recent, lastOpenedAt: recent, isNew: false };
const payload = {
    user: {
        id: '11111111-2222-3333-4444-555555555555', email: 'ada@example.com',
        name: 'Ada Lovelace', provider: 'google', createdAt: '2026-10-01T18:30:00.000Z',
    },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    computer: C2,
    desktopState: {},
};
const calls = [];
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method ?? 'GET', body: opts.body });
    const json = (body, status = 200) => ({
        ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    });
    if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: [C1, C2] } } });
    return json({ error: { json: { message: 'stub', data: { code: 'INTERNAL_SERVER_ERROR' } } } }, 500);
};
// The payload must precede evaluation: build() creates the actual dock here.
window.__EZIL_BOOT__ = payload;

const doc = window.document;
const q = sel => doc.querySelector(sel);
const qa = sel => Array.from(doc.querySelectorAll(sel));
const tick = (ms = 25) => new Promise(r => window.setTimeout(r, ms));
const settle = async (n = 12, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
const click = el => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const appWindow = id => q(`.window[data-app="${id}"]`);
const stamp = id => appWindow(id)?.getAttribute('data-ezil-computer-id');
const row = id => q(`.window[data-app="settings"] .ezil-settings-row[data-id="${id}"]`);
const currentRows = () => qa('.window[data-app="settings"] .ezil-settings-row')
    .filter(el => el.querySelector('.ezil-settings-pill')?.textContent.trim() === 'Current');
const isCurrent = id => currentRows().length === 1 && currentRows()[0].getAttribute('data-id') === id;
const switchButton = id => row(id)?.querySelector('[data-action="switch"]');
const dock = async id => {
    window.$(`.taskbar-item[data-app="${id}"]`).trigger('click');
    await settle();
};
const closeApp = async id => {
    window.$(`.window[data-app="${id}"]`).close();
    await settle();
};
const reopenSettings = async () => {
    await closeApp('settings');
    await dock('settings');
};

try {
    window.eval(fs.readFileSync(`${OS}/icons.js`, 'utf8'));
    window.eval(fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
    const deadline = Date.now() + 5000;
    while ( ! q('.taskbar-item[data-app="desktop"]') && Date.now() < deadline ) await tick();
    push('bundle self-boots the real desktop dock item', !! q('.taskbar-item[data-app="desktop"]'));

    await dock('settings');
    push('boot computer c-2 is the only Current row', isCurrent('c-2'));
    push('c-1 offers Switch', switchButton('c-1')?.textContent.trim() === 'Switch');
    // Keep a store opened with c-2's context across the switch as well.
    await dock('app-store');
    const store = appWindow('app-store');
    push('App Store opens from the dock before switching', !! store);

    click(switchButton('c-1'));
    await settle(20, 40);
    push('Switch opens a desktop stamped c-1', stamp('desktop') === 'c-1');
    await closeApp('desktop');
    await reopenSettings();
    push('closing the desktop keeps c-1 as the only Current row', isCurrent('c-1'));
    push('current c-1 offers Open with Your current computer subtext',
        switchButton('c-1')?.textContent.trim() === 'Open'
        && row('c-1')?.querySelector('.ezil-settings-row-sub')?.textContent === 'Your current computer');

    await dock('code');
    push('real dock Code uses c-1 after switching', stamp('code') === 'c-1', stamp('code'));
    await dock('desktop');
    push('real dock Desktop uses c-1 after switching', stamp('desktop') === 'c-1', stamp('desktop'));
    push('session exposes the current computer c-1',
        typeof window.ezil?.session?.currentComputer === 'function'
        && window.ezil.session.currentComputer()?.id === 'c-1');
    const sandboxWindows = qa('.window').filter(el => el.querySelector('.window-app-iframe'));
    push('every open sandbox window matches Settings Current',
        sandboxWindows.length >= 2 && isCurrent('c-1')
        && sandboxWindows.every(el => el.getAttribute('data-ezil-computer-id') === currentRows()[0].getAttribute('data-id')),
        sandboxWindows.map(el => `${el.dataset.app}:${el.getAttribute('data-ezil-computer-id')}`).join(', '));

    window.dispatchEvent(new window.CustomEvent('ezil:start-click', { detail: { element: null } }));
    await settle(4);
    const previewName = window.ezil.registry.resolve(payload).find(app => app.id === 'preview')?.name;
    const previewItem = qa('.context-menu li').find(el => el.querySelector('.contextmenu-label')?.textContent.trim() === previewName);
    push('Start menu exposes the Preview launcher', !! previewItem);
    click(previewItem);
    await settle();
    push('Start menu Preview uses c-1', stamp('preview') === 'c-1', stamp('preview'));
    await closeApp('preview');
    const storePreview = store?.querySelector('[data-action="open"][data-id="preview"]');
    push('existing App Store exposes Preview Open', !! storePreview);
    click(storePreview);
    await settle();
    push('App Store opened on c-2 launches Preview on current c-1', stamp('preview') === 'c-1', stamp('preview'));

    await reopenSettings();
    push('current desktop on screen says Active now and needs no Open button',
        isCurrent('c-1') && ! switchButton('c-1')
        && row('c-1')?.querySelector('.ezil-settings-row-sub')?.textContent === 'Active now');
    click(switchButton('c-2'));
    await settle(20, 40);
    push('switching back closes every sandbox window stamped c-1',
        ! qa('.window[data-ezil-computer-id="c-1"]').some(el => el.querySelector('.window-app-iframe')));
    // Settings is not a sandbox window; refresh its launch-time stamp too.
    await reopenSettings();
    push('switching back leaves no window stamped c-1', ! q('.window[data-ezil-computer-id="c-1"]'));
    push('switching back opens desktop c-2', stamp('desktop') === 'c-2');
    push('switching back closes Code before relaunch', ! appWindow('code'));
    await dock('code');
    push('dock Code uses c-2 after switching back', stamp('code') === 'c-2', stamp('code'));
    push('Settings now marks only c-2 Current', isCurrent('c-2'));

    const code = appWindow('code');
    await closeApp('desktop');
    await reopenSettings();
    push('c-2 offers Open while Code c-2 remains open',
        switchButton('c-2')?.textContent.trim() === 'Open' && stamp('code') === 'c-2');
    click(switchButton('c-2'));
    await settle(20, 40);
    push('Open preserves the same Code window on c-2',
        !! code && code.isConnected && appWindow('code') === code && stamp('code') === 'c-2');
    push('Open restores the desktop on c-2', stamp('desktop') === 'c-2');
    push('Settings switches never mutate the boot computer', window.__EZIL_BOOT__.computer === C2);
    push('Computers list was loaded through the fetch stub', calls.some(call => call.url.includes('computer.list')));
} catch (error) {
    push('scenario completes without throwing', false, error?.stack ?? String(error));
}

push('no uncaught page errors during the run', uncaught.length === 0, uncaught.join(' | '));
let failed = 0;
for ( const check of checks ) {
    if ( ! check.pass ) failed++;
    console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? `  [${check.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
dom.window.close();
process.removeListener('unhandledRejection', onRejection);
process.exit(failed === 0 ? 0 : 1);

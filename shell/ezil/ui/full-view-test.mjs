// full-view-test.mjs — EZiL-authored. The shared full-view mechanism
// (`./full-view.js`, app-code lane A2, 2026-10-30) against the REAL window
// functions it drives: `enter_fullpage_mode` / `exit_fullpage_chrome` /
// `reset_window_size_and_position` (UIDesktopFullpage.js) and `hideWindow` /
// `showWindow` (UIWindow.js), from the BUILT bundle, on real `.window`s.
//
// Run:  node shell/ezil/ui/full-view-test.mjs
//       (after shell/build-shell.sh, or with EZIL_SHELL_OUT_DIR / EZIL_OS_DIR
//       pointing at a build)
//
// The module under test is imported from SOURCE with jsdom's globals bridged
// in (`$`, `window`, `document`, `MutationObserver`), so a mutant of
// `full-view.js` is caught without rebuilding. The windows it is applied to
// are ordinary Settings and App Store windows: the mechanism is generic, and
// the Browser/Code wiring has its own suites (os-chrome, code-test, boot-test).
//
// jsdom has no layout: geometry here is the INLINE style the functions write,
// which is exactly what "restore the previous bounds" restores. Pixels are the
// browser suites' job.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || process.env.EZIL_OS_DIR || path.resolve(here, '../../../app/public/os');
for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`SKIP: missing ${path.join(OS, f)} — run shell/build-shell.sh first (or set EZIL_SHELL_OUT_DIR)`);
        process.exit(2);
    }
}

const checks = [];
const push = (name, pass, detail = '') => { checks.push({ name, pass: !! pass, detail }); return !! pass; };

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div id="ezil-os-root"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(e.message));
window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' });
window.__EZIL_BOOT__ = {
    user: { id: 'u-1', email: 'someone@example.com' },
    computer: { id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop' } },
};
// 🔴 Counted, so "never the Fullscreen API" is an observation, not a hope.
let fullscreen_calls = 0;
window.Element.prototype.requestFullscreen = function () { fullscreen_calls++; return Promise.resolve(); };
window.eval(fs.readFileSync(`${OS}/icons.js`, 'utf8'));
window.eval(fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
window.ezil.boot();

const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
const settle = async (n = 10, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
await settle(20);

// Bridge jsdom's globals for the SOURCE module.
Object.assign(globalThis, { window, document: window.document, $: window.$, MutationObserver: window.MutationObserver });
const { createFullView, FULL_VIEW_CLASS, FULL_VIEW_HOST_CLASS, is_minimized } = await import(pathToFileURL(path.join(here, 'full-view.js')).href);

const doc = window.document;
const q = (sel) => doc.querySelector(sel);
const taskbar_shown = () => window.getComputedStyle(q('.taskbar')).display !== 'none';
const head_shown = (el) => window.getComputedStyle(el.querySelector(':scope > .window-head')).display !== 'none';
const geom = (el) => ({ width: el.style.width, height: el.style.height, top: el.style.top, left: el.style.left });

push('setup: the shell booted with a visible taskbar', !! q('.taskbar') && taskbar_shown());
await window.ezil.registry.launch('settings');
await window.ezil.registry.launch('app-store', { payload: window.__EZIL_BOOT__ });
await settle(10);
const A = q('.window[data-app="settings"]');
const B = q('.window[data-app="app-store"]');
push('setup: two ordinary windows to drive', !! A && !! B && A !== B);

// ── 1. host, and nothing happens until asked ────────────────────────────────
const fa = createFullView(A);
push('createFullView marks the window as a full-view host', A.classList.contains(FULL_VIEW_HOST_CLASS));
push('…and does not enter full view by itself', ! fa.is_full() && ! A.classList.contains(FULL_VIEW_CLASS) && fa.wants === false && fa.allowed === true);
push('the state class is the historical `ezil-fullbleed` (feedback.js, diagnostics.js and the suites read it)', FULL_VIEW_CLASS === 'ezil-fullbleed');

// ── 2. enter ───────────────────────────────────────────────────────────────
const before = geom(A);
const entered = fa.enter();
push('🔴 enter(): the class, `data-is_fullpage="1"`, no head, no taskbar, 100% x 100%',
    entered === true && A.classList.contains(FULL_VIEW_CLASS) && A.getAttribute('data-is_fullpage') === '1'
    && ! head_shown(A) && ! taskbar_shown() && A.style.width === '100%' && A.style.height === '100%'
    && doc.body.classList.contains('fullpage-mode'),
    JSON.stringify({ fp: A.getAttribute('data-is_fullpage'), taskbar: taskbar_shown(), w: A.style.width }));
push('enter() records the desire', fa.wants === true);
push('enter() stashes the windowed bounds it is about to replace', A.dataset.ezilPrevFpWidth === before.width && A.dataset.ezilPrevFpTop === before.top,
    JSON.stringify({ stash: A.dataset.ezilPrevFpWidth, before }));
push('a second enter() is a no-op (returns false, nothing re-stashed)', fa.enter() === false && A.dataset.ezilPrevFpWidth === before.width);
push('🔴 full view never calls the browser Fullscreen API (and full view DID engage above)', fullscreen_calls === 0 && fa.is_full());

// ── 3. exit restores the previous bounds ────────────────────────────────────
const exited = fa.exit();
push('🔴 exit(): back to the EXACT pre-full inline bounds',
    exited === true && JSON.stringify(geom(A)) === JSON.stringify(before), JSON.stringify({ now: geom(A), before }));
push('exit(): the class and `data-is_fullpage` go, the head and the taskbar come back',
    ! A.classList.contains(FULL_VIEW_CLASS) && A.getAttribute('data-is_fullpage') === null && head_shown(A) && taskbar_shown()
    && ! doc.body.classList.contains('fullpage-mode'));
push('exit() clears the desire and consumes the stash', fa.wants === false && A.dataset.ezilPrevFpWidth === undefined);
push('exit() on a windowed window is a no-op', fa.exit() === false && JSON.stringify(geom(A)) === JSON.stringify(before));

// ── 4. minimise from full view is chrome-only; the restore can re-enter ────
let restores = 0;
const observer = fa.watch_restore(() => { restores++; });
fa.enter();
const full_geom = geom(A);
fa.minimise();
await settle(4);
push('🔴 minimise() from full view: taskbar back, class off, head back, window minimised',
    taskbar_shown() && ! A.classList.contains(FULL_VIEW_CLASS) && head_shown(A) && is_minimized(A));
push('…chrome only: the hidden window keeps its full-view geometry and the stash', A.dataset.ezilPrevFpWidth === before.width
    && full_geom.width === '100%', JSON.stringify({ full_geom, stash: A.dataset.ezilPrevFpWidth }));
push('…and still WANTS full view (the desire outlives a minimise)', fa.wants === true);
push('enter() while minimised does nothing but keep the desire', fa.enter() === false && ! fa.is_full() && fa.wants === true);
window.$(A).showWindow();
await settle(14);
push('watch_restore() fires once when the window comes back from the taskbar', restores === 1 && ! is_minimized(A), `${restores}`);
push('…and the caller can then re-enter full view', fa.enter() === true && fa.is_full() && ! taskbar_shown());

// ── 5. leaving full view while minimised: settle() restores the bounds ─────
fa.minimise();
await settle(4);
push('exit() while minimised only clears the desire', fa.exit() === false && fa.wants === false && A.dataset.ezilPrevFpWidth === before.width);
window.$(A).showWindow();
await settle(14);
fa.settle();
push('🔴 settle() after that restore puts the window back at its windowed bounds',
    JSON.stringify(geom(A)) === JSON.stringify(before) && A.dataset.ezilPrevFpWidth === undefined && ! fa.is_full(),
    JSON.stringify({ now: geom(A), before }));
push('settle() is a no-op once settled', (fa.settle(), JSON.stringify(geom(A)) === JSON.stringify(before)));
observer.disconnect();

// ── 6. forbid: no exit, no entry ────────────────────────────────────────────
const fb = createFullView(B);
fb.forbid();
push('🔴 forbid(): enter() records the desire but never takes the viewport',
    fb.enter() === false && ! fb.is_full() && fb.allowed === false && taskbar_shown() && head_shown(B));
push('…positive control: an allowed window does enter', fa.enter() === true && fa.is_full());
fa.exit();

// ── 7. two windows in full view share one taskbar ───────────────────────────
const fb2 = createFullView(B); // a fresh controller: `forbid` above is per controller
fa.enter();
fb2.enter();
push('setup: both windows in full view, taskbar hidden', fa.is_full() && fb2.is_full() && ! taskbar_shown());
fb2.exit();
push('🔴 one leaves while the other is still full: the taskbar stays hidden, only ITS head comes back',
    ! taskbar_shown() && head_shown(B) && ! head_shown(A) && B.getAttribute('data-is_fullpage') === null && fa.is_full());
fa.exit();
push('…positive control: the last one leaving gives the taskbar back', taskbar_shown() && head_shown(A));
fa.enter();
fb2.enter();
fb2.minimise();
await settle(4);
push('🔴 minimising one of two full windows leaves the taskbar hidden for the other', ! taskbar_shown() && fa.is_full() && is_minimized(B));
fa.minimise();
await settle(4);
push('…and minimising the last one gives it back', taskbar_shown());

// ── 8. closing one of two full windows (`prepare_close`, from on_before_exit) ─
window.$(A).showWindow();
window.$(B).showWindow();
await settle(14);
fa.enter();
fb2.enter();
push('setup: both full again', fa.is_full() && fb2.is_full() && ! taskbar_shown());
fa.prepare_close();
push('prepare_close() with another full window open hands back only this head and drops data-is_fullpage',
    ! fa.is_full() && A.getAttribute('data-is_fullpage') === null && head_shown(A) && ! taskbar_shown());
await window.$(A).close();
await settle(8);
push('🔴 …so the real close of one of two full windows leaves the taskbar hidden for the other',
    ! A.isConnected && ! taskbar_shown() && fb2.is_full(), `taskbar=${taskbar_shown()}`);
fb2.prepare_close();
push('…positive control: prepare_close() on the LAST full window does nothing (close then restores the taskbar as before)',
    fb2.is_full() && B.getAttribute('data-is_fullpage') === '1');
await window.$(B).close();
await settle(8);
push('…and that close gives the taskbar back', ! B.isConnected && taskbar_shown());

// Bounded wait on a condition (no fixed sleeps in the checks below).
const until = async (cond, tries = 200) => {
    for ( let i = 0; i < tries; i++ ) { if ( cond() ) return true; await tick(10); }
    return !! cond();
};

// ── 9. full view entered while the window is still opening ─────────────────
// UIWindow opens a window with `$(el).show(0, cb)`, which jQuery runs as a
// "show" animation that captures the inline geometry and writes it back when
// it completes. Whenever another jQuery animation is already running (the
// shell nearly always has one) that completion is a later fx tick, after
// `code.js` has entered full view (`await UIWindow()`, then `enter()`), and it
// put the window back at its windowed box. Reproduced exactly: a long
// animation elsewhere keeps the fx timer running, the window is shown with
// `show(0)` at a known box, and full view is entered in the same turn.
await window.ezil.registry.launch('settings');
await until(() => q('.window[data-app="settings"]'));
const C = q('.window[data-app="settings"]');
const fc = createFullView(C);
const keeper = window.$('<div>').appendTo(doc.body).animate({ opacity: 0 }, 60_000);
window.$(C).css({ width: '612px', height: '433px', top: '41px', left: '57px' }).hide().show(0);
const opening = window.$(C).is(':animated');
fc.enter();
const done = await until(() => ! window.$(C).is(':animated'));
const after_open = geom(C);
keeper.stop(true).remove();
push('setup: the window is still in its opening show animation when full view is entered', opening === true && done === true);
push('🔴 …and it keeps 100% x 100% once that animation has completed (THE BUG: the animation wrote 612x433 back over full view)',
    fc.is_full() && after_open.width === '100%' && after_open.height === '100%' && after_open.top === '0px', JSON.stringify(after_open));
push('…the stash is the settled windowed box', C.dataset.ezilPrevFpWidth === '612px' && C.dataset.ezilPrevFpHeight === '433px',
    JSON.stringify({ w: C.dataset.ezilPrevFpWidth, h: C.dataset.ezilPrevFpHeight }));
fc.exit();
push('…positive control: leaving full view restores that box', JSON.stringify(geom(C)) === JSON.stringify({ width: '612px', height: '433px', top: '41px', left: '57px' }),
    JSON.stringify(geom(C)));

// ── 10. showWindow on a full window that is NOT minimised (a relaunch) ──────
// The registry calls `showWindow()` on an already-open single-instance window
// (a dock click, Back/Forward onto an open app). Its geometry restore is the
// box `hideWindow` recorded in `data-orig-*`, and it must reach only a window
// that is minimised: written over a visible full window, it shrank it to that
// snapshot with the full-view class still on.
fc.enter();
fc.minimise();
await until(() => is_minimized(C));
// jsdom has no layout, so the box hideWindow measured is 0x0; give the
// snapshot recognisable values, as a drag or resize stop would.
window.$(C).attr({ 'data-orig-width': 701, 'data-orig-height': 502, 'data-orig-top': 23, 'data-orig-left': 19 });
const snapshot = ['width', 'height'].map(k => C.getAttribute(`data-orig-${k}`));
window.$(C).showWindow();
const restored_px = geom(C);
push('positive control: showWindow on a MINIMISED window writes the snapshot back',
    restored_px.width === '701px' && restored_px.height === '502px' && restored_px.top === '23px', JSON.stringify({ snapshot, restored_px }));
await until(() => ! is_minimized(C));
fc.enter();
push('setup: back in full view, with that snapshot still on the window', fc.is_full() && geom(C).width === '100%'
    && C.getAttribute('data-orig-width') === snapshot[0]);
window.$(C).showWindow();
push('🔴 showWindow on a VISIBLE full window leaves its geometry alone (THE BUG: it wrote the stale snapshot over 100% x 100%)',
    geom(C).width === '100%' && geom(C).height === '100%' && fc.is_full(), JSON.stringify(geom(C)));
fc.exit();
await window.$(C).close();
await until(() => ! C.isConnected);

push('no uncaught page errors', uncaught.length === 0, uncaught.slice(0, 2).join(' | '));

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

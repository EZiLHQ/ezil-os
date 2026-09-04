# Example: a minimal shell-local app ("Hello")

This is a worked example for [`../CONTRIBUTING-APPS.md`](../CONTRIBUTING-APPS.md).
It is deliberately **not** a `.js` file in this repository: it ships no
feature and is not part of the build, so it cannot go stale against
`shell/build-shell.sh --check` the way a real, unregistered source file
under `shell/` could.

Every helper name below exists in `shell/ezil/apps/registry.js` at the line
cited in its comment — nothing here is invented. To make this real, copy the
`AppDescriptor` at the bottom into `registry.js`'s `APPS` array
(`registry.js:286-409`) and move the icon/`open()` above it into that file
too (the real apps keep everything for one app together in `registry.js` —
see `preview.js`/`code.js` for the pattern of a bigger `open()` living in
its own file with just the descriptor in `registry.js`).

```js
// hello-app.js — a minimal shell-local EZiL-OS app, worked example only.
// Not built, not tested by CI, not part of the bundle — see this file's own
// markdown wrapper for why.

// Same relative path `preview.js`/`code.js`/`desktop-window.js` use from
// shell/ezil/apps/*.js to shell/src/UI/UIWindow.js (the ported Puter window
// manager) — NOT the ../../../ Settings uses, because Settings lives one
// directory deeper, at shell/ezil/ui/Settings/index.js.
import UIWindow from '../../src/UI/UIWindow.js';

// The exact shape registry.js's own appIcon() builds
// (registry.js:180-193) — inlined here because appIcon() itself has no
// `export`. A real entry does not duplicate this function: it adds one more
// call beside DESKTOP_ICON/SETTINGS_ICON/PREVIEW_ICON/CODE_ICON
// (registry.js:203-259), inside registry.js itself.
const GLYPH = '#f5f5f4'; // registry.js's own brand off-white, registry.js:159-161
function appIcon (id, from, to, glyph) {
    return 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
        + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`
        + '</linearGradient></defs>'
        + `<rect width="48" height="48" rx="11.5" fill="url(#${id})"/>`
        + '<rect x="0.75" y="0.75" width="46.5" height="46.5" rx="10.75" fill="none"'
        + ' stroke="rgba(255,255,255,0.22)" stroke-width="1.5"/>'
        + glyph
        + '</svg>',
    );
}

// A waving hand, drawn as two simple strokes — swap for whatever glyph fits.
const HELLO_ICON = appIcon('ezg-hello', '#4f9a52', '#245a27',
    `<g fill="none" stroke="${GLYPH}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M14 34V14M34 34V14M14 24h20"/>'
    + '</g>');

/**
 * Open the Hello window.
 *
 * This example declares `owns_boot_trace: true` and calls `ctx.trace.end`
 * itself, on purpose, even though a plain "Hello" paints synchronously and
 * could just as well leave `owns_boot_trace` unset (the way the real
 * `settings` entry does — see `../CONTRIBUTING-APPS.md`'s "boot-trace
 * contract" section for that shape and why it needs no `ctx.trace.end`
 * call at all). This shape is shown instead because it is what a REAL
 * follow-on app — a document viewer awaiting a dropped file, say — actually
 * needs: a real gap between the window existing and its content being
 * ready. Copy the `owns_boot_trace: false`-by-omission shape from
 * `settings` if your window has no such gap; copy this shape if it does.
 *
 * @param {object} ctx `registry.launch('hello', ctx)`'s own argument, plus
 *   `icon`, `appName`, and `trace: {step, end}` the launcher adds
 *   (`registry.js:669`).
 * @returns {Promise<HTMLElement|null>}
 */
export async function openHelloWindow (ctx = {}) {
    const el_window = await UIWindow({
        title: 'Hello',
        app: 'hello',
        icon: ctx.icon,
        body_content: '<div style="padding:24px;font:14px system-ui">Hello, EZiL-OS.</div>',
        width: 360,
        height: 200,
        is_resizable: true,
        has_head: true,
        single_instance: true,
        show_in_taskbar: true,
    });

    if (!el_window) {
        // Nothing opened, so nothing async was started either. `launch()`
        // already treats a null return from an owns_boot_trace app as
        // 'skipped' on its own (registry.js's launch(), the
        // `!(app.owns_boot_trace && el_window)` branch) — do NOT call
        // ctx.trace.end yourself in this branch, or you would race it.
        return null;
    }

    // The window is painted — this IS this app's terminal state, so end the
    // trace now, with one of the three real outcomes. Never 'ready': the
    // three legal values are 'ok' | 'error' | 'skipped'
    // (shell/ezil/trace.js's own end()), and anything else is silently
    // turned into 'error' — reporting this successful paint as a boot
    // failure. See ../CONTRIBUTING-APPS.md's "boot-trace contract" section
    // for the measured bug this exact mistake would reproduce.
    ctx.trace?.step?.('rendered');
    ctx.trace?.end?.('ok');

    return el_window;
}

/**
 * The AppDescriptor. Add one entry shaped like this to registry.js's APPS
 * array (registry.js:286-409) to register the app for real.
 *
 * `shell_local: true` because this window has nothing a server could fail
 * to provision (registry.js:28-32, "there is nothing the host could fail to
 * provision") — no matching entry in
 * `app/src/server/shell/boot-payload.ts`'s `SHELL_APPS` is needed.
 */
export const helloAppDescriptor = {
    id: 'hello',
    name: 'Hello',
    icon: HELLO_ICON,
    pinned: false,
    single_instance: true,
    shell_local: true,
    owns_boot_trace: true,
    open: openHelloWindow,
};
```

## Test skeleton

A real PR registering this app adds `shell/ezil/apps/hello-test.mjs`, built
against the **committed bundle**, the same way
`shell/ezil/apps/registry-trace-test.mjs` is. This is a skeleton — it omits
the `window.fetch` stub that captures outgoing telemetry batches, which the
real file needs in full (copy it from `registry-trace-test.mjs`, the
`sent`/`window.fetch = async (...)` setup near its top) — and it must also be
added to `.github/workflows/ci.yml`'s test-file list and to
`shell/run-tests.sh`'s `run_suite` list, per
[`../CONTRIBUTING-APPS.md`](../CONTRIBUTING-APPS.md)'s "Tests to add" section,
or it will never actually run:

```js
// hello-test.mjs — skeleton. See registry-trace-test.mjs for the full,
// working pattern this mirrors (the window.fetch stub in particular).
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../app/public/os');

for (const f of ['icons.js', 'bundle.min.js', 'bundle.min.css']) {
    if (!fs.existsSync(path.join(OS, f))) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
if (!window.crypto?.getRandomValues) {
    window.crypto = {
        getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; },
    };
}

// TODO (real file): stub window.fetch here to capture telemetry batches into
// a `sent` array, exactly as registry-trace-test.mjs does, before eval'ing
// the bundle below — telemetry.js reads window.fetch at call time, not at
// import time, so the stub just needs to be in place before boot() runs.

window.eval(fs.readFileSync(`${OS}/icons.js`, 'utf8'));
window.eval(fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
const ezil = window.ezil;

// Real `apps` list — NOT an absent one. resolve() with no `apps` array
// returns every known app unfiltered (registry.js:492-496), which would
// prove nothing about the shell_local exception this app actually relies
// on. Naming only 'desktop' here means 'hello' resolves ONLY because it is
// shell_local — the thing this test exists to prove.
window.__EZIL_BOOT__ = {
    user: { id: 'u-hello-test' },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { endpoints: { telemetry: 'https://telemetry.invalid/api/shell/telemetry' } },
};
ezil.boot();

const ctx = {
    payload: window.__EZIL_BOOT__,
    computer: {
        id: 'c-1', name: 'My computer', slot: 1,
        createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false,
    },
    desktopState: {},
};

const tick = (ms = 0) => new Promise((r) => window.setTimeout(r, ms));
const settle = async (n = 8, ms = 20) => { for (let i = 0; i < n; i++) await tick(ms); };
function forceFlush () { window.dispatchEvent(new window.Event('pagehide')); }

await ezil.registry.launch('hello', ctx);
await settle();
forceFlush();
await settle(4);

// TODO (real file): read `sent` (populated by the fetch stub above),
// flatMap its `.events`, filter eventClass === 'boot_summary' && site ===
// 'ezil-os:trace#hello', and assert the result has length exactly 1 — the
// one contract this whole guide is about: one boot_summary per app-open.
console.log('SKELETON — see registry-trace-test.mjs for the full assertion this needs');
process.exit(2);
```

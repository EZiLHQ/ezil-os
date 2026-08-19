// settings-test.mjs — EZiL-authored. End-to-end harness for the Settings window.
//
// Run:  node shell/ezil/ui/Settings/settings-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not the source)
//
// ── Why this exists, in the project's own words ─────────────────────────────
// This repository's documented, repeated failure mode is not wrong code — it
// is right code with wrong COVERAGE. Three verification rounds in a row
// declared success and were wrong: the harness omitted React; then an
// untested entry path; then a soft navigation. Every time the diff was
// correct and the test did not exercise the thing that broke.
//
// So this file does not check that the Settings module exports the right
// symbols. It loads the SHIPPED bundle into a DOM, boots it, and drives the
// window the way a person does — click a tab, click Delete, close the window
// and open it again — asserting the four things that, if they silently
// stopped being true, would leave a user with two broken computers and no way
// to delete either:
//
//   1. `resolve()` actually RETURNS Settings for a realistic boot payload.
//      The round-1 implementation was complete, built cleanly and passed the
//      shell's own smoke test while being filtered out of every real boot,
//      because `SHELL_APPS` (server-side) lists only `desktop`. Nothing
//      caught it. This check is that hole, closed.
//   2. The full-bleed desktop window's control drawer carries a Settings
//      button, positioned before Close and INSIDE the tray's clip — the only
//      way back once `enter_fullpage_mode` has hidden the taskbar.
//   3. Delete closes the desktop window BEFORE `computer.delete` is sent.
//      Asserted on ORDER, observed at the moment the request goes out, not on
//      the end state — the end state looks identical either way, and the
//      difference is whether the user watches their OS die mid-frame.
//   4. Closing Settings and reopening it leaves every button working.
//
// jsdom is not a browser: no layout, no real network, no cross-origin frames.
// This proves construction, wiring and ORDERING. It cannot prove anything
// about pixels — see the report for what still needs a real browser.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../../app/public/os');

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
     <body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(`window error: ${e.message}`));
window.onerror = (m) => uncaught.push(`onerror: ${m}`);
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = {
        getRandomValues: (a) => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; },
    };
}

// ── the stubbed server ──────────────────────────────────────────────────────
// Records every request in order, so the DELETE ORDERING check has something
// to compare the DOM against at the exact moment the request leaves.
const calls = [];
let listRows = [];
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const rec = { url: u, method: opts.method ?? 'GET', at: calls.length, domAtCall: {} };
    // Snapshot the DOM AS THE REQUEST GOES OUT. This is the whole delete-order
    // assertion: after the fact, both orderings look the same.
    rec.domAtCall.desktopWindows = window.document.querySelectorAll('.window[data-app="desktop"]').length;
    // 🔴 Same snapshot for Preview/Code — the app-name-selector defect
    // (`DESKTOP_SELECTOR`-only closing) is invisible to a check that only
    // ever counts `data-app="desktop"`. Section 5d below is the regression:
    // it fails if a future edit reintroduces an app-name-keyed selector for
    // the delete/switch close, because these three counts would stop
    // dropping to zero together.
    rec.domAtCall.previewWindows = window.document.querySelectorAll('.window[data-app="preview"]').length;
    rec.domAtCall.codeWindows = window.document.querySelectorAll('.window[data-app="code"]').length;
    calls.push(rec);

    const json = (body, status = 200) => ({
        ok: status < 400, status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });

    if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: listRows } } });
    if ( u.includes('/api/trpc/computer.delete') ) {
        const id = JSON.parse(opts.body ?? '{}').json?.id;
        listRows = listRows.filter(c => c.id !== id);
        return json({ result: { data: { json: { id } } } });
    }
    if ( u.includes('/api/trpc/computer.create') ) {
        const row = { id: 'c-new', name: 'New computer', slot: 2, createdAt: new Date().toISOString(), lastOpenedAt: null };
        listRows = [...listRows, row];
        return json({ result: { data: { json: row } } });
    }
    if ( u.includes('/api/trpc/computer.rename') ) {
        const { id, name } = JSON.parse(opts.body ?? '{}').json ?? {};
        listRows = listRows.map(c => (c.id === id ? { ...c, name } : c));
        return json({ result: { data: { json: { id, name } } } });
    }
    // Anything else (the desktop boot poll) fails cleanly — the window still
    // opens and still attaches its drawer, which is what check 2 needs.
    return json({ error: { json: { message: 'stub', data: { code: 'INTERNAL_SERVER_ERROR' } } } }, 500);
};

function evalOrDie (label, code) {
    try {
        window.eval(code);
    } catch ( e ) {
        console.error(`${label} threw: ${e?.stack ?? e}`);
        process.exit(1);
    }
}
evalOrDie('icons.js', fs.readFileSync(`${OS}/icons.js`, 'utf8'));
evalOrDie('bundle.min.js', fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));

const ezil = window.ezil;
push('bundle exposes window.ezil', typeof ezil === 'object');
ezil.boot();

const $ = window.$;
const doc = window.document;
const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
/** Give the window's own promise chains room to settle. */
const settle = async (n = 12, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
const q = (sel) => doc.querySelector(sel);
const qa = (sel) => Array.from(doc.querySelectorAll(sel));
const click = (el) => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

// ═══════════════════════════════════════════════════════════════════════════
// 1. REACHABILITY — resolve() must return Settings for a REAL boot payload.
// ═══════════════════════════════════════════════════════════════════════════
// This payload is copied from `SHELL_APPS` in
// `app/src/server/shell/boot-payload.ts` verbatim: an explicit, one-element,
// non-empty array. That is the exact input that silently deleted Settings
// from every boot in round 1.
const REAL_PAYLOAD = {
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    computer: { id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    desktopState: {},
};
const resolved = ezil.registry.resolve(REAL_PAYLOAD);
const resolvedIds = resolved.map(a => a.id);
push('resolve() keeps Settings when the server lists only "desktop"',
    resolvedIds.includes('settings'), JSON.stringify(resolvedIds));
push('resolve() still opens the desktop first (boot.js uses apps[0])',
    resolvedIds[0] === 'desktop', resolvedIds[0]);
push('resolve() keeps Preview registered', resolvedIds.includes('preview'));
push('resolve() still hides a HOSTED app the server did not list',
    ezil.registry.resolve({ apps: [] }).map(a => a.id).includes('desktop') === false,
    JSON.stringify(ezil.registry.resolve({ apps: [] }).map(a => a.id)));
push('Settings is pinned to the taskbar',
    resolved.find(a => a.id === 'settings')?.pinned === true);

const ctx = { payload: REAL_PAYLOAD, computer: REAL_PAYLOAD.computer, desktopState: {} };

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE DRAWER BUTTON — the only way back once the taskbar is hidden.
// ═══════════════════════════════════════════════════════════════════════════
await ezil.registry.launch('desktop', ctx);
await settle(4);

const drawer = q('.window[data-app="desktop"] .dashboard-app-drawer');
push('desktop window opened with a control drawer', !! drawer);
const settingsBtn = drawer?.querySelector('.dashboard-app-drawer-settings');
push('🔴 control drawer carries a Settings button', !! settingsBtn);
push('drawer Settings button is labelled for assistive tech',
    settingsBtn?.getAttribute('aria-label') === 'Settings' && settingsBtn?.title === 'Settings');

const btns = Array.from(drawer?.querySelectorAll('.dashboard-app-drawer-btn') ?? []);
const iSettings = btns.findIndex(b => b.classList.contains('dashboard-app-drawer-settings'));
const iClose = btns.findIndex(b => b.classList.contains('dashboard-app-drawer-close'));
push('Settings button sits BEFORE Close, as the actions contract says',
    iSettings >= 0 && iClose >= 0 && iSettings < iClose, `settings@${iSettings} close@${iClose}`);
push('🔴 tray is widened for a third button (or it lands outside overflow:hidden)',
    drawer?.classList.contains('ezil-has-settings-action'));

// Idempotence: relaunching (the "already open, just refocus" path) must not
// add a second button.
await ezil.registry.launch('desktop', ctx);
await settle(2);
push('re-launching the desktop does not duplicate the button',
    (q('.window[data-app="desktop"]')?.querySelectorAll('.dashboard-app-drawer-settings').length ?? 0) === 1);

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE WINDOW ITSELF — opened by the drawer button, as a trapped user would.
// ═══════════════════════════════════════════════════════════════════════════
listRows = [{ id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null }];
click(settingsBtn);
await settle();

const win = q('.window[data-app="settings"]');
push('🔴 clicking the drawer button opens Settings', !! win);
push('Settings window keeps its own head (not full-page chrome)',
    !! win?.querySelector('.window-head'));
push('exactly one Settings window (single_instance)',
    qa('.window[data-app="settings"]').length === 1);

const tabIds = qa('.window[data-app="settings"] .ezil-settings-tab').map(t => t.getAttribute('data-tab'));
push('four tabs, and only four', tabIds.length === 4, JSON.stringify(tabIds));
push('tabs are Computers / Appearance / About / Troubleshoot',
    JSON.stringify(tabIds) === JSON.stringify(['computers', 'appearance', 'about', 'troubleshoot']));
push('no upstream Dashboard tab survived',
    ! tabIds.some(id => ['home', 'apps', 'files', 'usage', 'account', 'security'].includes(id)));

// ── Computers tab ──────────────────────────────────────────────────────────
const rows = qa('.window[data-app="settings"] .ezil-settings-row');
push('two slot rows, always — the cap is structural', rows.length === 2, `${rows.length} rows`);
push('slot 1 shows the computer', rows[0]?.textContent.includes('My computer'));
push('slot 2 is an empty slot offering New', rows[1]?.classList.contains('ezil-settings-row-empty')
    && !! rows[1]?.querySelector('[data-action="create"]'));
push('the active computer is marked, not offered a Switch button',
    rows[0]?.classList.contains('active') && ! rows[0]?.querySelector('[data-action="switch"]'));
push('Rename and Delete are present on the filled row',
    !! rows[0]?.querySelector('[data-action="rename"]') && !! rows[0]?.querySelector('[data-action="delete"]'));

// Rename round-trip.
click(rows[0]?.querySelector('[data-action="rename"]'));
await settle(4);
const input = q('.window[data-app="settings"] [data-role="rename-input"]');
push('Rename opens an inline input pre-filled with the name', input?.value === 'My computer');
if ( input ) {
    input.value = 'Renamed box';
    input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
await settle();
push('Rename persists and re-renders',
    q('.window[data-app="settings"] .ezil-settings-row')?.textContent.includes('Renamed box'),
    listRows[0]?.name);

// New computer -> the second slot fills.
click(qa('.window[data-app="settings"] [data-action="create"]')[0]);
await settle();
push('New computer fills the second slot',
    qa('.window[data-app="settings"] .ezil-settings-row-empty').length === 0
    && listRows.length === 2, `${listRows.length} rows server-side`);

// ── Appearance tab ─────────────────────────────────────────────────────────
click(qa('.window[data-app="settings"] .ezil-settings-tab')[1]);
await settle(4);
push('Appearance pane becomes active',
    q('.window[data-app="settings"] .ezil-settings-pane[data-pane="appearance"]')?.classList.contains('active'));
push('Computers pane deactivates',
    ! q('.window[data-app="settings"] .ezil-settings-pane[data-pane="computers"]')?.classList.contains('active'));
const swatches = qa('.window[data-app="settings"] .ezil-settings-swatch');
push('wallpaper + accent swatches rendered', swatches.length >= 8, `${swatches.length} swatches`);
const wallpaperSwatch = qa('.window[data-app="settings"] [data-wallpaper]')[2];
click(wallpaperSwatch);
await settle(4);
push('picking a wallpaper applies it to the desktop root',
    (q('.desktop')?.style.background ?? '') !== '', q('.desktop')?.style.background?.slice(0, 40));
push('picking a wallpaper persists to localStorage (no server call)',
    JSON.stringify(window.localStorage).includes(wallpaperSwatch?.getAttribute('data-wallpaper')));
const accentSwatch = qa('.window[data-app="settings"] [data-accent]')[1];
click(accentSwatch);
await settle(4);
push('picking an accent writes the theme tokens',
    doc.documentElement.style.getPropertyValue('--select-hue') !== '',
    doc.documentElement.style.getPropertyValue('--select-hue'));

// ── About tab (AGPL §13) ───────────────────────────────────────────────────
click(qa('.window[data-app="settings"] .ezil-settings-tab')[2]);
await settle(4);
const about = q('.window[data-app="settings"] .ezil-settings-pane[data-pane="about"]');
push('About pane becomes active', about?.classList.contains('active'));
const aboutText = about?.textContent ?? '';
push('🔴 About names the licence (AGPL §13)',
    /Affero General\s+Public License/i.test(aboutText) && /AGPL-3\.0/.test(aboutText));
push('🔴 About states the network-use source entitlement (the §13 obligation)',
    /over a\s+network/i.test(aboutText) && /source code/i.test(aboutText));
push('🔴 About offers a way to actually GET the source',
    !! about?.querySelector('a[href^="mailto:"]'));
push('About links the upstream project',
    !! about?.querySelector('a[href*="github.com/HeyPuter/puter"]'));
push('About carries the required Puter trademark sentence',
    /not endorsed by Puter Technologies Inc/.test(aboutText));
push('About shows a version', /Shell version\s*\S/.test(aboutText));

// ── Troubleshoot tab (restart) ───────────────────────────────────────────────
// `window.__EZIL_BOOT__` is never set anywhere above this point in this file
// (`ezil.boot()` ran with none at line ~135; every window since was opened by
// calling `registry.launch(id, ctx)` directly with an explicit `ctx`, which is
// NOT the same thing `session.payload()` reads). So `session.restartEndpoint()`
// is null here for the same reason `desktop-window.js`'s own `focus_endpoint`
// would be: no boot payload published a `restart` key, because none exists yet.
// This is the exact "route not shipped" case the tab must degrade through
// honestly, not a test artefact.
click(qa('.window[data-app="settings"] .ezil-settings-tab')[3]);
await settle(4);
const troubleshoot = q('.window[data-app="settings"] .ezil-settings-pane[data-pane="troubleshoot"]');
push('Troubleshoot pane becomes active', troubleshoot?.classList.contains('active'));
let restartBtn = troubleshoot?.querySelector('[data-action="restart"]');
push('🔴 restart is DISABLED when the server has not published the route',
    !! restartBtn?.disabled, `disabled=${restartBtn?.disabled}`);
push('🔴 …and says so honestly, rather than staying silent or guessing a URL',
    /available in this deployment/i.test(troubleshoot?.textContent ?? ''));
push('the tab explains the workspace is not touched',
    /files.*(?:not|are not|aren.t) touched|storage.*not touched/i.test(troubleshoot?.textContent ?? ''));

// Now the OTHER direction: a deployment that HAS published the route. Setting
// `window.__EZIL_BOOT__` is exactly what a real page does before this bundle's
// first line runs; here it is done mid-run to prove the tab reads it LIVE
// (every render, not a value snapshotted at window-open) — the same shape of
// proof `preview-focus-test.mjs` uses for `endpoints.focus`.
window.__EZIL_BOOT__ = { user: { id: 'u-test' }, desktopState: { endpoints: { restart: '/api/shell/restart' } } };
click(qa('.window[data-app="settings"] .ezil-settings-tab')[2]); // away…
await settle(2);
click(qa('.window[data-app="settings"] .ezil-settings-tab')[3]); // …and back, re-triggering onActivate
await settle(4);
restartBtn = q('.window[data-app="settings"] .ezil-settings-pane[data-pane="troubleshoot"] [data-action="restart"]');
push('🔴 …and flips to ENABLED the moment the route is published — no code change, live feature-detection',
    restartBtn && ! restartBtn.disabled, `disabled=${restartBtn?.disabled}`);

// Click it: confirm, then a stubbed 500 (this harness's `fetch` stub has no
// `/api/shell/restart` case, so it falls through to the generic 500 at the
// bottom of the stub) must render as `failed`, never as a claimed success.
click(restartBtn);
await settle(2);
const restartConfirmBtn = Array.from(doc.querySelectorAll('button')).find(b => b.textContent.trim() === 'Restart');
push('restarting asks for confirmation first', !! restartConfirmBtn);
click(restartConfirmBtn);
await settle(6);
push('🔴 a failed restart is reported as failed, never as a claimed success',
    /something went wrong|couldn.t reach|expired|too long/i.test(
        q('.window[data-app="settings"] .ezil-settings-pane[data-pane="troubleshoot"]')?.textContent ?? '',
    ));
// ── Troubleshoot tab (diagnostic log) ────────────────────────────────────────
// `shell/ezil/log.js` has kept a 200-entry ring of every debug/info/warn/error
// call since it was written, explicitly so a support conversation would not
// depend on the user having had devtools open — and its own header said
// "nothing yet reads" it. These checks are the reader, and the thing they
// actually have to prove is not that a button exists: it is that what the
// button hands the user has been through the redactor, because the ring holds
// RAW console arguments and this is an export path.
//
// The probe is a real code path, not a stub: `registry.launch()` on an unknown
// id writes the id verbatim into the log ring (`no such app: <id>`) AND raises
// a `contract_violation` capture carrying it as `detail`. Handing it a URL
// with a query token therefore seeds BOTH halves of the report with something
// that must not survive.
const LEAKY_ID = 'https://evil.example/steal?tok=SECRET123';
push('probe: launching an unknown app id returns null (the seeding path is real)',
    (await ezil.registry.launch(LEAKY_ID)) === null);
await settle(2);

// Re-render the pane so the counts and the button's enabled state are current.
click(qa('.window[data-app="settings"] .ezil-settings-tab')[2]);
await settle(2);
click(qa('.window[data-app="settings"] .ezil-settings-tab')[3]);
await settle(4);

const ts = () => q('.window[data-app="settings"] .ezil-settings-pane[data-pane="troubleshoot"]');
const copyBtn = ts()?.querySelector('[data-action="copy-diagnostics"]');
push('🔴 Troubleshoot offers a way OUT of the log ring buffer at all',
    !! copyBtn, `button=${!! copyBtn}`);
push('…and it is enabled once anything has been recorded',
    copyBtn && ! copyBtn.disabled, `disabled=${copyBtn?.disabled}`);
push('the pane tells the user what the log does and does not carry',
    /replaced before it is copied|not carry your files/i.test(ts()?.textContent ?? ''));

// jsdom has neither `navigator.clipboard` nor `document.execCommand`, which is
// the same state a real browser presents on a non-secure origin or a denied
// permission. The tab must then say so and show the text, NOT claim "Copied".
click(copyBtn);
await settle(6);
const area = ts()?.querySelector('[data-role="diagnostic-text"]');
push('🔴 a clipboard write the page could not make is reported honestly, not as success',
    !! area && ! /^\s*Copied\./m.test(ts()?.textContent ?? ''), `textarea=${!! area}`);
const report = area?.value ?? '';
push('the report has both halves — the console ring AND the recorded events',
    /-- console \(\d+\) --/.test(report) && /-- events \(\d+\) --/.test(report), report.slice(0, 80));
push('the console ring actually reached it (the probe line is there)',
    /no such app/.test(report));
push('the recorded events actually reached it (the probe capture is there)',
    /contract_violation .*ezil-os:apps\/registry#launch .*unknown_app/.test(report));
push('the earlier failed restart is in it too — the api_failure this pane itself raised',
    /api_failure .*ezil-os:settings\/troubleshoot#restart/.test(report));
push('🔴 THE GUARANTEE: neither the URL nor its query token survived into the copied text',
    ! report.includes('evil.example') && ! report.includes('SECRET123'),
    report.includes('evil.example') ? 'LEAKED host' : (report.includes('SECRET123') ? 'LEAKED token' : 'clean'));
push('…and the redaction placeholder is what took its place, so the line is still readable',
    /<url>|<opaque>/.test(report));

delete window.__EZIL_BOOT__;

// ═══════════════════════════════════════════════════════════════════════════
// 4. CLOSE AND REOPEN — the second-open regression (dead buttons).
// ═══════════════════════════════════════════════════════════════════════════
$('.window[data-app="settings"]').close();
await settle();
push('Settings closes', ! q('.window[data-app="settings"]'));

await ezil.registry.launch('settings', ctx);
await settle();
const win2 = q('.window[data-app="settings"]');
push('Settings reopens', !! win2);
push('reopened Settings still renders two slot rows',
    qa('.window[data-app="settings"] .ezil-settings-row').length === 2);
push('reopened Settings does not carry stale edit state',
    ! q('.window[data-app="settings"] [data-role="rename-input"]'));

const callsBeforeRebind = calls.length;
const rowsAfterReopen = qa('.window[data-app="settings"] .ezil-settings-row');
click(rowsAfterReopen[0]?.querySelector('[data-action="rename"]'));
await settle(4);
push('🔴 buttons still work on the SECOND open (delegated handlers rebound)',
    !! q('.window[data-app="settings"] [data-role="rename-input"]'));
click(q('.window[data-app="settings"] [data-action="cancel-rename"]'));
await settle(4);
push('Cancel leaves the row readable again',
    ! q('.window[data-app="settings"] [data-role="rename-input"]')
    && qa('.window[data-app="settings"] .ezil-settings-row').length === 2,
    `${calls.length - callsBeforeRebind} extra server calls`);

// ═══════════════════════════════════════════════════════════════════════════
// 5. 🔴 DELETE CLOSES THE CONTAINER WINDOWS FIRST.
// ═══════════════════════════════════════════════════════════════════════════
// The desktop window opened in section 2 is still streaming computer c-1.
push('a desktop window is open before the delete', qa('.window[data-app="desktop"]').length === 1);

const deleteRow = qa('.window[data-app="settings"] .ezil-settings-row')
    .find(r => r.getAttribute('data-id') === 'c-1');
click(deleteRow?.querySelector('[data-action="delete"]'));
await settle(6);

// The confirmation must be a real dialog, not a silent delete.
const alertEl = q('.window-alert-message') ?? q('.window[data-is-alert] .window-body') ?? q('.window-alert');
push('🔴 Delete asks for confirmation first', !! alertEl);
const alertText = (q('.window-alert-message')?.textContent ?? doc.body.textContent) || '';
push('confirmation uses the shared delete-copy (names the computer)',
    alertText.includes('Renamed box'), alertText.slice(0, 90).replace(/\s+/g, ' '));

const deleteCallsBefore = calls.filter(c => c.url.includes('computer.delete')).length;
push('nothing was deleted before the user confirmed', deleteCallsBefore === 0);

// Confirm.
const confirmBtn = qa('.window .button, .window button').find(b => /delete/i.test(b.textContent ?? '')
    && b.closest('.window')?.querySelector('.window-alert-message'));
push('the confirm button is present', !! confirmBtn, confirmBtn?.textContent?.trim());
click(confirmBtn);
await settle(30, 40);

const deleteCall = calls.find(c => c.url.includes('computer.delete'));
push('computer.delete was sent after confirming', !! deleteCall);
push('🔴 THE GUARANTEE: no desktop window was still mounted when computer.delete went out',
    deleteCall?.domAtCall.desktopWindows === 0,
    `${deleteCall?.domAtCall.desktopWindows} desktop window(s) at request time`);
push('🔴 the desktop window is gone from the document', qa('.window[data-app="desktop"]').length === 0);
push('the deleted computer is gone and its slot is free again',
    qa('.window[data-app="settings"] .ezil-settings-row-empty').length === 1
    && ! qa('.window[data-app="settings"] .ezil-settings-row').some(r => r.getAttribute('data-id') === 'c-1'));

// ═══════════════════════════════════════════════════════════════════════════
// 5b. …BUT IT MUST NOT CLOSE A DESKTOP IT DID NOT HAVE TO.
// ═══════════════════════════════════════════════════════════════════════════
// Without this, "always close everything" would pass section 5 — and would be
// a different bug: deleting the computer you are not using would kill the one
// you are. The rule is "close unless positively known to be someone else's".
async function reopenSettings () {
    if ( q('.window[data-app="settings"]') ) { $('.window[data-app="settings"]').close(); await settle(6); }
    await ezil.registry.launch('settings', ctx);
    await settle(8);
}
async function confirmTheDialog () {
    const b = qa('.window .button, .window button').find(x => /delete/i.test(x.textContent ?? '')
        && x.closest('.window')?.querySelector('.window-alert-message'));
    click(b);
    await settle(30, 40);
    return !! b;
}

const A = { id: 'c-a', name: 'Alpha', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null };
const B = { id: 'c-b', name: 'Beta', slot: 2, createdAt: new Date().toISOString(), lastOpenedAt: null };
listRows = [A, B];
await ezil.registry.launch('desktop', { ...ctx, computer: A });
await settle(6);
push('a desktop streaming c-a is open', q(`.window[data-app="desktop"][data-ezil-computer-id="c-a"]`) !== null);

await reopenSettings();
const rowB = qa('.window[data-app="settings"] .ezil-settings-row').find(r => r.getAttribute('data-id') === 'c-b');
push('Alpha is shown as the current desktop, Beta is not',
    qa('.window[data-app="settings"] .ezil-settings-row')
        .find(r => r.getAttribute('data-id') === 'c-a')?.classList.contains('active') === true
    && rowB?.classList.contains('active') === false);
click(rowB?.querySelector('[data-action="delete"]'));
await settle(6);
await confirmTheDialog();
const delB = calls.filter(c => c.url.includes('computer.delete')).pop();
push('deleting the OTHER computer still deletes it', delB?.url.includes('computer.delete') && listRows.length === 1);
push('🔴 …and does NOT close the unrelated desktop window',
    delB?.domAtCall.desktopWindows === 1 && qa('.window[data-app="desktop"]').length === 1,
    `${delB?.domAtCall.desktopWindows} at request time, ${qa('.window[data-app="desktop"]').length} now`);

// ═══════════════════════════════════════════════════════════════════════════
// 5c. UNKNOWN OWNERSHIP MUST FAIL SAFE — the exact round-1 failure mode.
// ═══════════════════════════════════════════════════════════════════════════
// Strip the stamp to simulate a desktop window whose computer cannot be
// determined (a rehydrate boot with no inlined payload, a window opened
// outside `launch`). The old code read a module variable, found it empty, and
// skipped the close entirely. The new rule must close anyway.
q('.window[data-app="desktop"]')?.removeAttribute('data-ezil-computer-id');
push('the open desktop no longer says whose it is',
    ! q('.window[data-app="desktop"]')?.hasAttribute('data-ezil-computer-id'));

await reopenSettings();
const rowA = qa('.window[data-app="settings"] .ezil-settings-row').find(r => r.getAttribute('data-id') === 'c-a');
click(rowA?.querySelector('[data-action="delete"]'));
await settle(6);
await confirmTheDialog();
const delA = calls.filter(c => c.url.includes('computer.delete')).pop();
push('🔴 an un-attributable desktop is closed BEFORE delete (fails safe)',
    delA?.domAtCall.desktopWindows === 0 && qa('.window[data-app="desktop"]').length === 0,
    `${delA?.domAtCall.desktopWindows} at request time`);

// ═══════════════════════════════════════════════════════════════════════════
// 5d. 🔴 THE REGRESSION: DELETE MUST CLOSE PREVIEW AND CODE TOO, NOT JUST
//     THE DESKTOP. This is the exact defect `DESKTOP_SELECTOR`-only closing
//     shipped: Preview/Code are container windows on the same sandbox as the
//     desktop, but a different `data-app`, so an app-name-keyed selector
//     misses them by construction. If `closeSandboxWindows()` in
//     `tabs/computers.js` ever regresses to matching on `data-app` again,
//     THIS is the check that catches it — desktopWindows would still drop to
//     0 while previewWindows/codeWindows do not.
// ═══════════════════════════════════════════════════════════════════════════
const C = { id: 'c-c', name: 'Gamma', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null };
listRows = [C];
await ezil.registry.launch('desktop', { ...ctx, computer: C });
await settle(6);
await ezil.registry.launch('preview', { ...ctx, computer: C });
await settle(6);
await ezil.registry.launch('code', { ...ctx, computer: C });
await settle(6);

push('desktop + preview + code are all open, all stamped for c-c',
    q('.window[data-app="desktop"][data-ezil-computer-id="c-c"]') !== null
    && q('.window[data-app="preview"][data-ezil-computer-id="c-c"]') !== null
    && q('.window[data-app="code"][data-ezil-computer-id="c-c"]') !== null);

await reopenSettings();
const rowC = qa('.window[data-app="settings"] .ezil-settings-row').find(r => r.getAttribute('data-id') === 'c-c');
click(rowC?.querySelector('[data-action="delete"]'));
await settle(6);
await confirmTheDialog();
const delC = calls.filter(c => c.url.includes('computer.delete')).pop();
push('🔴 THE REGRESSION CHECK: desktop, preview AND code were all closed BEFORE computer.delete went out',
    delC?.domAtCall.desktopWindows === 0 && delC?.domAtCall.previewWindows === 0 && delC?.domAtCall.codeWindows === 0,
    `desktop=${delC?.domAtCall.desktopWindows} preview=${delC?.domAtCall.previewWindows} code=${delC?.domAtCall.codeWindows} at request time`);
push('all three are gone from the document afterwards',
    qa('.window[data-app="desktop"]').length === 0
    && qa('.window[data-app="preview"]').length === 0
    && qa('.window[data-app="code"]').length === 0);

// ═══════════════════════════════════════════════════════════════════════════
// 5e. 🔴 SWITCH MUST ALSO RE-TARGET PREVIEW AND CODE, NOT JUST THE DESKTOP.
//     Same defect, the other call site: switching computers left Preview/Code
//     streaming the OLD container because `switchTo()` only ever closed the
//     desktop window.
// ═══════════════════════════════════════════════════════════════════════════
const D = { id: 'c-d', name: 'Delta', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null };
const E = { id: 'c-e', name: 'Epsilon', slot: 2, createdAt: new Date().toISOString(), lastOpenedAt: null };
listRows = [D, E];
await ezil.registry.launch('desktop', { ...ctx, computer: D });
await settle(6);
await ezil.registry.launch('preview', { ...ctx, computer: D });
await settle(6);
await ezil.registry.launch('code', { ...ctx, computer: D });
await settle(6);
push('before switching: desktop + preview + code all stream c-d',
    q('.window[data-app="desktop"][data-ezil-computer-id="c-d"]') !== null
    && q('.window[data-app="preview"][data-ezil-computer-id="c-d"]') !== null
    && q('.window[data-app="code"][data-ezil-computer-id="c-d"]') !== null);

await reopenSettings();
const rowE = qa('.window[data-app="settings"] .ezil-settings-row').find(r => r.getAttribute('data-id') === 'c-e');
click(rowE?.querySelector('[data-action="switch"]'));
await settle(20, 40);

// `switchTo()` only relaunches the desktop for the new computer — it does
// not reopen Preview/Code for it — so the correct end state is that the OLD
// ones are gone entirely, not merely re-stamped.
push('🔴 switching away closes the OLD preview window (not left streaming c-d)',
    qa('.window[data-app="preview"]').length === 0,
    `${qa('.window[data-app="preview"]').length} preview window(s) remain`);
push('🔴 switching away closes the OLD code window (not left streaming c-d)',
    qa('.window[data-app="code"]').length === 0,
    `${qa('.window[data-app="code"]').length} code window(s) remain`);
push('the desktop now streams the NEW computer (c-e)',
    q('.window[data-app="desktop"][data-ezil-computer-id="c-e"]') !== null);

// ═══════════════════════════════════════════════════════════════════════════
// 6. LOCAL CODE ONLY.
// ═══════════════════════════════════════════════════════════════════════════
const offOrigin = calls.filter(c => /^https?:\/\//.test(c.url) && ! c.url.startsWith('https://ezil.local'));
push('🔴 every request this window made was same-origin', offOrigin.length === 0,
    JSON.stringify(offOrigin.map(c => c.url)));
push('no puter.* or socket.io traffic', ! calls.some(c => /puter\.com|socket\.io/.test(c.url)));
push('no uncaught page errors during the whole run', uncaught.length === 0,
    uncaught.slice(0, 2).join(' | '));

// ── report ──────────────────────────────────────────────────────────────────
let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

// registry-trace-test.mjs — EZiL-authored. End-to-end proof that
// `registry.js#launch()` produces exactly one `boot_summary` telemetry event
// per app-open, carrying an ordered phase string and a real correlation id —
// against the SHIPPED bundle in a DOM, not the source in isolation (see
// `settings-test.mjs`'s own header for why this project insists on that).
//
// Run:  node shell/ezil/apps/registry-trace-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not the source)

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = {
        getRandomValues: (a) => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; },
    };
}

// Every telemetry POST this run makes, in order, body already JSON-parsed.
const sent = [];
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if ( u.includes('telemetry') ) {
        try { sent.push(JSON.parse(opts.body)); } catch { /* ignore parse errors here */ }
    }
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
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
// `ezil.boot()` runs with NO `window.__EZIL_BOOT__` set — a deliberate no-op
// (same technique `settings-test.mjs` uses), so nothing auto-opens and
// telemetry is not yet armed while we set up the harness below.
ezil.boot();

const tick = (ms = 0) => new Promise((r) => window.setTimeout(r, ms));
const settle = async (n = 8, ms = 20) => { for ( let i = 0; i < n; i++ ) await tick(ms); };

/** Force telemetry.js's own batching timer to flush NOW, via the same
 * `pagehide` trigger `telemetry-test.mjs`'s black-hole test uses. */
function forceFlush () {
    window.dispatchEvent(new window.Event('pagehide'));
}

function bootSummaries () {
    return sent.flatMap((batch) => batch.events ?? []).filter((e) => e.eventClass === 'boot_summary');
}

// Arm telemetry NOW, mid-run — exactly how a real page's boot payload would
// already be present before this bundle's first line runs; done here so the
// harness controls exactly when it starts observing sends.
window.__EZIL_BOOT__ = {
    user: { id: 'u-trace-test' },
    desktopState: { endpoints: { telemetry: 'https://telemetry.invalid/api/shell/telemetry' } },
};

const ctx = {
    payload: window.__EZIL_BOOT__,
    computer: { id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    desktopState: {},
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. ONE app-open -> exactly ONE boot_summary, ordered phases, real correlation id.
// ═══════════════════════════════════════════════════════════════════════════
await ezil.registry.launch('settings', ctx);
await settle();
forceFlush();
await settle(4);

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
{
    const summaries = bootSummaries();
    push('🔴 exactly one boot_summary event was sent for one app-open', summaries.length === 1, `${summaries.length} sent`);
    const s = summaries[0];
    if ( s ) {
        push('boot_summary carries source: shell', s.source === 'shell');
        push('boot_summary carries a v4-uuid correlationId', typeof s.correlationId === 'string' && V4.test(s.correlationId), s.correlationId);
        push('boot_summary outcome is "ok" for a successful open', s.outcome === 'ok', s.outcome);
        push('boot_summary code is a valid [a-z0-9_]+ token', /^[a-z0-9_]+$/.test(s.code), s.code);
        push('boot_summary site names the app via ezil-os:trace#<id>', s.site === 'ezil-os:trace#settings', s.site);
        push('🔴 attrs.phases is a non-empty ORDERED "code:ms,code:ms" string', typeof s.attrs?.phases === 'string' && /^[a-z0-9_]+:\d+(,[a-z0-9_]+:\d+)*$/.test(s.attrs.phases), s.attrs?.phases);
        const codes = (s.attrs?.phases ?? '').split(',').map((p) => p.split(':')[0]);
        push('phases include launch_start then open_resolved, in that order', codes.indexOf('launch_start') === 0 && codes.includes('open_resolved') && codes.indexOf('launch_start') < codes.indexOf('open_resolved'), JSON.stringify(codes));
        push('attrs.total_ms is present and non-negative', typeof s.attrs?.total_ms === 'number' && s.attrs.total_ms >= 0, s.attrs?.total_ms);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. REOPENING an already-open window (refocus branch) must NOT mint a second
//    trace/boot_summary — it is the same window, nothing "opened" again.
// ═══════════════════════════════════════════════════════════════════════════
sent.length = 0;
await ezil.registry.launch('settings', ctx); // already open -> refocus branch
await settle();
forceFlush();
await settle(4);
push('reopening an already-open (single_instance) window sends NO additional boot_summary', bootSummaries().length === 0, `${bootSummaries().length} sent`);

// ═══════════════════════════════════════════════════════════════════════════
// 3. 🔴 boot_summary is EXEMPT from telemetry.js's MAX_PER_KEY=3 dedup.
//    Every open below shares the exact same (eventClass, site, code) key —
//    without the exemption in `telemetry.js`'s `capture()`, the 4th open's
//    boot_summary would be silently dropped. Closing and reopening 4 times
//    in one page life must still produce 4 boot_summary events.
// ═══════════════════════════════════════════════════════════════════════════
sent.length = 0;
for ( let i = 0; i < 4; i++ ) {
    window.$('.window[data-app="settings"]').close();
    await settle(2);
    await ezil.registry.launch('settings', ctx);
    await settle(2);
}
forceFlush();
await settle(4);
push('🔴 4 same-key app-opens in one page life still produce 4 boot_summary events (MAX_PER_KEY=3 exemption)', bootSummaries().length === 4, `${bootSummaries().length} sent`);

console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
// Force exit rather than let Node wait out any dangling timer a full window
// (Settings, unlike the black-hole harness in `telemetry-test.mjs`, may set
// one — a polling interval, a debounce) leaves running. The assertions above
// have already run; nothing after this line is being tested.
process.exit(checks.some((c) => ! c.pass) ? 1 : 0);

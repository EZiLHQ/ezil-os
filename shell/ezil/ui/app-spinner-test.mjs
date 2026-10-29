// app-spinner-test.mjs — EZiL-authored. Headless test of `./app-spinner.js`.
//
// Run: cd shell && node ezil/ui/app-spinner-test.mjs
//
// Round 5 (decision D5): when an app opens the user sees ONE calm surface —
// the app icon, an "Opening {App}" title, ONE bar, ONE status line (the
// loading-stage sentence `computer-progress.js` `progressView` produced) and a
// muted elapsed/expected line. Nothing else unless the server says something
// needs them. This file pins:
//
//   1. 🔴 THE STATIC GUARD. The component owns no timer: the caller's existing
//      250 ms paint and the shared observer drive every update. A component that
//      starts its own `setInterval` could advance a bar while nothing is asking.
//   2. The DOM: no step list, ticks, ring, <progress>, reassurance, bytes line,
//      "Estimated", guidance/next/updated line, and never a dev paragraph on the
//      visible surface (dev details live only in a closed, flagged <details>).
//   3. The bar binding: fill = max(previous, 0.88·(1 − e^(−2.2·t/T)), stage floor),
//      real transfer percent when measured, 100 only on the real ready signal,
//      MONOTONIC across a re-open, a null poll and a changed server timestamp,
//      with the elapsed clock anchored on this client's first sight of the open.
//   4. The states: opening, long (warn meta, no button), attention (needs_operator /
//      hold / ten-minute budget: one action by the existing predicate), failed, done.
//   5. Every L-A case: an active AWS timeout stays progress, 600 s shows Try again,
//      needs_operator shows Try again at once, no observation keeps the old failure.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });

// ── 1. THE STATIC GUARD ──────────────────────────────────────────────────
const source = fs.readFileSync(path.join(here, 'app-spinner.js'), 'utf8');
push('🔴 app-spinner.js contains no setTimeout', ! source.includes('setTimeout'));
push('🔴 app-spinner.js contains no setInterval', ! source.includes('setInterval'));
push('🔴 app-spinner.js does not import the retired phase panel', ! /from '\.\/boot-progress\.js'/.test(source));

// ── 2. Unobserved behaviour (Cloudflare / native / no computer) ───────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
const originalNow = Date.now;
let now = 0; Date.now = () => now;

const { AppSpinner, openingFill } = await import('./app-spinner.js');
const $ = (s, sel) => s.el.querySelector(sel);
const titleOf = s => $(s, '.ezil-app-spinner-label')?.textContent;
const statusOf = s => $(s, '.ezil-app-spinner-sub');
const barEl = s => $(s, '.ezil-opening-bar');
const barOf = s => Number(barEl(s)?.dataset.percent);
const metaOf = s => $(s, '.ezil-opening-meta');
const stateOf = s => s.el.dataset.state;
/** The surface the user can read: everything except a closed <details>. */
const visibleText = s => { const c = s.el.cloneNode(true); for (const d of c.querySelectorAll('details:not([open])')) d.remove(); return c.textContent; };
const FORBIDDEN_DOM = 'ol, li, progress, [data-phase], .ezil-app-spinner-ring, .ezil-boot-phase, .ezil-boot-check, .ezil-opening-name';
const NOISE = /\d+%|min left|Estimated|✓|Next session|Last recorded update|Applies after/;

{
    const retries = [];
    const spinner = AppSpinner({ label: 'Opening Browser…', onRetry: () => retries.push(1) });
    dom.window.document.body.appendChild(spinner.el);

    push('root carries the honesty-neutral class, not `.ezil-boot`',
        spinner.el.classList.contains('ezil-app-spinner') && ! spinner.el.classList.contains('ezil-boot'), spinner.el.className);
    push('ONE surface: one title, one bar, one status line, one meta line; no list, ring, <progress> or app-name line',
        spinner.el.querySelectorAll('h1').length === 1 && spinner.el.querySelectorAll('.ezil-opening-bar').length === 1
        && spinner.el.querySelectorAll('.ezil-app-spinner-sub').length === 1 && spinner.el.querySelectorAll('.ezil-opening-meta').length === 1
        && spinner.el.querySelectorAll(FORBIDDEN_DOM).length === 0);
    push('the root is not a live region (the elapsed tick is never announced); the status line is',
        ! spinner.el.hasAttribute('aria-live') && statusOf(spinner).getAttribute('aria-live') === 'polite'
        && metaOf(spinner).getAttribute('aria-hidden') === 'true');
    push('title is the "Opening {App}" label before the first render()', titleOf(spinner) === 'Opening Browser…');
    push('the title is announced when it changes (attention / failed headline)', $(spinner, 'h1').getAttribute('aria-live') === 'polite');
    push('icon falls back to the app initial', $(spinner, '.ezil-opening-icon')?.textContent === 'B');
    push('actions start hidden — nothing to retry before a state has rendered', $(spinner, '.ezil-boot-actions')?.hidden === true);

    spinner.render({ kind: 'progress', currentPhase: 'waking', confirmed: false, isRunningLong: false });
    push('unobserved progress: data-state opening, one indeterminate bar (no basis for a position)',
        stateOf(spinner) === 'opening' && barEl(spinner).hidden === false && barEl(spinner).dataset.indeterminate === 'true'
        && ! barEl(spinner).hasAttribute('aria-valuenow'));
    push('unobserved progress: the title stays "Opening Browser…" and there is no second line', titleOf(spinner) === 'Opening Browser…' && statusOf(spinner).hidden);
    push('unobserved progress: no Retry mid-boot', $(spinner, '.ezil-boot-actions').hidden === true);
    push('unobserved progress: no machine vocabulary in the surface text, not even in a hidden control',
        ! /computer|machine/i.test(spinner.el.textContent), spinner.el.textContent.replace(/\s+/g, ' '));
    push('unobserved progress: data-kind reflects the state', spinner.el.getAttribute('data-kind') === 'progress');
    push('unobserved progress: meta hidden in the first 3 s', metaOf(spinner).hidden === true);
    now = 5_000; spinner.render({ kind: 'progress' });
    push('unobserved progress: muted elapsed + expectation from TYPICAL_BOOT_MS', metaOf(spinner).textContent === '0:05 · usually under a minute', metaOf(spinner).textContent);
    now = 36_000; spinner.render({ kind: 'progress' });
    push('unobserved long (≥ LONG_BOOT_MS): warn meta, no button', stateOf(spinner) === 'long'
        && metaOf(spinner).textContent === 'Taking longer than usual · 0:36' && $(spinner, '.ezil-boot-actions').hidden, metaOf(spinner).textContent);
    spinner.stamp('url_received'); spinner.render({ kind: 'progress' });
    push('unobserved: the real url_received signal makes the bar determinate at the opening-app floor, never 100',
        barEl(spinner).dataset.indeterminate === undefined && barOf(spinner) >= 85 && barOf(spinner) < 100, String(barOf(spinner)));
    now = 0;

    spinner.render({ kind: 'not_configured' });
    push('not_configured: the bar hides', barEl(spinner).hidden === true);
    push('not_configured: renders the SAME copy every other surface uses',
        titleOf(spinner) === 'EZiL OS desktop' && statusOf(spinner).textContent === "This computer's desktop provider is not configured.");
    push('not_configured: no Retry — the next attempt would fail identically', $(spinner, '.ezil-boot-actions').hidden === true);

    spinner.render({ kind: 'failed', reason: 'timeout' });
    push('failed: BOOT_FAILURE_COPY for the specific reason', titleOf(spinner) === 'This is taking too long');
    push('failed: data-state failed, the bar hidden, Retry offered',
        stateOf(spinner) === 'failed' && barEl(spinner).hidden && $(spinner, '.ezil-boot-actions').hidden === false && $(spinner, '.ezil-boot-retry').hidden === false);
    $(spinner, '.ezil-boot-retry').dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    push('failed: clicking Retry calls onRetry exactly once', retries.length === 1, `${retries.length} calls`);
    spinner.render({ kind: 'failed', reason: 'unknown' });
    push('failed (unrecognised reason): generic copy', titleOf(spinner) === 'Something went wrong');

    let threw = false;
    try { spinner.render({ kind: 'ready' }); } catch { threw = true; }
    push('ready: data-state done and the bar at 100 (the real ready signal)', ! threw && stateOf(spinner) === 'done' && barOf(spinner) === 100
        && barEl(spinner).getAttribute('aria-valuenow') === '100');
    try { spinner.render({ kind: 'ready_unverified' }); } catch { threw = true; }
    push('ready_unverified renders without throwing', ! threw);
}
{
    const s = AppSpinner({ label: 'Opening Linux Desktop…', className: 'ezil-boot', icon: 'data:image/svg+xml;utf8,<svg/>' });
    push('className: the desktop window\'s one surface also answers the legacy `.ezil-boot` hooks',
        s.el.classList.contains('ezil-app-spinner') && s.el.classList.contains('ezil-boot')
        && !! $(s, 'h1.ezil-boot-title') && !! $(s, '.ezil-boot-sub'));
    push('icon: a data: URL renders as an image', $(s, '.ezil-opening-icon img')?.getAttribute('src')?.startsWith('data:image/svg+xml'));
}
{
    let retried = false;
    const spinner = AppSpinner({ label: 'Opening Code…', onRetry: () => { retried = true; },
        failureCopy: { title: 'Code is unavailable', body: 'Local editor <guidance>' } });
    spinner.render({ kind: 'failed', reason: 'unknown' });
    push('app-specific failure copy renders as text without changing failed state',
        spinner.el.dataset.kind === 'failed' && titleOf(spinner) === 'Code is unavailable'
        && statusOf(spinner).textContent === 'Local editor <guidance>' && ! $(spinner, 'guidance'));
    $(spinner, '.ezil-boot-retry').click();
    push('app-specific copy preserves explicit retry', retried);
    spinner.render({ kind: 'progress' });
    push('retry progress restores the app title and hides failure guidance', titleOf(spinner) === 'Opening Code…' && statusOf(spinner).hidden);
}
for (const flag of [undefined, null, false, 'true', 'false', 1, 0, {}, [], true]) {
    const spinner = AppSpinner({ label: 'Opening Preview…', isLaunching: () => flag });
    spinner.render({ kind: 'progress' });
    push(`launch copy requires boolean true (${JSON.stringify(flag)})`,
        titleOf(spinner) === (flag === true ? 'Starting a fresh computer…' : 'Opening Preview…')
        && statusOf(spinner).hidden === (flag !== true)
        && statusOf(spinner).textContent === (flag === true ? 'This start can take a few minutes.' : ''));
}
{
    let launching = true, migrating = true;
    const spinner = AppSpinner({ label: 'Opening Code…', isLaunching: () => launching, isMigrating: () => migrating });
    spinner.render({ kind: 'progress' });
    push('migration wins when both flags are true, with unchanged copy',
        titleOf(spinner) === 'Moving your computer to AWS (India)' && statusOf(spinner).textContent === 'This first start takes a few minutes. Your files come with you.');
    migrating = false;
    spinner.render({ kind: 'progress' });
    push('a remaining launch shows neutral copy without Retry',
        titleOf(spinner) === 'Starting a fresh computer…' && barEl(spinner).hidden === false && $(spinner, '.ezil-boot-actions').hidden === true);
    spinner.render({ kind: 'failed', reason: 'timeout' });
    push('launch flag does not override timeout or Retry', titleOf(spinner) === 'This is taking too long' && $(spinner, '.ezil-boot-actions').hidden === false);
    spinner.render({ kind: 'not_configured' });
    push('launch flag does not override unconfigured copy', titleOf(spinner) === 'EZiL OS desktop');
    launching = false;
    spinner.render({ kind: 'progress' });
    push('clearing observations restores the app title and hides the line', titleOf(spinner) === 'Opening Code…' && statusOf(spinner).hidden === true);
}

// ── 3. The bar formula (pure) ────────────────────────────────────────────
{
    const curve = (t, T) => 0.88 * (1 - Math.exp(-2.2 * t / T));
    push('formula: the time curve at t = T is ~78% and never reaches 88%',
        Math.abs(openingFill({ t: 240, T: 240 }) - curve(240, 240)) < 1e-9 && openingFill({ t: 1e9, T: 240 }) <= 0.88);
    push('formula: a stage floor lifts an early bar', openingFill({ t: 1, T: 240, floor: 0.6 }) === 0.6);
    push('formula: never below the previous value', openingFill({ t: 0, T: 240, prev: 0.42 }) === 0.42);
    push('formula: a measured transfer shows the real fraction (cap 0.99), not the clock',
        openingFill({ t: 1000, T: 240, real: 0.26 }) === 0.26 && openingFill({ t: 0, T: 240, real: 1 }) === 0.99);
    push('formula: reduced motion quantises to whole 5% steps', [10, 50, 120, 400].every(t => Math.round(openingFill({ t, T: 240, reducedMotion: true }) * 100) % 5 === 0));
}

// ── 4. Observed behaviour (fake fetch, fake timers, fake clock) ──────────
const originalFetch = globalThis.fetch, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
const timers = new Map(); let timerId = 0;
globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const T0 = '1970-01-01T00:00:00.000Z';
const migration = { version: 2, computerId: 'qa-computer', operation: 'migration', stage: 'provisioning', recordedStage: 'provisioning',
    active: true, durable: true, resumePolicy: 'saved_workspace_only', bytes: { transferred: 312_000_000, total: 1_200_000_000 },
    percent: 26, etaSeconds: 121, typicalSeconds: 390, transferStartedAt: '2026-10-26T10:00:00Z', transferUpdatedAt: '2026-10-26T10:01:00Z' };
let payload = migration, failFetch = false;
globalThis.fetch = async () => {
    if (failFetch) throw new Error('network');
    return { ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) };
};
async function observe(data, check, options = {}) {
    payload = data;
    const spinner = AppSpinner({ computerId: 'qa-computer', label: 'Opening Browser…', ...options });
    document.body.appendChild(spinner.el);
    try { spinner.render({ kind: 'progress' }); await tick(); await check(spinner); }
    finally { spinner.dispose(); spinner.el.remove(); failFetch = false; }
}
const poll = async () => { const [id, timer] = [...timers].find(([, value]) => value.ms === 5000); timers.delete(id); timer.fn(); await tick(); };
const opening = { version: 2, computerId: 'qa-computer', operation: 'opening', stage: 'starting', recordedStage: 'starting', active: true, durable: false,
    path: 'warm', openingStartedAt: T0, expectedSeconds: 240, milestones: [{ key: 'requested', at: T0 }],
    bytes: { transferred: null, total: null }, percent: null, etaSeconds: null };
try {
    // Migration: one status line per step (bytes join it while moving), one bar below 100.
    const labels = ['Saving your files', 'Getting your AWS computer', 'Moving your files', 'Starting your desktop'];
    for (const [stage, transferred, current] of [
        ['requested', null, 0], ['fenced', null, 0], ['exported', 0, 1], ['provisioning', 0, 1],
        ['provisioning', 312_000_000, 2], ['restored', 312_000_000, 2], ['committed', 312_000_000, 3],
        ['mounting', 312_000_000, 3], ['starting', 312_000_000, 3], ['running', 312_000_000, 3],
    ]) {
        await observe({ ...migration, stage, bytes: { ...migration.bytes, transferred } }, spinner => {
            const want = current === 2 ? `${labels[2]} · 312 MB of 1.2 GB` : labels[current];
            push(`${stage} (${transferred} bytes): the title stays "Opening Browser…", ONE status line "${want}"`,
                titleOf(spinner) === 'Opening Browser…' && statusOf(spinner).textContent === want && ! NOISE.test(visibleText(spinner))
                && spinner.el.querySelectorAll(FORBIDDEN_DOM).length === 0, statusOf(spinner).textContent);
            push(`${stage} (${transferred} bytes): one determinate bar below 100`,
                ! barEl(spinner).hidden && barEl(spinner).dataset.indeterminate === undefined && barOf(spinner) > 0 && barOf(spinner) < 100, String(barOf(spinner)));
        });
    }
    await observe(migration, async spinner => {
        const bar = barEl(spinner);
        push('measured transfer: the bar shows the REAL percent', barOf(spinner) === 26, String(barOf(spinner)));
        push('the bar exposes an accessible range named by the title',
            bar.getAttribute('role') === 'progressbar' && bar.getAttribute('aria-valuemin') === '0'
            && bar.getAttribute('aria-valuemax') === '100' && bar.getAttribute('aria-label') === 'Opening Browser…'
            && bar.getAttribute('aria-valuenow') === '26');
        payload = { ...migration, bytes: { transferred: 600_000_000, total: 1_200_000_000 }, percent: 50, etaSeconds: 59 };
        await poll();
        push('a later measurement moves the bar to the new real percent', barOf(spinner) === 50 && statusOf(spinner).textContent === 'Moving your files · 600 MB of 1.2 GB');
        payload = { ...migration, bytes: { transferred: 100_000_000, total: 1_200_000_000 }, percent: 8 };
        await poll();
        push('a lower reading never moves the bar backwards', barOf(spinner) === 50);
    });
    for (const percent of [0, 100, null]) {
        await observe({ ...migration, stage: 'restored', bytes: { transferred: percent === 100 ? 1_200_000_000 : 0, total: 1_200_000_000 }, percent }, spinner => {
            push(`transfer ${percent}%: never 100 before ready`, barOf(spinner) < 100 && barOf(spinner) >= 0, String(barOf(spinner)));
        });
    }
    // Holds: the server says something needs the user. No bar for a hold that is not a failure.
    for (const [override, title, state] of [
        [{ operationsPaused: true, needsOperator: true }, 'Computer startup is temporarily paused', 'attention'],
        [{ paused: true }, 'Computer startup is temporarily paused', 'attention'],
        [{ stage: 'operations_paused' }, 'Computer startup is temporarily paused', 'attention'],
        [{ stage: 'queued' }, 'Waiting to start', 'attention'],
        [{ stage: 'failed_reopened' }, 'Migration did not finish', 'failed'],
    ]) {
        await observe({ ...migration, ...override }, spinner => {
            push(`${JSON.stringify(override)}: the hold copy, data-state ${state}, no bar or transfer`,
                titleOf(spinner) === title && stateOf(spinner) === state && barEl(spinner).hidden
                && ! spinner.el.querySelector('ol') && ! spinner.el.textContent.includes('312 MB'), `${titleOf(spinner)} ${stateOf(spinner)}`);
        });
    }
    // Opening: title + the HF3 stage sentence + the bar binding.
    await observe(opening, async spinner => {
        push('opening: title "Opening Browser…", status = the stage sentence, data-state opening',
            titleOf(spinner) === 'Opening Browser…' && statusOf(spinner).textContent === 'A machine is ready and starting up.'
            && stateOf(spinner) === 'opening', `${titleOf(spinner)} / ${statusOf(spinner).textContent}`);
        push('opening: the getting-computer floor (5%) at t = 0', barOf(spinner) === 5, String(barOf(spinner)));
        push('opening: meta hidden in the first 3 s', metaOf(spinner).hidden);
        now = 72_000; await poll();
        const want = Math.round(100 * 0.88 * (1 - Math.exp(-2.2 * 72 / 240)));
        push('opening: at 72 s the bar is the time curve against T = 240 s', barOf(spinner) === want, `${barOf(spinner)} vs ${want}`);
        push('opening: muted "1:12 · usually about 4 min"', metaOf(spinner).textContent === '1:12 · usually about 4 min', metaOf(spinner).textContent);
        now = 76_000; spinner.render({ kind: 'progress' });
        push('the bar advances on the caller\'s paint tick, not only on a poll', barOf(spinner) > want, String(barOf(spinner)));
        push('aria-valuenow is throttled (not rewritten every tick)', barEl(spinner).getAttribute('aria-valuenow') === String(want));
        payload = { ...opening, milestones: [{ key: 'requested', at: T0 }, { key: 'host_claimed', at: T0 }, { key: 'files_attached', at: T0 }, { key: 'desktop_starting', at: T0 }] };
        now = 78_000; await poll();
        push('desktop_starting lifts the bar to the starting floor (60%)', barOf(spinner) >= 60 && statusOf(spinner).textContent === 'The desktop is starting. Browser opens next.', String(barOf(spinner)));
        spinner.stamp('url_received'); spinner.render({ kind: 'progress' });
        push('url_received lifts it to the opening-app floor, not to 100', barOf(spinner) >= 85 && barOf(spinner) < 100);
        spinner.stamp('first_frame'); spinner.render({ kind: 'progress' });
        push('first_frame (the ready event) is the only 100%', barOf(spinner) === 100);
    });
    now = 0;
    for (const [n, floor] of [[2, 5], [3, 35], [4, 60], [5, 85]]) {
        const keys = ['requested', 'host_claimed', 'files_attached', 'desktop_starting', 'desktop_ready'];
        await observe({ ...opening, stage: 'provisioning', milestones: keys.slice(0, n).map(key => ({ key, at: T0 })) }, spinner => {
            push(`stage floor after ${keys[n - 1]}: ${floor}%`, barOf(spinner) === floor, String(barOf(spinner)));
        });
    }
    // Never 100 before the ready signal, however long it takes.
    await observe({ ...opening, stage: 'running', milestones: [{ key: 'desktop_ready', at: T0 }] }, async spinner => {
        const seen = [];
        for (const t of [0, 240_000, 600_000, 3_600_000, 36_000_000]) { now = t; await poll(); seen.push(barOf(spinner)); }
        push('🔴 the bar never reaches 100 before ready (0 s … 10 h)', seen.every(v => v < 100), seen.join());
        spinner.render({ kind: 'ready' });
        push('ready: 100 and data-state done', barOf(spinner) === 100 && stateOf(spinner) === 'done');
    });
    now = 0;
    // 🔴 MONOTONIC across a re-open, a changed server timestamp and a null poll; elapsed never resets.
    await observe(opening, async spinner => {
        now = 85_000; await poll();
        const before = barOf(spinner);
        push('before the re-open: 1:25', metaOf(spinner).textContent === '1:25 · usually about 4 min', metaOf(spinner).textContent);
        // The desktop window's re-open: a fresh attempt stamps null and paints progress again.
        now = 86_000; spinner.stamp(null); spinner.render({ kind: 'progress' });
        push('🔴 re-open: the elapsed clock keeps counting (no 1:25 → 0:01 reset)', metaOf(spinner).textContent === '1:26 · usually about 4 min', metaOf(spinner).textContent);
        push('🔴 re-open: the bar never goes back', barOf(spinner) >= before, `${barOf(spinner)} < ${before}`);
        // The server's opening start changes (the live HYPOTHESIS for the reset) and the stage reads earlier.
        payload = { ...opening, stage: 'provisioning', openingStartedAt: '1970-01-01T00:01:26.000Z', milestones: [{ key: 'requested', at: '1970-01-01T00:01:26.000Z' }] };
        now = 88_000; await poll();
        push('🔴 a changed server openingStartedAt does not reset the elapsed time', metaOf(spinner).textContent === '1:28 · usually about 4 min', metaOf(spinner).textContent);
        push('🔴 ... nor the bar', barOf(spinner) >= before);
        const status = statusOf(spinner).textContent, high = barOf(spinner);
        failFetch = true; now = 95_000; await poll();
        push('null poll: the live observation is gone (verdicts read the live value)', spinner.hasComputerProgress() === false && spinner.el.dataset.progress === 'unavailable');
        push('🔴 null poll: the surface keeps the held status, a determinate bar and the clock',
            statusOf(spinner).textContent === status && barEl(spinner).dataset.indeterminate === undefined && barOf(spinner) >= high
            && metaOf(spinner).textContent === '1:35 · usually about 4 min', `${statusOf(spinner).textContent} ${barOf(spinner)} ${metaOf(spinner).textContent}`);
        spinner.render({ kind: 'progress' }, { reopening: true });
        push('null poll during a re-open still shows the held stage (one surface, no swap)', statusOf(spinner).textContent === status);
    });
    now = 0;
    // 🔴 MONOTONIC: a re-open never discards the high-water mark, even when the recomputed value is lower.
    await observe(opening, async spinner => {
        now = 20_000; await poll(); spinner.stamp('url_received'); spinner.render({ kind: 'progress' });
        const high = barOf(spinner);
        push('url_received lifts the bar to the opening-app floor', high >= 85 && high < 100, String(high));
        spinner.stamp(null); spinner.render({ kind: 'progress' }, { reopening: true });
        push('🔴 re-open at the same instant: the bar keeps its high-water and stays determinate',
            barOf(spinner) >= high && barEl(spinner).dataset.indeterminate === undefined, `${barOf(spinner)} ${barEl(spinner).dataset.indeterminate}`);
        now = 21_000; await poll(); spinner.render({ kind: 'progress' });
        push('🔴 ...and after the next poll', barOf(spinner) >= high, String(barOf(spinner)));
    });
    now = 0;
    {
        const s = AppSpinner({ label: 'Opening Browser…' });
        document.body.appendChild(s.el);
        s.render({ kind: 'progress' }); now = 20_000; s.stamp('url_received'); s.render({ kind: 'progress' });
        const high = barOf(s);
        s.stamp(null); s.render({ kind: 'progress' }, { reopening: true });
        push('🔴 unobserved re-open: the bar keeps its high-water and stays determinate', high >= 85
            && barOf(s) >= high && barEl(s).dataset.indeterminate === undefined, `${high} → ${barOf(s)}`);
        s.dispose(); s.el.remove(); now = 0;
    }
    // 🔴 A concluded open (ready) never lends its clock or first sight to the next one (restart, new tab).
    await observe({ ...opening, openingStartedAt: null, milestones: [] }, async spinner => {
        now = 30_000; await poll(); spinner.stamp('url_received'); spinner.render({ kind: 'progress' });
        spinner.render({ kind: 'ready' });
        push('ready concludes the open', stateOf(spinner) === 'done' && barOf(spinner) === 100);
        now = 3_600_000; spinner.render({ kind: 'progress' }); await tick();
        push('🔴 an hour later the next open is fresh: opening, no "Taking longer", no Try again, no carried 85%',
            stateOf(spinner) === 'opening' && ! /Taking longer|60:/.test(metaOf(spinner).textContent)
            && $(spinner, '.ezil-boot-actions').hidden && ! (barOf(spinner) >= 85),
            `${stateOf(spinner)} "${metaOf(spinner).textContent}" ${barOf(spinner)} actions=${! $(spinner, '.ezil-boot-actions').hidden}`);
        push('🔴 ...and its observation counts from this open, not the last one', (spinner.computerProgress()?.elapsed ?? 0) < 60,
            String(spinner.computerProgress()?.elapsed));
    });
    now = 0;
    // 🔴 One clock for the ten-minute stop: the server's opening start resets at 88 s (the live 1:25 → 0:01
    // case), yet the clock the user reads reaches 10:00 and Try again appears there, not 88 s later.
    await observe({ ...opening, startedAt: T0 }, async spinner => {
        now = 88_000; payload = { ...opening, startedAt: '1970-01-01T00:01:28.000Z', openingStartedAt: '1970-01-01T00:01:28.000Z' }; await poll();
        now = 599_000; await poll(); spinner.render({ kind: 'progress' });
        push('client 9:59 (server 8:31): still opening, no Try again', $(spinner, '.ezil-boot-retry').hidden === true, stateOf(spinner));
        now = 600_000; await poll(); spinner.render({ kind: 'progress' });
        push('🔴 client 10:00 (server 8:32): Try again, the calm ten-minute copy', $(spinner, '.ezil-boot-retry').hidden === false
            && statusOf(spinner).textContent === "This is taking longer than usual. We're still working on it — you can keep this open or come back later.",
            `${stateOf(spinner)} ${statusOf(spinner).textContent}`);
        now = 600_250; spinner.render({ kind: 'progress' });
        push('🔴 the stop holds on the next tick (never flips back to a fresh 0:00 open)', $(spinner, '.ezil-boot-retry').hidden === false
            && stateOf(spinner) === 'attention', `${stateOf(spinner)} "${metaOf(spinner).textContent}"`);
        $(spinner, '.ezil-boot-retry').click();
        now = 601_000; spinner.render({ kind: 'progress' });
        push('Try again releases the hold: a fresh open', stateOf(spinner) !== 'attention' && $(spinner, '.ezil-boot-retry').hidden === true,
            `${stateOf(spinner)} "${metaOf(spinner).textContent}"`);
    });
    now = 0;
    // An AWS observer that has not answered yet: elapsed only, never the Cloudflare expectation or "taking longer".
    {
        const hold = globalThis.fetch; globalThis.fetch = () => new Promise(() => {});
        const s = AppSpinner({ computerId: 'qa-computer', label: 'Opening Browser…' });
        document.body.appendChild(s.el);
        s.render({ kind: 'progress' }); await tick();
        now = 5_000; s.render({ kind: 'progress' });
        push('observer pending at 0:05: elapsed only, no expectation', s.el.dataset.progress === 'pending' && metaOf(s).textContent === '0:05', metaOf(s).textContent);
        now = 40_000; s.render({ kind: 'progress' });
        push('observer pending at 0:40: not "taking longer" (the expectation is unknown)', stateOf(s) === 'opening' && metaOf(s).textContent === '0:40',
            `${stateOf(s)} ${metaOf(s).textContent}`);
        s.dispose(); s.el.remove(); globalThis.fetch = hold; timers.clear(); now = 0;
    }
    // Long: t ≥ T turns the meta warn; the status line keeps following the server; no button.
    await observe({ ...opening, expectedSeconds: 90 }, async spinner => {
        now = 91_000; await poll();
        push('long: data-state long, "Taking longer than usual · 1:31", no Try again, bar below 100',
            stateOf(spinner) === 'long' && metaOf(spinner).textContent === 'Taking longer than usual · 1:31'
            && statusOf(spinner).textContent === 'A machine is ready and starting up.'
            && $(spinner, '.ezil-boot-actions').hidden && barOf(spinner) < 100, `${stateOf(spinner)} ${metaOf(spinner).textContent}`);
    });
    now = 0;
    // Reduced motion: whole 5% steps, flagged for the CSS (no transition, no sheen).
    globalThis.window = dom.window;
    dom.window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' });
    await observe(opening, async spinner => {
        const steps = [];
        for (const t of [7000, 33000, 61000, 97000]) { now = t; await poll(); steps.push(barOf(spinner)); }
        push('reduced motion: the bar advances in whole 5% steps, flagged on the root', steps.every(v => v % 5 === 0)
            && spinner.el.dataset.reducedMotion === 'true', steps.join());
    });
    delete dom.window.matchMedia; delete globalThis.window; now = 0;
    // Attention: needs_operator, amber frozen fill, ONE action by the existing predicate.
    globalThis.window = dom.window;
    for (const feedback of [false, true]) {
        window.__EZIL_BOOT__ = { desktopState: { endpoints: feedback ? { feedback: '/api/shell/feedback' } : {} } };
        for (const [recordedStage, retryable] of [['unconfirmed', true], ['failed_needs_operator', false]]) {
            let viewed = 0;
            await observe(opening, async spinner => {
                now = 60_000; spinner.render({ kind: 'progress' });
                const high = barOf(spinner);
                payload = { ...opening, stage: 'needs_operator', recordedStage, active: false };
                await poll();
                spinner.render({ kind: 'failed', reason: 'unknown' });
                const status = $(spinner, '.ezil-opening-view-status');
                push(`attention (${recordedStage}): the body matches the one action offered`,
                    statusOf(spinner).textContent === (retryable ? 'Starting it stopped before it finished.'
                        : 'Your computer needs a fix on our side. Your files stay on your own disk.'), statusOf(spinner).textContent);
                push(`attention (${recordedStage}, feedback ${feedback}): copy, amber frozen fill, one action`,
                    titleOf(spinner) === 'Your computer needs attention' && stateOf(spinner) === 'attention'
                    && ! barEl(spinner).hidden && barOf(spinner) === high
                    && $(spinner, '.ezil-boot-retry').hidden === ! retryable && status.hidden === retryable
                    && $(spinner, '.ezil-opening-feedback').hidden === ! feedback, `${stateOf(spinner)} ${barOf(spinner)}/${high}`);
                now = 90_000; spinner.render({ kind: 'failed', reason: 'unknown' });
                push(`attention (${recordedStage}): the fill stays frozen`, barOf(spinner) === high);
                if (! retryable) { status.click(); push('manualAttention: "View computer status" calls onViewStatus', viewed === 1 && status.textContent === 'View computer status'); }
            }, { onViewStatus: () => { viewed++; } });
            now = 0;
        }
    }
    delete globalThis.window;
    // L-A: an active AWS operation keeps progress through the client timeout; ten minutes shows Try again.
    for (const operation of ['opening', 'migration']) {
        await observe({ ...opening, operation, startedAt: '1970-01-01T00:00:00Z' }, async spinner => {
            for (const elapsed of [300000, 480000, 599000, 600000]) {
                now = elapsed;
                await poll();
                spinner.render({ kind: 'failed', reason: 'timeout' });
                push(`${operation} at ${elapsed}ms: an active operation stays in progress`, spinner.el.dataset.kind === 'progress'
                    && ! barEl(spinner).hidden && ! spinner.el.textContent.includes('This is taking too long'));
                push(`${operation} at ${elapsed}ms: retry appears only at the ten-minute ceiling`, $(spinner, '.ezil-boot-retry').hidden === (elapsed < 600000));
                push(`${operation} at ${elapsed}ms: never 100 before ready`, barOf(spinner) < 100 && barOf(spinner) > 0);
            }
            push(`${operation}: ten minutes shows calm guidance (attention, one action)`,
                statusOf(spinner).textContent === "This is taking longer than usual. We're still working on it — you can keep this open or come back later."
                && stateOf(spinner) === 'attention' && spinner.el.classList.contains('ezil-app-spinner-running-long'));
            spinner.render({ kind: 'failed', reason: 'unknown' });
            push(`${operation}: a genuine failure is not suppressed by active progress`, spinner.el.dataset.kind === 'failed'
                && titleOf(spinner) === 'Something went wrong' && ! $(spinner, '.ezil-boot-actions').hidden);
        });
        now = 0;
    }
    // 🔴 devDetails: never on the visible surface; only in a closed <details>, and only when the flag is boolean true.
    for (const devDetails of [undefined, false, 'true', true]) {
        globalThis.window = dom.window;
        window.__EZIL_BOOT__ = { user: { id: 'qa-user' }, features: { devDetails } };
        await observe({ ...opening, updatedAt: '2026-10-27T00:00:00Z', selectedNextOpenHardware: { effective: 'next_open', vcpu: 2, memoryGiB: 8 } }, spinner => {
            const details = $(spinner, 'details.ezil-opening-details');
            push(`devDetails ${devDetails}: no dev paragraph on the visible surface`, ! NOISE.test(visibleText(spinner)), visibleText(spinner));
            push(`devDetails ${devDetails}: the update line exists only inside a CLOSED, HIDDEN <details>, only for boolean true`,
                devDetails === true
                    ? details && details.hidden === true && details.open === false && details.textContent.includes('Last recorded update:')
                    : (! details || details.hidden === true) && ! spinner.el.textContent.includes('Last recorded update'));
            push(`devDetails ${devDetails}: the status line is the loading stage, never "Next session"`,
                statusOf(spinner).textContent === 'A machine is ready and starting up.' && ! /Next session|GiB memory/.test(spinner.el.textContent));
        });
        delete globalThis.window;
    }
    // HF3 sentences, one per server milestone; "Almost there" only at desktop_ready.
    {
        const keys = ['requested', 'host_claimed', 'files_attached', 'desktop_starting', 'desktop_ready'];
        const sentences = ['Finding a machine for your computer.', 'A machine is ready and starting up.', 'Your files are attached. The desktop is starting.',
            'The desktop is starting. Browser opens next.', 'Almost there — waiting for Browser to connect.'];
        for (let n = 1; n <= 5; n++) {
            await observe({ ...opening, stage: 'provisioning', milestones: keys.slice(0, n).map(key => ({ key, at: T0 })) }, spinner => {
                push(`milestone ${keys[n - 1]}: the status line is "${sentences[n - 1]}"`, ! statusOf(spinner).hidden && statusOf(spinner).textContent === sentences[n - 1], statusOf(spinner).textContent);
                push(`milestone ${keys[n - 1]}: no percentages, countdowns or ticks`, ! NOISE.test(visibleText(spinner)));
            });
        }
    }
    // F1b: open in flight while the server still says stopped.
    const stoppedNow = { ...opening, operation: 'none', stage: 'stopped', recordedStage: 'stopped', active: false, openingStartedAt: null, milestones: [] };
    for (const stage of ['stopped', 'purge_eligible']) {
        await observe({ ...stoppedNow, stage }, async spinner => {
            push(`${stage} + open in flight: "Starting your computer", indeterminate bar, no stopped copy`,
                statusOf(spinner).textContent === 'Starting your computer' && ! barEl(spinner).hidden && barEl(spinner).dataset.indeterminate === 'true'
                && ! /stopped|normal computer controls|No active startup/i.test(spinner.el.textContent), spinner.el.textContent);
            push(`${stage} + open in flight: the observation keeps the server stage for the window's wait`,
                spinner.computerProgress()?.stage === stage && spinner.computerProgress()?.activeAws === false);
            push(`${stage} + open in flight: no Try again or feedback while starting`, $(spinner, '.ezil-boot-actions').hidden);
            payload = { ...opening, stage: 'leased' };
            now = 30000; await poll();
            push(`${stage}: the server's opening takes over with its determinate bar`, barEl(spinner).dataset.indeterminate === undefined && barOf(spinner) > 0);
        });
        now = 0;
    }
    {
        const element = document.createElement('div'); document.body.appendChild(element);
        const seen = [];
        const observer = (await import('./computer-progress.js')).observeComputerProgress({ computerId: 'qa-computer', element,
            onChange: view => seen.push(view), query: async () => ({ ok: true, data: stoppedNow }) });
        observer.start(); await tick(); observer.stop(); element.remove();
        push('stopped without an open request: unchanged "Computer stopped" copy', seen[0]?.title === 'Computer stopped'
            && seen[0]?.body === 'Use the normal computer controls to start a session.' && seen[0]?.indeterminate === false);
    }
    push('all observed spinners dispose their polling timers', timers.size === 0);
} finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    Date.now = originalNow; delete globalThis.window;
    dom.window.close();
}

// ── 5. Send feedback names the RAW server code ──────────────────────────
{
    const fbDom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    globalThis.document = fbDom.window.document;
    globalThis.HTMLElement = fbDom.window.HTMLElement;
    globalThis.__feedbackCalls = [];
    const dialogUrl = new URL('./feedback/feedback.js', import.meta.url).href;
    const hooks = registerHooks({ load (url, context, next) {
        return url === dialogUrl ? { format: 'module', shortCircuit: true,
            source: 'export const open_feedback_dialog = opts => { globalThis.__feedbackCalls.push(opts); };' } : next(url, context);
    } });
    try {
        const { computeBootUiState } = await import('../boot-phases.js');
        const settle = async () => { for (let i = 0; i < 50 && globalThis.__feedbackCalls.length === 0; i++) await new Promise(r => setTimeout(r, 5)); };
        for (const [errorCode, expected] of [['billing_files_on_aws', 'billing_files_on_aws'], ['billing_size_not_allowed', 'billing_size_not_allowed'], [undefined, 'unknown']]) {
            globalThis.__feedbackCalls = [];
            const surface = AppSpinner({ label: 'Opening Code…' });
            document.body.appendChild(surface.el);
            surface.render(errorCode ? computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode }) : { kind: 'failed', reason: 'unknown' });
            surface.el.querySelector('.ezil-opening-feedback').click();
            await settle();
            const call = globalThis.__feedbackCalls[0];
            push(`AppSpinner: ${errorCode ?? 'no code'} → feedback prefill code ${expected}`,
                globalThis.__feedbackCalls.length === 1 && call?.source === 'opening' && call?.errorCode === expected, JSON.stringify(call));
            surface.el.remove();
        }
    } finally {
        hooks.deregister();
        delete globalThis.__feedbackCalls;
        fbDom.window.close();
    }
}

// ───────────────────────────────────────────────────────────────────────────
const failed = checks.filter(c => !c.pass);
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

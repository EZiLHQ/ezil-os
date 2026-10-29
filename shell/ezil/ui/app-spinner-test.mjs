// app-spinner-test.mjs — EZiL-authored. Headless test of `./app-spinner.js`.
//
// Run: cd shell && node ezil/ui/app-spinner-test.mjs
//
// Two things this pins, and why each is worth a file of its own:
//
//   1. 🔴 THE STATIC GUARD. `AppSpinner` exists specifically because Preview
//      and Code have no machine to boot, and the desktop window is only
//      allowed to show it for the first `PHASE_LIST_AFTER_MS` of a boot. Both
//      of those properties depend on this component being unable to invent
//      its own progress — see `app-spinner.js`'s own header. A component that
//      imports `boot-progress.js` or starts a `setInterval` on its own clock
//      would satisfy every DOM assertion below while quietly reopening the
//      exact hole `boot-phases.ts`'s honesty constraint exists to close.
//      Reverting the "no timers" property (e.g. adding a `setInterval` that
//      advances a percentage outside the shared observer) makes this guard fail without touching a
//      single other assertion in this file — that is the point of pinning it
//      separately from the behavioural checks.
//
//   2. The behavioural checks: it renders the SAME `BootUiState` every other
//      boot surface in this codebase renders, using the SAME copy tables
//      (`BOOT_FAILURE_COPY` / `BOOT_NOT_CONFIGURED_COPY`), so a caller that
//      swaps `BootProgress` for this component changes only how much detail
//      is shown, never what is claimed.
//
// jsdom, not a browser: this proves the DOM this component builds and what it
// does with a `render()` call, not that a ring visibly spins (that is CSS,
// asserted only by its presence as a class name here).

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

// ── 2. Behavioural checks ────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const { AppSpinner } = await import('./app-spinner.js');

{
    const retries = [];
    const spinner = AppSpinner({ label: 'Opening Browser…', onRetry: () => retries.push(Date.now()) });
    dom.window.document.body.appendChild(spinner.el);

    push('root carries the honesty-neutral class, not `.ezil-boot`',
        spinner.el.classList.contains('ezil-app-spinner')
        && ! spinner.el.classList.contains('ezil-boot'),
        spinner.el.className);
    push('no phase list anywhere in the markup',
        spinner.el.querySelectorAll('[data-phase], .ezil-boot-phase').length === 0);
    push('label is set before the first render()',
        spinner.el.querySelector('.ezil-app-spinner-label')?.textContent === 'Opening Browser…');
    push('actions start hidden — nothing to retry before a state has rendered',
        spinner.el.querySelector('.ezil-boot-actions')?.hidden === true);

    spinner.render({ kind: 'progress', currentPhase: 'waking', confirmed: false, isRunningLong: false });
    push('progress: one thin indeterminate bar, no ring (round 3)',
        spinner.el.querySelector('.ezil-opening-bar')?.hidden === false
        && spinner.el.querySelector('.ezil-opening-bar')?.dataset.indeterminate === 'true'
        && !spinner.el.querySelector('.ezil-app-spinner-ring'));
    push('progress: app icon and app name from the label',
        spinner.el.querySelector('.ezil-opening-name')?.textContent === 'Browser'
        && spinner.el.querySelector('.ezil-opening-icon')?.textContent === 'B');
    push('progress: the label is the app-specific one, not machine copy',
        spinner.el.querySelector('.ezil-app-spinner-label')?.textContent === 'Opening Browser…');
    push('progress: no Retry offered mid-boot',
        spinner.el.querySelector('.ezil-boot-actions')?.hidden === true);
    push('progress: data-kind reflects the state',
        spinner.el.getAttribute('data-kind') === 'progress');

    spinner.render({ kind: 'not_configured' });
    push('not_configured: the bar hides',
        spinner.el.querySelector('.ezil-opening-bar')?.hidden === true);
    push('not_configured: renders the SAME copy every other surface uses',
        spinner.el.querySelector('.ezil-app-spinner-label')?.textContent === 'EZiL OS desktop'
        && spinner.el.querySelector('.ezil-app-spinner-sub')?.textContent
            === "This computer's desktop provider is not configured.");
    push('not_configured: no Retry — the next attempt would fail identically',
        spinner.el.querySelector('.ezil-boot-actions')?.hidden === true);

    spinner.render({ kind: 'failed', reason: 'timeout' });
    push('failed: renders BOOT_FAILURE_COPY for the specific reason, not a generic message',
        spinner.el.querySelector('.ezil-app-spinner-label')?.textContent === 'This is taking too long');
    push('failed: Retry is offered',
        spinner.el.querySelector('.ezil-boot-actions')?.hidden === false);

    dom.window.$ ??= undefined; // no jQuery dependency — plain DOM events only
    spinner.el.querySelector('.ezil-boot-retry')?.dispatchEvent(
        new dom.window.Event('click', { bubbles: true, cancelable: true }));
    push('failed: clicking Retry calls onRetry exactly once', retries.length === 1, `${retries.length} calls`);

    spinner.render({ kind: 'failed', reason: 'unknown' });
    push('failed (unrecognised reason still falls back honestly): falls back to the generic copy',
        spinner.el.querySelector('.ezil-app-spinner-label')?.textContent === 'Something went wrong');

    // 'ready' / 'ready_unverified' are no-ops here — the caller is about to
    // swap the iframe in, or already has. Must not throw.
    let threw = false;
    try {
        spinner.render({ kind: 'ready' });
        spinner.render({ kind: 'ready_unverified' });
    } catch {
        threw = true;
    }
    push('ready / ready_unverified render without throwing', ! threw);
}

{
    let retried = false;
    const spinner = AppSpinner({ label: 'Opening Code…', onRetry: () => { retried = true; },
        failureCopy: { title: 'Code is unavailable', body: 'Local editor <guidance>' } });
    spinner.render({ kind: 'failed', reason: 'unknown' });
    push('app-specific failure copy renders as text without changing failed state',
        spinner.el.dataset.kind === 'failed'
        && spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Code is unavailable'
        && spinner.el.querySelector('.ezil-app-spinner-sub').textContent === 'Local editor <guidance>'
        && !spinner.el.querySelector('guidance'));
    spinner.el.querySelector('.ezil-boot-retry').click();
    push('app-specific copy preserves explicit retry', retried);
    spinner.render({ kind: 'progress' });
    push('retry progress restores app label and hides failure guidance',
        spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Opening Code…'
        && spinner.el.querySelector('.ezil-app-spinner-sub').hidden);
}

// A replacement is distinct from a migration, including malformed observations.
for (const flag of [undefined, null, false, 'true', 'false', 1, 0, {}, [], true]) {
    const spinner = AppSpinner({ label: 'Opening Preview…', isLaunching: () => flag });
    spinner.render({ kind: 'progress' });
    push(`launch copy requires boolean true (${JSON.stringify(flag)})`,
        spinner.el.querySelector('.ezil-app-spinner-label').textContent
            === (flag === true ? 'Starting a fresh computer…' : 'Opening Preview…')
        && spinner.el.querySelector('.ezil-app-spinner-sub').hidden === (flag !== true)
        && spinner.el.querySelector('.ezil-app-spinner-sub').textContent
            === (flag === true ? 'This start can take a few minutes.' : ''));
}
{
    let launching = true, migrating = true;
    const spinner = AppSpinner({ label: 'Opening Code…', isLaunching: () => launching, isMigrating: () => migrating });
    spinner.render({ kind: 'progress' });
    push('migration wins when both flags are true, with unchanged copy',
        spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Moving your computer to AWS (India)'
        && spinner.el.querySelector('.ezil-app-spinner-sub').textContent === 'This first start takes a few minutes. Your files come with you.');
    migrating = false;
    spinner.render({ kind: 'progress' });
    push('a remaining launch shows neutral copy without Retry',
        spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Starting a fresh computer…'
        && spinner.el.querySelector('.ezil-opening-bar').hidden === false
        && spinner.el.querySelector('.ezil-boot-actions').hidden === true);
    spinner.render({ kind: 'failed', reason: 'timeout' });
    push('launch flag does not override timeout or Retry',
        spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'This is taking too long'
        && spinner.el.querySelector('.ezil-boot-actions').hidden === false);
    spinner.render({ kind: 'not_configured' });
    push('launch flag does not override unconfigured copy',
        spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'EZiL OS desktop');
    launching = false;
    spinner.render({ kind: 'progress' });
    push('clearing observations restores the app label and hides the body',
        spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Opening Code…'
        && spinner.el.querySelector('.ezil-app-spinner-sub').hidden === true
        && spinner.el.querySelector('.ezil-app-spinner-sub').textContent === '');
}

const originalFetch = globalThis.fetch, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = Date.now;
let now = 0; Date.now = () => now;
const timers = new Map(); let timerId = 0;
globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const migration = { version: 2, computerId: 'qa-computer', operation: 'migration', stage: 'provisioning', recordedStage: 'provisioning',
    active: true, durable: true, resumePolicy: 'saved_workspace_only', bytes: { transferred: 312_000_000, total: 1_200_000_000 },
    percent: 26, etaSeconds: 121, typicalSeconds: 390, transferStartedAt: '2026-10-26T10:00:00Z', transferUpdatedAt: '2026-10-26T10:01:00Z' };
let payload = migration;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
async function observe(data, check) {
    payload = data;
    const spinner = AppSpinner({ computerId: 'qa-computer' });
    document.body.appendChild(spinner.el);
    try { spinner.render({ kind: 'progress' }); await tick(); await check(spinner); }
    finally { spinner.dispose(); spinner.el.remove(); }
}
const poll = async () => { const [id, timer] = [...timers].find(([, value]) => value.ms === 5000); timers.delete(id); timer.fn(); await tick(); };
const barOf = spinner => Number(spinner.el.querySelector('.ezil-opening-bar').getAttribute('aria-valuenow'));
// Round 3 (plan §6.5): one status line, one bar, a muted elapsed time. No list, ticks, percentages or countdowns.
const NOISE = /\d+%|min left|Almost there|Estimated|✓/;
try {
    const labels = ['Saving your files', 'Getting your AWS computer', 'Moving your files', 'Starting your desktop'];
    for (const [stage, transferred, current] of [
        ['requested', null, 0], ['fenced', null, 0], ['exported', 0, 1], ['provisioning', 0, 1],
        ['provisioning', 312_000_000, 2], ['restored', 312_000_000, 2], ['committed', 312_000_000, 3],
        ['mounting', 312_000_000, 3], ['starting', 312_000_000, 3], ['running', 312_000_000, 3],
    ]) {
        await observe({ ...migration, stage, bytes: { ...migration.bytes, transferred } }, spinner => {
            push(`${stage} (${transferred} bytes): one status line, no step list`,
                spinner.el.querySelector('.ezil-app-spinner-label').textContent === labels[current]
                && !spinner.el.querySelector('ol, li') && !NOISE.test(spinner.el.textContent));
            push(`${stage} (${transferred} bytes): one determinate bar below 100`,
                spinner.el.querySelectorAll('.ezil-opening-bar').length === 1
                && !spinner.el.querySelector('.ezil-opening-bar').hidden && barOf(spinner) < 100);
            push(`${stage}: bytes only while moving`, spinner.el.textContent.includes('312 MB of 1.2 GB') === (current === 2));
        });
    }
    await observe(migration, async spinner => {
        const bar = spinner.el.querySelector('.ezil-opening-bar');
        push('measured transfer uses decimal MB and GB', spinner.el.textContent.includes('312 MB of 1.2 GB'));
        push('the bar exposes an accessible range and the status line as its name',
            bar.getAttribute('role') === 'progressbar' && bar.getAttribute('aria-valuemin') === '0'
            && bar.getAttribute('aria-valuemax') === '100' && bar.getAttribute('aria-label') === 'Moving your files');
        const before = barOf(spinner);
        payload = { ...migration, bytes: { transferred: 600_000_000, total: 1_200_000_000 }, percent: 50, etaSeconds: 59 };
        await poll();
        push('a later observation updates bytes and moves the bar forward without changing stage',
            spinner.el.textContent.includes('600 MB of 1.2 GB') && barOf(spinner) > before
            && spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Moving your files');
        payload = { ...migration, bytes: { transferred: 100_000_000, total: 1_200_000_000 }, percent: 8 };
        const high = barOf(spinner);
        await poll();
        push('a lower reading never moves the bar backwards', barOf(spinner) === high);
    });
    for (const percent of [0, 100, null]) {
        await observe({ ...migration, stage: 'restored', bytes: { transferred: percent === 100 ? 1_200_000_000 : 0, total: 1_200_000_000 }, percent }, spinner => {
            push(`percentage ${percent}: transfer cannot finish the bar before ready`, barOf(spinner) < 100 && barOf(spinner) >= 25);
        });
    }
    for (const [override, title] of [
        [{ operationsPaused: true, needsOperator: true }, 'Computer startup is temporarily paused'],
        [{ paused: true }, 'Computer startup is temporarily paused'],
        [{ stage: 'operations_paused' }, 'Computer startup is temporarily paused'],
        [{ needsOperator: true }, 'Your computer needs attention'], [{ stage: 'queued' }, 'Waiting to start'],
        [{ stage: 'failed_reopened' }, 'Migration did not finish'], [{ stage: 'failed_needs_operator' }, 'Your computer needs attention'],
    ]) {
        await observe({ ...migration, ...override }, spinner => {
            push(`${JSON.stringify(override)}: existing message overrides migration with no bar or transfer`,
                spinner.el.querySelector('.ezil-app-spinner-label').textContent === title
                && spinner.el.querySelector('.ezil-opening-bar').hidden
                && !spinner.el.querySelector('ol') && !spinner.el.textContent.includes('312 MB'));
            if (override.stage !== 'queued') push(`${JSON.stringify(override)}: no active migration promise`,
                !spinner.el.textContent.includes('your files keep moving'));
        });
    }
    const opening = { ...migration, operation: 'opening', stage: 'starting', typicalSeconds: null, bytes: { transferred: null, total: null }, percent: null, etaSeconds: null };
    await observe(opening, async spinner => {
        push('AWS opening: STARTING reads "Starting your computer" (the order is no longer inverted)',
            spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Starting your computer');
        push('AWS opening: no step list, countdown or percentage', !spinner.el.querySelector('ol') && !NOISE.test(spinner.el.textContent));
        push('AWS opening: muted elapsed time', spinner.el.querySelector('.ezil-opening-meta').textContent === '0:00');
        const first = barOf(spinner);
        now = 120000; payload = { ...opening, stage: 'mounting' }; await poll();
        push('AWS opening: MOUNTING follows STARTING and the bar advances',
            spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Attaching your files'
            && barOf(spinner) > first && spinner.el.querySelector('.ezil-opening-meta').textContent === '2:00');
        const mid = barOf(spinner);
        now = 130000; payload = { ...opening, stage: 'starting' }; await poll();
        push('AWS opening: a stage read out of order never regresses the bar', barOf(spinner) >= mid);
        spinner.stamp('url_received'); spinner.render({ kind: 'progress' });
        push('url_received lifts the bar but not to 100', barOf(spinner) >= 88 && barOf(spinner) < 100);
        spinner.stamp('first_frame'); spinner.render({ kind: 'progress' });
        push('first_frame (the ready event) is the only 100%', barOf(spinner) === 100);
    });
    now = 0;
    // Two tabs with the same server opening start show the same bar and time.
    {
        const shared = { ...opening, openingStartedAt: '1970-01-01T00:00:00.000Z', expectedSeconds: 200, milestones: [{ key: 'requested', at: '1970-01-01T00:00:00.000Z' }] };
        const results = [];
        for (const firstSeen of [5000, 95000]) {
            now = firstSeen;
            await observe(shared, async spinner => {
                now = 100000; await poll();
                results.push([barOf(spinner), spinner.el.querySelector('.ezil-opening-meta').textContent]);
            });
        }
        push('two tabs (different first observations, one server start) agree', JSON.stringify(results[0]) === JSON.stringify(results[1])
            && results[0][1] === '1:40', JSON.stringify(results));
        now = 0;
    }
    // Long: past the server's expected seconds, the meta line says so; the status line stays.
    await observe({ ...opening, openingStartedAt: '1970-01-01T00:00:00.000Z', expectedSeconds: 90 }, async spinner => {
        now = 91000; await poll();
        push('long: "Taking a little longer than usual" with the elapsed time, no Try again',
            spinner.el.querySelector('.ezil-opening-meta').textContent === 'Taking a little longer than usual · 1:31'
            && spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Starting your computer'
            && spinner.el.querySelector('.ezil-boot-actions').hidden && barOf(spinner) <= 90);
    });
    now = 0;
    // Reduced motion: whole 10% steps, flagged for the CSS (no transition, no shimmer).
    globalThis.window = dom.window;
    dom.window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' });
    await observe({ ...opening, openingStartedAt: '1970-01-01T00:00:00.000Z', expectedSeconds: 240 }, async spinner => {
        const steps = [];
        for (const t of [7000, 33000, 61000, 97000]) { now = t; await poll(); steps.push(barOf(spinner)); }
        push('reduced motion: the bar advances in whole steps', steps.every(v => v % 10 === 0)
            && spinner.el.querySelector('.ezil-opening').dataset.reducedMotion === 'true', steps.join());
    });
    delete dom.window.matchMedia; delete globalThis.window; now = 0;
    // Attention: "Your computer needs attention" + Try again only when retryable + Send feedback (flag on).
    globalThis.window = dom.window;
    for (const feedback of [false, true]) {
        window.__EZIL_BOOT__ = { desktopState: { endpoints: feedback ? { feedback: '/api/shell/feedback' } : {} } };
        for (const [recordedStage, retryable] of [['unconfirmed', true], ['failed_needs_operator', false]]) {
            await observe({ ...opening, stage: 'needs_operator', recordedStage, active: false }, spinner => {
                spinner.render({ kind: 'failed', reason: 'unknown' });
                push(`attention (${recordedStage}, feedback ${feedback}): copy, Try again only when retryable, feedback only when on`,
                    spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Your computer needs attention'
                    && spinner.el.querySelector('.ezil-boot-retry').hidden === !retryable
                    && spinner.el.querySelector('.ezil-opening-feedback').hidden === !feedback
                    && spinner.el.querySelector('.ezil-opening-feedback').textContent === 'Send feedback');
            });
        }
    }
    delete globalThis.window;
    for (const operation of ['opening', 'migration']) {
        await observe({ ...opening, operation, startedAt: '1970-01-01T00:00:00Z' }, async spinner => {
            for (const elapsed of [300000, 480000, 599000, 600000]) {
                now = elapsed;
                await poll();
                spinner.render({ kind: 'failed', reason: 'timeout' });
                push(`${operation} at ${elapsed}ms: an active operation stays in progress`, spinner.el.dataset.kind === 'progress'
                    && !spinner.el.querySelector('.ezil-opening-bar').hidden
                    && !spinner.el.textContent.includes('This is taking too long'));
                push(`${operation} at ${elapsed}ms: retry appears only at the ten-minute ceiling`,
                    spinner.el.querySelector('.ezil-boot-retry').hidden === (elapsed < 600000));
                push(`${operation} at ${elapsed}ms: an overdue bar holds below 90%`, barOf(spinner) <= 90 && barOf(spinner) > 0);
            }
            push(`${operation}: ten minutes shows calm guidance and secondary retry styling`,
                spinner.el.querySelector('.ezil-app-spinner-sub').textContent === "This is taking longer than usual. We're still working on it — you can keep this open or come back later."
                && spinner.el.classList.contains('ezil-app-spinner-running-long'));
            spinner.render({ kind: 'failed', reason: 'unknown' });
            push(`${operation}: a genuine failure is not suppressed by active progress`, spinner.el.dataset.kind === 'failed'
                && spinner.el.querySelector('.ezil-app-spinner-label').textContent === 'Something went wrong'
                && !spinner.el.querySelector('.ezil-boot-actions').hidden);
        });
        now = 0;
    }
    for (const devDetails of [undefined, false, 'true', true]) {
        globalThis.window = dom.window;
        window.__EZIL_BOOT__ = { user: { id: 'qa-user' }, features: { devDetails } };
        await observe({ ...opening, updatedAt: '2026-10-27T00:00:00Z', selectedNextOpenHardware: { effective: 'next_open', vcpu: 2, memoryGiB: 8 } }, spinner => {
            push(`boot devDetails ${devDetails}: diagnostics require boolean true`,
                spinner.el.textContent.includes('Next session: 2 vCPU · 8 GiB memory.') === (devDetails === true)
                && spinner.el.textContent.includes('Last recorded update:') === (devDetails === true));
        });
        delete globalThis.window;
    }
    // F1b: while this window's open is in flight and the server still says stopped (no opening yet), the surface
    // reads "Starting your computer" with an indeterminate bar, never "Computer stopped — Use the normal computer controls…".
    const stoppedNow = { ...opening, operation: 'none', stage: 'stopped', recordedStage: 'stopped', active: false, openingStartedAt: null, milestones: [] };
    for (const stage of ['stopped', 'purge_eligible']) {
        await observe({ ...stoppedNow, stage }, async spinner => {
            const label = () => spinner.el.querySelector('.ezil-app-spinner-label').textContent;
            const bar = spinner.el.querySelector('.ezil-opening-bar');
            push(`${stage} + open in flight: "Starting your computer", indeterminate bar, no stopped copy`,
                label() === 'Starting your computer' && !bar.hidden && bar.dataset.indeterminate === 'true'
                && !/stopped|normal computer controls|No active startup/i.test(spinner.el.textContent), spinner.el.textContent);
            push(`${stage} + open in flight: the observation keeps the server stage for the window's wait`,
                spinner.computerProgress()?.stage === stage && spinner.computerProgress()?.activeAws === false);
            push(`${stage} + open in flight: no Try again or feedback while starting`, spinner.el.querySelector('.ezil-boot-actions').hidden);
            payload = { ...opening, stage: 'leased', openingStartedAt: '1970-01-01T00:00:00.000Z', expectedSeconds: 240,
                milestones: [{ key: 'requested', at: '1970-01-01T00:00:00.000Z' }] };
            now = 30000; await poll();
            push(`${stage}: the server's opening takes over with its determinate bar`,
                label() === 'Starting your computer' && bar.dataset.indeterminate === undefined && barOf(spinner) > 0);
            spinner.render({ kind: 'failed', reason: 'timeout' });
            push(`${stage}: a failed open shows its failure copy`, label() !== 'Computer stopped');
        });
        now = 0;
    }
    // Without a request (Settings, transition watchers) the observer keeps the stopped copy.
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

// ── 3. Round 4: Send feedback names the RAW server code ──────────────────
// The founder's 10-28 report read "Error code: unknown" for `billing_size_not_allowed`:
// both surfaces passed the classified reason. The dialog module is replaced by a recorder.
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
        const { BootProgress } = await import('./boot-progress.js');
        const settle = async () => { for (let i = 0; i < 50 && globalThis.__feedbackCalls.length === 0; i++) await new Promise(r => setTimeout(r, 5)); };
        const cases = [
            ['AppSpinner', 'billing_files_on_aws', 'billing_files_on_aws'],
            ['AppSpinner', 'billing_size_not_allowed', 'billing_size_not_allowed'],
            ['BootProgress', 'billing_payment_issue', 'billing_payment_issue'],
            // A state built without a code (older callers) still names its reason.
            ['BootProgress', undefined, 'unknown'],
        ];
        for (const [name, errorCode, expected] of cases) {
            globalThis.__feedbackCalls = [];
            const surface = name === 'AppSpinner' ? AppSpinner({ label: 'Opening Code…' }) : BootProgress({ onRetry () {} });
            document.body.appendChild(surface.el);
            surface.render(errorCode ? computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode }) : { kind: 'failed', reason: 'unknown' });
            surface.el.querySelector('.ezil-opening-feedback').click();
            await settle();
            const call = globalThis.__feedbackCalls[0];
            push(`${name}: ${errorCode ?? 'no code'} → feedback prefill code ${expected}`,
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

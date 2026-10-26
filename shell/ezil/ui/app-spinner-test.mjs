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
//      advances a fake percentage) makes this guard fail without touching a
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
    push('progress: the ring shows',
        spinner.el.querySelector('.ezil-app-spinner-ring')?.hidden === false);
    push('progress: the label is the app-specific one, not machine copy',
        spinner.el.querySelector('.ezil-app-spinner-label')?.textContent === 'Opening Browser…');
    push('progress: no Retry offered mid-boot',
        spinner.el.querySelector('.ezil-boot-actions')?.hidden === true);
    push('progress: data-kind reflects the state',
        spinner.el.getAttribute('data-kind') === 'progress');

    spinner.render({ kind: 'not_configured' });
    push('not_configured: ring hides',
        spinner.el.querySelector('.ezil-app-spinner-ring')?.hidden === true);
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
        && spinner.el.querySelector('.ezil-app-spinner-ring').hidden === false
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

const originalFetch = globalThis.fetch, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
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
try {
    const labels = ['Saving your files', 'Getting your AWS computer', 'Moving your files', 'Starting your desktop'];
    for (const [stage, transferred, current] of [
        ['requested', null, 0], ['fenced', null, 0], ['exported', 0, 1], ['provisioning', 0, 1],
        ['provisioning', 312_000_000, 2], ['restored', 312_000_000, 2], ['committed', 312_000_000, 3],
        ['mounting', 312_000_000, 3], ['starting', 312_000_000, 3], ['running', 312_000_000, 3],
    ]) {
        await observe({ ...migration, stage, bytes: { ...migration.bytes, transferred } }, spinner => {
            const items = [...spinner.el.querySelectorAll('ol li')];
            push(`${stage} (${transferred} bytes): four steps with one highlighted current step`,
                items.length === 4 && spinner.el.querySelectorAll('[aria-current="step"]').length === 1
                && items[current].getAttribute('aria-current') === 'step' && items[current].textContent === labels[current]);
            push(`${stage} (${transferred} bytes): only completed steps have ticks`,
                items.every((item, i) => item.dataset.state === (i < current ? 'complete' : i === current ? 'current' : 'pending')
                    && item.textContent === `${i < current ? '✓ ' : ''}${labels[i]}`)
                && spinner.el.querySelectorAll('li span[aria-hidden="true"]').length === current);
            push(`${stage} (${transferred} bytes): transfer bar appears only during Moving your files`,
                !!spinner.el.querySelector('progress') === (current === 2));
        });
    }
    await observe(migration, async spinner => {
        const bar = spinner.el.querySelector('progress');
        push('measured transfer uses decimal MB and GB', spinner.el.textContent.includes('312 MB of 1.2 GB'));
        push('determinate bar exposes the measured percentage and accessible range',
            bar?.value === 26 && bar.max === 100 && bar.getAttribute('aria-valuenow') === '26'
            && bar.getAttribute('aria-valuemin') === '0' && bar.getAttribute('aria-valuemax') === '100'
            && bar.getAttribute('aria-label') === 'Moving your files');
        push('measured ETA rounds up to whole minutes', spinner.el.textContent.includes('About 3 min left'));
        push('typical duration and closing guidance are shown upfront', spinner.el.textContent.includes(
            'Moving your files to AWS. This usually takes about 7 minutes. You can close this window — your files keep moving, and your computer will be ready when you come back.'));
        payload = { ...migration, bytes: { transferred: 600_000_000, total: 1_200_000_000 }, percent: 50, etaSeconds: 59 };
        const [id, timer] = [...timers].find(([, value]) => value.ms === 5000);
        timers.delete(id); timer.fn(); await tick();
        push('a later observation updates bytes, bar and ETA without changing stage',
            spinner.el.textContent.includes('600 MB of 1.2 GB') && spinner.el.textContent.includes('Less than a minute left')
            && spinner.el.querySelector('progress')?.getAttribute('aria-valuenow') === '50');
    });
    for (const [etaSeconds, expected] of [[0, 'Less than a minute left'], [59, 'Less than a minute left'], [60, 'About 1 min left'], [61, 'About 2 min left'], [null, null]]) {
        await observe({ ...migration, etaSeconds }, spinner => {
            push(`ETA ${etaSeconds}: measured text only`, expected === null
                ? !/min left|minute left/.test(spinner.el.textContent) : spinner.el.textContent.includes(expected));
        });
    }
    for (const percent of [0, 100, null]) {
        await observe({ ...migration, stage: 'restored', bytes: { transferred: percent === 100 ? 1_200_000_000 : 0, total: 1_200_000_000 }, percent }, spinner => {
            const bar = spinner.el.querySelector('progress');
            push(`percentage ${percent}: zero and completion remain measured, null stays indeterminate`,
                percent === null ? !bar.hasAttribute('value') && !bar.hasAttribute('aria-valuenow')
                    : bar.value === percent && bar.getAttribute('aria-valuenow') === String(percent));
        });
    }
    for (const bytes of [{ transferred: 312_000_000, total: null }, { transferred: null, total: 1_200_000_000 }]) {
        await observe({ ...migration, stage: 'restored', bytes, typicalSeconds: null }, spinner => {
            const bar = spinner.el.querySelector('progress');
            push(`missing bytes ${JSON.stringify(bytes)}: indeterminate bar has no numeric value`,
                !!bar && !bar.hasAttribute('value') && !bar.hasAttribute('aria-valuenow'));
            push(`missing bytes ${JSON.stringify(bytes)}: Not measured, without byte counts or ETA`,
                spinner.el.textContent.includes('Not measured') && !/\d|MB|GB|min left|minute left/.test(spinner.el.textContent));
        });
    }
    await observe({ ...migration, stage: 'requested', typicalSeconds: null }, spinner => {
        push('first migration stage shows the null duration fallback and closing guidance', spinner.el.textContent.includes(
            'Moving your files to AWS. This can take a few minutes. You can close this window — your files keep moving, and your computer will be ready when you come back.'));
        push('old durable-guidance sentence is replaced', !spinner.el.textContent.includes('Progress resumes only when operations allow it'));
    });
    for (const [override, title] of [
        [{ operationsPaused: true, needsOperator: true }, 'Computer startup is temporarily paused'],
        [{ paused: true }, 'Computer startup is temporarily paused'],
        [{ stage: 'operations_paused' }, 'Computer startup is temporarily paused'],
        [{ needsOperator: true }, 'Computer needs attention'], [{ stage: 'queued' }, 'Waiting to start'],
        [{ stage: 'failed_reopened' }, 'Migration did not finish'], [{ stage: 'failed_needs_operator' }, 'Computer needs attention'],
    ]) {
        await observe({ ...migration, ...override }, spinner => {
            push(`${JSON.stringify(override)}: existing message overrides migration with no animation or transfer`,
                spinner.el.querySelector('.ezil-app-spinner-label').textContent === title
                && spinner.el.querySelector('.ezil-app-spinner-ring').hidden
                && !spinner.el.querySelector('ol') && !spinner.el.querySelector('progress')
                && !spinner.el.textContent.includes('312 MB') && !spinner.el.textContent.includes('min left'));
            if (override.stage !== 'queued') push(`${JSON.stringify(override)}: no active migration promise`,
                !spinner.el.textContent.includes('your files keep moving'));
        });
    }
    push('all observed spinners dispose their polling timers', timers.size === 0);
} finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    dom.window.close();
}

// ───────────────────────────────────────────────────────────────────────────
const failed = checks.filter(c => !c.pass);
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

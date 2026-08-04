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
const dom = new JSDOM('<!doctype html><html><body></body></html>');
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

// ───────────────────────────────────────────────────────────────────────────
const failed = checks.filter(c => !c.pass);
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

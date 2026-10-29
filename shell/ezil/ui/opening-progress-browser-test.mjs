// Real Chromium against the SOURCE opening surface (`computer-progress.js` +
// `app-spinner.js`, bundled on the fly with Bun; the committed shell bundle is
// never read or generated) and the real shell CSS in bundle order
// (`computer-progress.css` before `ezil-shell.css`). No network.
// Proves what jsdom cannot (round 5, D5): the one surface is centred, the bar is
// one thin token-coloured bar that follows the 250 ms paint with a 600 ms
// transition, the elapsed line and the bar never reset across a re-open, dev
// details never paint, actions are 44 px, reduced motion drops the transition,
// the sheen and the sweep, and a phone width never scrolls sideways.
//
// HF3 adds screenshot cases (1200×800 PNG, written to <worktree>/.tmp/hf3/<case>-<tab>.png):
// the opening surface at reached 1 / 3 / 4, and Settings → Computer and System for an
// active, pending, failed, recovered, reopened-after-failure and repeated switch. The
// Settings tabs are the SOURCE modules with their imports stubbed (as computers-test).
//
// PLAYWRIGHT_REQUIRE_DIR=/path/to/existing/node_modules \
// node shell/ezil/ui/opening-progress-browser-test.mjs
// PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an already installed Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
    if ( process.env.PLAYWRIGHT_REQUIRE_DIR ) {
        const external = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'probe.cjs'));
        try { ({ chromium } = external('playwright')); } catch { /* Explicit skip below. */ }
    }
}
if ( ! chromium ) {
    console.error('SKIP: installed Playwright is unavailable; a DOM simulation cannot prove browser behaviour.');
    process.exit(2);
}

const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opening-browser-source-'));
let source, settingsSource;
try {
    const entry = path.join(buildDir, 'entry.js');
    await fs.writeFile(entry, `import { AppSpinner } from ${JSON.stringify(path.join(here, 'app-spinner.js'))};
window.AppSpinner = AppSpinner;`);
    source = execFileSync('bun', ['build', entry, '--target=browser', '--format=iife'], { encoding: 'utf8' });
    // Settings → Computer and System from source, every import stubbed (the replacements of computers-test Part A).
    const settings = path.join(here, 'Settings');
    const stub = (text, pairs) => pairs.reduce((out, [from, to]) => { assert.ok(out.includes(from), `stub target: ${from}`); return out.replace(from, to); }, text);
    const computers = stub(await fs.readFile(path.join(settings, 'tabs/computers.js'), 'utf8'), [
        ["import { isNative } from '../../../native-runtime.js';", 'const isNative = () => false;'],
        ["import { deleteComputerCopy } from '../../../../../app/src/app/computers/_lib/delete-copy.ts';", 'const deleteComputerCopy = () => ({});'],
        ["import UIAlert from '../../../../src/UI/UIAlert.js';", "const UIAlert = async () => 'confirm';"],
        ["import registry from '../../../apps/registry.js';", 'const registry = { launch: async () => undefined };'],
        ["import session from '../../../session.js';", 'const session = { currentComputer: () => null, payload: () => null };'],
        ["import trpc from '../trpc.js';", 'const trpc = { query: async () => ({ ok: false }), mutate: async () => ({ ok: false }) };'],
        ["import TabBilling from './billing.js';", 'const TabBilling = { available: () => true };'],
        ["import { feedback_enabled, open_feedback_dialog } from '../../feedback/feedback.js';", 'const feedback_enabled = () => true, open_feedback_dialog = () => undefined;'],
        ["import { TRANSITION_EVENT } from '../../computer-progress.js';", "const TRANSITION_EVENT = 'ezil:computer-transition';"],
    ]) + '\n// Test only: what the tab records when it renders a transition in flight.\nexport const markSeenInFlight = id => seenInFlight.add(id);\n';
    const system = stub(await fs.readFile(path.join(settings, 'tabs/system.js'), 'utf8'), [
        ["import { isNative, NATIVE_CAPABILITIES, selectRuntimeAdapter } from '../../../native-runtime.js';", 'const isNative = () => false, NATIVE_CAPABILITIES = {}, selectRuntimeAdapter = () => null;'],
        ["import session from '../../../session.js';", 'const session = window.__systemSession;'],
        ["from './system-describe.js';", `from ${JSON.stringify(path.join(settings, 'tabs/system-describe.js'))};`],
    ]);
    assert.ok(! /^import /m.test(computers) && ! /^import (?!.*system-describe)/m.test(system), 'every other import is stubbed');
    await fs.writeFile(path.join(buildDir, 'computers.js'), computers);
    await fs.writeFile(path.join(buildDir, 'system.js'), system);
    await fs.writeFile(path.join(buildDir, 'settings-entry.js'), `import * as computers from './computers.js';
import system from './system.js';
import { summaryV3 } from ${JSON.stringify(path.join(settings, 'billing-v3-fixtures.mjs'))};
window.ComputersTab = computers; window.SystemTab = system; window.summaryV3 = summaryV3;`);
    settingsSource = execFileSync('bun', ['build', path.join(buildDir, 'settings-entry.js'), '--target=browser', '--format=iife'], { encoding: 'utf8' });
} finally { await fs.rm(buildDir, { recursive: true, force: true }); }
const css = (await fs.readFile(path.join(here, 'computer-progress.css'), 'utf8'))
    + (await fs.readFile(path.join(here, 'ezil-shell.css'), 'utf8'));
const settingsCss = await fs.readFile(path.join(here, 'Settings/settings.css'), 'utf8');
const shotDir = path.resolve(here, '../../../.tmp/hf3');

const page_html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}
body { margin: 0; } .window-body { position: relative; width: 100vw; height: 100vh; }
</style></head><body><div class="window-body" id="host"></div></body></html>`;

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let checks = 0;
async function check (label, run) { await run(); checks++; console.log(`PASS ${label}`); }

try {
    for ( const [viewport, reducedMotion] of [[{ width: 1280, height: 800 }, 'no-preference'], [{ width: 390, height: 844 }, 'reduce']] ) {
        const context = await browser.newContext({ viewport, reducedMotion });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(page_html);
        await page.addScriptTag({ content: source });
        const tag = `${viewport.width}px/${reducedMotion}`;

        await check(`${tag}: one centred surface — icon, title, one thin bar, no ring, no app-name line, no sideways scroll`, async () => {
            const box = await page.evaluate(() => {
                document.documentElement.style.setProperty('--ezil-accent', '#7c3bed');
                const s = window.AppSpinner({ label: 'Opening Code…' });
                document.getElementById('host').replaceChildren(s.el);
                s.render({ kind: 'progress' });
                const panel = s.el.querySelector('.ezil-opening');
                const bar = s.el.querySelector('.ezil-opening-bar').getBoundingClientRect();
                const fill = getComputedStyle(s.el.querySelector('.ezil-opening-fill'));
                return { align: getComputedStyle(panel).textAlign, h: bar.height, w: bar.width,
                    centre: Math.abs((bar.left + bar.width / 2) - window.innerWidth / 2), ring: !!s.el.querySelector('.ezil-app-spinner-ring'),
                    animation: fill.animationName, colour: fill.backgroundColor, title: s.el.querySelector('h1').textContent,
                    name: !!s.el.querySelector('.ezil-opening-name'), bg: getComputedStyle(s.el).backgroundColor,
                    overflow: document.documentElement.scrollWidth - window.innerWidth };
            });
            assert.equal(box.align, 'center');
            assert.equal(box.h, 4);
            assert.ok(box.w > 100 && box.w <= 260, String(box.w));
            assert.ok(box.centre < 2, `centred (${box.centre})`);
            assert.equal(box.ring, false);
            assert.equal(box.name, false);
            assert.equal(box.title, 'Opening Code…');
            assert.equal(box.colour, 'rgb(124, 59, 237)', 'the fill is the user accent (--ezil-accent)');
            assert.equal(box.bg, 'rgb(22, 22, 22)', 'dark default background');
            assert.equal(box.overflow, 0, 'no sideways scroll');
            assert.equal(box.animation, reducedMotion === 'reduce' ? 'none' : 'ezil-open-sweep', 'no basis yet: a sweep, not a position');
        });

        await check(`${tag}: observed opening — determinate bar on every paint, 600 ms transition, monotonic and no elapsed reset across a re-open, no dev line painted`, async () => {
            const out = await page.evaluate(async () => {
                const T = new Date(Date.now()).toISOString();
                let payload = { version: 2, computerId: 'qa-computer', operation: 'opening', stage: 'starting', recordedStage: 'starting', active: true,
                    path: 'warm', openingStartedAt: T, expectedSeconds: 240, milestones: [{ key: 'requested', at: T }], updatedAt: T,
                    bytes: { transferred: null, total: null }, percent: null };
                window.__EZIL_BOOT__ = { features: { devDetails: true } };
                window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
                const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
                const s = window.AppSpinner({ computerId: 'qa-computer', label: 'Opening Browser…', className: 'ezil-boot' });
                document.getElementById('host').replaceChildren(s.el);
                s.render({ kind: 'progress' });
                for ( let i = 0; i < 100 && s.el.dataset.progress !== 'observed'; i++ ) await new Promise(r => setTimeout(r, 20));
                const read = () => ({ pct: Number(s.el.querySelector('.ezil-opening-bar').dataset.percent), meta: s.el.querySelector('.ezil-opening-meta').textContent });
                skew = 85_000; s.render({ kind: 'progress' });
                const before = read();
                skew = 86_000; s.stamp(null); s.render({ kind: 'progress' }, { reopening: true });
                const after = read();
                const fill = getComputedStyle(s.el.querySelector('.ezil-opening-fill'));
                const details = s.el.querySelector('details.ezil-opening-details');
                const detailsText = details.querySelector('.ezil-opening-details-text');
                const out = { before, after, transition: fill.transitionDuration, sheen: getComputedStyle(s.el.querySelector('.ezil-opening-fill'), '::after').animationName,
                    detailsOpen: details.open, detailsHidden: details.hidden, devPainted: detailsText.checkVisibility(), devInText: s.el.innerText.includes('Last recorded update'),
                    visible: s.el.innerText, width: s.el.querySelector('.ezil-opening-fill').style.width };
                s.dispose(); Date.now = realNow;
                return out;
            });
            assert.ok(out.before.pct > 5 && out.before.pct < 100, JSON.stringify(out.before));
            assert.equal(out.before.meta, '1:25 · usually about 4 min');
            assert.equal(out.after.meta, '1:26 · usually about 4 min', 'no 1:25 → 0:01 reset');
            assert.ok(out.after.pct >= out.before.pct, JSON.stringify(out));
            assert.equal(out.width, `${out.after.pct}%`, 'the fill width follows the paint');
            assert.equal(out.transition, reducedMotion === 'reduce' ? '0s' : '0.6s, 0.2s');
            assert.equal(out.sheen, reducedMotion === 'reduce' ? 'none' : 'ezil-open-sheen');
            assert.equal(out.detailsHidden, false, 'devDetails on: the details block exists');
            assert.equal(out.detailsOpen, false, 'closed by default');
            assert.equal(out.devPainted, false, 'the dev line is never painted on the surface');
            assert.equal(out.devInText, false, 'nor in the rendered text');
            assert.doesNotMatch(out.visible, /Last recorded update|Next session/);
        });

        await check(`${tag}: attention — amber frozen fill, one 44 px action, no sheen`, async () => {
            const out = await page.evaluate(async () => {
                const T = new Date(Date.now()).toISOString();
                let payload = { version: 2, computerId: 'qa-computer', operation: 'opening', stage: 'starting', recordedStage: 'starting', active: true,
                    path: 'warm', openingStartedAt: T, expectedSeconds: 240, milestones: [{ key: 'requested', at: T }], bytes: { transferred: null, total: null }, percent: null };
                window.__EZIL_BOOT__ = {};
                window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
                const s = window.AppSpinner({ computerId: 'qa-computer', label: 'Opening Browser…' });
                document.getElementById('host').replaceChildren(s.el);
                s.render({ kind: 'progress' });
                for ( let i = 0; i < 100 && s.el.dataset.progress !== 'observed'; i++ ) await new Promise(r => setTimeout(r, 20));
                payload = { ...payload, stage: 'needs_operator', recordedStage: 'unconfirmed', active: false };
                s.dispose();
                const a = window.AppSpinner({ computerId: 'qa-computer', label: 'Opening Browser…' });
                document.getElementById('host').replaceChildren(a.el);
                a.render({ kind: 'progress' });
                for ( let i = 0; i < 100 && a.el.dataset.progress !== 'observed'; i++ ) await new Promise(r => setTimeout(r, 20));
                a.render({ kind: 'failed', reason: 'unknown' });
                const retry = a.el.querySelector('.ezil-boot-retry').getBoundingClientRect();
                const out = { state: a.el.dataset.state, retryH: retry.height, retryW: retry.width,
                    actions: [...a.el.querySelectorAll('.ezil-opening-action')].filter(b => b.getClientRects().length > 0).length,
                    title: a.el.querySelector('h1').textContent };
                a.dispose();
                return out;
            });
            assert.equal(out.state, 'attention');
            assert.equal(out.title, 'Your computer needs attention');
            assert.ok(out.retryH >= 44 && out.retryW >= 44, `${out.retryW}x${out.retryH}`);
            assert.equal(out.actions, 1, 'exactly one action (feedback is off)');
        });
        assert.deepEqual(errors, []);
        await context.close();
    }
    await hf3Screens();
} finally { await browser.close(); }
console.log(`${checks} checks passed`);

/** HF3 screenshots: the opening surface per milestone, and the Computer + System tabs per switch state. */
async function hf3Screens () {
    await fs.mkdir(shotDir, { recursive: true });
    const shots = [];
    const BACK_ON = /back on|Next session|GiB memory\. Applies/i;
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        // ── The opening surface at reached 1 / 3 / 4 (devDetails on: the founder's view) ──
        const keys = ['requested', 'host_claimed', 'files_attached', 'desktop_starting', 'desktop_ready'];
        for ( const [reached, stage, body] of [
            [1, 'leased', 'A machine is ready and starting up.'],
            [3, 'mounting', 'The desktop is starting. Browser opens next.'],
            [4, 'running', 'Almost there — waiting for Browser to connect.'],
        ] ) {
            await page.setContent(page_html);
            await page.addScriptTag({ content: source });
            const startedAt = new Date(Date.now() - 42_000).toISOString();
            const payload = { version: 2, computerId: 'qa-computer', operation: 'opening', stage, recordedStage: stage, active: true, durable: false,
                path: 'warm', openingStartedAt: startedAt, expectedSeconds: 120, milestones: keys.slice(0, reached + 1).map(key => ({ key, at: startedAt })),
                bytes: { transferred: null, total: null }, percent: null, selectedNextOpenHardware: { size: 'xlarge', vcpu: 4, memoryGiB: 16, effective: 'next_open' } };
            const out = await page.evaluate(async payload => {
                window.__EZIL_BOOT__ = { features: { devDetails: true } };
                window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
                const s = window.AppSpinner({ computerId: 'qa-computer', label: 'Opening Browser…' });
                document.getElementById('host').replaceChildren(s.el);
                s.render({ kind: 'progress' });
                for ( let i = 0; i < 100 && s.el.dataset.progress !== 'observed'; i++ ) await new Promise(r => setTimeout(r, 20));
                s.render({ kind: 'progress' });
                const out = { observed: s.el.dataset.progress, status: s.el.querySelector('.ezil-opening-status').textContent,
                    sub: s.el.querySelector('.ezil-opening-status').textContent, text: s.el.innerText,
                    bar: Number(s.el.querySelector('.ezil-opening-bar').dataset.percent) };
                s.dispose();
                return out;
            }, payload);
            await check(`HF3 opening reached ${reached}: "${body}"`, async () => {
                assert.equal(out.observed, 'observed');
                assert.equal(out.sub, body);
                assert.equal(/Almost there/.test(out.text), reached === 4, 'Almost there only at desktop_ready');
                assert.doesNotMatch(out.text, BACK_ON);
                assert.ok(out.bar > 0 && out.bar < 100, String(out.bar));
            });
            // The card fades in after 150 ms (a warm open never shows it); shoot it settled.
            await page.waitForTimeout(400);
            const file = path.join(shotDir, `reached${reached}-opening.png`);
            await page.screenshot({ path: file });
            shots.push(file);
        }

        // ── Settings → Computer and System for each switch state ──
        const settingsHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${settingsCss}
body { margin: 0; font: 14px system-ui, sans-serif; } .ezil-settings-window .window-body { min-height: 100vh; padding: 24px; }
</style></head><body><div class="ezil-settings-window"><div class="window-body"><div class="ezil-settings-content">
<div class="ezil-settings-pane active" data-pane="computers" id="pane"></div><div class="ezil-settings-pane" data-pane="system" id="syspane"></div>
</div></div></div></body></html>`;
        await page.setContent(settingsHtml);
        await page.addScriptTag({ content: `window.html_encode = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.__systemSession = { currentComputer: () => window.__computer, payload: () => null,
    getScreen: async () => ({ ok: true, width: 1280, height: 720 }), getSystemInfo: async () => ({ ok: true, info: window.__systemInfo }) };` });
        await page.addScriptTag({ content: settingsSource });
        const TYPE = { 'std-2': 'm6i.large', 'cmp-4': 'm6i.xlarge', 'cmp-8': 'm6i.2xlarge' };
        const MIB = { 'std-2': 8192, 'cmp-4': 16384, 'cmp-8': 32768 };
        const VCPU = { 'std-2': 2, 'cmp-4': 4, 'cmp-8': 8 };
        const T = '2026-10-29T10:00:00Z';
        const tr = (current, target, phase, extra = {}) => ({ transitionId: `t-${current}-${target}-${phase}`, kind: 'switch', current, target, phase, reason: null,
            requestedAt: T, endedAt: null, revertAvailable: false, ...extra });
        const cases = [
            { name: 'active', on: 'std-2', lifecycle: 'RUNNING', size: 'cmp-4', transition: tr('std-2', 'cmp-4', 'waking'), stage: 'switching', operation: 'opening',
                plan: { status: 'being_prepared', current: 'std-2', selected: 'cmp-4' },
                computer: [/Switching…/, /Now: 2 vCPU · 8 GB/, /Next: 4 vCPU · 16 GB/], system: ['Switching to 4 vCPU / 16 GB', 'Now: 2 vCPU / 8 GB.'] },
            { name: 'pending', on: 'std-2', lifecycle: 'STOPPED', size: 'cmp-4', transition: null, stage: 'stopped', operation: 'none',
                plan: { status: 'ready', current: 'std-2', selected: 'cmp-4' },
                computer: [/Next start: 4 vCPU · 16 GB/, /Start now/, /Stopped/], system: ['2 vCPU / 8 GB on AWS (India)', 'Next start: 4 vCPU / 16 GB.'] },
            { name: 'failed-real', on: 'std-2', lifecycle: 'RUNNING', size: 'std-2', transition: tr('std-2', 'cmp-4', 'failed', { reason: 'wake_timeout', revertAvailable: true, endedAt: T }),
                stage: 'running', operation: 'none', plan: { status: 'failed', reason: 'wake_timeout', current: 'std-2', selected: 'std-2' },
                computer: [/We couldn't switch to 4 vCPU · 16 GB\. Your computer is on 2 vCPU · 8 GB and your files are safe\./, /Try again/, /Needs attention/],
                notComputer: /Back to/, system: ["Switch to 4 vCPU / 16 GB didn't finish", 'Your computer is on 2 vCPU / 8 GB. Your files are safe. Try again from Settings → Computer.'] },
            { name: 'recovered', on: 'cmp-4', lifecycle: 'RUNNING', size: 'cmp-4', transition: tr('std-2', 'cmp-4', 'done', { endedAt: T }), seen: true,
                stage: 'running', operation: 'none', plan: { status: 'ready', current: 'cmp-4', selected: 'cmp-4' }, planTransition: null,
                computer: [/Now running on 4 vCPU · 16 GB/, /Open desktop/, /Running/], notComputer: /couldn't switch|Needs attention/, system: ['4 vCPU / 16 GB on AWS (India)', ''] },
            { name: 'reopened-after-failure', on: 'cmp-4', lifecycle: 'RUNNING', size: 'cmp-4', transition: null, stage: 'running', operation: 'none',
                plan: { status: 'ready', current: 'cmp-4', selected: 'cmp-4' },
                computer: [/Running/, /4 vCPU · 16 GB memory/], notComputer: /couldn't switch|switch-failed|Now running on|Needs attention/, system: ['4 vCPU / 16 GB on AWS (India)', ''] },
            { name: 'repeated', on: 'cmp-4', lifecycle: 'RUNNING', size: 'cmp-8', transition: tr('cmp-4', 'cmp-8', 'waking'), stage: 'switching', operation: 'opening',
                plan: { status: 'being_prepared', current: 'cmp-4', selected: 'cmp-8' },
                computer: [/Switching…/, /Now: 4 vCPU · 16 GB/, /Next: 8 vCPU · 32 GB/], notComputer: /couldn't switch/, system: ['Switching to 8 vCPU / 32 GB', 'Now: 4 vCPU / 16 GB.'] },
        ];
        for ( const c of cases ) {
            const prog = { version: 2, computerId: 'c-1', operation: c.operation, stage: c.stage, lifecycleState: c.lifecycle, needsOperator: false, transition: c.transition,
                hardware: { instanceType: TYPE[c.on], source: 'placement' }, openingStartedAt: c.operation === 'opening' ? T : null, observedAt: '2026-10-29T10:00:40Z',
                expectedSeconds: 150, milestones: c.operation === 'opening' ? [{ key: 'requested', at: T }, { key: 'host_claimed', at: '2026-10-29T10:00:30Z' }] : [] };
            const transition = c.planTransition === null ? null : c.transition;
            const info = { provider: 'aws-ec2', providerSource: 'placement', lifecycleState: c.lifecycle, usage: null,
                machine: { vcpu: VCPU[c.on], memoryMiB: MIB[c.on], instanceType: TYPE[c.on], region: 'ap-south-1', source: 'configured' },
                image: { id: 'ezil-os-image-hf3', source: 'running' },
                plan: { standing: 'paid', vcpu: VCPU[c.plan.selected], memoryGB: MIB[c.plan.selected] / 1024, region: 'ap-south-1', reason: null, outcome: null, ...c.plan,
                    transition: transition && transition.phase !== 'done' ? transition : null } };
            const out = await page.evaluate(async ({ prog, info, size, seen }) => {
                const me = { id: 'c-1', name: 'My computer', slot: 1, createdAt: '2026-10-01T00:00:00Z', lastOpenedAt: null };
                const data = window.summaryV3('premium');
                data.computer = { ...data.computer, size, disk: { provisionedGiB: 50, usedBytes: null } };
                const tab = window.ComputersTab;
                if ( seen ) tab.markSeenInFlight(prog.transition.transitionId);
                const model = tab.computerModel({ computer: me, data, prog });
                const pane = document.getElementById('pane');
                pane.innerHTML = tab.computerHtml(model, prog, []);
                const computerText = pane.textContent.replace(/\s+/g, ' ');
                // System: the real tab paint, fed the System info through its session stub.
                // A fresh id per case resets the tab's last reading, so the row below is this case's.
                const linked = { ...me, id: `c-1-${Math.random().toString(36).slice(2, 8)}` };
                window.__computer = linked; window.__systemInfo = info;
                const sys = document.getElementById('syspane');
                const $win = { off () { return this; }, on () { return this; } };
                window.SystemTab.onDeactivate();
                sys.innerHTML = window.SystemTab.html();
                window.SystemTab.init($win, { computer: linked });
                window.SystemTab.onActivate($win, { computer: linked });
                for ( let i = 0; i < 50 && ! /AWS \(India\)/.test(sys.textContent); i++ ) await new Promise(r => setTimeout(r, 20));
                const row = sys.querySelector('[data-role="sys-configuration"]');
                return { computerText, html: pane.innerHTML, value: row?.querySelector('.ezil-sys-v')?.textContent ?? null,
                    hint: row?.querySelector('.ezil-sys-h')?.textContent ?? '', systemText: sys.textContent.replace(/\s+/g, ' ') };
            }, { prog, info, size: c.size, seen: !! c.seen });
            await check(`HF3 ${c.name}: Computer tab shows the truthful state`, async () => {
                for ( const re of c.computer ) assert.match(out.computerText, re, `${c.name}: ${out.computerText}`);
                if ( c.notComputer ) assert.doesNotMatch(out.computerText, c.notComputer);
                assert.doesNotMatch(out.computerText, BACK_ON);
                if ( c.name === 'failed-real' ) assert.doesNotMatch(out.html, /data-action="switch-back"/, 'never Back to the size it runs');
            });
            await check(`HF3 ${c.name}: System tab Configuration row`, async () => {
                assert.equal(out.value, c.system[0]);
                assert.equal(out.hint, c.system[1]);
                assert.doesNotMatch(out.systemText, BACK_ON);
            });
            for ( const [tab, pane] of [['computer', 'pane'], ['system', 'syspane']] ) {
                await page.evaluate(([show, hide]) => {
                    document.getElementById(show).classList.add('active'); document.getElementById(hide).classList.remove('active');
                    window.scrollTo(0, 0);
                }, pane === 'pane' ? ['pane', 'syspane'] : ['syspane', 'pane']);
                const file = path.join(shotDir, `${c.name}-${tab}.png`);
                await page.screenshot({ path: file });
                shots.push(file);
            }
        }
        await page.evaluate(() => window.SystemTab.onDeactivate());
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
    console.log(`HF3 screenshots (${shots.length}):\n${shots.join('\n')}`);
}

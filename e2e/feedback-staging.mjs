#!/usr/bin/env node
/**
 * Opt-in synthetic Feedback check on os-staging (round 3, acceptance E1).
 * Importing this file reads no credentials, loads no Playwright and makes no
 * request. Without E2E_CREDS_FILE it prints {"feedback":"SKIP"} and exits 2.
 *
 *   E2E_CREDS_FILE=<json {email,password}> [E2E_BASE_URL=https://os-staging.ezil.work]
 *   [E2E_OUT=e2e-results/feedback-staging-<run>] node e2e/feedback-staging.mjs
 *
 * Signs in by email/password (e2e/billing-staging-journey.mjs's path and its
 * redaction helpers), opens Settings → Troubleshoot → "Report a problem",
 * submits ONE report whose description starts with "[synthetic r3]" and the
 * run id (diagnostics consent on, no screenshot), expects 201 and the
 * "Thanks — we got it" outcome, finds it under "Your reports", then deletes it
 * through the same UI (204) and checks it is gone. It never reads the
 * database: the DB/admin readback of E1 is the release owner's.
 * Exit: 0 every step passed, 1 any step failed, 2 skipped (no credentials).
 * Only fixed step ids/statuses are printed; results.json is redacted.
 *
 * Selector references: shell/ezil/ui/Settings/index.js (data-tab/data-pane),
 * shell/ezil/ui/Settings/tabs/troubleshoot.js (report-problem, load-reports,
 * feedback-reports), shell/ezil/ui/feedback/feedback.js (dialog, result).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { closeApp, createRedactor, guardPlaywright, redactEvidence } from './billing-staging-journey.mjs';

export const STEP_IDS = ['health', 'sign_in', 'open_form', 'submit', 'listed', 'deleted'];
const elapsed = start => Math.round(performance.now() - start);
const dock = (page, id) => page.locator(`.taskbar-item[data-app="${id}"]`).first();
const appWindow = (page, id) => page.locator(`.window[data-app="${id}"]:not([data-closing="1"])`).last();
const FEEDBACK_PATH = '/api/shell/feedback';

async function loadPlaywright() {
    for (const url of [import.meta.url, new URL('../app/package.json', import.meta.url), new URL('../shell/package.json', import.meta.url)]) {
        for (const name of ['playwright', '@playwright/test']) {
            try { return createRequire(url)(name); } catch { /* Try existing local dependencies only. */ }
        }
    }
    throw new Error('Playwright is not installed locally; install it and Chromium before running this check');
}

async function troubleshootPane(page) {
    if (!await appWindow(page, 'settings').count()) await dock(page, 'settings').click();
    const win = appWindow(page, 'settings');
    await win.locator('[data-tab="troubleshoot"]').click();
    const pane = win.locator('[data-pane="troubleshoot"]');
    await pane.waitFor({ state: 'visible' });
    return pane;
}

export async function main(env = process.env) {
    const runId = randomUUID();
    const marker = `[synthetic r3] ${runId}`;
    const report = { runId, startedAt: new Date().toISOString(), steps: [] };
    if (!env.E2E_CREDS_FILE) {
        process.stdout.write('{"feedback":"SKIP"}\n');
        process.exitCode = 2;
        return { ...report, skipped: 'E2E_CREDS_FILE is not set' };
    }
    const out = resolve(env.E2E_OUT || `e2e-results/feedback-staging-${runId}`);
    let redact = createRedactor(), browser, page, credentials, reportId = null;
    const originalWrites = [process.stdout.write, process.stderr.write];
    let outputGuarded = false;
    const save = async () => {
        await mkdir(out, { recursive: true });
        await writeFile(join(out, 'results.json'), JSON.stringify(redactEvidence(report, redact), null, 2) + '\n', { mode: 0o600 });
    };
    const record = async (id, work, skip) => {
        const start = performance.now();
        const step = { id, status: skip ? 'SKIP' : 'PASS', ms: 0, evidence: {} };
        try {
            if (skip) step.reason = skip;
            else await work(step.evidence);
        } catch (error) {
            step.status = 'FAIL'; step.evidence.error = redact(error);
        }
        step.ms = elapsed(start);
        report.steps.push(redactEvidence(step, redact));
        await save();
        return step.status === 'PASS';
    };
    try {
        // Suppress JSON parse/read diagnostics, which can include the file contents.
        try { credentials = JSON.parse(await readFile(env.E2E_CREDS_FILE, 'utf8')); }
        catch { throw new Error('E2E_CREDS_FILE must identify a readable JSON credentials file'); }
        redact = createRedactor(credentials ?? {});
        if (typeof credentials?.email !== 'string' || !credentials.email
            || typeof credentials?.password !== 'string' || !credentials.password) throw new Error('Credentials require nonempty email and password strings');
        for (const [index, stream] of [process.stdout, process.stderr].entries()) {
            stream.write = function (chunk, ...args) {
                return originalWrites[index].call(this, redact(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk), ...args);
            };
        }
        outputGuarded = true;
        const base = new URL(env.E2E_BASE_URL || 'https://os-staging.ezil.work');
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('E2E_BASE_URL must be an HTTP(S) URL without user information');
        report.baseUrl = base.origin; report.marker = marker;
        await save();

        await record('health', async evidence => {
            const response = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(20_000) });
            evidence.httpStatus = response.status;
            // The deployed SHA the report is expected to carry (admin/DB readback).
            evidence.sha = (await response.json()).sha ?? null;
            if (!response.ok || !evidence.sha) throw new Error(`Health returned HTTP ${response.status} without a sha`);
        });
        const playwright = guardPlaywright(await loadPlaywright(), redact);
        browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(60_000);
        const signedIn = await record('sign_in', async () => {
            await page.goto(new URL('/login?method=email', base).href, { waitUntil: 'domcontentloaded' });
            await page.locator('input[type="email"]').fill(credentials.email);
            await page.locator('input[type="password"]').fill(credentials.password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            await page.waitForURL(url => url.origin === base.origin && /^\/os\/?$/.test(url.pathname));
            await dock(page, 'settings').waitFor({ state: 'visible' });
        });
        const dialog = page.locator('dialog.ezil-feedback-dialog');
        const formOpen = await record('open_form', async evidence => {
            evidence.chipVisible = await page.locator('button.ezil-feedback-chip').isVisible();
            const pane = await troubleshootPane(page);
            const entry = pane.locator('[data-action="report-problem"]');
            if (!await entry.count()) throw new Error('No "Report a problem" entry: feedback is not enabled for this account (EZIL_OS_FEEDBACK / pilot list)');
            await entry.click();
            await dialog.waitFor({ state: 'visible' });
        }, signedIn ? null : 'sign_in_failed');
        const submitted = await record('submit', async evidence => {
            await dialog.locator('#ezil-feedback-description').fill(marker);
            await dialog.locator('input[name="diagnostics"]').check();
            const preview = JSON.parse(await dialog.locator('.ezil-feedback-preview pre').textContent());
            evidence.clientRequestId = preview.clientRequestId;
            evidence.diagnosticsKeys = Object.keys(preview.diagnostics ?? {}).sort();
            const responded = page.waitForResponse(r => new URL(r.url()).pathname === FEEDBACK_PATH && r.request().method() === 'POST');
            await dialog.locator('button[type="submit"]').click();
            const response = await responded;
            evidence.httpStatus = response.status();
            if (response.status() !== 201) throw new Error(`POST ${FEEDBACK_PATH} returned ${response.status()}, expected 201`);
            reportId = (await response.json()).id;
            evidence.reportId = reportId;
            await dialog.locator('.ezil-feedback-result', { hasText: 'Thanks — we got it' }).waitFor();
            await dialog.locator('[data-action="cancel"]').click();
            await dialog.waitFor({ state: 'detached' });
        }, formOpen ? null : 'form_unavailable');
        const row = () => appWindow(page, 'settings').locator('[data-role="feedback-reports"] li', { hasText: marker });
        const listed = await record('listed', async () => {
            const pane = await troubleshootPane(page);
            await pane.locator('[data-action="load-reports"]').click();
            await row().waitFor({ state: 'visible' });
        }, submitted ? null : 'submit_failed');
        await record('deleted', async evidence => {
            page.once('dialog', confirm => { void confirm.accept(); });
            const responded = page.waitForResponse(r => new URL(r.url()).pathname === FEEDBACK_PATH && r.request().method() === 'DELETE');
            await row().locator('button', { hasText: 'Delete' }).click();
            const response = await responded;
            evidence.httpStatus = response.status();
            if (response.status() !== 204) throw new Error(`DELETE ${FEEDBACK_PATH} returned ${response.status()}, expected 204`);
            await row().waitFor({ state: 'detached' });
        }, listed ? null : submitted ? 'not_listed' : 'submit_failed');
        // Leave Settings closed so a following journey starts from the desktop.
        await closeApp(page, 'settings').catch(() => {});
    } catch (error) {
        report.steps.push({ id: 'setup', status: 'FAIL', ms: 0, evidence: { error: redact(error) } });
    } finally {
        if (browser) await browser.close().catch(() => {});
        for (const id of STEP_IDS) if (!report.steps.some(step => step.id === id)) {
            report.steps.push({ id, status: 'SKIP', reason: 'setup_failed', ms: 0, evidence: {} });
        }
        if (reportId && !report.steps.some(step => step.id === 'deleted' && step.status === 'PASS')) {
            // The report could not be removed through the UI: name it (no content) for manual cleanup.
            report.leftover = { reportId, marker };
        }
        report.finishedAt = new Date().toISOString();
        await save().catch(() => {});
        const statuses = Object.fromEntries(report.steps.map(step => [step.id, step.status]));
        process.stdout.write(JSON.stringify(statuses) + '\n');
        if (outputGuarded) { process.stdout.write = originalWrites[0]; process.stderr.write = originalWrites[1]; }
        process.exitCode = report.steps.some(step => step.status === 'FAIL') ? 1
            : report.steps.every(step => step.status === 'PASS') ? 0 : 1;
    }
    return redactEvidence(report, redact);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main().catch(() => {
        process.stdout.write('{"setup":"FAIL"}\n');
        process.exitCode = 1;
    });
}

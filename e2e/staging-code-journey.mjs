/** Staging-only browser checks. The caller supplies verified release evidence and a dedicated account. */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { appRequest, configureAppContext } from './deployed-target.mjs';
import { classifyStartFailure, readWindowSnapshot, userReadiness } from './prod-journeys.mjs';

const CODE_MINT = '/api/shell/code-preview-url';
const CODE_WINDOW = '.window[data-app="code"]:not([data-closing="1"])';
const CODE_FRAME = CODE_WINDOW + ' iframe.window-app-iframe';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REPOSITORY = /^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}\.git$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BOOT_TIMEOUT = 230_000;
const AUTH_TIMEOUT = 20_000;
const CODE_ERROR = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const now = () => new Date().toISOString();

class CheckError extends Error {
    constructor(status, message, evidence = {}) {
        super(message);
        this.status = status;
        this.evidence = evidence;
    }
}

const blocked = message => new CheckError('blocked', message);
const failed = (message, evidence) => new CheckError('fail', message, evidence);

function fixtureInput(target, repo, storageState) {
    const value = target instanceof URL ? target : target?.app ?? target?.origin ?? target;
    let app;
    try { app = new URL(value); } catch { throw blocked('A verified staging origin is required'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname);
    if (app.username || app.password || app.search || app.hash || app.pathname !== '/'
        || !(app.origin === 'https://os-staging.ezil.work' || loopback && app.protocol === 'http:')) {
        throw blocked('The browser journey requires the staging origin or a loopback fixture');
    }
    if (!storageState) throw blocked('An authorized staging storage state is required');
    if (!repo || typeof repo.url !== 'string' || !REPOSITORY.test(repo.url)
        || repo.url.includes('..') || repo.url.endsWith('.git.git') || repo.url !== repo.fixtureUrl) {
        throw blocked('An explicitly fenced private Git fixture is required');
    }
    if (!UUID.test(repo.computerId ?? '')) throw blocked('An explicit fixture computer is required');
    const expectedFile = repo.expectedFile ?? 'README.md';
    if (typeof expectedFile !== 'string' || !FILE.test(expectedFile) || expectedFile.endsWith('.') || expectedFile.includes('..')) {
        throw blocked('A single tracked fixture filename is required');
    }
    if (repo.expectedText !== undefined
        && (typeof repo.expectedText !== 'string' || !repo.expectedText.trim() || repo.expectedText.length > 160)) {
        throw blocked('The expected fixture text must be a short synthetic marker');
    }
    return { app: app.origin, headers: target?.headers ?? {}, expectedFile, loopback };
}

function createChecks() {
    const startedAt = now();
    const checks = [];
    const run = async (name, work, prerequisite, skip) => {
        const began = performance.now();
        let status = 'pass', detail, evidence = {};
        try {
            if (prerequisite) throw blocked(prerequisite);
            if (skip) throw new CheckError('skip', skip);
            evidence = await work() ?? {};
        } catch (error) {
            if (error instanceof CheckError) {
                status = error.status;
                detail = error.message;
                evidence = error.evidence;
            } else {
                // Playwright errors may contain private frame URLs, locator values or credentials.
                status = 'fail';
                detail = 'The browser operation did not complete';
            }
        }
        checks.push({ name, status, ...(detail && { detail }), evidence, observedAt: now(), elapsedMs: Math.round(performance.now() - began) });
        return status === 'pass';
    };
    return { run, complete: () => ({ startedAt, completedAt: now(), checks }) };
}

async function until(read, timeout, onTimeout) {
    const end = performance.now() + timeout;
    do {
        const value = await read();
        if (value) return value;
        await sleep(200);
    } while (performance.now() < end);
    throw onTimeout();
}

function targetPath(page, app, expected) {
    const url = new URL(page.url());
    if (url.origin !== app || url.pathname.startsWith('/login') || url.pathname.startsWith('/auth/')) {
        throw blocked('The authorized browser state did not establish the staging session');
    }
    if (!expected.includes(url.pathname)) throw failed('The browser navigated away from the expected staging route');
    return url;
}

async function verifyFixtureComputer(page, id) {
    const deadline = performance.now() + AUTH_TIMEOUT;
    do {
        const matches = await page.evaluate(expected => {
            const current = window.__EZIL_BOOT__?.computer?.id;
            return typeof current === 'string' ? current === expected : null;
        }, id).catch(() => null);
        if (matches === true) return;
        if (matches === false) throw blocked('The session selected a different computer');
        await sleep(150);
    } while (performance.now() < deadline);
    throw blocked('The browser did not expose an authoritative computer binding');
}

async function verifySessionComputer(context, { app, headers }, id) {
    let payload;
    try {
        const response = await context.request.get(new URL('/api/shell/session', app).href,
            { headers, maxRedirects: 0, timeout: AUTH_TIMEOUT });
        if (response.ok()) payload = await response.json();
    } catch { /* No browser state, request headers, or account payload in evidence. */ }
    if (typeof payload?.computer?.id !== 'string') {
        throw blocked('The read-only session lookup did not establish an authorized computer');
    }
    if (payload.computer.id !== id) throw blocked('The read-only session lookup selected a different computer');
}

function mintFence(app, repo) {
    let active = false;
    const validate = (url, options) => {
        if (new URL(url).pathname !== CODE_MINT) return true;
        if (!active || options.method !== 'POST') return false;
        let body;
        try { body = JSON.parse(options.body?.toString() ?? ''); } catch { return false; }
        return body?.computerId === repo.computerId && body?.repository?.url === repo.url
            && body.intent === 'open' && !body.codeFolder && !body.project;
    };
    return {
        enable: () => { active = true; },
        send: (url, options) => validate(url, options) ? appRequest(url, options) :
            Promise.resolve({ status: 403, headers: { 'content-type': 'application/json' },
                body: Buffer.from(JSON.stringify({ error: { code: 'fixture_mint_refused' } })) }),
        isMint: response => {
            const url = new URL(response.url());
            return url.origin === app && url.pathname === CODE_MINT && response.request().method() === 'POST';
        },
    };
}

function observeMints(page, fence, loopback) {
    const events = [];
    page.on('response', async response => {
        if (!fence.isMint(response)) return;
        const status = response.status();
        const event = { status };
        events.push(event);
        let body;
        try { body = await response.json(); } catch { return; }
        const errorCode = body?.error?.code ?? body?.errorCode;
        if (typeof errorCode === 'string' && CODE_ERROR.test(errorCode)) event.code = errorCode;
        if (!response.ok() || body?.ok !== true || !UUID.test(body.repository?.id ?? '')) return;
        let preview;
        try { preview = new URL(body.codePreviewUrl); } catch { return; }
        if (preview.username || preview.password
            || !(preview.protocol === 'https:' || loopback && preview.protocol === 'http:'
                && ['localhost', '127.0.0.1', '[::1]'].includes(preview.hostname))) return;
        const folders = preview.searchParams.getAll('folder');
        if (folders.length !== 1 || !folders[0].endsWith('/projects/' + body.repository.id)) return;
        event.checkout = { origin: preview.origin, folder: folders[0], id: body.repository.id };
    });
    return events;
}

function mintTimeout(mints) {
    const last = mints.at(-1);
    if (last?.code === 'IDENTITY_REFRESH_REQUIRED' || last?.status === 401) {
        return blocked('The staging session has no retained identity for the private fixture');
    }
    return failed('The private repository did not mint a matching Code checkout',
        last ? { httpStatus: last.status, ...(last.code && { code: last.code }) } : {});
}

async function waitCheckout(page, app, repo, readMints, timeLimit) {
    return until(async () => {
        const url = targetPath(page, app, ['/app/code']);
        if (url.searchParams.getAll('repo').length !== 1 || url.searchParams.get('repo') !== repo.url
            || url.searchParams.has('folder') || url.searchParams.has('project')) {
            throw failed('Code lost or changed the fenced repository link');
        }
        const mint = readMints().find(event => event.checkout)?.checkout;
        if (!mint) return null;
        const element = await page.locator(CODE_FRAME).first().elementHandle({ timeout: 500 }).catch(() => null);
        if (!element) return null;
        let frame;
        try { frame = await element.contentFrame(); } finally { await element.dispose().catch(() => {}); }
        if (!frame) return null;
        let address;
        try { address = new URL(frame.url()); } catch { return null; }
        if (address.origin !== mint.origin || address.searchParams.getAll('folder').length !== 1
            || address.searchParams.get('folder') !== mint.folder) return null;
        const snapshot = await page.evaluate(readWindowSnapshot, 'code');
        const failure = classifyStartFailure(snapshot);
        if (failure) throw failed('Code displayed an opening failure', { kind: failure.kind });
        const contentReady = await frame.locator('.monaco-workbench').isVisible().catch(() => false);
        const stateCovered = await page.locator(CODE_WINDOW + ' .ezil-code-state').first().isVisible().catch(() => false);
        return userReadiness({ snapshot, contentReady }).ready && !stateCovered ? { mint, frame } : null;
    }, timeLimit, () => mintTimeout(readMints()));
}

function editorTab(frame, filename) {
    return frame.locator('.part.editor .tab').filter({ hasText: filename }).first();
}

async function verifyKnownFile(frame, filename, expectedText, timeLimit, { reopen = false } = {}) {
    const tab = editorTab(frame, filename);
    const alreadyOpen = await tab.isVisible().catch(() => false);
    if (!alreadyOpen) {
        const tree = frame.locator('.explorer-folders-view').getByRole('treeitem', { name: filename, exact: true }).first();
        try { await tree.dblclick({ timeout: timeLimit }); }
        catch { throw failed('The known fixture file did not open from Explorer'); }
    }
    try { await tab.waitFor({ state: 'visible', timeout: timeLimit }); }
    catch { throw failed('The known fixture editor tab did not appear'); }
    if (expectedText) {
        await until(async () => {
            const contents = await frame.locator('.part.editor .editor-instance .monaco-editor .view-lines')
                .allTextContents().catch(() => []);
            return contents.some(value => value.replace(/\u00a0/g, ' ').includes(expectedText));
        }, timeLimit, () => failed('The known fixture marker was not visible in the editor'));
    }
    return { fixtureFileOpened: true, markerMatched: Boolean(expectedText), ...(reopen && { editorTabRestored: alreadyOpen }) };
}

async function prepareSameWindowTab(page) {
    const context = page.context();
    let browserCdp, other;
    try {
        await page.bringToFront();
        const mainCdp = await context.newCDPSession(page);
        browserCdp = await context.browser().newBrowserCDPSession();
        const { targetInfo } = await mainCdp.send('Target.getTargetInfo');
        const { windowId } = await mainCdp.send('Browser.getWindowForTarget');
        if (!targetInfo.browserContextId || !Number.isInteger(windowId)) {
            throw blocked('The browser did not expose a verifiable tab context');
        }
        await mainCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        const [tab, { targetId }] = await Promise.all([
            context.waitForEvent('page', { timeout: 5000 }),
            browserCdp.send('Target.createTarget', {
                url: 'about:blank', browserContextId: targetInfo.browserContextId, newWindow: false, background: true,
            }),
        ]);
        other = tab;
        const otherCdp = await context.newCDPSession(other);
        const { targetInfo: otherInfo } = await otherCdp.send('Target.getTargetInfo');
        const { windowId: otherWindow } = await otherCdp.send('Browser.getWindowForTarget');
        if (targetId !== otherInfo.targetId || windowId !== otherWindow) {
            throw blocked('The probe did not open a tab in the same browser window');
        }
        await otherCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        // Verify that the browser can perform and observe the switch before
        // using any inference capacity. The same tab is reused during the turn.
        await other.bringToFront();
        await until(() => page.evaluate(() => !document.hasFocus()), 5000, () => blocked('Code did not lose browser focus'));
        await page.bringToFront();
        await until(() => page.evaluate(() => document.hasFocus()), 5000, () => blocked('Code did not regain browser focus'));
        return other;
    } catch (error) {
        await other?.close().catch(() => {});
        if (error instanceof CheckError) throw error;
        throw blocked('The browser could not prepare a verifiable same-window tab');
    } finally {
        await browserCdp?.detach().catch(() => {});
    }
}

async function runBackgroundAgent(page, frame, repo, timeLimit) {
    if (!repo.allowAgent || typeof repo.modelName !== 'string' || !repo.modelName.trim()) {
        throw blocked('A separately authorized synthetic agent fixture and model are required');
    }
    const side = frame.locator('.part.auxiliarybar');
    const newChat = side.getByRole('button', { name: /^New Chat(?:\b|$)/i }).first();
    if (!await newChat.isVisible().catch(() => false)) throw blocked('A fresh synthetic chat could not be established');
    await newChat.click();
    // A text instruction alone cannot prevent file-changing tools. Keep the
    // live probe in the workbench's read-only Ask mode or send nothing.
    const mode = side.locator('.chat-input-toolbar .action-item.chat-input-picker-item:not(.model-picker-item) .action-label').first();
    const readOnly = async () => (await mode.innerText({ timeout: 1000 }).catch(() => '')).trim() === 'Ask';
    if (!await readOnly()) {
        try {
            await mode.click({ timeout: 2000 });
            const rows = frame.locator('.action-widget .monaco-list-row, .context-view .monaco-list-row');
            await rows.getByText('Ask', { exact: true }).first().click({ timeout: 2000 });
        } catch { throw blocked('The fixture could not select read-only Ask mode'); }
        await until(readOnly, 3000, () => blocked('Read-only Ask mode was not confirmed'));
    }
    const model = side.locator('.action-label[aria-label^="Models, "]').first();
    const modelName = 'Models, ' + repo.modelName;
    await until(async () => (await model.getAttribute('aria-label', { timeout: 1000 }).catch(() => '')) === modelName,
        Math.min(timeLimit, AUTH_TIMEOUT), () => blocked('The authorized fixture model was not selected'));
    const chat = side.locator('.interactive-list').first();
    if (await chat.locator('.interactive-request').count()) throw blocked('The synthetic chat was not empty');
    const input = side.locator('.chat-input-container .monaco-editor').first();
    const marker = 'EZILQAPROBE' + randomUUID().replaceAll('-', '').slice(0, 12);
    const instruction = 'Reply with exactly ' + marker + '. Do not use tools or change any files.';
    const other = await prepareSameWindowTab(page);
    try {
        const stamp = await frame.evaluate(() => window.ezilQaFixtureDocument = crypto.randomUUID());
        await input.locator('.view-lines').first().click({ force: true });
        await page.keyboard.type(instruction, { delay: 3 });
        const typed = await input.innerText().catch(() => '');
        if (!typed.replace(/\s/g, '').includes(marker)) throw blocked('The synthetic prompt was not verified in the input');
        if (!await readOnly() || (await model.getAttribute('aria-label', { timeout: 1000 }).catch(() => '')) !== modelName) {
            throw blocked('The authorized model or read-only mode changed before submission');
        }
        const pending = frame.locator('.interactive-response.chat-response-loading').last();
        const replies = chat.locator('.interactive-response .rendered-markdown').getByText(marker, { exact: true });
        await page.keyboard.press('Enter');
        await until(async () => {
            if (await replies.count()) throw blocked('The response completed before a pending turn could be observed');
            return await pending.isVisible();
        }, Math.min(timeLimit, AUTH_TIMEOUT), () => blocked('No pending response was observed for the synthetic prompt'));
        await other.bringToFront();
        await until(() => page.evaluate(() => !document.hasFocus()), 5000, () => blocked('Code did not lose browser focus'));
        if (!await pending.isVisible()) throw blocked('The response was no longer pending when Code lost focus');
        const backgroundVisibility = await page.evaluate(() => document.visibilityState);
        await until(async () => {
            if (await chat.locator('.chat-notification-widget:has(.chat-error-codicon)').first().isVisible()) {
                throw failed('The synthetic reply displayed an error');
            }
            return await replies.count();
        }, timeLimit, () => failed('The synthetic reply did not finish while Code was in the background'));
        await page.bringToFront();
        await until(() => page.evaluate(() => document.hasFocus()), 5000, () => failed('Code did not regain browser focus'));
        if (await frame.evaluate(() => window.ezilQaFixtureDocument).catch(() => null) !== stamp) {
            throw failed('The Code document changed during a browser tab switch');
        }
        await until(() => replies.first().isVisible(), Math.min(timeLimit, 5000),
            () => failed('The synthetic reply was not visible on return'));
        if (await replies.count() !== 1 || await chat.locator('.interactive-request').count() !== 1) {
            throw failed('The fixture did not show exactly one submitted prompt and one reply');
        }
        return { mode: 'ask', submissionsObserved: 1, repliesObserved: 1, pendingWhenBackgrounded: true, backgroundVisibility,
            sameBrowserWindow: true, sameCodeDocument: true };
    } finally {
        await page.bringToFront().catch(() => {});
        await other.close().catch(() => {});
    }
}

/**
 * Returns observed browser checks only. Build identity, runtime identity and
 * release qualification belong to the orchestrator and have separate evidence.
 */
export async function runCodeJourney({ browser, target, repo, storageState, evidence = {} }) {
    const checks = createChecks();
    let inputs, context, page, fence, mints, initial, reopened;
    const timeLimit = Number.isFinite(evidence.timeoutMs) ? Math.min(BOOT_TIMEOUT, Math.max(1_000, evidence.timeoutMs)) : BOOT_TIMEOUT;
    const fileTimeLimit = Math.min(30_000, timeLimit);
    const configured = await checks.run('fixture_configuration', () => {
        inputs = fixtureInput(target, repo, storageState);
        if (!browser?.newContext) throw blocked('Playwright browser is required');
        return { fencedRepository: true, explicitComputer: true, storageStateProvided: true };
    });
    try {
        const authenticated = await checks.run('authenticated_isolated_computer', async () => {
            try { context = await browser.newContext({ storageState, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } }); }
            catch { throw blocked('The authorized browser state could not be loaded'); }
            await verifySessionComputer(context, inputs, repo.computerId);
            fence = mintFence(inputs.app, repo);
            await configureAppContext(context, { app: inputs.app, headers: inputs.headers, send: fence.send });
            page = await context.newPage();
            page.setDefaultTimeout(fileTimeLimit);
            page.setDefaultNavigationTimeout(timeLimit);
            mints = observeMints(page, fence, inputs.loopback);
            const desktop = new URL('/os', inputs.app);
            desktop.searchParams.set('computer', repo.computerId);
            await page.goto(desktop.href, { waitUntil: 'domcontentloaded' });
            targetPath(page, inputs.app, ['/os', '/']);
            await verifyFixtureComputer(page, repo.computerId);
            fence.enable();
            return { readOnlySessionMatched: true, bootComputerMatched: true };
        }, !configured && 'Fixture configuration was blocked');
        const checkout = await checks.run('private_repo_checkout', async () => {
            const route = new URL('/app/code', inputs.app);
            route.searchParams.set('repo', repo.url);
            route.searchParams.set('computer', repo.computerId);
            await page.goto(route.href, { waitUntil: 'domcontentloaded' });
            targetPath(page, inputs.app, ['/app/code']);
            await verifyFixtureComputer(page, repo.computerId);
            initial = await waitCheckout(page, inputs.app, repo, () => mints, timeLimit);
            return { serverMintMatched: true, editorWorkspaceMatched: true,
                ...await verifyKnownFile(initial.frame, inputs.expectedFile, repo.expectedText, fileTimeLimit) };
        }, !authenticated && 'The fixture computer was not verified');
        const reloaded = await checks.run('code_full_reload', async () => {
            if (!page) throw failed('The initial Code page was unavailable');
            const priorMintCount = mints.length;
            const priorDocument = await initial.frame.evaluate(() => window.ezilQaFixtureDocument = crypto.randomUUID());
            await page.reload({ waitUntil: 'domcontentloaded' });
            targetPath(page, inputs.app, ['/app/code']);
            await verifyFixtureComputer(page, repo.computerId);
            reopened = await waitCheckout(page, inputs.app, repo, () => mints.slice(priorMintCount), timeLimit);
            if (reopened.mint.id !== initial.mint.id || reopened.mint.folder !== initial.mint.folder
                || await reopened.frame.evaluate(() => window.ezilQaFixtureDocument) === priorDocument) {
                throw failed('A full reload did not reopen the same fenced workspace in a new document');
            }
            return { sameWorkspace: true, newCodeDocument: true,
                ...await verifyKnownFile(reopened.frame, inputs.expectedFile, repo.expectedText, fileTimeLimit, { reopen: true }) };
        }, !checkout && 'The private checkout was not verified');
        await checks.run('code_background_agent', () => runBackgroundAgent(page, reopened.frame, repo, timeLimit),
            repo?.allowAgent === true && !reloaded && 'The reloaded private workspace was not verified',
            repo?.allowAgent !== true && 'The optional synthetic agent scenario was not selected');
    } finally {
        await context?.close().catch(() => {});
    }
    return checks.complete();
}

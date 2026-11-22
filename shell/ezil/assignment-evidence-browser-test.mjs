// Exercise the shell capture control in real Chromium with synthetic identities
// and a loopback assignment API. No other URLs or browser surfaces are used.
// Set EZIL_ASSIGNMENT_EVIDENCE_FIXTURE_BACKEND to exercise a real loopback API.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.ezil.work/default/assignment-evidence-fixture.git';
const otherRepository = 'https://github.ezil.work/default/assignment-evidence-other.git';
const computerId = '11111111-1111-4111-8111-111111111111';
const oppositeComputerId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const assignmentId = '44444444-4444-4444-8444-444444444444';
const resumeAttemptId = '55555555-5555-4555-8555-555555555555';
const sourceRoot = process.env.EZIL_ASSIGNMENT_SHELL_SOURCE
    ? resolve(process.env.EZIL_ASSIGNMENT_SHELL_SOURCE)
    : fileURLToPath(new URL('.', import.meta.url));
const endpoint = '/api/shell/assignment-evidence';
const evidenceModules = new Set([
    '/app/src/server/ai-traces/contract.js',
    '/app/src/server/assignment-evidence/chat-content.js',
    '/app/src/server/assignment-evidence/terminal-commands.js',
]);
const startCommand = { action: 'start', computerId, consentVersion: 'assignment-evidence-v2' };

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    if (process.env.PLAYWRIGHT_REQUIRE_DIR) {
        try {
            const require = createRequire(resolve(process.env.PLAYWRIGHT_REQUIRE_DIR, 'noop.js'));
            ({ chromium } = require('playwright'));
        } catch { /* Set the same skip status as the other shell browser suites. */ }
    }
}
if (!chromium) {
    console.error('SKIP playwright is not resolvable. Set PLAYWRIGHT_REQUIRE_DIR.');
    process.exit(2);
}

const fixture = `<!doctype html>
    <html lang="en">
        <meta charset="utf-8">
        <link rel="icon" href="data:,">
        <title>Assignment evidence browser fixture</title>
        <body>
            <div id="first"></div>
            <div id="second"></div>
            <div id="other"></div>
            <div id="foreign"></div>
            <button id="unrelated">Unrelated window control</button>
            <label>Unrelated field <input id="unrelated-field"></label>
            <script type="module">
                import {
                    closeAssignmentEvidenceWindow, mountAssignmentEvidence,
                    recordAssignmentEvent, recordAssignmentWindow,
                } from '/assignment-evidence.js';
                window.fixture = {
                    mount (id, repositoryUrl, computerId) {
                        const owner = document.getElementById(id);
                        owner.setAttribute('data-app', 'code');
                        owner.setAttribute('data-ezil-computer-id', computerId);
                        mountAssignmentEvidence({ container: owner, owner, repositoryUrl, computerId });
                    },
                    close (id) {
                        closeAssignmentEvidenceWindow(document.getElementById(id));
                    },
                    windowEvent (kind, id, app, computerId) {
                        const element = document.getElementById(id);
                        element.setAttribute('data-app', app);
                        element.setAttribute('data-ezil-computer-id', computerId);
                        recordAssignmentWindow(kind, element);
                    },
                    visibility (next) {
                        Object.defineProperty(document, 'visibilityState', { configurable: true, value: next });
                        document.dispatchEvent(new Event('visibilitychange'));
                    },
                    record: recordAssignmentEvent,
                };
            </script>
        </body>
    </html>`;

function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
}

function makeServer(handleApi) {
    const errors = [];
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            if (url.pathname === endpoint) {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const raw = Buffer.concat(chunks).toString('utf8');
                const reply = await handleApi(req.method, url, raw ? JSON.parse(raw) : null);
                json(res, reply.status, reply.body);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(fixture);
                return;
            }
            if (req.method === 'GET' && evidenceModules.has(url.pathname)) {
                const contents = await readFile(resolve(sourceRoot, '../..', url.pathname.slice(1)));
                res.writeHead(200, { 'content-type': 'text/javascript' });
                res.end(contents);
                return;
            }
            if (req.method === 'GET' && /^\/[a-z][a-z0-9-]*\.js$/.test(url.pathname)) {
                const contents = await readFile(resolve(sourceRoot, url.pathname.slice(1)));
                res.writeHead(200, { 'content-type': 'text/javascript' });
                res.end(contents);
                return;
            }
            res.writeHead(404);
            res.end();
        } catch (error) {
            errors.push(error);
            json(res, 500, { error: 'fixture_error' });
        }
    });
    return { server, errors };
}

function apiFixture() {
    const mutations = [];
    let attempt = null;
    const assignment = { id: assignmentId, computerId, repositoryUrl: repository };
    function activeAttempt(id) {
        const now = Date.now();
        return { id, state: 'active', startedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 600_000).toISOString(), endedAt: null,
            consentVersion: startCommand.consentVersion, captureChat: false };
    }
    function handle(method, _url, body) {
        if (method === 'GET') {
            return { status: 200, body: { enabled: true, assignment, attempt } };
        }
        assert.equal(method, 'POST');
        mutations.push(body);
        if (body.action === 'start') {
            assert.deepEqual(body, startCommand);
            assert.equal(attempt, null, 'one capture attempt');
            attempt = activeAttempt(attemptId);
            return { status: 200, body: { attempt } };
        }
        assert.equal(attempt?.state, 'active');
        assert.equal(body.attemptId, attempt.id);
        if (body.action === 'append') {
            assert.deepEqual(Object.keys(body).sort(), ['action', 'attemptId', 'events']);
            assert.ok(Array.isArray(body.events) && body.events.length > 0);
            for (const event of body.events) {
                assert.deepEqual(Object.keys(event).sort(), ['detail', 'id', 'kind', 'occurredAt']);
                assert.match(event.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
                assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
            }
            return { status: 200, body: { accepted: body.events.map(event => event.id) } };
        }
        assert.deepEqual(body, { action: 'end', attemptId: attempt.id });
        attempt = { ...attempt, state: 'ended', endedAt: new Date().toISOString() };
        return { status: 200, body: { attempt } };
    }
    return {
        handle, mutations,
        seedActive() {
            assert.equal(attempt?.state, 'ended');
            attempt = activeAttempt(resumeAttemptId);
            return attempt.id;
        },
    };
}

function backendFixture(value) {
    const backend = new URL(value);
    assert.ok(backend.protocol === 'http:' && backend.hostname === '127.0.0.1'
        && backend.port && !backend.username && !backend.password && !backend.search && !backend.hash
        && ['/', endpoint].includes(backend.pathname),
    'fixture backend must be a port-specific HTTP URL on 127.0.0.1');
    backend.pathname = endpoint;

    const mutations = [];
    let scenario = 'fresh';
    async function request(method, search, body) {
        assert.ok(['GET', 'POST'].includes(method));
        const url = new URL(backend);
        url.search = search;
        const response = await fetch(url, {
            method,
            headers: {
                'x-assignment-fixture-scenario': scenario,
                ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            },
            ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
            redirect: 'error',
            signal: AbortSignal.timeout(4_000),
        });
        return { status: response.status, body: await response.json() };
    }
    return {
        mutations,
        handle(method, url, body) {
            if (method === 'POST') mutations.push(body);
            return request(method, url.search, body);
        },
        async seedActive() {
            scenario = 'resume';
            const reply = await request('POST', '', startCommand);
            assert.equal(reply.status, 200, 'seed a separate fixture assignment for Resume');
            assert.equal(reply.body.attempt.state, 'active');
            return reply.body.attempt.id;
        },
        async report(id) {
            return request('GET', new URLSearchParams({ attemptId: id }).toString(), null);
        },
    };
}

async function verifyDurableReport(api, id, captureMutations) {
    const { status, body } = await api.report(id);
    assert.equal(status, 200);
    assert.equal(body.attempt.id, id);
    assert.equal(body.attempt.state, 'ended');
    assert.equal(body.binding.computerId, computerId);
    assert.equal(body.nextAfter, null);

    const sent = captureMutations.filter(command => command.action === 'append').flatMap(command => command.events);
    assert.deepEqual(body.events.map(event => event.sequence), Array.from({ length: sent.length + 2 }, (_, i) => i + 1));
    assert.equal(body.events[0].kind, 'assignment.started');
    assert.equal(body.events[0].source, 'server_observed');
    assert.equal(body.events.at(-1).kind, 'assignment.ended');
    assert.equal(body.events.at(-1).source, 'server_observed');
    assert.ok(body.events.slice(1, -1).every(event => event.source === 'client_reported'));
    assert.deepEqual(body.events.slice(1, -1).map(({ id, kind, occurredAt, detail }) => (
        { id, kind, occurredAt, detail }
    )), sent);
    return body.binding.assignmentId;
}

const api = process.env.EZIL_ASSIGNMENT_EVIDENCE_FIXTURE_BACKEND
    ? backendFixture(process.env.EZIL_ASSIGNMENT_EVIDENCE_FIXTURE_BACKEND)
    : apiFixture();
const { server, errors } = makeServer(api.handle);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
    browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const context = await browser.newContext();
    context.setDefaultTimeout(5_000);
    const external = [];
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().resourceType());
        return route.abort();
    });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error));
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.fixture));

    const mount = (slot, repositoryUrl, computerId) => page.evaluate(
        args => window.fixture.mount(...args), [slot, repositoryUrl, computerId],
    );
    const emit = (kind, detail, scope) => page.evaluate(args => window.fixture.record(...args), [kind, detail, scope]);
    const emitWindow = (kind, slot, app, computerId) => page.evaluate(
        args => window.fixture.windowEvent(...args), [kind, slot, app, computerId],
    );
    const setVisibility = state => page.evaluate(value => window.fixture.visibility(value), state);
    const unrelatedInput = async () => {
        await page.locator('#unrelated').click();
        await page.locator('#unrelated').click({ button: 'right' });
        await page.locator('#unrelated-field').fill('synthetic-unrelated-input-marker');
        await page.locator('#unrelated-field').press('Enter');
    };
    const requestFor = (action, currentPage = page) => currentPage.waitForResponse(response =>
        response.url().startsWith(origin + endpoint) && response.request().method() === 'POST'
        && response.request().postDataJSON().action === action,
    );
    const scope = { computerId, repositoryUrl: repository };
    const start = page.getByRole('button', { name: 'Start assignment evidence' });
    const stop = page.getByRole('button', { name: 'Stop assignment evidence' });

    await mount('other', otherRepository, computerId);
    await mount('foreign', repository, oppositeComputerId);
    await mount('first', repository, computerId);
    await start.waitFor();
    assert.equal(await start.count(), 1, 'only the exact matching workspace has a start control');
    assert.equal(api.mutations.length, 0, 'mounting or opening a window did not start capture');
    assert.equal(await emit('code.file_opened', { path: 'before-consent.js' }, scope), false);
    await emitWindow('app.opened', 'first', 'code', computerId);
    await unrelatedInput();
    assert.equal(api.mutations.length, 0, 'unrelated GUI input before consent did not capture');

    await setVisibility('visible');
    const [started] = await Promise.all([requestFor('start'), start.click()]);
    assert.equal(started.status(), 200);
    const firstAttemptId = (await started.json()).attempt.id;
    await stop.waitFor();

    await mount('first', repository, computerId);
    assert.equal(await stop.count(), 1, 'remounting the owner keeps the same active control');
    await unrelatedInput();
    await emitWindow('app.opened', 'second', 'code', computerId);
    await emitWindow('app.focused', 'foreign', 'browser', oppositeComputerId);
    await emitWindow('app.opened', 'other', 'preview', computerId);
    assert.equal(await emit('code.file_opened', { path: 'another-workspace.js' }, {
        ...scope, repositoryUrl: otherRepository,
    }), false);
    assert.equal(await emit('code.file_opened', { path: 'unscoped.js' }), false);
    assert.equal(await emit('code.file_opened', { path: '.env.local' }, scope), false);
    assert.equal(await emit('keyboard.key_pressed', { key: 'synthetic-marker' }, scope), false);

    for (const action of ['opened', 'focused', 'minimized', 'restored', 'closed']) {
        await emitWindow(`app.${action}`, 'first', 'code', computerId);
    }
    await setVisibility('hidden');
    await setVisibility('visible');
    await Promise.all([requestFor('end'), stop.click()]);
    assert.equal(await emit('code.file_opened', { path: 'after-stop.js' }, scope), false);
    await emitWindow('app.focused', 'first', 'code', computerId);

    assert.equal(api.mutations.filter(body => body.action === 'start').length, 1);
    assert.equal(api.mutations.filter(body => body.action === 'end').length, 1);
    assert.deepEqual(api.mutations
        .filter(body => body.action === 'append')
        .flatMap(body => body.events.map(event => [event.kind, event.detail])), [
        ['activity.visibility', { state: 'foreground' }],
        ['app.opened', { app: 'code' }],
        ['app.focused', { app: 'code' }],
        ['app.minimized', { app: 'code' }],
        ['app.restored', { app: 'code' }],
        ['app.closed', { app: 'code' }],
        ['activity.visibility', { state: 'background' }],
        ['activity.visibility', { state: 'foreground' }],
    ]);
    assert.doesNotMatch(JSON.stringify(api.mutations), /synthetic-unrelated-input-marker|another-workspace|after-stop|before-consent/);
    console.log('PASS explicit consent, exact workspace scope, Code window actions, visibility, and stop');

    const firstBinding = api.report ? await verifyDurableReport(api, firstAttemptId, api.mutations) : null;
    const resumedAttemptId = await api.seedActive();
    assert.notEqual(resumedAttemptId, firstAttemptId);
    const resumedPage = await context.newPage();
    resumedPage.on('pageerror', error => browserErrors.push(error));
    await resumedPage.goto(origin);
    await resumedPage.waitForFunction(() => Boolean(window.fixture));
    await resumedPage.evaluate(args => window.fixture.mount(...args), ['first', repository, computerId]);
    const resume = resumedPage.getByRole('button', { name: 'Resume assignment evidence' });
    await resume.waitFor();
    const countBeforeResume = api.mutations.length;
    await resumedPage.evaluate(args => {
        const [scope, computerId] = args;
        window.fixture.windowEvent('app.focused', 'first', 'code', computerId);
        window.fixture.close('other');
        window.fixture.record('code.file_opened', { path: 'before-resume.js' }, scope);
    }, [scope, computerId]);
    assert.equal(api.mutations.length, countBeforeResume, 'an active server attempt does not resume capture without consent');
    await resume.click();
    await resumedPage.getByText('Assignment evidence active.', { exact: true }).waitFor();
    await resumedPage.evaluate(id => window.fixture.windowEvent('app.closed', 'first', 'code', id), computerId);
    await Promise.all([
        requestFor('append', resumedPage),
        resumedPage.evaluate(() => window.fixture.close('first')),
    ]);
    assert.equal(api.mutations.filter(body => body.action === 'start').length, 1, 'resume did not create another attempt');
    assert.equal(api.mutations.filter(body => body.action === 'end').length, 1, 'closing Code pauses the attempt');
    await resumedPage.evaluate(args => window.fixture.mount(...args), ['first', repository, computerId]);
    await resume.waitFor();
    await resume.click();
    const resumedStop = resumedPage.getByRole('button', { name: 'Stop assignment evidence' });
    await resumedStop.waitFor();
    await Promise.all([requestFor('end', resumedPage), resumedStop.click()]);
    assert.equal(api.mutations.filter(body => body.action === 'end').length, 2, 'explicit Stop ends the attempt');
    assert.equal(api.mutations.slice(countBeforeResume).filter(body => body.action === 'append')
        .flatMap(body => body.events).filter(event => event.kind === 'activity.resumed').length, 2);
    assert.ok(api.mutations.slice(countBeforeResume).every(body => body.attemptId === resumedAttemptId));
    assert.ok(api.mutations.slice(countBeforeResume).some(body => body.action === 'append'
        && body.events.some(event => event.kind === 'app.closed')));
    assert.doesNotMatch(JSON.stringify(api.mutations), /before-resume/);
    console.log('PASS explicit resume, pause on owner close, and explicit stop');

    if (api.report) {
        const resumedBinding = await verifyDurableReport(api, resumedAttemptId, api.mutations.slice(countBeforeResume));
        assert.notEqual(resumedBinding, firstBinding);
        assert.equal((await api.report(firstAttemptId)).status, 404, 'the resume assignment cannot read the fresh attempt');
        console.log('PASS two durable reports preserve verified assignment scope and exact capture order');
    }

    assert.deepEqual(errors, []);
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(external, []);
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
}

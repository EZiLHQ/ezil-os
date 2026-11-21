import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCodeJourney } from './staging-code-journey.mjs';

const COMPUTER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REPO_ID = '33333333-3333-8333-8333-333333333333';
const REPO = 'https://github.ezil.work/qa-fixtures/code-exercise.git';
const MARKER = 'SYNTHETIC_CODE_EXERCISE';
const MODEL = 'Kimi K3 (no streaming)';
const storageState = { cookies: [], origins: [] };
const repo = { url: REPO, fixtureUrl: REPO, computerId: COMPUTER, expectedText: MARKER };
const names = report => Object.fromEntries(report.checks.map(({ name, status }) => [name, status]));

test('missing authorization or a non-fixture repository stops before creating a browser context', async () => {
    let created = 0;
    const browser = { newContext: () => { created++; } };
    for (const options of [
        { target: 'https://os-staging.ezil.work', repo, storageState: undefined },
        { target: 'https://os.ezil.work', repo, storageState },
        { target: 'https://os-staging.ezil.work', repo: { ...repo, fixtureUrl: REPO + '.other' }, storageState },
        { target: 'https://os-staging.ezil.work', repo: { ...repo, computerId: undefined }, storageState },
    ]) {
        const report = await runCodeJourney({ browser, ...options });
        assert.equal(names(report).fixture_configuration, 'blocked');
        assert.equal(names(report).private_repo_checkout, 'blocked');
        assert.equal(names(report).code_background_agent, 'skip');
        assert.equal(names(report).code_chat_history_after_reload, 'skip');
        assert.equal(created, 0);
    }
});

test('browser setup errors do not expose the provided storage state', async () => {
    const state = 'private-browser-state-do-not-log';
    const report = await runCodeJourney({
        browser: { async newContext() { throw new Error('Invalid ' + state); } },
        target: 'https://os-staging.ezil.work', repo, storageState: state,
    });
    assert.equal(names(report).authenticated_isolated_computer, 'blocked');
    assert(!JSON.stringify(report).includes(state));
});

const requireDir = process.env.PLAYWRIGHT_REQUIRE_DIR;
test('loopback Chromium requires the single background reply to reopen from Chat history after full reload', {
    skip: !requireDir && 'Set PLAYWRIGHT_REQUIRE_DIR for the Chromium loopback test',
}, async t => {
    const { chromium } = createRequire(join(requireDir, 'staging-code-journey-test.js'))('playwright');
    const mints = [];
    const prompts = [];
    let boot = COMPUTER;
    let session = COMPUTER;
    let desktopLoads = 0;
    let showSavedChat = true;
    let draft = '';
    const server = createServer(async (request, response) => {
        const app = 'http://' + request.headers.host;
        const url = new URL(request.url, app);
        const html = body => {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end('<!doctype html><html><body>' + body + '</body></html>');
        };
        if (url.pathname === '/api/shell/session') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ computer: { id: session } }));
            return;
        }
        if (url.pathname === '/os') {
            desktopLoads++;
            return html('<script>window.__EZIL_BOOT__={computer:{id:' + JSON.stringify(boot) + '}};</script>');
        }
        if (url.pathname === '/app/code') {
            return html('<main class="window" data-app="code"></main><script>' +
                'window.__EZIL_BOOT__={computer:{id:' + JSON.stringify(boot) + '}};' +
                'const url=new URL(location.href);fetch("/api/shell/code-preview-url",{method:"POST",' +
                'headers:{"content-type":"application/json"},body:JSON.stringify({computerId:url.searchParams.get("computer"),' +
                'intent:"open",repository:{url:url.searchParams.get("repo")}})}).then(r=>r.json()).then(result=>{' +
                'const frame=document.createElement("iframe");frame.className="window-app-iframe";' +
                'frame.src=result.codePreviewUrl;frame.width="1200";frame.height="800";document.querySelector("main").append(frame);});</script>');
        }
        if (url.pathname === '/api/shell/code-preview-url') {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks));
            mints.push(body);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, repository: { id: REPO_ID },
                codePreviewUrl: app + '/editor?folder=' + encodeURIComponent('/workspace/projects/' + REPO_ID) }));
            return;
        }
        if (url.pathname === '/editor') {
            return html('<main class="monaco-workbench" style="min-height:600px">' +
                '<div class="explorer-folders-view"><div role="treeitem" aria-label="README.md" ' +
                'ondblclick="openFixture()">README.md</div></div>' +
                '<div class="part editor"><div class="tabs"></div><div class="editor-instance">' +
                '<div class="monaco-editor"><div class="view-lines"></div></div></div></div>' +
                '<div class="part auxiliarybar"><button onclick="setTimeout(() => chat.replaceChildren(), 250)">New Chat</button>' +
                '<div class="chat-view-title-container visible"><button class="chat-view-title-action-item" onclick="showHistory()">Chat history</button></div>' +
                '<div class="quick-input-widget" style="min-height:20px" hidden></div>' +
                '<button class="action-label" aria-label="Models, ' + MODEL + '">Model</button>' +
                '<div class="chat-input-toolbar"><span class="action-item chat-input-picker-item"><button class="action-label">Ask</button></span></div>' +
                '<div class="interactive-list" id="chat"><div class="interactive-request">Restoring the view</div></div><div class="chat-input-container">' +
                '<div class="monaco-editor"><div class="view-lines" contenteditable="true" style="width:500px;height:40px" id="input"></div>' +
                '</div></div></div></main><script>' +
                'function openFixture(){document.querySelector(".tabs").innerHTML=' + JSON.stringify('<div class="tab">README.md</div>') + ';' +
                'document.querySelector(".editor-instance .view-lines").textContent=' + JSON.stringify(MARKER) + ';' +
                'sessionStorage.setItem("opened","yes")}if(sessionStorage.getItem("opened"))openFixture();' +
                'function showHistory(){const picker=document.querySelector(".quick-input-widget");picker.hidden=false;' +
                'const saved=' + JSON.stringify(showSavedChat) + ' && JSON.parse(sessionStorage.getItem("savedChat"));' +
                'if(!saved)return;const row=document.createElement("button");row.className="monaco-list-row";' +
                'row.textContent=saved.marker;row.onclick=()=>{picker.hidden=true;chat.innerHTML=saved.transcript};picker.append(row);}' +
                'input.textContent=' + JSON.stringify(draft) + ';' +
                'input.addEventListener("keydown",event=>{if(event.key!=="Enter")return;event.preventDefault();' +
                'const text=input.textContent;input.textContent="";const marker=text.match(/EZILQAPROBE[a-z0-9]+/)?.[0];' +
                'if(!marker)return;fetch("/fixture-prompt",{method:"POST",body:marker});' +
                'const request=document.createElement("div");request.className="interactive-request";request.textContent=text;chat.append(request);' +
                'const response=document.createElement("div");response.className="interactive-response chat-response-loading";' +
                'response.textContent="Thinking";chat.append(response);setTimeout(()=>{' +
                'response.classList.remove("chat-response-loading");const m=document.createElement("div");m.className="rendered-markdown";' +
                'm.textContent=marker;response.replaceChildren(m);' +
                'sessionStorage.setItem("savedChat",JSON.stringify({marker,transcript:chat.innerHTML}));},2500);});</script>');
        }
        if (url.pathname === '/fixture-prompt') {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            prompts.push(Buffer.concat(chunks).toString());
            response.writeHead(204);
            response.end();
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chromium' });
    t.after(() => browser.close());
    const target = 'http://127.0.0.1:' + server.address().port;

    session = OTHER;
    const mismatch = await runCodeJourney({ browser, target, repo, storageState, evidence: { timeoutMs: 10_000 } });
    assert.equal(names(mismatch).authenticated_isolated_computer, 'blocked');
    assert.equal(names(mismatch).private_repo_checkout, 'blocked');
    assert.equal(desktopLoads, 0);
    assert.equal(mints.length, 0);
    assert(!JSON.stringify(mismatch).includes(OTHER));

    session = COMPUTER;
    boot = OTHER;
    const bootMismatch = await runCodeJourney({ browser, target, repo, storageState, evidence: { timeoutMs: 10_000 } });
    assert.equal(names(bootMismatch).authenticated_isolated_computer, 'blocked');
    assert.equal(desktopLoads, 1);
    assert.equal(mints.length, 0);
    assert.equal(prompts.length, 0);
    assert(!JSON.stringify(bootMismatch).includes(OTHER));

    boot = COMPUTER;
    const report = await runCodeJourney({ browser, target, repo: { ...repo, allowAgent: true, modelName: MODEL },
        storageState, evidence: { timeoutMs: 10_000 } });
    assert.deepEqual(names(report), {
        fixture_configuration: 'pass',
        authenticated_isolated_computer: 'pass',
        private_repo_checkout: 'pass',
        code_background_agent: 'pass',
        code_full_reload: 'pass',
        code_chat_history_after_reload: 'pass',
    }, JSON.stringify(report));
    assert.equal(mints.length, 2);
    assert(mints.every(body => body.computerId === COMPUTER && body.repository.url === REPO));
    assert.equal(prompts.length, 1);
    assert.equal(report.checks.find(check => check.name === 'code_full_reload').evidence.editorTabRestored, true);
    assert.equal(report.checks.find(check => check.name === 'code_background_agent').evidence.mode, 'ask');
    assert.equal(report.checks.find(check => check.name === 'code_background_agent').evidence.sameBrowserWindow, true);
    assert.deepEqual(report.checks.find(check => check.name === 'code_chat_history_after_reload').evidence,
        { historyPickerOpened: true, promptsRestored: 1, repliesRestored: 1 });
    assert(!JSON.stringify(report).includes(REPO));
    assert(!JSON.stringify(report).includes(REPO_ID));
    assert(!JSON.stringify(report).includes(prompts[0]));

    showSavedChat = false;
    const missing = await runCodeJourney({ browser, target, repo: { ...repo, allowAgent: true, modelName: MODEL },
        storageState, evidence: { timeoutMs: 5_000 } });
    assert.equal(names(missing).code_background_agent, 'pass', JSON.stringify(missing));
    assert.equal(names(missing).code_full_reload, 'pass', JSON.stringify(missing));
    const missingHistory = missing.checks.find(check => check.name === 'code_chat_history_after_reload');
    assert.equal(missingHistory.status, 'fail');
    assert.match(missingHistory.detail, /did not list exactly one matching saved conversation/);
    assert.equal(prompts.length, 2);
    assert(!JSON.stringify(missing).includes(prompts[1]));

    draft = 'An existing draft that must stay unsent';
    const unsafe = await runCodeJourney({ browser, target, repo: { ...repo, allowAgent: true, modelName: MODEL },
        storageState, evidence: { timeoutMs: 5_000 } });
    assert.equal(names(unsafe).code_background_agent, 'blocked', JSON.stringify(unsafe));
    assert.equal(names(unsafe).code_full_reload, 'pass');
    assert.equal(names(unsafe).code_chat_history_after_reload, 'blocked');
    assert.match(unsafe.checks.find(check => check.name === 'code_background_agent').detail, /contained a draft/);
    assert.equal(prompts.length, 2);
    assert(!JSON.stringify(unsafe).includes(draft));
});

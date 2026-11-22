import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createMcpObservation } from './mcp-observation.mjs';
import { browserTabPolicy } from './mcp-tab-actions.mjs';

const BINDING = 'a'.repeat(64);
const CHROME = process.env.EZIL_TEST_CHROMIUM;
const QA_PATH = '/browser-mcp-fixture.html';

test('the existing owned Browser allows only reviewed public and exact fixture destinations', () => {
    const permit = browserTabPolicy();
    assert.equal(permit('https://example.com/').href, 'https://example.com/');
    assert.equal(permit('https://os-staging.ezil.work' + QA_PATH).pathname, QA_PATH);
    for (const url of [
        'http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'http://127.0.0.1:3002/', 'https://example.invalid/',
        'https://example.com:9222/', 'https://someone@example.com/', 'https://example.com/?sensitive=x',
        'https://example.com/login', 'https://example.com/a%2fadmin', 'https://os-staging.ezil.work/api/shell/session',
    ]) assert.equal(permit(url), null, url);
});

test('stock Browser home is neutral and every other local file remains outside the view', async () => {
    let visibilityChecks = 0;
    let privateReads = 0;
    const stock = {
        isClosed: () => false,
        url: () => 'file:///usr/local/share/ezil/browser-home.html',
        on: () => {},
        evaluate: async check => {
            assert.match(String(check), /document\.visibilityState/);
            visibilityChecks += 1;
            return true;
        },
    };
    const foreign = {
        ...stock, url: () => 'file:///usr/local/share/ezil/other.html',
        evaluate: async () => { privateReads += 1; return true; },
    };
    const observe = createMcpObservation({
        connect: async () => ({ contexts: () => [{ pages: () => [foreign, stock] }] }),
    });
    const result = await observe({ binding: BINDING, action: { kind: 'read', includeFrame: true } });
    assert.equal(result.observed, 'browser_ready');
    assert.equal(result.pageUrl, null);
    assert.equal(result.pageTitle, null);
    assert.deepEqual(result.elements, []);
    assert.equal(result.viewerFrame, null);
    assert.ok(visibilityChecks > 0);
    assert.equal(privateReads, 0);
    assert.equal(browserTabPolicy()(stock.url()), null);
    assert.equal(browserTabPolicy()('file:///tmp/other.html'), null);
});

test('real Chromium keeps control, receipts and viewer pixels on the one approved tab', { skip: !CHROME }, async () => {
    const fixture = await readFile(new URL('../../app/public/browser-mcp-fixture.html', import.meta.url), 'utf8');
    const document = fixture.replace('</main>', '<label>Test credential<input type="password" value="secret-only"></label>'
        + '<form><input type="text" aria-label="Do not submit"><button type="submit">Submit</button></form></main>');
    const endpoint = createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== QA_PATH) return res.writeHead(404).end();
        return res.writeHead(200, { 'content-type': 'text/html' }).end(document);
    });
    endpoint.listen(0, '127.0.0.1');
    await once(endpoint, 'listening');
    const fixtureOrigin = 'http://127.0.0.1:' + endpoint.address().port;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: CHROME, headless: true });
        const context = await browser.newContext({ viewport: { width: 1080, height: 720 } });
        const page = await context.newPage();
        const observe = createMcpObservation({ connect: async () => browser }, { fixtureOrigin, allowHttpForTests: true });
        const initial = await observe({ binding: BINDING, action: { kind: 'read' } });
        assert.equal(initial.observed, 'browser_ready', JSON.stringify(initial));
        const browserSessionId = initial.browserSessionId;
        const read = (includeFrame = false) => observe({ binding: BINDING, browserSessionId, action: { kind: 'read', includeFrame } });
        const mutate = (action, requestId = randomUUID()) => observe({ binding: BINDING, browserSessionId, requestId, action });

        if (process.env.EZIL_TEST_PUBLIC_EXAMPLE === '1') {
            const example = await mutate({ kind: 'navigate', url: 'https://example.com/' });
            assert.equal(example.browserSessionId, browserSessionId, JSON.stringify(example));
            assert.equal(example.pageTitle, 'Example Domain');
        }
        const target = fixtureOrigin + QA_PATH;
        const opened = await mutate({ kind: 'navigate', url: target });
        assert.equal(opened.browserSessionId, browserSessionId, JSON.stringify(opened));
        assert.equal(opened.pageUrl, target);
        assert.equal(page.url(), target);
        assert.equal(context.pages().length, 1);

        const refs = await read();
        assert.deepEqual(refs.elements.map(({ label, kind }) => [label, kind]), [
            ['Test message', 'text_input'], ['Show message', 'button'],
        ]);
        const [input, button] = refs.elements;
        const before = await read(true);
        assert.equal(before.viewerFrame.mimeType, 'image/jpeg');
        assert.ok(before.viewerFrame.base64.length <= 80_000);
        assert.deepEqual(before.elements, []);
        assert.doesNotMatch(JSON.stringify(before), /secret-only/);

        // Off owner-app pages the v1 bound and the v1 actions hold (browser verbs v2 §4): no line break, no v2 kind.
        for (const refused of [
            { kind: 'type', ref: input.ref, text: 'two\nlines' },
            { kind: 'type', ref: input.ref, text: 'x'.repeat(81) },
            { kind: 'fill_form', fields: [{ ref: input.ref, text: 'EZiL staging test' }] },
            { kind: 'select', ref: input.ref, values: ['a'] },
            { kind: 'scroll', dy: 100 },
            { kind: 'press', key: 'Enter', ref: input.ref },
        ]) assert.equal((await mutate(refused)).error, 'browser_action_unavailable', JSON.stringify(refused));
        assert.equal(await page.locator('#test-message').inputValue(), '', 'nothing reached the page');
        const content = { kind: 'type', ref: input.ref, text: 'EZiL staging test' };
        const requestId = randomUUID();
        const typed = await mutate(content, requestId);
        assert.equal(typed.ok, true, JSON.stringify(typed));
        assert.deepEqual(await mutate(content, requestId), typed);
        assert.equal((await mutate({ ...content, text: 'different' }, requestId)).error, 'browser_action_conflict');
        assert.equal(await page.locator('#test-message').inputValue(), content.text);
        assert.equal((await mutate({ kind: 'click', ref: button.ref })).error, 'browser_action_unavailable');

        const refreshed = await read();
        const freshButton = refreshed.elements.find(element => element.label === 'Show message');
        const clicked = await mutate({ kind: 'click', ref: freshButton.ref });
        assert.equal(clicked.browserSessionId, browserSessionId);
        assert.equal(await page.getByRole('status').innerText(), 'Shown: ' + content.text);
        assert.notEqual((await read(true)).viewerFrame.base64, before.viewerFrame.base64);
        assert.equal((await observe({ binding: 'b'.repeat(64), browserSessionId, action: { kind: 'read' } })).error, 'browser_session_stale');
        assert.equal((await mutate({ kind: 'click', selector: 'button' })).error, 'browser_invalid_request');
        await page.goto('about:blank');
        assert.equal((await read()).error, 'browser_session_stale');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => endpoint.close(resolve));
    }
});

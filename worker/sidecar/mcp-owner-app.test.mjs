import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ORIGIN_TIER_ENV } from './contract.mjs';
import { loadOriginPolicy } from './origin-policy.mjs';
import { createMcpObservation, OBSERVE_PATH } from './mcp-observation.mjs';
import { BROWSER_UI_RESULT_MAX_BYTES, browserUiPayload, fitBrowserUiResult } from './mcp-observation-payload.mjs';
import { ownerAppKind, pageUrlOf } from './mcp-owner-app.mjs';
import { typedText, v1Text, validUiInput } from './mcp-tab-actions.mjs';
import { createSidecarServer } from './server.mjs';

const CHROME = process.env.EZIL_TEST_CHROMIUM;
const OWNER = 'https://universe-staging.ezil.work';
const IDP = 'https://id.ezil.work';
const STAGING = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: OWNER, [ORIGIN_TIER_ENV.idp_transit]: IDP });
const BINDING = 'a'.repeat(64);
const TOKEN = 'T'.repeat(43);
const PASSWORD = 'fixture-password-1234';
const EMAIL = 'ada.builder@example.test';
/** Values distinctive enough to search a whole serialised answer for. */
const LEAKS = ['code=', 'state=', 'nonce=', 'AUTHCODEq7Rk', 'STATEw3Lp', 'NONCEz9Vt', 'IDPSTATEk2Xm', PASSWORD];
const CALLBACK = OWNER + '/creator/social-login/callback/auth0?code=AUTHCODEq7Rk&state=STATEw3Lp';

// ── the fixtures: what Universe and EZiL ID serve, reduced to what the tool sees ──

/** `builder_form.blade.php`, reduced: the topbar Save outside the form, a readonly e-mail, a password, the JS save. */
const PROFILE_BUILDER = `<!doctype html><html><head><title>Profile builder | EZiL Universe</title></head><body>
<header><nav>
  <a href="/builder/dashboard">Dashboard</a>
  <a href="${IDP}/u/logout?state=STATEw3Lp">Sign out of EZiL ID</a>
  <a href="https://elsewhere.example.invalid/x">Elsewhere</a>
  <a href="/builder/jobs" target="_blank">Jobs in a new tab</a>
  <a href="/builder/export.csv" download>Export</a>
</nav></header>
<main>
  <h1>Profile builder</h1>
  <div class="profile-builder-topbar">
    <button type="submit" form="builderForm" name="action" value="save" class="profile-builder-save-btn js-save-btn">Save changes</button>
    <button type="button" class="js-discard-btn">Discard</button>
    <button type="button" class="js-save-retry" hidden>Retry save</button>
    <span id="builderSaveStatus" role="status"></span>
  </div>
  <form class="builder-photo" id="builderPhoto" action="/builder/profile-builder-photo" method="POST" enctype="multipart/form-data">
    <label for="builderPhotoInput">Profile photo</label><input type="file" name="image" id="builderPhotoInput">
  </form>
  <form action="/builder/profile-builder-save" method="POST" class="profile-form-modern" id="builderForm" novalidate>
    <input type="hidden" name="profile_revision" value="7">
    <input type="hidden" name="manual_save" value="1">
    <label for="builderFirstname">First name</label><input type="text" id="builderFirstname" name="firstname" value="Ada" maxlength="40">
    <label for="builderLastname">Last name</label><input type="text" id="builderLastname" name="lastname" value="Lovelace">
    <label class="form-label" for="builderEmail">E-mail address</label><input id="builderEmail" class="form-control" value="${EMAIL}" readonly>
    <label for="builderPassword">Password</label><input type="password" id="builderPassword" name="password" value="${PASSWORD}">
    <label for="builderOtp">Verification code</label><input type="text" id="builderOtp" name="otp" autocomplete="one-time-code">
    <label for="profileCountry">Country</label><select name="country" id="profileCountry" disabled><option>India</option></select>
    <label for="profileMobile">Mobile number</label><input type="tel" id="profileMobile" name="mobile" value="9999" readonly>
    <label for="builderTagline">Professional headline</label><input type="text" id="builderTagline" name="tagline" value="Builds things" maxlength="255">
    <label for="builderRateUnit">Rate unit</label><select name="rate_unit" id="builderRateUnit"><option value="hour">per hour</option><option value="day">per day</option></select>
    <label for="builderBio">Builder story</label><textarea id="builderBio" name="about">Old story</textarea>
    <label><input type="checkbox" name="available" value="1"> Available for work</label>
    <button type="reset">Reset form</button>
  </form>
  <form action="/builder/jobs" method="GET"><label for="jobSearch">Search jobs</label><input id="jobSearch" name="q" type="search"><button type="submit">Search</button></form>
</main>
<script>
  document.getElementById('builderForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = document.getElementById('builderSaveStatus');
    status.textContent = 'Saving…';
    // A control named "action" shadows form.action, as on Universe: read the attribute.
    const response = await fetch(event.target.getAttribute('action'), { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
    status.textContent = response.ok ? 'Saved' : 'Not saved';
  });
</script>
</body></html>`;

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

/** A callback that carries its code and state in the URL, the title, a label and an option. */
const CALLBACK_PAGE = page(`Signing in ${CALLBACK}`, `<h1>Signing you in</h1>
  <a href="/builder/profile-builder?code=AUTHCODEq7Rk&state=STATEw3Lp">Continue to ${CALLBACK}</a>
  <button type="button">Retry ?code=AUTHCODEq7Rk</button>
  <label for="where">Where next</label><select id="where"><option>/cb?state=STATEw3Lp</option><option>Profile</option></select>`);

const IDP_LOGIN = page('Log in | EZiL ID', `<h1>Welcome</h1><form method="POST">
  <label for="u">Email address</label><input id="u" name="username" type="email" value="ada@example.test">
  <label for="p">Password</label><input id="p" name="password" type="password" value="${PASSWORD}">
  <button type="submit">Continue</button></form>`);

const SIGN_IN_LANDING = page('EZiL Universe', `<div id="loginModal" role="dialog"><h2>Sign in to EZiL Universe</h2>
  <a id="ezilIdSignInBtn" data-provider="ezil-id" href="/builder/social-login/auth0">Continue with EZiL ID</a></div>`);

/** Far more select options than 160 KiB can carry: 70 selects × 25 options × 80 three-byte characters. */
function bigPage () {
    const wide = String.fromCharCode(0x20ac).repeat(80);
    const selects = Array.from({ length: 70 }, (_, n) => `<label for="s${n}">Choice ${n}</label><select id="s${n}">`
        + Array.from({ length: 25 }, () => `<option>${wide}</option>`).join('') + '</select>').join('\n');
    return page('Lots of choices', selects);
}

/** Test-only routing: the browser believes it is talking to Universe and EZiL ID. Records what the page posts. */
async function serveFixtures (context) {
    const posted = [];
    await context.route(OWNER + '/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const html = (body, status = 200) => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });
        if (request.method() === 'POST' && url.pathname === '/builder/profile-builder-save') {
            posted.push(request.postData() ?? '');
            return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
        }
        if (url.pathname === '/builder/profile-builder') return html(PROFILE_BUILDER);
        if (url.pathname === '/builder/jobs') return html(page('Jobs', '<h1>Jobs</h1><a href="/builder/profile-builder">Back to my profile</a>'));
        if (url.pathname === '/builder/dashboard') return html(page('Dashboard', '<h1>Dashboard</h1>'));
        if (url.pathname === '/creator/social-login/callback/auth0') return html(CALLBACK_PAGE);
        if (url.pathname === '/builder/big') return html(bigPage());
        if (url.pathname === '/') return html(SIGN_IN_LANDING);
        return html(page('Not found', '<h1>Not found</h1>'), 404);
    });
    await context.route(IDP + '/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: IDP_LOGIN }));
    return posted;
}

async function startChrome () {
    const profile = await mkdtemp(join(tmpdir(), 'ezil-owner-app-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--no-first-run', '--window-size=1280,900',
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore' });
    let port;
    for (let attempt = 0; attempt < 80 && !port; ++attempt) {
        try { port = parseInt(await readFile(join(profile, 'DevToolsActivePort'), 'utf8'), 10); } catch { await delay(100); }
    }
    assert.ok(port, 'the disposable local Chrome announced a debugging port');
    return {
        cdpUrl: 'http://127.0.0.1:' + port,
        async stop () {
            if (chrome.exitCode === null) {
                const exited = once(chrome, 'exit');
                chrome.kill('SIGTERM');
                await exited;
            }
            // Chrome's helpers can still be flushing the profile for a moment after the browser exits.
            await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        },
    };
}

/** The whole harness: real Chrome over CDP, the real BrowserSurface in its default context, the real HTTP route. */
async function harness () {
    const { BrowserSurface } = await import('./browser.mjs');
    const chrome = await startChrome();
    const surface = new BrowserSurface(chrome.cdpUrl, { originPolicy: STAGING });
    const browser = await surface.connect();
    const context = browser.contexts()[0];
    const [tab] = context.pages();
    const posted = await serveFixtures(context);
    const sidecar = createSidecarServer(surface, {
        observe: createMcpObservation(surface, {}), workerBrowserOpenToken: TOKEN, workerBrowserControl: true,
    });
    sidecar.listen(0, '127.0.0.1');
    await once(sidecar, 'listening');
    const endpoint = 'http://127.0.0.1:' + sidecar.address().port + OBSERVE_PATH;
    async function send (body) {
        const response = await fetch(endpoint, {
            method: 'POST', body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
        });
        const text = await response.text();
        return { status: response.status, text, bytes: Buffer.byteLength(text), json: JSON.parse(text) };
    }
    let session;
    const read = async (includeFrame) => {
        const answer = await send({ binding: BINDING, ...(session ? { browserSessionId: session } : {}),
            action: { kind: 'read', ...(includeFrame === undefined ? {} : { includeFrame }) } });
        if (answer.json.ok) session = answer.json.browserSessionId;
        return answer;
    };
    const act = (action, requestId = randomUUID()) => send({ binding: BINDING, browserSessionId: session, requestId, action });
    const fresh = () => { session = undefined; };
    return {
        surface, tab, posted, read, act, fresh, send,
        async close () {
            sidecar.close();
            await chrome.stop();
        },
    };
}

const labelsOf = (answer) => answer.json.elements.map(({ kind, label }) => [kind, label]);
const elementNamed = (answer, label) => answer.json.elements.find((element) => element.label === label);
function assertNoLeak (answer, where) {
    for (const leak of LEAKS) assert.ok(!answer.text.includes(leak), `${where}: ${leak} left the sidecar`);
}

// ── no browser needed ────────────────────────────────────────────────────────

test('the v2 action union is the MCP union: seven kinds, exact members, the same bounds', () => {
    const ref = 'r'.repeat(22);
    const base = { binding: BINDING, browserSessionId: 'b'.repeat(43), requestId: '7bb70a50-cd7d-40f8-9539-45aee597ea48' };
    const ok = (action) => validUiInput({ ...base, action });
    for (const action of [
        { kind: 'navigate', url: OWNER + '/builder/profile-builder' },
        { kind: 'click', ref },
        { kind: 'type', ref, text: 'line one\nline two\twith a tab' },
        { kind: 'type', ref, text: 'x'.repeat(4000) },
        { kind: 'fill_form', fields: Array.from({ length: 20 }, (_, n) => ({ ref: String(n).padStart(22, 'f'), text: 'v' })) },
        { kind: 'select', ref, values: ['per hour', 'd'.repeat(200)] },
        { kind: 'scroll', ref }, { kind: 'scroll', dy: -5000 }, { kind: 'scroll', dy: 5000 },
        { kind: 'press', key: 'Shift+Tab' }, { kind: 'press', key: 'Enter', ref },
    ]) assert.equal(ok(action), true, JSON.stringify(action).slice(0, 120));
    for (const action of [
        { kind: 'type', ref, text: '' }, { kind: 'type', ref, text: 'x'.repeat(4001) },
        { kind: 'type', ref, text: 'bell' + String.fromCharCode(7) }, { kind: 'type', ref, text: 'cr' + String.fromCharCode(13) },
        { kind: 'type', ref, text: 'line' + String.fromCharCode(0x2028) }, { kind: 'type', ref, text: 'c1' + String.fromCharCode(0x85) },
        { kind: 'type', ref, text: 'del' + String.fromCharCode(0x7f) }, { kind: 'type', ref, text: 'x', submit: true },
        { kind: 'fill_form', fields: [] }, { kind: 'fill_form', fields: Array.from({ length: 21 }, (_, n) => ({ ref: String(n).padStart(22, 'f'), text: 'v' })) },
        { kind: 'fill_form', fields: [{ ref, text: 'a' }, { ref, text: 'b' }] }, { kind: 'fill_form', fields: [{ ref, value: 'a' }] },
        { kind: 'select', ref, values: [] }, { kind: 'select', ref, values: ['x'.repeat(201)] }, { kind: 'select', ref, values: ['a\nb'] },
        { kind: 'select', ref, values: Array(21).fill('a') }, { kind: 'scroll' }, { kind: 'scroll', ref, dy: 1 },
        { kind: 'scroll', dy: 5001 }, { kind: 'scroll', dy: 1.5 }, { kind: 'press', key: 'a' }, { kind: 'press', key: 'Control+A' },
        { kind: 'press', key: 'Enter', ref: 'e1' }, { kind: 'click', ref: 'e12' }, { kind: 'click', ref, selector: 'button' },
        { kind: 'upload', ref }, { kind: 'evaluate', script: '1' },
    ]) assert.equal(ok(action), false, JSON.stringify(action).slice(0, 120));
    // 16 KiB of UTF-8 is a second bound: 4000 four-byte characters would be 16,000 bytes, 4000 three-byte ones 12,000.
    assert.equal(typedText(String.fromCharCode(0x20ac).repeat(4000)), true);
    assert.equal(v1Text('Plain words, ok!'), true);
    assert.equal(v1Text('two\nlines'), false);
    assert.equal(v1Text('x'.repeat(81)), false);
});

test('owner-app kinds and page URLs: the profile builder, the sign-in handoff, everything else; origin + path only', () => {
    assert.equal(ownerAppKind(OWNER + '/builder/profile-builder'), 'profile_builder');
    assert.equal(ownerAppKind(OWNER + '/builder/profile-builder/'), 'profile_builder');
    for (const url of ['/auth/ezil-id/login', '/builder/login', '/creator/login', '/?role=builder&redirect=x', '/?role=creator']) {
        assert.equal(ownerAppKind(OWNER + url), 'interactive_sign_in_required', url);
    }
    for (const url of ['/', '/?role=builder&role=creator', '/builder/jobs?q=x', '/builder/profile-builder-save']) {
        assert.equal(ownerAppKind(OWNER + url), 'owner_app_page', url);
    }
    assert.equal(pageUrlOf(CALLBACK, STAGING), OWNER + '/creator/social-login/callback/auth0');
    assert.equal(pageUrlOf(IDP + '/authorize?state=STATEw3Lp#x', STAGING), IDP + '/authorize');
    assert.equal(pageUrlOf('http://127.0.0.1:4173/x?code=1', STAGING), null);
    assert.equal(pageUrlOf('https://user:pw@example.com/', STAGING), null);
});

test('the 160 KiB bound: trim the element list first, then the frame, never exceed', () => {
    const frame = { mimeType: 'image/jpeg', base64: '/9j/' + 'A'.repeat(79_996) };
    const wide = String.fromCharCode(0x20ac).repeat(80);
    const elements = Array.from({ length: 64 }, (_, n) => ({
        ref: String(n).padStart(22, 'h'), kind: 'select', label: 'Choice ' + n, options: Array(20).fill(wide),
    }));
    const result = {
        ok: true, browserSessionId: 'b'.repeat(43), expiresAt: '2026-11-22T00:02:00.000Z', observed: 'owner_app_page',
        profileHeadingVisible: false, universeIdentity: 'unverified', pageUrl: OWNER + '/builder/big', pageTitle: 'Big',
        elements, viewerFrame: frame, ownerAppAccountEmail: null,
    };
    // Untrimmed, the closed projection refuses the whole answer rather than send it.
    assert.deepEqual(browserUiPayload(result), { ok: false, error: 'browser_unavailable' });
    const handles = new Map(elements.map((element) => [element.ref, { kind: 'select' }]));
    const fitted = fitBrowserUiResult(result, handles);
    const bytes = Buffer.byteLength(JSON.stringify(browserUiPayload(fitted)));
    assert.ok(bytes <= BROWSER_UI_RESULT_MAX_BYTES, `${bytes} bytes`);
    assert.ok(fitted.elements.length > 0 && fitted.elements.length < 64, `${fitted.elements.length} elements`);
    assert.deepEqual(fitted.viewerFrame, frame, 'the frame is kept while trimming the list is enough');
    // One more element would not have fitted, and every dropped element's handle is spent.
    const oneMore = { ...fitted, elements: elements.slice(0, fitted.elements.length + 1) };
    assert.ok(Buffer.byteLength(JSON.stringify({ ...browserUiPayload({ ...oneMore, elements: [] }), elements: oneMore.elements }))
        > BROWSER_UI_RESULT_MAX_BYTES);
    assert.deepEqual([...handles.keys()], fitted.elements.map((element) => element.ref));
    // When even an empty list does not fit the limit, the frame goes before the answer does.
    const tight = fitBrowserUiResult(result, new Map(), 2000);
    assert.equal(tight.viewerFrame, null);
    assert.deepEqual(tight.elements, []);
    assert.equal(fitBrowserUiResult({ ...result, pageTitle: 'x'.repeat(120) }, new Map(), 100), null);
});

test('the closed projection: owner-app kinds, no href, e-mail on the profile builder only, no frame on sign-in', () => {
    const base = {
        ok: true, browserSessionId: 'b'.repeat(43), expiresAt: '2026-11-22T00:02:00.000Z', observed: 'profile_builder',
        profileHeadingVisible: true, universeIdentity: 'unverified', pageUrl: OWNER + '/builder/profile-builder', pageTitle: 'Profile',
        elements: [{ ref: 'r'.repeat(22), kind: 'select', label: 'Rate unit', options: ['per hour', 'per day'] }],
        viewerFrame: { mimeType: 'image/jpeg', base64: '/9j/2Q==' }, ownerAppAccountEmail: EMAIL,
    };
    assert.deepEqual(browserUiPayload(base), base);
    const refused = { ok: false, error: 'browser_unavailable' };
    for (const [name, over] of Object.entries({
        'options off a select': { elements: [{ ref: 'r'.repeat(22), kind: 'button', label: 'Go', options: [] }] },
        '21 options': { elements: [{ ref: 'r'.repeat(22), kind: 'select', label: 'S', options: Array(21).fill('o') }] },
        'untrimmed label': { elements: [{ ref: 'r'.repeat(22), kind: 'button', label: ' Save' }] },
        'password kind': { elements: [{ ref: 'r'.repeat(22), kind: 'password', label: 'Password' }] },
        '65 elements': { elements: Array.from({ length: 65 }, (_, n) => ({ ref: String(n).padStart(22, 'h'), kind: 'button', label: 'B' })) },
        'e-mail elsewhere': { observed: 'owner_app_page', profileHeadingVisible: false },
        'e-mail too long': { ownerAppAccountEmail: 'x'.repeat(255) },
        'frame on sign-in': { observed: 'interactive_sign_in_required', profileHeadingVisible: false, pageTitle: null, elements: [], ownerAppAccountEmail: null },
        'non-JPEG frame': { viewerFrame: { mimeType: 'image/jpeg', base64: 'iVBORw0KGgo=' } },
        'query in pageUrl': { pageUrl: OWNER + '/builder/profile-builder?code=1' },
        '17 elements on an approved page': { observed: 'approved_page', profileHeadingVisible: false, ownerAppAccountEmail: null,
            pageUrl: 'https://example.com/', elements: Array.from({ length: 17 }, (_, n) => ({ ref: String(n).padStart(22, 'h'), kind: 'button', label: 'B' })) },
    })) assert.deepEqual(browserUiPayload({ ...base, ...over }), refused, name);
    assert.deepEqual(browserUiPayload({ ok: false, error: 'origin_read_only' }), { ok: false, error: 'origin_read_only' });
    // A reader that handed over an href would still not send one: the projection is closed.
    const linked = browserUiPayload({ ...base, elements: [{ ref: 'r'.repeat(22), kind: 'link', label: 'Go', href: OWNER + '/x?code=1' }] });
    assert.deepEqual(linked.elements, [{ ref: 'r'.repeat(22), kind: 'link', label: 'Go' }]);
});

// ── real Chromium, default context ───────────────────────────────────────────

test('real Chromium: a Universe profile builder is read, filled and saved, and its password never gets a ref', { skip: !CHROME }, async () => {
    const h = await harness();
    try {
        await h.tab.goto(OWNER + '/builder/profile-builder');
        const builder = await h.read();
        assert.equal(builder.status, 200, builder.text);
        assert.equal(builder.json.observed, 'profile_builder', builder.text);
        assert.equal(builder.json.pageUrl, OWNER + '/builder/profile-builder');
        assert.equal(builder.json.profileHeadingVisible, true);
        assert.equal(builder.json.pageTitle, 'Profile builder | EZiL Universe');
        assert.equal(builder.json.universeIdentity, 'unverified');
        assert.equal(builder.json.ownerAppAccountEmail, EMAIL);
        assert.deepEqual(labelsOf(builder), [
            ['link', 'Dashboard'], ['button', 'Save changes'], ['button', 'Discard'],
            ['text_input', 'First name'], ['text_input', 'Last name'], ['text_input', 'Professional headline'],
            ['select', 'Rate unit'], ['textarea', 'Builder story'], ['checkbox', 'Available for work'],
            ['text_input', 'Search jobs'], ['button', 'Search'],
        ]);
        assert.deepEqual(elementNamed(builder, 'Rate unit').options, ['per hour', 'per day']);
        for (const element of builder.json.elements) {
            assert.match(element.ref, /^[A-Za-z0-9_-]{22}$/);
            assert.deepEqual(Object.keys(element).sort(), element.kind === 'select' ? ['kind', 'label', 'options', 'ref'] : ['kind', 'label', 'ref']);
        }
        assert.ok(!builder.text.includes('"href"'));
        assertNoLeak(builder, 'profile builder read');

        // 🔴 The password field got no ref at all: not in the DOM, not in the surface, not in the answer.
        assert.equal(await h.tab.$eval('#builderPassword', (el) => el.getAttribute('data-ezil-ref')), null);
        assert.equal(await h.tab.$eval('#builderOtp', (el) => el.getAttribute('data-ezil-ref')), null);
        assert.equal(await h.tab.$eval('#builderEmail', (el) => el.getAttribute('data-ezil-ref')), null);
        const registered = [...h.surface.refs.values()].filter((meta) => meta.generation === h.surface.refGeneration);
        assert.equal(registered.length, builder.json.elements.length);
        assert.equal(registered.some((meta) => meta.isPassword || /password|verification/i.test(meta.name)), false);
        // Positive control: the listed controls really were stamped and registered.
        assert.ok(await h.tab.$eval('#builderTagline', (el) => el.getAttribute('data-ezil-ref')));

        // A masked frame may come with the listing on an owner-app page.
        const framed = await h.read(true);
        assert.equal(framed.json.viewerFrame?.mimeType, 'image/jpeg', framed.text.slice(0, 300));
        assert.ok(framed.json.viewerFrame.base64.startsWith('/9j/'));
        assert.ok(framed.json.elements.length > 0);
        assertNoLeak(framed, 'framed read');

        // fill_form, then Save: line feeds and tabs are fine on an owner-app page.
        const fields = [
            { ref: elementNamed(framed, 'First name').ref, text: 'Grace' },
            { ref: elementNamed(framed, 'Professional headline').ref, text: 'e2e-nonce-7Hq' },
            { ref: elementNamed(framed, 'Builder story').ref, text: 'Story line one\nline two\twith a tab' },
        ];
        const fillId = randomUUID();
        const filled = await h.act({ kind: 'fill_form', fields }, fillId);
        assert.equal(filled.json.ok, true, filled.text);
        assert.equal(filled.json.observed, 'profile_builder');
        assert.deepEqual(filled.json.elements, [], 'an action returns the state, never fresh handles');
        assert.equal(filled.json.ownerAppAccountEmail, EMAIL);
        assert.equal(await h.tab.inputValue('#builderTagline'), 'e2e-nonce-7Hq');
        assert.equal(await h.tab.inputValue('#builderBio'), 'Story line one\nline two\twith a tab');
        // The same requestId replays the receipt; a different action under it is a conflict; handles are single-use.
        assert.deepEqual((await h.act({ kind: 'fill_form', fields }, fillId)).json, filled.json);
        assert.equal((await h.act({ kind: 'fill_form', fields: [{ ...fields[0], text: 'Other' }] }, fillId)).json.error, 'browser_action_conflict');
        assert.equal((await h.act({ kind: 'click', ref: elementNamed(framed, 'Save changes').ref })).json.error, 'browser_action_unavailable');

        const again = await h.read();
        assert.equal(h.posted.length, 0, 'nothing was posted before Save');
        const saved = await h.act({ kind: 'click', ref: elementNamed(again, 'Save changes').ref });
        assert.equal(saved.json.ok, true, saved.text);
        assert.equal(saved.json.observed, 'profile_builder');
        for (let i = 0; i < 40 && h.posted.length === 0; i++) await delay(50);
        assert.equal(h.posted.length, 1, 'Save went through');
        const form = new URLSearchParams(h.posted[0]);
        assert.equal(form.get('tagline'), 'e2e-nonce-7Hq');
        assert.equal(form.get('firstname'), 'Grace');
        assert.equal(form.get('manual_save'), '1');
        assert.equal(form.get('about'), 'Story line one\nline two\twith a tab');
        assertNoLeak(saved, 'save result');

        // A select and a checkbox act through the same verbs.
        const third = await h.read();
        assert.equal((await h.act({ kind: 'select', ref: elementNamed(third, 'Rate unit').ref, values: ['per day'] })).json.ok, true);
        assert.equal(await h.tab.inputValue('#builderRateUnit'), 'day');
        const fourth = await h.read();
        assert.equal((await h.act({ kind: 'click', ref: elementNamed(fourth, 'Available for work').ref })).json.ok, true);
        assert.equal(await h.tab.isChecked('input[name=available]'), true);
        // A typed action is refused on a control that cannot take text, and nothing is sent.
        const fifth = await h.read();
        assert.equal((await h.act({ kind: 'type', ref: elementNamed(fifth, 'Save changes').ref, text: 'x' })).json.error, 'browser_action_unavailable');
        assert.equal(h.posted.length, 1);

        // The element a handle names is re-read before anything is sent: one that became something else since the
        // read (same node, same ref attribute, a new label) is refused, and the click never happens.
        const sixth = await h.read();
        await h.tab.$eval('.js-save-btn', (el) => { el.textContent = 'Publish profile'; });
        assert.equal((await h.act({ kind: 'click', ref: elementNamed(sixth, 'Save changes').ref })).json.error, 'browser_action_unavailable');
        await delay(200);
        assert.equal(h.posted.length, 1, 'the changed button was not clicked');
        // Positive control: read again, and the new label is what may be clicked.
        const seventh = await h.read();
        assert.ok(elementNamed(seventh, 'Publish profile'));
        assert.equal(elementNamed(seventh, 'Save changes'), undefined);
    } finally {
        await h.close();
    }
});

test('real Chromium: navigation stays on the owner app, and actions need a read of the document they act on', { skip: !CHROME }, async () => {
    const h = await harness();
    try {
        const start = await h.read();
        assert.equal(start.json.observed, 'browser_ready', start.text);
        // An IdP origin is never a navigate target; an unapproved origin is not one either.
        assert.equal((await h.act({ kind: 'navigate', url: IDP + '/u/login' })).json.error, 'browser_action_unavailable');
        assert.equal((await h.act({ kind: 'navigate', url: 'https://elsewhere.example.invalid/' })).json.error, 'browser_action_unavailable');
        const opened = await h.act({ kind: 'navigate', url: OWNER + '/builder/profile-builder' });
        assert.equal(opened.json.ok, true, opened.text);
        assert.equal(opened.json.observed, 'profile_builder');
        assert.equal(h.tab.url(), OWNER + '/builder/profile-builder');
        // No read of this document yet: no non-navigate action.
        assert.equal((await h.act({ kind: 'press', key: 'Tab' })).json.error, 'browser_action_unavailable');
        await h.read();
        assert.equal((await h.act({ kind: 'press', key: 'Tab' })).json.ok, true);
        assert.equal((await h.act({ kind: 'scroll', dy: 400 })).json.ok, true);
        // A submit that navigates is allowed from an owner-app page and lands on the next owner-app page.
        const listed = await h.read();
        assert.equal((await h.act({ kind: 'type', ref: elementNamed(listed, 'Search jobs').ref, text: 'rust' })).json.ok, true);
        const search = await h.read();
        const searched = await h.act({ kind: 'click', ref: elementNamed(search, 'Search').ref });
        assert.equal(searched.json.ok, true, searched.text);
        assert.equal(searched.json.observed, 'owner_app_page');
        assert.equal(searched.json.pageUrl, OWNER + '/builder/jobs');
        assert.equal(new URL(h.tab.url()).searchParams.get('q'), 'rust');
        assert.equal(searched.json.ownerAppAccountEmail, null);
        const jobs = await h.read();
        assert.deepEqual(labelsOf(jobs), [['link', 'Back to my profile']]);
        assert.equal(jobs.json.ownerAppAccountEmail, null, 'the e-mail comes from the profile builder only');
    } finally {
        await h.close();
    }
});

test('real Chromium: an IdP page and the Universe sign-in handoff are sign-in only: no element, frame, title or e-mail', { skip: !CHROME }, async () => {
    const h = await harness();
    try {
        await h.tab.goto(IDP + '/u/login?state=IDPSTATEk2Xm&client=c1');
        const idp = await h.read(true);
        assert.equal(idp.status, 200, idp.text);
        assert.deepEqual(idp.json, {
            ok: true, browserSessionId: idp.json.browserSessionId, expiresAt: idp.json.expiresAt,
            observed: 'interactive_sign_in_required', profileHeadingVisible: false, universeIdentity: 'unverified',
            pageUrl: IDP + '/u/login', pageTitle: null, elements: [], viewerFrame: null, ownerAppAccountEmail: null,
        });
        assertNoLeak(idp, 'IdP read');
        // Nothing on the page was stamped or registered.
        assert.equal(await h.tab.$$eval('[data-ezil-ref]', (els) => els.length), 0);
        // Transit only: a key press there is refused before anything happens.
        assert.equal((await h.act({ kind: 'press', key: 'Enter' })).json.error, 'origin_read_only');
        assert.equal((await h.act({ kind: 'scroll', dy: 100 })).json.error, 'origin_read_only');
        assert.equal(await h.tab.inputValue('#p'), PASSWORD, 'the IdP form was not touched');
        // Leaving it for the owner app is allowed: navigation is what transit means.
        const back = await h.act({ kind: 'navigate', url: OWNER + '/builder/profile-builder' });
        assert.equal(back.json.observed, 'profile_builder', back.text);

        h.fresh();
        await h.tab.goto(OWNER + '/?role=builder&redirect=' + encodeURIComponent(CALLBACK));
        const landing = await h.read(true);
        assert.equal(landing.json.observed, 'interactive_sign_in_required', landing.text);
        assert.equal(landing.json.pageUrl, OWNER + '/');
        assert.deepEqual([landing.json.elements, landing.json.viewerFrame, landing.json.pageTitle, landing.json.ownerAppAccountEmail],
            [[], null, null, null]);
        assertNoLeak(landing, 'sign-in landing');
        assert.equal((await h.act({ kind: 'press', key: 'Enter' })).json.error, 'browser_action_unavailable');
    } finally {
        await h.close();
    }
});

test('real Chromium: a callback URL carrying code and state leaves no code= or state= in any answer', { skip: !CHROME }, async () => {
    const h = await harness();
    try {
        await h.tab.goto(CALLBACK);
        const read = await h.read(true);
        assert.equal(read.json.observed, 'owner_app_page', read.text);
        assert.equal(read.json.pageUrl, OWNER + '/creator/social-login/callback/auth0');
        assertNoLeak(read, 'callback read');
        // Positive control: the page was really read — the labels are there, minus what was sanitised.
        assert.deepEqual(labelsOf(read).map(([kind]) => kind), ['link', 'button', 'select']);
        // Sanitised first, then cut to 80 characters: a cut can never bring a parameter back.
        assert.ok(elementNamed(read, ('Continue to ' + OWNER + '/creator/social-login/callback/auth0').slice(0, 80)), read.text);
        assert.equal(read.json.pageTitle, 'Signing in ' + OWNER + '/creator/social-login/callback/auth0');
        assert.deepEqual(elementNamed(read, 'Where next').options, ['/cb', 'Profile']);
        const scrolled = await h.act({ kind: 'scroll', dy: 50 });
        assert.equal(scrolled.json.ok, true, scrolled.text);
        assertNoLeak(scrolled, 'callback action');
        // A navigate to a callback-style URL answers with the sanitised page.
        const navigated = await h.act({ kind: 'navigate', url: CALLBACK.replace('AUTHCODEq7Rk', 'AUTHCODEq7Rk2') });
        assert.equal(navigated.json.ok, true, navigated.text);
        assertNoLeak(navigated, 'callback navigate');
    } finally {
        await h.close();
    }
});

test('real Chromium: a page whose controls would pass 160 KiB is trimmed, the frame kept, the answer under the bound', { skip: !CHROME }, async () => {
    const h = await harness();
    try {
        await h.tab.goto(OWNER + '/builder/big');
        const plain = await h.read();
        assert.equal(plain.json.ok, true, plain.text.slice(0, 300));
        assert.ok(plain.bytes <= BROWSER_UI_RESULT_MAX_BYTES, `${plain.bytes} bytes`);
        assert.ok(plain.bytes > BROWSER_UI_RESULT_MAX_BYTES - 6 * 1024, `${plain.bytes} bytes: trimmed to the bound, not far below it`);
        assert.ok(plain.json.elements.length > 0 && plain.json.elements.length < 64, `${plain.json.elements.length} elements`);
        assert.equal(plain.json.elements[0].options.length, 20);
        assert.equal(plain.json.elements[0].options[0].length, 80);
        const framed = await h.read(true);
        assert.ok(framed.bytes <= BROWSER_UI_RESULT_MAX_BYTES, `${framed.bytes} bytes`);
        assert.equal(framed.json.viewerFrame?.mimeType, 'image/jpeg', 'the frame is kept: trimming the list was enough');
        assert.ok(framed.json.elements.length < plain.json.elements.length);
        // A handle trimmed away is spent: only listed handles act.
        const last = framed.json.elements[framed.json.elements.length - 1];
        assert.equal((await h.act({ kind: 'select', ref: last.ref, values: [String.fromCharCode(0x20ac).repeat(80)] })).json.ok, true);
    } finally {
        await h.close();
    }
});

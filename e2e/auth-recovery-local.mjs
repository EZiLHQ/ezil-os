/**
 * Auth recovery round trips in Chromium against a LOCAL app (os-share-auth-20261103-v1): "Sign out and use another
 * account" from an unverified-email refusal, with no OS session cookie, and the destination kept through id.ezil.work's
 * logout, a cancelled sign-in, refresh and Back/Forward.
 *
 * 🔴 Fixture only, never Auth0. Chromium resolves id.ezil.work:443 to a local HTTPS stand-in started by this script
 * (self-signed: AUTH_RECOVERY_IDP_CERT / _KEY, port AUTH_RECOVERY_IDP_PORT), which plays `oidc/logout` (straight back to
 * the registered `post_logout_redirect_uri`) and `authorize` (back cancelled, `error=access_denied`); every other
 * non-local request is aborted. The token exchange and JWKS are server-side and not reached by these flows; a verified
 * sign-in is covered by the route tests only.
 *
 * How it was run (os-share-auth evidence), as root, everything inside ONE network namespace with no way out:
 *   unshare -n bash -c '
 *     ip link set lo up
 *     # Chromium refuses to navigate while it believes it is offline; a black-hole default route lets nothing out.
 *     ip link add dummy0 type dummy && ip addr add 10.255.255.1/24 dev dummy0 && ip link set dummy0 up \
 *       && ip route add default dev dummy0
 *     cd app && setsid env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development NEXT_TELEMETRY_DISABLED=1 \
 *       AUTH0_CLIENT_ID=local-fixture-client AUTH0_SECRET_ID=local-fixture-secret-not-a-real-one \
 *       NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 NEXT_PUBLIC_SUPABASE_ANON_KEY=fixture-anon \
 *       SUPABASE_DATABASE_URL=postgres://fixture@127.0.0.1:9/none \
 *       node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3187 &
 *     # wait for http://127.0.0.1:3187/login to answer 200, then:
 *     PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       PLAYWRIGHT_CHROMIUM_EXECUTABLE=~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell \
 *       AUTH_RECOVERY_IDP_CERT=c.pem AUTH_RECOVERY_IDP_KEY=k.pem node ../e2e/auth-recovery-local.mjs'
 * (No .env file may exist in app/. That Playwright expects headless shell 1228; 1248 is the one installed here.)
 * The self-signed pair: openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=id.ezil.work -days 1 -keyout k.pem -out c.pem
 * Chromium maps id.ezil.work:443 to the stand-in itself (--host-resolver-rules), and localhost to 127.0.0.1.
 * Optional: AUTH_RECOVERY_BASE_URL (default http://localhost:3187), AUTH_RECOVERY_IDP_PORT (default 8443).
 * Exit 2 means unable to run.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';

const base = new URL(process.env.AUTH_RECOVERY_BASE_URL || 'http://localhost:3187');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'Use a local app server');
const IDP = 'https://id.ezil.work';
const KEPT = '__Host-ezil-login-return';
const SESSION = /^(?:__Host-ezil-os-auth|sb-.*-auth-token)/;
/** Every hop the stand-in served, in order. */
const seen = { logout: [], authorize: [] };
const idpPort = Number(process.env.AUTH_RECOVERY_IDP_PORT || 8443);
let browser;
let idp;
try {
    idp = createServer({ cert: readFileSync(process.env.AUTH_RECOVERY_IDP_CERT), key: readFileSync(process.env.AUTH_RECOVERY_IDP_KEY) }, (req, res) => {
        const url = new URL(req.url, 'https://id.ezil.work');
        let location = null;
        if (url.pathname === '/oidc/logout') {
            seen.logout.push(url);
            location = url.searchParams.get('post_logout_redirect_uri');
        } else if (url.pathname === '/authorize') {
            seen.authorize.push(url);
            const back = new URL(url.searchParams.get('redirect_uri'));
            back.search = new URLSearchParams({ error: 'access_denied', error_description: 'fixture cancel', state: url.searchParams.get('state') }).toString();
            location = back.toString();
        }
        res.writeHead(location ? 302 : 404, location ? { location } : {}).end();
    });
    await new Promise((resolve, reject) => idp.once('error', reject).listen(idpPort, '127.0.0.1', resolve));
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch {
        const require = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR || 'node_modules'), 'probe.cjs'));
        ({ chromium } = require('playwright'));
    }
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        args: ['--no-sandbox', `--host-resolver-rules=MAP localhost 127.0.0.1, MAP id.ezil.work:443 127.0.0.1:${idpPort}`],
    });
    const response = await fetch(new URL('/login', `http://127.0.0.1:${base.port}`), { signal: AbortSignal.timeout(120_000) });
    assert(response.ok, 'Local login route must return success');
    assert.match(await response.text(), /Continue with EZiL ID/, 'The app must run with the Auth0 fixture settings');
} catch (error) {
    console.error(`UNABLE TO RUN: ${error.message.split('\n')[0]}`);
    await browser?.close();
    idp?.close();
    process.exit(2);
}

let passed = 0;
let failed = 0;
/** The step a long check is on, named in its failure. */
let stage = '';
async function check(name, run) {
    stage = '';
    try { await run(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}${stage && ` [at: ${stage}]`}: ${error.message.split('\n')[0]}`); }
}

/** A context whose only ways off the local app are the id.ezil.work stand-in; `hops` counts what it served from here. */
async function contextWith(options = {}) {
    const context = await browser.newContext({ ...options, ignoreHTTPSErrors: true });
    const from = { logout: seen.logout.length, authorize: seen.authorize.length };
    const blocked = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if ([base.origin, `http://127.0.0.1:${base.port}`, IDP].includes(url.origin)) return route.continue();
        blocked.push(url.origin);
        return route.abort('blockedbyclient');
    });
    const hops = () => ({ logout: seen.logout.slice(from.logout), authorize: seen.authorize.slice(from.authorize), blocked });
    return { context, hops };
}

const href = async page => page.getByRole('link', { name: 'Continue with EZiL ID' }).getAttribute('href');
const kept = async context => (await context.cookies(base.origin)).find(c => c.name === KEPT);
const signOut = page => page.getByRole('button', { name: 'Sign out and use another account' });
const loginFor = returnUrl => new URL(`/login?${new URLSearchParams({ error: 'email_unverified', returnUrl })}`, base).toString();

await check('unverified refusal: alert, accessible sign-out right after Continue in tab order', async () => {
    const { context } = await contextWith();
    const page = await context.newPage();
    await page.goto(loginFor('/app/browser'));
    assert.match(await page.getByRole('alert').innerText(), /not verified yet.*verification link.*Continue with EZiL ID again/s);
    const button = signOut(page);
    assert.equal(await button.count(), 1);
    const hint = await button.getAttribute('aria-describedby');
    assert.match(await page.locator(`#${hint}`).textContent(), /Signs this browser out of EZiL ID/);
    await page.getByRole('link', { name: 'Continue with EZiL ID' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Sign out and use another account');
    assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser');
    await context.close();
});

/**
 * The whole recovery, twice: with JavaScript off and every control worked from the keyboard (the plain-form path), and
 * with JavaScript on and every control clicked. (With JavaScript off, Playwright's pointer actionability wait on the
 * link never settles here, though `elementFromPoint` at its centre is the link itself; the keyboard is the real no-JS
 * path anyway.)
 */
for (const [mode, options, activate] of [
    ['no JavaScript, keyboard', { javaScriptEnabled: false }, async locator => { await locator.focus(); await locator.press('Enter'); }],
    ['JavaScript, mouse', {}, async locator => locator.click()],
]) {
    await check(`🔴 ${mode}, no OS cookie: sign-out → fixed logout → /login still headed for /app/browser; refresh; cancelled retry; Back/Forward; switch again`, async () => {
        const { context, hops } = await contextWith(options);
        const page = await context.newPage();
        await page.goto(loginFor('/app/browser'));
        assert.equal((await context.cookies()).filter(c => SESSION.test(c.name)).length, 0, 'starts without an OS session');
        stage = 'sign-out';
        await Promise.all([page.waitForURL(url => url.pathname === '/login' && !url.search), activate(signOut(page))]);
        assert.equal(hops().logout.length, 1);
        assert.deepEqual(Object.fromEntries(hops().logout[0].searchParams), { client_id: 'local-fixture-client', post_logout_redirect_uri: `${base.origin}/login` });
        assert.equal(await page.getByRole('alert').count(), 0, 'the stale refusal is gone');
        assert.equal(await signOut(page).count(), 0, 'the plain lock screen has no sign-out control');
        assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser');
        const cookie = await kept(context);
        assert(cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Lax' && cookie.path === '/', 'kept in a host-only, httpOnly cookie');
        assert.equal((await context.cookies()).filter(c => SESSION.test(c.name)).length, 0, 'no OS session was minted');
        stage = 'refresh';
        await page.reload();
        assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser', 'refresh keeps it');

        stage = 'cancelled retry';
        await Promise.all([page.waitForURL(url => url.searchParams.get('error') !== null), activate(page.getByRole('link', { name: 'Continue with EZiL ID' }))]);
        assert.equal(hops().authorize.length, 1);
        const authorize = hops().authorize[0];
        assert.equal(authorize.searchParams.get('client_id'), 'local-fixture-client');
        assert.equal(authorize.searchParams.get('redirect_uri'), `${base.origin}/auth/auth0/callback`);
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authorize.searchParams.has('prompt'), false);
        // The exact code: `invalid_transaction` would mean the signed transaction cookie never stuck, a different branch.
        assert.equal(new URL(page.url()).search, '?error=auth0_failed&returnUrl=%2Fapp%2Fbrowser');
        assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser');
        assert(await kept(context), 'a failed attempt keeps the page for the retry');

        stage = 'Back';
        await Promise.all([page.waitForURL(url => url.pathname === '/login' && !url.search, { timeout: 15_000 }), page.goBack()]);
        assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser', 'Back');
        stage = 'Forward';
        await Promise.all([page.waitForURL(url => url.search === '?error=auth0_failed&returnUrl=%2Fapp%2Fbrowser', { timeout: 15_000 }), page.goForward()]);
        assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser', 'Forward');

        stage = 'switch again';
        await Promise.all([page.waitForURL(url => url.pathname === '/login' && !url.search), activate(signOut(page))]);
        assert.equal(hops().logout.length, 2);
        assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fapp%2Fbrowser', 'account switch again');
        assert.deepEqual(hops().blocked.filter(origin => !origin.startsWith('https://fonts.')), []);
        await context.close();
    });
}

for (const [hostile, expected] of [
    ['https://evil.example/', '/computers'], ['//evil.example', '/computers'], ['/\\evil.example', '/computers'],
    ['/%2F%2Fevil.example', '/computers'], ['javascript:alert(1)', '/computers'], ['/app/%2e%2e/admin', '/os'],
    ['/app/browser?tab=1#top', '/app/browser?tab=1#top'], ['/app/desktop', '/app/desktop'],
]) {
    await check(`returnUrl ${JSON.stringify(hostile)} → ${expected} for Continue and the sign-out form`, async () => {
        const { context } = await contextWith();
        const page = await context.newPage();
        await page.goto(loginFor(hostile));
        assert.equal(await href(page), `/auth/auth0/login?${new URLSearchParams({ returnUrl: expected })}`);
        assert.equal(await page.locator('form[action="/auth/signout"] input[name="returnUrl"]').inputValue(), expected);
        // Every navigation target and form value on the page; the RSC payload's own copy of the URL is data, not a target.
        const targets = await page.evaluate(() => [...document.querySelectorAll('a[href], form[action], input[value]')]
            .map(el => el.getAttribute('href') ?? el.getAttribute('action') ?? el.getAttribute('value')));
        // React's own placeholder on the server-action form is the one `javascript:` allowed.
        const reactSentinel = "javascript:throw new Error('React form unexpectedly submitted.')";
        assert(targets.length >= 3 && !targets.some(target => /evil/i.test(target) || (/^javascript:/i.test(target) && target !== reactSentinel)), JSON.stringify(targets));
        await context.close();
    });
}

await check('a tampered sign-out field is narrowed by the server before it is kept', async () => {
    const { context } = await contextWith();
    const page = await context.newPage();
    await page.goto(loginFor('/app/browser'));
    await page.locator('form[action="/auth/signout"] input[name="returnUrl"]').evaluate(input => { input.value = 'https://evil.example/'; });
    await Promise.all([page.waitForURL(url => url.pathname === '/login' && !url.search), signOut(page).click()]);
    assert.equal(await href(page), '/auth/auth0/login?returnUrl=%2Fcomputers');
    await context.close();
});

await check('a sign-out POSTed from another origin is refused before anything is kept', async () => {
    const { context, hops } = await contextWith();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${base.port}/login`);
    const [response] = await Promise.all([
        page.waitForResponse(r => r.url() === `${base.origin}/auth/signout`),
        page.evaluate(action => {
            const form = Object.assign(document.createElement('form'), { method: 'post', action });
            form.append(Object.assign(document.createElement('input'), { name: 'returnUrl', value: '/app/browser' }));
            document.body.append(form);
            form.submit();
        }, `${base.origin}/auth/signout`),
    ]);
    assert.equal(response.status(), 403);
    assert.equal(hops().logout.length, 0);
    assert.equal(await kept(context), undefined);
    await context.close();
});

await browser.close();
idp.close();
console.log(`${passed} passed, ${failed} failed (local fixture IdP; not Auth0 proof)`);
process.exit(failed ? 1 : 0);

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONSENT_ACCEPT, DEFAULT_ID_ORIGIN, LOGIN_BUTTON, PASSWORD_INPUT, PRIMARY_SUBMIT, USERNAME_INPUT,
  appLoginError, classifyAuth0Alert, classifyScreen, loginUrl, screenName, signIn,
} from './sign-in-ezilid.mjs';

const APP = 'https://os-prod.ezil.work';
const ID = 'https://id.ezil.work';
const EMAIL = 'qa-test@example.invalid';
const PASSWORD = 'Private-Passw0rd!';
const place = { app: APP, idOrigin: ID, destination: '/os' };
const clean = error => !/Private-Passw0rd|qa-test@example/.test(`${error.message}\n${error.stack}`);

// ── pure helpers ───────────────────────────────────────────────────────────

test('the EZiL ID origin mirrors the app\'s Auth0 issuer', () => {
  assert.equal(DEFAULT_ID_ORIGIN, 'https://id.ezil.work');
});

test('the login URL carries only a same-origin destination', () => {
  assert.equal(loginUrl(APP), `${APP}/login?returnUrl=%2Fos`);
  assert.equal(loginUrl(`${APP}/os?x=1`, '/computers'), `${APP}/login?returnUrl=%2Fcomputers`);
  assert.equal(loginUrl('http://localhost:3000', '/os'), 'http://localhost:3000/login?returnUrl=%2Fos');
  assert.throws(() => loginUrl('http://os-prod.ezil.work'), /needs the app origin/);
  assert.throws(() => loginUrl(APP, '//evil.example'), /same-origin destination/);
  assert.throws(() => loginUrl(APP, 'https://evil.example/'), /same-origin destination/);
});

test('the app\'s refusal code is read from /login?error= and allowlisted', () => {
  assert.equal(appLoginError(`${APP}/login?error=account_conflict`), 'account_conflict');
  assert.equal(appLoginError(`${APP}/login?error=email_unverified&returnUrl=%2Fos`), 'email_unverified');
  assert.equal(appLoginError(`${APP}/login?error=<script>`), null);
  assert.equal(appLoginError(`${APP}/login?error=${'a'.repeat(65)}`), null);
  assert.equal(appLoginError(`${APP}/login`), null);
  assert.equal(appLoginError('not a url'), null);
});

test('Universal Login screen names come from the path, allowlisted', () => {
  assert.equal(screenName('/u/login/password'), 'login-password');
  assert.equal(screenName('/u/reset-password/request/Username-Password-Authentication'), 'reset-password-request');
  assert.equal(screenName('/u/signup'), 'signup');
  assert.equal(screenName('/u/<x>'), 'unknown');
  assert.equal(screenName(''), 'root');
});

test('every place in the flow is classified, and only the EZiL ID origin gets login screens', () => {
  const kind = href => classifyScreen(href, place);
  assert.deepEqual(kind(`${APP}/os`), { kind: 'destination' });
  assert.deepEqual(kind(`${APP}/os?computer=1`), { kind: 'destination' });
  assert.deepEqual(kind(`${APP}/login?returnUrl=%2Fos`), { kind: 'app-login' });
  assert.deepEqual(kind(`${APP}/login?error=auth0_failed`), { kind: 'app-login', code: 'auth0_failed' });
  assert.deepEqual(kind(`${APP}/auth/auth0/callback?code=c&state=s`), { kind: 'app-transit' });
  assert.deepEqual(kind(`${ID}/authorize?client_id=x`), { kind: 'id-transit' });
  assert.deepEqual(kind(`${ID}/authorize/resume?state=s`), { kind: 'id-transit' });
  assert.deepEqual(kind(`${ID}/u/login/identifier?state=s`), { kind: 'identifier' });
  assert.deepEqual(kind(`${ID}/u/login/password?state=s`), { kind: 'password' });
  assert.deepEqual(kind(`${ID}/u/login?state=s`), { kind: 'login' });
  assert.deepEqual(kind(`${ID}/u/consent?state=s`), { kind: 'consent' });
  assert.deepEqual(kind(`${ID}/u/mfa-otp-challenge?state=s`), { kind: 'mfa' });
  assert.deepEqual(kind(`${ID}/u/signup?state=s`), { kind: 'id-other', name: 'signup' });
  assert.deepEqual(kind('about:blank'), { kind: 'blank' });
  // Look-alikes are foreign: credentials are never typed there.
  assert.deepEqual(kind('https://id.ezil.work.evil.example/u/login/password'), { kind: 'foreign', host: 'id.ezil.work.evil.example' });
  assert.deepEqual(kind('http://id.ezil.work/u/login/password'), { kind: 'foreign', host: 'id.ezil.work' });
  assert.deepEqual(kind('https://accounts.google.com/o/oauth2/auth'), { kind: 'foreign', host: 'accounts.google.com' });
  assert.equal(classifyScreen(`${ID}/u/login/password`, { ...place, idOrigin: 'http://id.ezil.work' }).kind, 'foreign',
    'a non-HTTPS EZiL ID origin is never trusted');
});

test('Auth0 alert text becomes a class, never the text', () => {
  assert.equal(classifyAuth0Alert('Wrong email or password'), 'wrong_credentials');
  assert.equal(classifyAuth0Alert('Wrong username or password'), 'wrong_credentials');
  assert.equal(classifyAuth0Alert('Incorrect password'), 'wrong_credentials');
  assert.equal(classifyAuth0Alert('Your account has been blocked after multiple consecutive login attempts.'), 'too_many_attempts');
  assert.equal(classifyAuth0Alert('This account is blocked.'), 'blocked');
  assert.equal(classifyAuth0Alert('Solve the challenge question to verify you are not a robot.'), 'challenge');
  assert.equal(classifyAuth0Alert('You need to reset your password'), 'password_reset_required');
  assert.equal(classifyAuth0Alert('Please enter a valid email address'), 'invalid_input');
  assert.equal(classifyAuth0Alert('Something else'), 'other');
  assert.equal(classifyAuth0Alert('  '), null);
  assert.equal(classifyAuth0Alert(undefined), null);
});

test('the selectors target the primary submit, never a social button', () => {
  assert.match(PRIMARY_SUBMIT, /\[name="action"\]\[value="default"\]/);
  assert.match(PRIMARY_SUBMIT, /:not\(\[data-provider\]\)/);
  assert.match(CONSENT_ACCEPT, /\[value="accept"\]/);
  assert.match(LOGIN_BUTTON, /Continue with EZiL ID/);
  assert.match(USERNAME_INPUT, /#username/);
  assert.match(PASSWORD_INPUT, /type="password"/);
});

// ── the flow, with a fake page ─────────────────────────────────────────────

/**
 * A page whose URL moves through `script`: each entry names the URL after an
 * action (`goto`, `click:<selector>`, `press`). `alerts` maps a URL to the
 * Auth0 alert text shown there; `fails` makes one selector's action throw an
 * error that quotes the password, as a driver call log can.
 */
function fakePage({ start = 'about:blank', after = {}, alerts = {}, visible = new Set(), fails = new Set(), notice = '' } = {}) {
  let current = start;
  const calls = [];
  const move = key => { if (!after[key]) return false; current = after[key]; return true; };
  const locator = selector => {
    const self = {
      first: () => self,
      waitFor: async () => { calls.push(['waitFor', selector]); if (!visible.has(selector)) throw new Error(`timeout waiting for ${selector}`); },
      isVisible: async () => visible.has(selector),
      isEditable: async () => visible.has(selector),
      fill: async (value, options) => {
        calls.push(['fill', selector, value, new URL(current).origin]);
        if (fails.has(selector)) throw new Error(`locator.fill: Timeout\nCall log:\n  - fill("${value}")`);
        assert.ok(options?.timeout > 0);
      },
      click: async () => { calls.push(['click', selector]); if (fails.has(selector)) throw new Error(`click failed after typing ${PASSWORD}`); move(`click:${selector}:${current}`) || move(`click:${selector}`); },
      press: async key => { calls.push(['press', selector, key]); move(`press:${current}`); },
    };
    return self;
  };
  const page = {
    url: () => current,
    goto: async (href, options) => { calls.push(['goto', href, options.waitUntil]); current = after[`goto:${href}`] ?? href; },
    locator,
    evaluate: async fn => (fn.name === 'readAuth0Alert' ? alerts[current] ?? '' : fn.name === 'readLoginNotice' ? notice : ''),
  };
  return { page, calls };
}

const LOGIN = `${APP}/login?returnUrl=%2Fos`;
const IDENT = `${ID}/u/login/identifier?state=abc`;
const PASS = `${ID}/u/login/password?state=abc`;
const happy = {
  [`click:${LOGIN_BUTTON}`]: IDENT,
  [`click:${PRIMARY_SUBMIT}:${IDENT}`]: PASS,
  [`click:${PRIMARY_SUBMIT}:${PASS}`]: `${APP}/os`,
};
const fast = { nap: async () => {} };

test('identifier-first: the email on the identifier screen, the password on the password screen, then /os', async () => {
  const f = fakePage({ after: happy, visible: new Set([LOGIN_BUTTON, USERNAME_INPUT, PASSWORD_INPUT, PRIMARY_SUBMIT]) });
  await signIn(f.page, { email: EMAIL, password: PASSWORD, app: APP, ...fast });
  assert.deepEqual(f.calls[0], ['goto', LOGIN, 'domcontentloaded']);
  const fills = f.calls.filter(call => call[0] === 'fill');
  assert.deepEqual(fills, [['fill', USERNAME_INPUT, EMAIL, ID], ['fill', PASSWORD_INPUT, PASSWORD, ID]],
    'the email and the password are typed once each, both on the EZiL ID origin');
  assert.equal(f.page.url(), `${APP}/os`);
  assert.ok(!f.calls.some(call => call[0] === 'press'), 'the visible primary button is clicked, not Enter');
});

test('a combined login form and a consent screen are completed too', async () => {
  const COMBINED = `${ID}/u/login?state=abc`, CONSENT = `${ID}/u/consent?state=abc`;
  const f = fakePage({
    after: { [`click:${LOGIN_BUTTON}`]: COMBINED, [`click:${PRIMARY_SUBMIT}:${COMBINED}`]: CONSENT, [`click:${CONSENT_ACCEPT}:${CONSENT}`]: `${APP}/os` },
    visible: new Set([LOGIN_BUTTON, USERNAME_INPUT, PASSWORD_INPUT, PRIMARY_SUBMIT, CONSENT_ACCEPT]),
  });
  await signIn(f.page, { email: EMAIL, password: PASSWORD, app: APP, ...fast });
  assert.deepEqual(f.calls.filter(call => call[0] === 'fill').map(call => call[1]), [USERNAME_INPUT, PASSWORD_INPUT]);
  assert.ok(f.calls.some(call => call[0] === 'click' && call[1] === CONSENT_ACCEPT));
});

test('without a visible primary button the form is submitted with Enter', async () => {
  const f = fakePage({
    after: { [`click:${LOGIN_BUTTON}`]: IDENT, [`press:${IDENT}`]: PASS, [`press:${PASS}`]: `${APP}/os` },
    visible: new Set([LOGIN_BUTTON, USERNAME_INPUT, PASSWORD_INPUT]),
  });
  await signIn(f.page, { email: EMAIL, password: PASSWORD, app: APP, ...fast });
  assert.deepEqual(f.calls.filter(call => call[0] === 'press').map(call => call[1]), [USERNAME_INPUT, PASSWORD_INPUT]);
});

test('every failure is a fixed message without the address or the password', async () => {
  const visible = new Set([LOGIN_BUTTON, USERNAME_INPUT, PASSWORD_INPUT, PRIMARY_SUBMIT]);
  const cases = [
    ['the app refused the callback', { after: { ...happy, [`click:${PRIMARY_SUBMIT}:${PASS}`]: `${APP}/login?error=account_conflict` } },
      /^EZiL ID sign-in was refused by the app \(account_conflict\)$/],
    ['a wrong password re-renders the same screen with an alert',
      { after: { ...happy, [`click:${PRIMARY_SUBMIT}:${PASS}`]: PASS }, alerts: { [PASS]: `Wrong email or password for ${EMAIL}` } },
      /^EZiL ID refused the sign-in at the password screen \(wrong_credentials\)$/],
    ['an MFA challenge', { after: { ...happy, [`click:${PRIMARY_SUBMIT}:${PASS}`]: `${ID}/u/mfa-otp-challenge?state=abc` } },
      /asked for a second factor \(MFA\)/],
    ['an unexpected Universal Login screen', { after: { ...happy, [`click:${PRIMARY_SUBMIT}:${IDENT}`]: `${ID}/u/signup/password?state=abc` } },
      /^EZiL ID showed an unexpected screen \(signup-password\)$/],
    ['a redirect to another host, before any typing', { after: { [`click:${LOGIN_BUTTON}`]: 'https://login.evil.example/u/login/identifier' } },
      /^EZiL ID sign-in reached an unexpected host \(login\.evil\.example\)$/],
    ['a driver error that quotes the password', { after: happy, fails: new Set([PASSWORD_INPUT]) },
      /^EZiL ID password screen could not be completed$/],
    ['a click error that quotes the password', { after: happy, fails: new Set([LOGIN_BUTTON]) },
      /^"Continue with EZiL ID" could not be clicked$/],
  ];
  for (const [name, options, expected] of cases) {
    const f = fakePage({ visible, ...options });
    const error = await signIn(f.page, { email: EMAIL, password: PASSWORD, app: APP, ...fast }).then(() => null, error => error);
    assert.ok(error, `${name}: must fail`);
    assert.match(error.message, expected, name);
    assert.ok(clean(error), `${name}: leaked a credential`);
  }
  const foreign = fakePage({ visible, after: { [`click:${LOGIN_BUTTON}`]: 'https://login.evil.example/u/login/identifier' } });
  await signIn(foreign.page, { email: EMAIL, password: PASSWORD, app: APP, ...fast }).catch(() => {});
  assert.ok(!foreign.calls.some(call => call[0] === 'fill'), 'nothing is typed off the EZiL ID origin');
});

test('a login page without the EZiL ID button says whether sign-in is unavailable there', async () => {
  const unavailable = fakePage({ notice: 'Sign-in is unavailable right now. Please try again later or contact contact@ezil.work.' });
  await assert.rejects(signIn(unavailable.page, { email: EMAIL, password: PASSWORD, app: APP, ...fast }),
    /^Error: EZiL ID sign-in is unavailable on this deployment/);
  await assert.rejects(signIn(fakePage().page, { email: EMAIL, password: PASSWORD, app: APP, ...fast }),
    /^Error: The login page has no "Continue with EZiL ID" button$/);
});

test('a flow that never moves on times out naming the screen, and inputs are checked first', async () => {
  let clock = 0;
  const f = fakePage({ after: { [`click:${LOGIN_BUTTON}`]: IDENT, [`click:${PRIMARY_SUBMIT}:${IDENT}`]: IDENT },
    visible: new Set([LOGIN_BUTTON, USERNAME_INPUT, PRIMARY_SUBMIT]) });
  const error = await signIn(f.page, { email: EMAIL, password: PASSWORD, app: APP, timeoutMs: 60_000,
    now: () => clock, nap: async ms => { clock += ms; } }).then(() => null, e => e);
  assert.match(error.message, /^EZiL ID did not move on from the identifier screen$/);
  assert.ok(clean(error));
  await assert.rejects(signIn(f.page, { email: EMAIL, app: APP }), /Missing EZiL ID sign-in credentials/);
  await assert.rejects(signIn(f.page, { email: EMAIL, password: PASSWORD, app: 'ftp://x' }), /needs the app origin/);
  await assert.rejects(signIn(f.page, { email: EMAIL, password: PASSWORD, app: APP, idOrigin: 'http://id.ezil.work' }), /HTTPS EZiL ID origin/);
});

// ── the flow, in Chromium, over routed fakes of the real pages (offline) ───
//
// Hermetic: the hosts are reserved `.invalid` names, Chromium's resolver refuses every name, and
// `context.route` answers every request (anything unexpected is aborted). Measured 2026-10-31: with
// the real `id.ezil.work` origin, a fulfilled 302 into it was followed WITHOUT re-interception and
// reached the live tenant, and with `.invalid` origins it was intercepted only sometimes. So redirects
// here are documents that navigate on, and real hosts are never used.
// The markup mirrors app/src/app/login/page.tsx and Auth0's New Universal Login (identifier-first,
// a "Continue with Google" social button BEFORE the primary button).
test('in Chromium: /login → EZiL ID identifier → password → callback → /os, and a wrong password is refused', {
  skip: process.env.PLAYWRIGHT_REQUIRE_DIR ? false : 'PLAYWRIGHT_REQUIRE_DIR is not set',
}, async () => {
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_REQUIRE_DIR, 'sign-in-ezilid-test.cjs'))('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  const APP = 'https://os.e2e.invalid', ID = 'https://id.e2e.invalid';
  try {
    const run = async password => {
      const context = await browser.newContext();
      const seen = { posts: [], aborted: [], requested: [] };
      const html = body => ({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` });
      // A document that moves on, not a 302: Chromium does not reliably re-intercept a fulfilled redirect's target.
      const redirect = location => html(`<script>location.replace(${JSON.stringify(location)})</script>`);
      const social = `<form method="post" action="/u/login/identifier?state=abc"><input type="hidden" name="connection" value="google-oauth2">
        <button type="submit" data-provider="google" data-action-button-secondary="true">Continue with Google</button></form>`;
      const ulp = (fields, error = '') => html(`<main>${error}${social}<form method="post">${fields}
        <button type="submit" name="action" value="default" data-action-button-primary="true">Continue</button></form></main>`);
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        seen.requested.push(url.href);
        const at = `${url.origin}${url.pathname}`;
        const post = route.request().method() === 'POST' ? Object.fromEntries(new URLSearchParams(route.request().postData() ?? '')) : null;
        if (post) seen.posts.push({ at, keys: Object.keys(post).sort(), connection: post.connection ?? null });
        if (at === `${APP}/login`) return route.fulfill(html(`<main class="ezil-lock"><div class="ezil-lock-auth">
          <a class="ezil-lock-google" href="/auth/auth0/login?returnUrl=%2Fos">Continue with EZiL ID</a></div></main>`));
        if (at === `${APP}/auth/auth0/login`) return route.fulfill(redirect(`${ID}/authorize?client_id=c&state=s`));
        if (at === `${ID}/authorize`) return route.fulfill(redirect(`${ID}/u/login/identifier?state=abc`));
        if (at === `${ID}/u/login/identifier`) {
          if (post?.connection) return route.fulfill(html('<p>social login started</p>'));
          if (post) return route.fulfill(redirect(`${ID}/u/login/password?state=abc`));
          return route.fulfill(ulp('<label for="username">Email address</label><input id="username" name="username" type="text" inputmode="email">'));
        }
        if (at === `${ID}/u/login/password`) {
          const fields = `<span class="ulp-authenticator-selector-text">${EMAIL}</span><input type="hidden" name="username" value="${EMAIL}">
            <label for="password">Password</label><input id="password" name="password" type="password">`;
          if (post?.password === PASSWORD) return route.fulfill(redirect(`${ID}/authorize/resume?state=s`));
          if (post) return route.fulfill({ ...ulp(fields, '<div id="prompt-alert" role="alert"><p>Wrong email or password</p></div>'), status: 400 });
          return route.fulfill(ulp(fields));
        }
        if (at === `${ID}/authorize/resume`) return route.fulfill(redirect(`${APP}/auth/auth0/callback?code=k&state=s`));
        if (at === `${APP}/auth/auth0/callback`) return route.fulfill(redirect(`${APP}/os`));
        if (at === `${APP}/os`) return route.fulfill(html('<div id="desktop">EZiL OS</div>'));
        seen.aborted.push(at);
        return route.abort();
      });
      const page = await context.newPage();
      try {
        const error = await signIn(page, { email: EMAIL, password, app: APP, idOrigin: ID, timeoutMs: 20_000 }).then(() => null, e => e);
        return { error, url: page.url(), seen };
      } finally { await context.close(); }
    };

    const ok = await run(PASSWORD);
    assert.equal(ok.error, null, `${ok.error?.message} ${JSON.stringify(ok.seen)}`);
    assert.equal(ok.url, `${APP}/os`);
    assert.deepEqual(ok.seen.posts.map(post => [post.at, post.keys, post.connection]), [
      [`${ID}/u/login/identifier`, ['action', 'username'], null],
      [`${ID}/u/login/password`, ['action', 'password', 'username'], null],
    ], 'the primary forms were posted, never the Google one');
    assert.deepEqual(ok.seen.aborted.filter(at => !at.endsWith('/favicon.ico')), []);
    assert.ok(ok.seen.requested.every(href => new URL(href).hostname.endsWith('.invalid')), 'only reserved hosts were asked for');

    const wrong = await run('not-the-password');
    assert.equal(wrong.error?.message, 'EZiL ID refused the sign-in at the password screen (wrong_credentials)');
    assert.ok(!/not-the-password|qa-test@example/.test(`${wrong.error.message}\n${wrong.error.stack}`));
  } finally { await browser.close(); }
});

/**
 * Sign a QA account in THROUGH the login UI, the way a user does:
 * `/login` → "Continue with EZiL ID" → Auth0 Universal Login on id.ezil.work
 * (identifier-first: email, then password; a combined form and a consent
 * screen are handled too) → `/auth/auth0/callback` → the destination.
 *
 * Use this for an EZiL ID account (an Auth0 Username-Password-Authentication
 * user). Unlike `e2e/sign-in.mjs` (Supabase password grant, no UI), this path
 * runs the app's Auth0 bridge, which is where a new account is enrolled in
 * EZiL AI (`{"event":"ai-enroll","source":"auth0"}`).
 *
 * Same contract as `sign-in.mjs`: `signIn(page, { email, password, destination, app })`
 * resolves once the destination has loaded, and every failure is a FIXED
 * message. Nothing the driver or the page says is passed through, because
 * Playwright call logs can quote the typed password and Auth0 pages show the
 * address. Only allowlisted tokens are interpolated: a screen name from
 * Auth0's `/u/<screen>` paths, an app error code from `/login?error=<code>`,
 * an alert classification, and a host name.
 *
 * Credentials are typed only on the expected EZiL ID origin over HTTPS.
 * Node built-ins only: the unit test runs without Playwright.
 */

/** Mirrors AUTH0_ISSUER in app/src/server/auth/auth0.ts (the custom domain of the EZiL ID tenant). */
export const DEFAULT_ID_ORIGIN = 'https://id.ezil.work';
export const DEFAULT_TIMEOUT_MS = 80_000;

/** The one sign-in action on `/login` (app/src/app/login/page.tsx). */
export const LOGIN_BUTTON = 'a[href^="/auth/auth0/login"]:has-text("Continue with EZiL ID")';
/** Auth0 New Universal Login fields (standard rendering; no custom page template on this tenant). */
export const USERNAME_INPUT = 'input#username:visible, input[name="username"]:not([type="hidden"]):visible';
export const PASSWORD_INPUT = 'input#password:visible, input[name="password"][type="password"]:visible';
/** The primary "Continue" submit; the social buttons ("Continue with Google") carry `data-provider`. */
export const PRIMARY_SUBMIT = 'button[type="submit"][name="action"][value="default"]:not([data-provider]):visible';
export const CONSENT_ACCEPT = 'button[type="submit"][name="action"][value="accept"]:visible';

const CODE = /^[a-z0-9_]{1,64}$/;
const SCREEN = /^[a-z0-9-]{1,40}$/;
const STUCK_MS = 20_000;

/** A failure this module wrote: its message is already safe to show. */
class SignInError extends Error {}
const fail = message => new SignInError(message);

/** HTTPS origin (HTTP only on loopback), else null. */
function originOf(value, { loopback = true } = {}) {
  try {
    const url = new URL(String(value));
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (loopback && local && url.protocol === 'http:') ? url.origin : null;
  } catch { return null; }
}

/** `/login?returnUrl=<destination>` on the app: the page a signed-out user lands on. */
export function loginUrl(app, destination = '/os') {
  const origin = originOf(app);
  if (!origin) throw fail('EZiL ID sign-in needs the app origin');
  if (typeof destination !== 'string' || !destination.startsWith('/') || /^\/[/\\]/.test(destination)) {
    throw fail('EZiL ID sign-in needs a same-origin destination path');
  }
  return `${origin}/login?${new URLSearchParams({ returnUrl: destination })}`;
}

/** The app's refusal code from `/login?error=<code>` (auth/auth0/callback/route.ts), allowlisted; else null. */
export function appLoginError(href) {
  try {
    const value = new URL(href).searchParams.get('error');
    return value && CODE.test(value) ? value : null;
  } catch { return null; }
}

/** `/u/login/password` → `login-password`; anything outside the allowlist → `unknown`. */
export function screenName(pathname) {
  const parts = String(pathname ?? '').split('/').filter(Boolean);
  const name = (parts[0] === 'u' ? parts.slice(1) : parts).slice(0, 2).join('-') || 'root';
  return SCREEN.test(name) ? name : 'unknown';
}

/**
 * Where the browser is, as one of:
 * - `destination`: the app at the destination path (done);
 * - `app-login` (with `code` when the callback refused: `/login?error=<code>`);
 * - `app-transit`: any other app path (`/auth/auth0/login`, `/auth/auth0/callback`);
 * - `identifier`, `password`, `login` (combined), `consent`, `mfa`: Universal Login screens;
 * - `id-transit`: `/authorize`, `/u/.../resume`, … on the EZiL ID origin (redirects in flight);
 * - `id-other` (with `name`): any other Universal Login screen;
 * - `foreign` (with `host`): anywhere else. Credentials are never typed there.
 */
export function classifyScreen(href, { app, idOrigin = DEFAULT_ID_ORIGIN, destination = '/os' } = {}) {
  let url;
  try { url = new URL(href); } catch { return { kind: 'foreign', host: 'invalid' }; }
  if (url.protocol === 'about:') return { kind: 'blank' };
  const appOrigin = originOf(app);
  if (appOrigin && url.origin === appOrigin) {
    if (url.pathname === new URL(destination, appOrigin).pathname) return { kind: 'destination' };
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) {
      const code = appLoginError(url.href);
      return code ? { kind: 'app-login', code } : { kind: 'app-login' };
    }
    return { kind: 'app-transit' };
  }
  if (url.origin === originOf(idOrigin, { loopback: false })) {
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/u/login/identifier') return { kind: 'identifier' };
    if (path === '/u/login/password') return { kind: 'password' };
    if (path === '/u/login') return { kind: 'login' };
    if (path === '/u/consent') return { kind: 'consent' };
    if (path.startsWith('/u/mfa')) return { kind: 'mfa' };
    if (!path.startsWith('/u/') || /\/resume$/.test(path)) return { kind: 'id-transit' };
    return { kind: 'id-other', name: screenName(path) };
  }
  return { kind: 'foreign', host: /^[a-z0-9.-]{1,253}$/i.test(url.hostname) ? url.hostname : 'unknown' };
}

/**
 * What an Auth0 error says, as a class. The text itself is never reported: it
 * can quote the address ("We couldn't find an account for …").
 */
export function classifyAuth0Alert(text) {
  const value = String(text ?? '');
  if (!value.trim()) return null;
  if (/wrong (?:email|username)?\s*(?:or|and)?\s*password|incorrect|invalid (?:email|username|password|credentials)/i.test(value)) return 'wrong_credentials';
  if (/too many|attempts|temporarily (?:locked|blocked)/i.test(value)) return 'too_many_attempts';
  if (/blocked|suspended|disabled/i.test(value)) return 'blocked';
  if (/captcha|robot|human|challenge/i.test(value)) return 'challenge';
  if (/reset (?:your )?password|password (?:has )?expired|change your password/i.test(value)) return 'password_reset_required';
  if (/verify your email|email (?:is )?not verified/i.test(value)) return 'email_unverified';
  if (/couldn.?t find|no account|not found|does not exist/i.test(value)) return 'unknown_account';
  if (/enter (?:a|your) (?:valid )?(?:email|username)|valid email|required/i.test(value)) return 'invalid_input';
  return 'other';
}

/** In the page (serialised by Playwright, so self-contained): the first visible Auth0 error text. */
export function readAuth0Alert() {
  const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    && getComputedStyle(el).display !== 'none';
  const selectors = ['#prompt-alert', '.ulp-alert', '[id^="error-element-"]', '.ulp-input-error-message',
    '.ulp-validator-error', '[data-error-code]', '[role="alert"]'];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text && shown(el)) return text.slice(0, 300);
    }
  }
  return '';
}

/** Is the "sign-in unavailable" notice on `/login` (no Auth0 settings on this deployment)? */
export function readLoginNotice() {
  return (document.querySelector('.ezil-lock-error')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const LABEL = Object.freeze({ identifier: 'identifier', password: 'password', login: 'login', consent: 'consent' });

/**
 * Sign in through `/login` and EZiL ID, and load `destination` (default `/os`).
 * `app` is the app origin (default: the page's current origin). `env` is
 * accepted for call compatibility with `sign-in.mjs` and ignored.
 */
export async function signIn(page, {
  email, password, destination = '/os', app, idOrigin = DEFAULT_ID_ORIGIN, timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => performance.now(), nap = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!email || !password) throw new Error('Missing EZiL ID sign-in credentials');
  let origin;
  try { origin = originOf(app ?? page.url()); } catch { origin = null; }
  if (!origin) throw new Error('EZiL ID sign-in needs the app origin');
  if (!originOf(idOrigin, { loopback: false })) throw new Error('EZiL ID sign-in needs an HTTPS EZiL ID origin');
  const target = loginUrl(origin, destination);
  const deadline = now() + timeoutMs;
  let where = 'login page';
  const left = (cap = timeoutMs) => {
    const ms = Math.min(cap, deadline - now());
    if (!(ms > 0)) throw fail(`EZiL ID sign-in timed out at the ${where}`);
    return Math.max(1, Math.floor(ms));
  };
  const places = { app: origin, idOrigin, destination };

  try {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: left(30_000) });
    } catch (error) {
      if (error instanceof SignInError) throw error;
      throw fail('EZiL ID sign-in could not load /login');
    }
    // /login never redirects, so the button is the way on.
    const button = page.locator(LOGIN_BUTTON).first();
    try {
      await button.waitFor({ state: 'visible', timeout: left(15_000) });
    } catch (error) {
      if (error instanceof SignInError) throw error;
      const notice = await page.evaluate(readLoginNotice).catch(() => '');
      throw fail(/unavailable/i.test(notice)
        ? 'EZiL ID sign-in is unavailable on this deployment (/login shows "Sign-in is unavailable")'
        : 'The login page has no "Continue with EZiL ID" button');
    }
    try { await button.click({ timeout: left(10_000) }); } catch (error) {
      if (error instanceof SignInError) throw error;
      throw fail('"Continue with EZiL ID" could not be clicked');
    }

    const clickedAt = now();
    let submitted = null;   // { kind, href, at } of the last form this run submitted
    for (;;) {
      left();
      const screen = classifyScreen(page.url(), places);
      switch (screen.kind) {
        case 'destination': {
          where = 'destination';
          const landed = new URL(page.url());
          if (landed.origin !== origin) throw fail('EZiL ID sign-in did not reach its destination');
          return;
        }
        case 'app-login':
          where = 'login page';
          if (screen.code) throw fail(`EZiL ID sign-in was refused by the app (${screen.code})`);
          if (now() - clickedAt > STUCK_MS) {
            throw fail(submitted ? 'EZiL ID sign-in returned to /login without an error code' : 'EZiL ID sign-in did not leave /login');
          }
          break;
        case 'foreign':
          throw fail(`EZiL ID sign-in reached an unexpected host (${screen.host})`);
        case 'mfa':
          throw fail('EZiL ID asked for a second factor (MFA); this QA account cannot complete it');
        case 'id-other':
          throw fail(`EZiL ID showed an unexpected screen (${screen.name})`);
        case 'identifier': case 'password': case 'login': case 'consent': {
          where = `${LABEL[screen.kind]} screen`;
          const href = page.url();
          if (submitted && submitted.kind === screen.kind && submitted.href === href) {
            // Still on the form this run submitted: Auth0 re-renders it with an error, or is still posting.
            const alert = classifyAuth0Alert(await page.evaluate(readAuth0Alert).catch(() => ''));
            if (alert) throw fail(`EZiL ID refused the sign-in at the ${where} (${alert})`);
            if (now() - submitted.at > STUCK_MS) throw fail(`EZiL ID did not move on from the ${where}`);
            break;
          }
          await complete(page, screen.kind, { email, password, left });
          submitted = { kind: screen.kind, href, at: now() };
          break;
        }
        default:   // redirects in flight: app-transit, id-transit, blank
          break;
      }
      await nap(Math.min(250, left()));
    }
  } catch (error) {
    // Only this module's own messages leave; driver errors can quote what was typed.
    if (error instanceof SignInError) throw new Error(error.message);
    throw new Error('EZiL ID sign-in failed');
  }
}

/** Fill and submit one Universal Login screen. Re-checks the origin right before typing. */
async function complete(page, kind, { email, password, left }) {
  const label = `${LABEL[kind]} screen`;
  try {
    if (kind === 'consent') {
      await page.locator(CONSENT_ACCEPT).first().click({ timeout: left(10_000) });
      return;
    }
    let field;
    if (kind === 'identifier' || kind === 'login') {
      const user = page.locator(USERNAME_INPUT).first();
      // The combined form may show the identifier read-only (a returning session): fill only an editable field.
      const editable = kind === 'identifier'
        ? (await user.waitFor({ state: 'visible', timeout: left(15_000) }), true)
        : await user.isEditable({ timeout: 1000 }).catch(() => false);
      if (editable) { await user.fill(email, { timeout: left(5000) }); field = user; }
    }
    if (kind === 'password' || kind === 'login') {
      const secret = page.locator(PASSWORD_INPUT).first();
      await secret.waitFor({ state: 'visible', timeout: left(15_000) });
      await secret.fill(password, { timeout: left(5000) });
      field = secret;
    }
    const submit = page.locator(PRIMARY_SUBMIT).first();
    if (await submit.isVisible().catch(() => false)) await submit.click({ timeout: left(10_000) });
    else await field.press('Enter', { timeout: left(5000) });
  } catch (error) {
    if (error instanceof SignInError) throw error;
    throw fail(`EZiL ID ${label} could not be completed`);
  }
}

export { signIn as signInEzilId };

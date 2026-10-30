/**
 * Sign the hosted QA account in WITHOUT the login UI.
 *
 * `/login` offers only "Continue with EZiL ID" (Auth0 at id.ezil.work), which
 * automation cannot drive. The QA account keeps its Supabase email/password
 * identity, so this performs the same password grant `signInWithPassword`
 * sends, then writes the session into the browser context as the app's
 * Supabase SSR auth cookie, exactly as `@supabase/ssr` 0.5 writes it:
 *
 * - name: `__Host-ezil-os-auth` on HTTPS (app/src/utils/supabase/cookie-options.ts);
 *   on loopback HTTP the library default, `sb-<first host label>-auth-token`.
 * - value: `base64-` + base64url(JSON of the token response, with
 *   `expires_at` filled in from `expires_in` when absent, as auth-js does).
 * - chunks: one cookie up to 3180 characters, else `<name>.0`, `<name>.1`, …
 * - attributes: Path=/, SameSite=Lax, not HttpOnly, 400 days, Secure on
 *   HTTPS, and host-only (no Domain), which `__Host-` requires.
 *
 * Inputs are the app's own public names, NEXT_PUBLIC_SUPABASE_URL and
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, for the Supabase project the target app uses.
 * Node built-ins only: CI imports the unit test without installing packages.
 */

/** Mirrors SECURE_AUTH_COOKIE_NAME in app/src/utils/supabase/cookie-options.ts. */
export const SECURE_AUTH_COOKIE_NAME = '__Host-ezil-os-auth';
/** `@supabase/ssr` MAX_CHUNK_SIZE and DEFAULT_COOKIE_OPTIONS.maxAge. */
const MAX_CHUNK_SIZE = 3180;
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** The cookie the app's Supabase clients read for this origin. */
export function authCookieName(app, supabaseUrl) {
  return new URL(app).protocol === 'https:'
    ? SECURE_AUTH_COOKIE_NAME
    : `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}

/** Name/value pairs for one session, chunked the way `@supabase/ssr` chunks. */
export function authCookies(session, { app, supabaseUrl }) {
  const name = authCookieName(app, supabaseUrl);
  // base64url output needs no URI escaping, so the library's escape-aware
  // splitter reduces to fixed-size slices here.
  const value = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')}`;
  if (value.length <= MAX_CHUNK_SIZE) return [{ name, value }];
  const chunks = [];
  for (let i = 0; i * MAX_CHUNK_SIZE < value.length; i++) {
    chunks.push({ name: `${name}.${i}`, value: value.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE) });
  }
  return chunks;
}

/** Only a same-origin path may come from the current page's `returnUrl`. */
function returnPath(url) {
  const value = url.pathname.startsWith('/login') ? url.searchParams.get('returnUrl') : null;
  return value && value.startsWith('/') && !/^\/[/\\]/.test(value) ? value : '/os';
}

async function passwordGrant(request, { supabaseUrl, anonKey, email, password }) {
  let response, body;
  try {
    response = await request(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, gotrue_meta_security: {} }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    body = await response.json();
  } catch {
    // Network errors can quote the request; keep this message fixed.
    throw new Error('Hosted sign-in request failed');
  }
  if (!response.ok) {
    const code = [body?.error_code, body?.error].find(item => typeof item === 'string' && /^[a-z0-9_]{1,64}$/.test(item));
    throw new Error(`Hosted sign-in was refused (HTTP ${response.status}${code ? ` ${code}` : ''})`);
  }
  if (typeof body?.access_token !== 'string' || typeof body.refresh_token !== 'string'
      || !(Number.isFinite(body.expires_at) || Number.isFinite(body.expires_in))) {
    throw new Error('Hosted sign-in returned no session');
  }
  return body;
}

/**
 * Sign in and load `destination` (or the current page's `returnUrl`, else
 * `/os`). The app origin is `app`, or the page's current origin.
 */
export async function signIn(page, {
  email, password, destination, app, env = process.env, fetch: request = globalThis.fetch, now = Date.now,
} = {}) {
  if (!email || !password) throw new Error('Missing hosted sign-in credentials');
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL, anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing hosted sign-in inputs: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }
  const current = new URL(page.url());
  const origin = new URL(app ?? current).origin;
  if (!/^https?:\/\//.test(origin)) throw new Error('Hosted sign-in needs the app origin');

  const data = await passwordGrant(request, { supabaseUrl, anonKey, email, password });
  const session = { ...data, expires_at: data.expires_at ?? Math.round(now() / 1000) + data.expires_in };
  const cookies = authCookies(session, { app: origin, supabaseUrl });
  const name = authCookieName(origin, supabaseUrl);
  const context = page.context();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    // Like the library, drop chunks a previous, longer session left behind.
    await context.clearCookies({ name: new RegExp(`^${escaped}(?:\\.\\d+)?$`), domain: new URL(origin).hostname });
    const expires = Math.floor(now() / 1000) + MAX_AGE_SECONDS;
    await context.addCookies(cookies.map(cookie => ({ ...cookie, url: `${origin}/`, expires, httpOnly: false, sameSite: 'Lax' })));
    const stored = new Map((await context.cookies(origin)).map(cookie => [cookie.name, cookie.value]));
    if (!cookies.every(cookie => stored.get(cookie.name) === cookie.value)) throw new Error('not stored');
  } catch {
    // Driver errors can print cookie values, which carry the refresh token.
    throw new Error('Hosted sign-in cookie was not accepted');
  }

  const target = destination ?? returnPath(current);
  try {
    // The destination can start cloud requests while its document loads.
    // Each suite checks application readiness after navigation commits.
    await page.goto(new URL(target, origin).href, { waitUntil: 'commit', timeout: 60000 });
    const landed = new URL(page.url());
    const reached = destination ? landed.pathname === destination : !landed.pathname.startsWith('/login');
    if (landed.origin !== origin || !reached) throw new Error('not reached');
  } catch {
    // Driver call logs may include session headers.
    throw new Error('Hosted sign-in did not reach its destination');
  }
}

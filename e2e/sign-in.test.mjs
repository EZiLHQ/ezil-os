import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { authCookies, signIn } from './sign-in.mjs';

const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key' };
const credentials = { email: 'test@example.invalid', password: 'private-password' };
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
const EXPIRES_AT = 1900000000;

function tokenResponse({ pad = 0, expiresAt = EXPIRES_AT } = {}) {
  const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated',
    email: credentials.email, app_metadata: { provider: 'email' }, user_metadata: { pad: 'x'.repeat(pad) } };
  return { access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: EXPIRES_AT })}.private-signature`,
    token_type: 'bearer', expires_in: 3600, ...(expiresAt ? { expires_at: expiresAt } : {}),
    refresh_token: 'private-refresh', user };
}

function grant(body = tokenResponse(), status = 200, calls = []) {
  return async (url, init) => {
    calls.push(['fetch', url, init]);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

function fixture({ url = 'https://os.example.test/login?returnUrl=%2Fcomputers', land = href => href, accept = true, jar = new Map() } = {}) {
  const calls = [];
  let current = url;
  const context = {
    clearCookies: async filter => {
      calls.push(['clear', filter.domain]);
      for (const name of [...jar.keys()]) if (filter.name.test(name)) jar.delete(name);
    },
    addCookies: async cookies => {
      calls.push(['add', cookies]);
      if (accept) for (const cookie of cookies) jar.set(cookie.name, cookie.value);
    },
    cookies: async origin => { calls.push(['cookies', origin]); return [...jar].map(([name, value]) => ({ name, value })); },
  };
  const page = { url: () => current, context: () => context, goto: async (href, options) => {
    calls.push(['goto', href, options.waitUntil]);
    current = land(href);
  } };
  return { page, calls, jar };
}

const decode = cookies => JSON.parse(Buffer.from(cookies.map(c => c.value).join('').replace(/^base64-/, ''), 'base64url').toString('utf8'));
const redacted = error => !/private|test@example/.test(`${error.message}\n${error.stack}`);

test('signs in through the password grant, writes the SSR auth cookie, then loads the return path', async () => {
  const f = fixture();
  const body = tokenResponse();
  await signIn(f.page, { ...credentials, env, fetch: grant(body, 200, f.calls), now: () => 1_800_000_000_000 });
  const [, url, init] = f.calls[0];
  assert.equal(url, 'https://db.example.test/auth/v1/token?grant_type=password');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { apikey: 'public-anon-key', authorization: 'Bearer public-anon-key', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(init.body), { ...credentials, gotrue_meta_security: {} });
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['clear', 'add', 'cookies', 'goto']);
  const added = f.calls.find(c => c[0] === 'add')[1];
  assert.deepEqual(added.map(c => c.name), ['__Host-ezil-os-auth']);
  assert.match(added[0].value, /^base64-[A-Za-z0-9_-]+$/);
  // Host-only: the url form carries no Domain or Path, which __Host- forbids.
  assert.deepEqual({ ...added[0], value: undefined }, { name: '__Host-ezil-os-auth', value: undefined,
    url: 'https://os.example.test/', expires: 1_800_000_000 + 400 * 24 * 60 * 60, httpOnly: false, sameSite: 'Lax' });
  assert.deepEqual(decode(added), body);
  assert.deepEqual(f.calls.at(-1), ['goto', 'https://os.example.test/computers', 'commit']);
});

test('chunks a large session into ordered cookies and clears a longer session\'s leftover chunk', async () => {
  const f = fixture({ jar: new Map([['__Host-ezil-os-auth.3', 'stale'], ['other', 'kept']]) });
  const body = tokenResponse({ pad: 5000 });
  await signIn(f.page, { ...credentials, destination: '/os', env, fetch: grant(body) });
  const added = f.calls.find(c => c[0] === 'add')[1];
  assert.deepEqual(added.map(c => c.name), ['__Host-ezil-os-auth.0', '__Host-ezil-os-auth.1', '__Host-ezil-os-auth.2']);
  assert.deepEqual(added.map(c => c.value.length).slice(0, 2), [3180, 3180]);
  assert.deepEqual(decode(added), body);
  assert.deepEqual([...f.jar.keys()].sort(), ['__Host-ezil-os-auth.0', '__Host-ezil-os-auth.1', '__Host-ezil-os-auth.2', 'other']);
  assert.deepEqual(f.calls.at(-1), ['goto', 'https://os.example.test/os', 'commit']);
});

test('loopback HTTP uses the library default name for the Supabase host', () => {
  const session = tokenResponse();
  assert.equal(authCookies(session, { app: 'http://127.0.0.1:3141', supabaseUrl: 'http://127.0.0.1:54321' })[0].name, 'sb-127-auth-token');
  assert.equal(authCookies(session, { app: 'http://localhost:3000', supabaseUrl: 'https://db.ezil.work' })[0].name, 'sb-db-auth-token');
  assert.equal(authCookies(session, { app: 'https://os.ezil.work', supabaseUrl: 'https://db.ezil.work' })[0].name, '__Host-ezil-os-auth');
});

test('fills expires_at from expires_in the way auth-js does', async () => {
  const f = fixture();
  await signIn(f.page, { ...credentials, env, fetch: grant(tokenResponse({ expiresAt: null })), now: () => 1_800_000_000_400 });
  assert.equal(decode(f.calls.find(c => c[0] === 'add')[1]).expires_at, 1_800_003_600);
});

test('a refused or failed grant is a redacted failure with no cookie and no navigation', async () => {
  const refused = fixture();
  const body = { code: 400, error_code: 'invalid_credentials', msg: `Invalid login credentials for ${credentials.email}` };
  await assert.rejects(signIn(refused.page, { ...credentials, env, fetch: grant(body, 400) }), error => {
    assert.equal(error.message, 'Hosted sign-in was refused (HTTP 400 invalid_credentials)');
    return redacted(error);
  });
  const offline = fixture();
  await assert.rejects(signIn(offline.page, { ...credentials, env,
    fetch: async () => { throw new Error(`connect failed: ${credentials.password}`); } }), error => {
    assert.equal(error.message, 'Hosted sign-in request failed');
    return redacted(error);
  });
  const empty = fixture();
  await assert.rejects(signIn(empty.page, { ...credentials, env, fetch: grant({ user: {} }) }), /returned no session/);
  for (const f of [refused, offline, empty]) assert.equal(f.calls.some(c => c[0] === 'add' || c[0] === 'goto'), false);
});

test('a cookie the browser refuses or a session the app rejects never counts as signed in', async () => {
  const refused = fixture({ accept: false });
  await assert.rejects(signIn(refused.page, { ...credentials, env, fetch: grant() }), error => {
    assert.equal(error.message, 'Hosted sign-in cookie was not accepted');
    return redacted(error);
  });
  assert.equal(refused.calls.some(c => c[0] === 'goto'), false);
  const bounced = fixture({ land: () => 'https://os.example.test/login?returnUrl=%2Fcomputers' });
  await assert.rejects(signIn(bounced.page, { ...credentials, destination: '/computers', env, fetch: grant() }), error => {
    assert.equal(error.message, 'Hosted sign-in did not reach its destination');
    return redacted(error);
  });
  const fallback = fixture({ land: () => 'https://os.example.test/login' });
  await assert.rejects(signIn(fallback.page, { ...credentials, env, fetch: grant() }), /did not reach its destination/);
});

test('requires credentials, the public Supabase inputs and an app origin', async () => {
  await assert.rejects(signIn(fixture().page, { env }), /Missing hosted sign-in credentials/);
  await assert.rejects(signIn(fixture().page, { ...credentials, env: {} }),
    /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  await assert.rejects(signIn(fixture({ url: 'about:blank' }).page, { ...credentials, env, fetch: grant() }), /needs the app origin/);
  // An explicit origin needs no page load first; an off-origin returnUrl is ignored.
  const blank = fixture({ url: 'about:blank' });
  await signIn(blank.page, { ...credentials, app: 'https://os.example.test', env, fetch: grant() });
  assert.deepEqual(blank.calls.at(-1), ['goto', 'https://os.example.test/os', 'commit']);
  const offsite = fixture({ url: 'https://os.example.test/login?returnUrl=%2F%2Fevil.example' });
  await signIn(offsite.page, { ...credentials, env, fetch: grant() });
  assert.deepEqual(offsite.calls.at(-1), ['goto', 'https://os.example.test/os', 'commit']);
});

// Parity with the library the app reads the cookie with. Runs wherever the
// app's dependencies are installed (`cd app && bun install`).
const appRequire = createRequire(new URL('../app/package.json', import.meta.url));
let ssr;
try { ssr = appRequire('@supabase/ssr'); } catch { /* not installed here */ }

test('@supabase/ssr writes the same cookies and reads the session back', { skip: !ssr && 'app dependencies are not installed' }, async () => {
  for (const [app, cookieOptions] of [
    ['https://os.example.test', { name: '__Host-ezil-os-auth', path: '/', sameSite: 'lax', secure: true }],
    ['http://127.0.0.1:3141', undefined],
  ]) {
    for (const pad of [0, 5000]) {
      const body = tokenResponse({ pad });
      const ours = authCookies(body, { app, supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL });
      // The server client applies its cookies from an auth event listener,
      // after signInWithPassword itself has resolved.
      let timer;
      const written = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('@supabase/ssr wrote no cookies')), 5000);
        const writer = ssr.createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
          cookieOptions, global: { fetch: grant(body) },
          cookies: { getAll: () => [], setAll: resolve },
        });
        writer.auth.signInWithPassword(credentials).then(({ error }) => { if (error) reject(error); }, reject);
      }).finally(() => clearTimeout(timer));
      assert.deepEqual(written.filter(c => c.value).map(({ name, value }) => ({ name, value })), ours);
      const reader = ssr.createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        cookieOptions, global: { fetch: async () => { throw new Error('no network expected'); } },
        cookies: { getAll: () => ours, setAll: () => {} },
      });
      const { data } = await reader.auth.getSession();
      assert.equal(data.session?.access_token, body.access_token);
      assert.equal(data.session?.refresh_token, body.refresh_token);
      assert.equal(data.session?.expires_at, EXPIRES_AT);
    }
  }
});

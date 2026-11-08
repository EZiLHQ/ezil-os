import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  aggregate, assertAuthRedirect, blockWritesRouteHandler, classify, exitCodeFor, healthMatches,
  isPreviewSha, isSlotOrigin, MAX_RUN_MS, redactEvidence, runPreviewSmoke, signedOutRouteHandler,
} from './os-preview-smoke.mjs';

const SHA = 'c0ffee' + '0'.repeat(34); // 40 lowercase hex, a distinctive leak probe
const APP = 'https://os-pv1.ezil.work';
const EMAIL = 'qa-secret@example.test';
const PASSWORD = 'pw-secret-value';

test('MAX_RUN_MS stays within the brief\'s 180s cap', () => {
  assert.ok(MAX_RUN_MS <= 180_000 && MAX_RUN_MS > 0);
});

test('slot-origin validation accepts os-pv1/os-pv2 and rejects everything outside the fixed slots', () => {
  for (const good of ['https://os-pv1.ezil.work', 'https://os-pv2.ezil.work', 'https://os-pv9.ezil.work']) {
    assert.equal(isSlotOrigin(good), true, good);
  }
  for (const bad of [
    'https://os-staging.ezil.work',          // a real host, but not a slot
    'https://os.ezil.work',                  // production
    'https://os.ezil.org',                   // canonical production
    'https://os-pv1.ezil.work.evil.com',     // slot as a subdomain of an attacker
    'http://os-pv1.ezil.work',               // not https
    'https://os-pv10.ezil.work',             // two digits: [1-9] is one digit
    'https://os-pv0.ezil.work',              // zero is excluded
    'https://os-pv1.ezil.work/',             // trailing slash
    'https://os-pv1.ezil.work/os',           // a path
    'https://os-pv1.ezil.work:443',          // explicit default port
    'https://OS-PV1.ezil.work',              // uppercase host
    'https://os-pv1.ezil.work?x=1',          // a query
    '', null, undefined, 42,
  ]) {
    assert.equal(isSlotOrigin(bad), false, String(bad));
  }
});

test('SHA validation requires a full lowercase 40-hex commit id', () => {
  assert.equal(isPreviewSha('a'.repeat(40)), true);
  assert.equal(isPreviewSha(SHA), true);
  for (const bad of [
    'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40),
    'abc1234',                   // a 7-char short id
    SHA.slice(0, 7),             // the right SHA truncated
    ' ' + 'a'.repeat(40), '', null, undefined, 123,
  ]) {
    assert.equal(isPreviewSha(bad), false, String(bad));
  }
});

test('health matches only an exact {ok:true, sha} for the expected commit', () => {
  assert.equal(healthMatches({ ok: true, sha: SHA }, SHA), true);
  for (const body of [
    { ok: true, sha: 'd'.repeat(40) },   // a different build
    { ok: true, sha: SHA.slice(0, 7) },  // the deployed sha is only a short prefix
    { ok: false, sha: SHA },             // not healthy
    { ok: 'true', sha: SHA },            // ok must be strictly boolean true
    { ok: true, sha: null },             // deploySha returned null
    { ok: true },                        // no sha field
    {}, null, undefined,
  ]) {
    assert.equal(healthMatches(body, SHA), false, JSON.stringify(body));
  }
});

test('auth redirect assertion keeps the slot callback and rejects a production bounce', () => {
  const location = slot => `https://id.ezil.work/authorize?client_id=x&redirect_uri=${encodeURIComponent(`${slot}/auth/auth0/callback`)}&state=s&nonce=n`;
  assert.equal(assertAuthRedirect(location(APP), APP), true);

  // The exact defect this check exists to catch: the preview bounced the callback
  // to the canonical production origin.
  assert.throws(() => assertAuthRedirect(location('https://os.ezil.org'), APP), /redirect_uri is not this preview slot callback/);
  // A different slot's callback is also wrong for this app.
  assert.throws(() => assertAuthRedirect(location('https://os-pv2.ezil.work'), APP), /redirect_uri is not this preview slot callback/);
  // No redirect_uri at all.
  assert.throws(() => assertAuthRedirect('https://id.ezil.work/authorize?state=s', APP), /redirect_uri is not this preview slot callback/);
  // The same-origin disabled bounce (/login?error=auth0_disabled) never reaches id.ezil.work.
  assert.throws(() => assertAuthRedirect(`${APP}/login?error=auth0_disabled`, APP), /did not reach id\.ezil\.work/);
  // Another issuer host must not pass.
  assert.throws(() => assertAuthRedirect(`https://id.ezil.work.evil.com/authorize?redirect_uri=${encodeURIComponent(`${APP}/auth/auth0/callback`)}`, APP), /did not reach id\.ezil\.work/);
  // No location header on the redirect.
  assert.throws(() => assertAuthRedirect(undefined, APP), /carried no location/);
  assert.throws(() => assertAuthRedirect('', APP), /carried no location/);
});

function fakeRoute(method, url, headers = {}) {
  const acted = { aborted: null, continued: null, fellBack: false };
  return {
    acted,
    request: () => ({ method: () => method, url: () => url, headers: () => headers }),
    abort: reason => { acted.aborted = reason ?? 'failed'; },
    continue: options => { acted.continued = options ?? {}; },
    fallback: () => { acted.fellBack = true; },
  };
}

test('signed-out route aborts every non-GET and bypasses only same-origin GETs', () => {
  const handler = signedOutRouteHandler(APP, { 'x-vercel-protection-bypass': 'bypass-secret' });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const route = fakeRoute(method, `${APP}/login`); handler(route);
    assert.equal(route.acted.aborted, 'failed', method);
    assert.equal(route.acted.continued, null);
  }
  // Same-origin GET continues with the scoped bypass merged over the real headers.
  const sameOrigin = fakeRoute('GET', `${APP}/login`, { accept: 'text/html' }); handler(sameOrigin);
  assert.deepEqual(sameOrigin.acted.continued, { headers: { accept: 'text/html', 'x-vercel-protection-bypass': 'bypass-secret' } });
  assert.equal(sameOrigin.acted.aborted, null);
  // Cross-origin GET continues untouched — the bypass is never sent off-origin.
  const crossOrigin = fakeRoute('GET', 'https://fonts.googleapis.com/css'); handler(crossOrigin);
  assert.deepEqual(crossOrigin.acted.continued, {});
  // With no bypass configured, same-origin GET continues without a header override.
  const noBypass = signedOutRouteHandler(APP, {});
  const plain = fakeRoute('GET', `${APP}/login`); noBypass(plain);
  assert.deepEqual(plain.acted.continued, {});
});

test('signed-in write block aborts EVERY write regardless of endpoint and lets reads through', () => {
  const handler = blockWritesRouteHandler();
  // Compute starts, window opens, tRPC mutations and copilot calls are all writes.
  for (const path of ['/api/shell/desktop', '/api/shell/stop', '/api/trpc/computer.delete', '/api/copilot/chat', '/login']) {
    const route = fakeRoute('POST', `${APP}${path}`); handler(route);
    assert.equal(route.acted.aborted, 'failed', path);
    assert.equal(route.acted.fellBack, false, path);
  }
  // Reads fall back to the deployment route (which serves the /os document + bundle).
  for (const [method, url] of [['GET', `${APP}/os`], ['GET', `${APP}/api/shell/desktop?computerId=x`], ['HEAD', `${APP}/os`]]) {
    const route = fakeRoute(method, url); handler(route);
    assert.equal(route.acted.fellBack, true, url);
    assert.equal(route.acted.aborted, null, url);
  }
});

test('result classification: FAIL outranks PARTIAL; PASS needs a check and no skips', () => {
  const ok = name => ({ check: name, ok: true, ms: 1 });
  const bad = name => ({ check: name, ok: false, ms: 1 });
  const skip = [{ check: 'signed_in_desktop', reason: 'qa_identity_not_configured' }];

  assert.equal(classify([ok('health_sha'), ok('signed_out_desktop')], []), 'PASS');
  assert.equal(classify([ok('health_sha')], skip), 'PARTIAL');
  assert.equal(classify([bad('health_sha')], []), 'FAIL');
  // Precedence: a failure plus skipped checks is still FAIL, never PARTIAL.
  assert.equal(classify([bad('health_sha')], skip), 'FAIL');
  // An empty run is never a PASS.
  assert.equal(classify([], []), 'FAIL');
  // A malformed check (ok not strictly true) is redacted to ok:false, so FAIL.
  assert.equal(classify([{ check: 'health_sha', ok: 'true', ms: 1 }], []), 'FAIL');

  assert.equal(exitCodeFor('PASS'), 0);
  assert.equal(exitCodeFor('FAIL'), 1);
  assert.equal(exitCodeFor('PARTIAL'), 3);
});

test('evidence redaction keeps only {check, ok, ms} and drops anything else', () => {
  const raw = {
    check: 'auth_redirect_origin', ok: true, ms: 7.6,
    location: `https://id.ezil.work/authorize?redirect_uri=${APP}/auth/auth0/callback&state=secret`,
    cookie: 'session=secret', email: EMAIL, sha: SHA,
  };
  assert.deepEqual(redactEvidence(raw), { check: 'auth_redirect_origin', ok: true, ms: 8 });
  // An unknown check name (here a SHA) collapses to 'unknown' and ok:false; the
  // numeric duration is harmless and survives.
  assert.deepEqual(redactEvidence({ check: SHA, ok: true, ms: 5 }), { check: 'unknown', ok: false, ms: 5 });
  // A non-finite ms (e.g. a leaked string where a duration was expected) is zeroed.
  assert.deepEqual(redactEvidence({ check: 'health_sha', ok: true, ms: PASSWORD }), { check: 'health_sha', ok: false, ms: 0 });
  assert.deepEqual(redactEvidence({ check: 'health_sha', ok: true, ms: NaN }), { check: 'health_sha', ok: false, ms: 0 });
  assert.equal(raw.cookie, 'session=secret', 'redaction must not mutate its input');
});

// ── Browser-free end-to-end runs via injected dependencies ──────────────────

function fakeDeps({ out, healthSha = SHA, location, status = 307, calls, hangClose = false } = {}) {
  const authLocation = location ?? `https://id.ezil.work/authorize?client_id=x&redirect_uri=${encodeURIComponent(`${APP}/auth/auth0/callback`)}&state=s&nonce=n`;
  const page = {
    _url: `${APP}/login`,
    url() { return this._url; },
    async goto(url) { this._url = url; calls.goto.push(url); },
    locator() { return { async waitFor() {} }; },
    async waitForFunction() {},
    async evaluate(fn) { return String(fn).includes('scrollWidth') ? true : undefined; },
    isClosed() { return false; },
    async screenshot() { calls.screenshots++; },
  };
  const context = {
    setDefaultTimeout() {},
    async route(_pattern, handler) { calls.routes.push(handler); },
    async newPage() { return page; },
    async close() { calls.contextClose++; },
  };
  const browser = {
    async newContext(options) { calls.contexts.push(options); return context; },
    close() { calls.browserClose++; return hangClose ? new Promise(() => {}) : Promise.resolve(); },
  };
  const deployment = {
    deployedTarget: env => ({ app: env.EZIL_E2E_APP, headers: {} }),
    async configureAppContext() {},
    async appRequest(url) {
      calls.requests.push(url);
      if (url.endsWith('/api/health')) {
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ ok: true, sha: healthSha })) };
      }
      if (url.endsWith('/auth/auth0/login')) {
        return { status, headers: { location: authLocation }, body: Buffer.alloc(0) };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
  const signIn = async () => { calls.signIn++; };
  return { deployment, signIn, chromium: { async launch() { return browser; } } };
}

async function fakeRun(t, { env: overrides = {}, ...depOptions } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'ezil-preview-smoke-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const calls = { requests: [], goto: [], routes: [], contexts: [], signIn: 0, screenshots: 0, contextClose: 0, browserClose: 0 };
  const emitted = [];
  const env = { EZIL_E2E_APP: APP, EZIL_PREVIEW_SHA: SHA, EZIL_LIVE_OUT: out, ...overrides };
  const result = await runPreviewSmoke({
    env,
    loadDependencies: async () => fakeDeps({ out, calls, ...depOptions }),
    emit: value => emitted.push(value),
  });
  return { result, emitted, calls, out };
}

test('a healthy preview with a QA identity passes all six checks and installs the write blocks', async t => {
  const { result, emitted, calls, out } = await fakeRun(t, { env: { EZIL_E2E_EMAIL: EMAIL, EZIL_E2E_PASSWORD: PASSWORD } });
  assert.equal(result.result, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.checks.map(check => check.check),
    ['health_sha', 'signed_out_desktop', 'signed_out_mobile', 'auth_redirect_origin', 'signed_in_desktop', 'signed_in_mobile']);
  assert.ok(result.checks.every(check => check.ok));
  assert.deepEqual(result.skipped, []);
  assert.equal(calls.signIn, 2);
  assert.equal(calls.screenshots, 2);

  // Four browser contexts: desktop then phone, signed-out then signed-in.
  assert.deepEqual(calls.contexts.map(options => options.viewport), [
    { width: 1440, height: 900 }, { width: 390, height: 844 },
    { width: 1440, height: 900 }, { width: 390, height: 844 },
  ]);
  assert.deepEqual(calls.contexts.map(options => options.isMobile), [false, true, false, true]);
  assert.deepEqual(calls.contexts.map(options => options.hasTouch), [false, true, false, true]);

  // Wiring proof: each check installed a route (dropping a context.route call
  // makes this fail). The signed-in route blocks every write — even a tRPC
  // mutation outside /api/shell — so reaching /os can start nothing.
  assert.equal(calls.routes.length, 4);
  const signedInWrite = fakeRoute('POST', `${APP}/api/trpc/computer.delete`);
  calls.routes.at(-1)(signedInWrite);
  assert.equal(signedInWrite.acted.aborted, 'failed');
  const signedOutWrite = fakeRoute('POST', `${APP}/login`);
  calls.routes[0](signedOutWrite);
  assert.equal(signedOutWrite.acted.aborted, 'failed');
  // The smoke never issues a shell lifecycle request of its own either.
  assert.ok(!calls.requests.some(url => url.includes('/api/shell/')));

  // The saved report equals the final emitted line.
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'os-preview-smoke.json'), 'utf8')), emitted.at(-1));
});

test('a hung browser close cannot wedge the run: the bounded close still lets it emit a result', { timeout: 15_000 }, async t => {
  // Without the bounded close in the finally, this run would never return and the
  // test would hit its own timeout.
  const { result, emitted } = await fakeRun(t, { env: { EZIL_E2E_EMAIL: EMAIL, EZIL_E2E_PASSWORD: PASSWORD }, hangClose: true });
  assert.equal(result.result, 'PASS');
  assert.equal(emitted.at(-1).result, 'PASS');
});

test('no QA identity skips the signed-in pair and reports PARTIAL (never PASS)', async t => {
  const { result, calls } = await fakeRun(t);
  assert.equal(result.result, 'PARTIAL');
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.checks.map(check => check.check),
    ['health_sha', 'signed_out_desktop', 'signed_out_mobile', 'auth_redirect_origin']);
  assert.deepEqual(result.skipped,
    [{ check: 'signed_in_desktop', reason: 'qa_identity_not_configured' },
     { check: 'signed_in_mobile', reason: 'qa_identity_not_configured' }]);
  assert.equal(calls.signIn, 0);
  assert.equal(calls.screenshots, 0);
  // Only the two signed-out contexts and their routes are created.
  assert.equal(calls.contexts.length, 2);
  assert.equal(calls.routes.length, 2);
});

test('one QA variable alone is not a configured identity: still PARTIAL', async t => {
  for (const env of [{ EZIL_E2E_EMAIL: EMAIL }, { EZIL_E2E_PASSWORD: PASSWORD }]) {
    const { result, calls } = await fakeRun(t, { env });
    assert.equal(result.result, 'PARTIAL');
    assert.equal(calls.signIn, 0);
  }
});

test('a stale build fails health_sha first and stops the sequence', async t => {
  const { result, emitted, calls } = await fakeRun(t, {
    env: { EZIL_E2E_EMAIL: EMAIL, EZIL_E2E_PASSWORD: PASSWORD },
    healthSha: 'd'.repeat(40),
  });
  assert.equal(result.result, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.checks, [{ check: 'health_sha', ok: false, ms: result.checks[0].ms }]);
  assert.equal(emitted.at(-1).result, 'FAIL');
  // Stopped immediately: no browser work, no sign-in, no screenshot.
  assert.equal(calls.signIn, 0);
  assert.equal(calls.screenshots, 0);
  assert.equal(calls.goto.length, 0);
  assert.equal(calls.contexts.length, 0);
});

test('a preview that bounces the auth callback to production fails auth_redirect_origin', async t => {
  const { result } = await fakeRun(t, {
    location: `https://id.ezil.work/authorize?redirect_uri=${encodeURIComponent('https://os.ezil.org/auth/auth0/callback')}&state=s`,
  });
  assert.equal(result.result, 'FAIL');
  assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.check), ['auth_redirect_origin']);
});

test('reports never leak the sha, credentials or a redirect URL', async t => {
  const { emitted } = await fakeRun(t, { env: { EZIL_E2E_EMAIL: EMAIL, EZIL_E2E_PASSWORD: PASSWORD } });
  const serialised = JSON.stringify(emitted);
  assert.doesNotMatch(serialised, /c0ffee|qa-secret|pw-secret|redirect_uri|id\.ezil\.work/);
  // Every per-check line is exactly {check, ok, ms}; the final line is {result, checks, skipped}.
  for (const line of emitted.slice(0, -1)) {
    assert.deepEqual(Object.keys(line).sort(), ['check', 'ms', 'ok']);
  }
  assert.deepEqual(Object.keys(emitted.at(-1)).sort(), ['checks', 'result', 'skipped']);
});

test('loadDependencies is never reached for a bad slot origin (exit 2, zero network)', async () => {
  let loaded = false;
  const result = await runPreviewSmoke({
    env: { EZIL_E2E_APP: 'https://os-staging.ezil.work', EZIL_PREVIEW_SHA: SHA },
    loadDependencies: async () => { loaded = true; throw new Error('must not load'); },
    emit: () => assert.fail('nothing may be emitted when unable to run'),
  });
  assert.deepEqual(result, { unable: true, reason: 'app_origin_invalid', exitCode: 2 });
  assert.equal(loaded, false);
});

test('a malformed preview SHA is unable-to-run, resolved before any dependency loads', async () => {
  let loaded = false;
  const result = await runPreviewSmoke({
    env: { EZIL_E2E_APP: APP, EZIL_PREVIEW_SHA: 'not-a-sha' },
    loadDependencies: async () => { loaded = true; throw new Error('must not load'); },
    emit: () => assert.fail('nothing may be emitted when unable to run'),
  });
  assert.deepEqual(result, { unable: true, reason: 'preview_sha_invalid', exitCode: 2 });
  assert.equal(loaded, false);
});

test('CLI exits 2 on a hostile EZIL_E2E_APP without echoing it or emitting a result line', () => {
  const out = mkdtempSync(join(tmpdir(), 'ezil-preview-cli-'));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./os-preview-smoke.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        EZIL_E2E_APP: 'https://os-pv1.ezil.work.evil.com/?token=private-token',
        EZIL_PREVIEW_SHA: SHA,
        PLAYWRIGHT_REQUIRE_DIR: out, EZIL_LIVE_OUT: out,
      },
    });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /UNABLE TO RUN: app_origin_invalid/);
    assert.equal(child.stdout, '', 'exit 2 emits no check or result lines');
    assert.doesNotMatch(child.stdout + child.stderr, /private|token|evil/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('aggregate shapes the final report with redacted checks and skips', () => {
  const report = aggregate(
    [{ check: 'health_sha', ok: true, ms: 1 }],
    [{ check: 'signed_in_desktop', reason: 'qa_identity_not_configured' }],
  );
  assert.deepEqual(report, {
    result: 'PARTIAL',
    checks: [{ check: 'health_sha', ok: true, ms: 1 }],
    skipped: [{ check: 'signed_in_desktop', reason: 'qa_identity_not_configured' }],
  });
});

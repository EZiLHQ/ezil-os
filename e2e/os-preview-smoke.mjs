/**
 * os-preview-smoke.mjs — post-deploy smoke test for a PR preview slot.
 *
 * A CI job runs this against a fixed slot origin (https://os-pv1.ezil.work or
 * os-pv2) once the preview container has rolled out. It proves four things, in
 * order, and stops at the first failure:
 *
 *   1. health_sha           — the slot serves THIS commit, not a stale build.
 *   2. signed_out_desktop   — /login renders the sign-in UI with no horizontal
 *      signed_out_mobile      overflow, at a desktop and a phone viewport.
 *   3. auth_redirect_origin — EZiL ID sign-in redirects to id.ezil.work with a
 *                             redirect_uri on THIS slot, not bounced to prod.
 *   4. signed_in_desktop    — only with a QA identity: that identity signs in
 *      signed_in_mobile       and reaches /os on this origin. Without the QA
 *                             env these two are skipped and the run is PARTIAL.
 *
 * It reuses e2e/deployed-target.mjs (deployedTarget / appRequest /
 * configureAppContext) and e2e/sign-in.mjs (signIn), and matches live-check.mjs's
 * evidence allowlist: every emitted line is {check, ok, ms} and the final report
 * carries no credentials, cookies, full URLs with query strings, IDs or API
 * bodies.
 *
 * Exit codes follow this directory's convention:
 *   0 = PASS
 *   1 = FAIL (the first failed check stops the sequence)
 *   3 = PARTIAL (the signed-in checks were skipped for lack of a QA identity)
 *   2 = unable to run (a bad input, or no browser) — a fixed-token
 *       "UNABLE TO RUN: <reason>" on stderr, with NO check lines and NO
 *       {result} line, exactly as e2e/login-layout.mjs signals exit 2.
 *
 * Browser-free validation: node --check e2e/os-preview-smoke.mjs and
 * node --test e2e/os-preview-smoke.test.mjs.
 */
import { chmodSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// Under the 180s cap the brief sets. A global deadline (started below) governs
// each check's budget, with a reserve so browser close and the report always
// fit inside MAX_RUN_MS even after a slow check.
export const MAX_RUN_MS = 180_000;
const EVIDENCE_RESERVE_MS = 12_000;

/**
 * The exact PR preview slot regex, copied from app/src/utils/forwarded.ts:59
 * (PR_PREVIEW_SLOT_ORIGIN). Fixed hosts os-pv1..os-pv9 — never a `*.ezil.work`
 * grant, so os-pv10, a subdomain suffix, http://, or a trailing slash/path all
 * fail. It is matched against the RAW env string: normalising through
 * `new URL().origin` first would wrongly accept a trailing `/`, `:443` or
 * uppercase host, none of which the production guard accepts.
 */
export const SLOT_ORIGIN = /^https:\/\/os-pv[1-9]\.ezil\.work$/;

/**
 * A full lowercase commit id. deploySha() (app/src/server/feedback/deploy-sha.ts,
 * the same source /api/health reports) only ever emits lowercase hex, so an
 * uppercase expected value could never match and would surface later as a
 * confusing health mismatch rather than a clear input error here.
 */
export const PREVIEW_SHA = /^[0-9a-f]{40}$/;

export const CHECK_NAMES = Object.freeze([
  'health_sha', 'signed_out_desktop', 'signed_out_mobile',
  'auth_redirect_origin', 'signed_in_desktop', 'signed_in_mobile', 'deadline',
]);
const QA_CHECKS = Object.freeze(['signed_in_desktop', 'signed_in_mobile']);
const SKIP_REASONS = Object.freeze(['qa_identity_not_configured']);

export function isSlotOrigin(value) {
  return typeof value === 'string' && SLOT_ORIGIN.test(value);
}

export function isPreviewSha(value) {
  return typeof value === 'string' && PREVIEW_SHA.test(value);
}

/** /api/health answers {ok:true, sha}; the slot must serve exactly the expected commit. */
export function healthMatches(body, expectedSha) {
  return !!body && body.ok === true && typeof body.sha === 'string' && body.sha === expectedSha;
}

/**
 * Assert the Location that /auth/auth0/login answers with (never followed). It
 * proves the EZiL ID flow starts at id.ezil.work AND carries a redirect_uri on
 * THIS slot: a preview whose origin overlay is missing bounces the callback to
 * the canonical production origin instead (app/src/utils/forwarded.ts,
 * ownedPublicOrigin -> canonicalAppOrigin), which is the defect this check
 * exists to catch. Throws a constraint-named error that never embeds the URL —
 * it carries the login transaction's state and nonce.
 */
export function assertAuthRedirect(location, app) {
  if (!location || typeof location !== 'string') throw new Error('auth redirect carried no location');
  let url;
  try { url = new URL(location, app); } catch { throw new Error('auth redirect location is not a URL'); }
  if (url.host !== 'id.ezil.work' || url.pathname !== '/authorize') {
    throw new Error('auth redirect did not reach id.ezil.work/authorize');
  }
  // searchParams decodes the value; compare it to the slot's own callback. The
  // production fallback https://os.ezil.org/auth/auth0/callback fails here.
  if (url.searchParams.get('redirect_uri') !== `${app}/auth/auth0/callback`) {
    throw new Error('redirect_uri is not this preview slot callback');
  }
  return true;
}

/**
 * The route for the layout-only, signed-out checks. Aborts every non-GET (as
 * login-layout.mjs does) and adds the scoped bypass to same-origin GETs so a
 * protected preview still serves /login; cross-origin GETs (e.g. fonts) just
 * continue — the brief asks only that non-GET requests be aborted.
 */
export function signedOutRouteHandler(app, headers) {
  return route => {
    const request = route.request();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.abort('failed');
    if (new URL(request.url()).origin === app && Object.keys(headers).length > 0) {
      return route.continue({ headers: { ...request.headers(), ...headers } });
    }
    return route.continue();
  };
}

/**
 * The route installed after a signed-in session is established: abort EVERY
 * write, whatever its endpoint, and let GET/HEAD fall back to the deployment
 * route. This forecloses every paid/computer action reaching /os could trigger —
 * starting, stopping or restarting a computer and opening Code or Browser
 * (POST /api/shell/*, shell/ezil/session.js), AND any tRPC mutation such as
 * computer.delete (POST /api/trpc, shell/ezil/session.js:282) or a copilot call.
 * /os paints from its inline boot payload and GET bundle, so the shell still
 * renders for the screenshot. Reads (tRPC queries, the non-waking GET poll) pass.
 */
export function blockWritesRouteHandler() {
  return route => {
    const request = route.request();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return route.abort('failed');
    return route.fallback();
  };
}

/** Allowlist evidence (live-check.mjs style): nothing but a known check name, a boolean, and a duration survives. */
export function redactEvidence(value) {
  const known = CHECK_NAMES.includes(value?.check);
  const validMs = Number.isFinite(value?.ms) && value.ms >= 0;
  return {
    check: known ? value.check : 'unknown',
    ok: known && validMs && value?.ok === true,
    ms: validMs ? Math.round(value.ms) : 0,
  };
}

function redactSkip(value) {
  return {
    check: CHECK_NAMES.includes(value?.check) ? value.check : 'unknown',
    reason: SKIP_REASONS.includes(value?.reason) ? value.reason : 'unknown',
  };
}

/**
 * FAIL wins over PARTIAL: a failed check plus skipped ones is still FAIL. PASS
 * needs at least one executed check and nothing skipped — a run that skipped the
 * signed-in pair can never be a PASS.
 */
export function classify(checks, skipped = []) {
  const safe = checks.map(redactEvidence);
  if (safe.length === 0 || safe.some(check => !check.ok)) return 'FAIL';
  return skipped.length > 0 ? 'PARTIAL' : 'PASS';
}

export function aggregate(checks, skipped = []) {
  return {
    result: classify(checks, skipped),
    checks: checks.map(redactEvidence),
    skipped: skipped.map(redactSkip),
  };
}

export function exitCodeFor(result) {
  if (result === 'PASS') return 0;
  if (result === 'PARTIAL') return 3;
  return 1; // FAIL
}

async function loadSmokeDependencies(env) {
  const deployment = await import('./deployed-target.mjs');
  const { signIn } = await import('./sign-in.mjs');
  // Same resolution live-check.mjs uses: require('playwright') from the testkit
  // tree, which has Chromium installed.
  const require = createRequire(join(resolve(env.PLAYWRIGHT_REQUIRE_DIR ?? 'node_modules'), 'os-preview-smoke.cjs'));
  const { chromium } = require('playwright');
  return { deployment, signIn, chromium };
}

/**
 * The full run. `loadDependencies`, `emit` and `now` are injectable so the test
 * drives it without a browser. Returns either `{ unable, reason, exitCode: 2 }`
 * (no stdout emitted) or an aggregated report plus its `exitCode`.
 */
export async function runPreviewSmoke({
  env = process.env,
  loadDependencies = loadSmokeDependencies,
  emit = value => writeSync(1, `${JSON.stringify(value)}\n`),
  now = () => performance.now(),
} = {}) {
  // Taken at entry so the hard timer below bounds the WHOLE process — browser
  // launch included — inside MAX_RUN_MS, not just the checks.
  const started = now();
  // ── Preconditions. Every one is resolved before the first check line, so exit
  // 2 always means "zero checks emitted". The reason is a fixed token; the raw
  // EZIL_E2E_APP / EZIL_PREVIEW_SHA values are never echoed. ──
  const app = env.EZIL_E2E_APP;
  if (!isSlotOrigin(app)) return { unable: true, reason: 'app_origin_invalid', exitCode: 2 };
  const expectedSha = env.EZIL_PREVIEW_SHA;
  if (!isPreviewSha(expectedSha)) return { unable: true, reason: 'preview_sha_invalid', exitCode: 2 };

  const out = resolve(env.EZIL_LIVE_OUT || join(tmpdir(), 'ezil-preview-smoke'));
  try { mkdirSync(out, { recursive: true, mode: 0o700 }); }
  catch { return { unable: true, reason: 'evidence_dir_failed', exitCode: 2 }; }

  let deployment, signIn, chromium;
  try { ({ deployment, signIn, chromium } = await loadDependencies(env)); }
  catch { return { unable: true, reason: 'playwright_unavailable', exitCode: 2 }; }

  let target;
  try { target = deployment.deployedTarget(env); }
  catch { return { unable: true, reason: 'app_origin_invalid', exitCode: 2 }; }
  // deployedTarget normalises; it must still resolve to exactly our slot origin.
  if (target.app !== app) return { unable: true, reason: 'app_origin_invalid', exitCode: 2 };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true, timeout: 25_000,
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
  } catch { return { unable: true, reason: 'browser_launch_failed', exitCode: 2 }; }

  // ── Checks ──
  const deadline = started + MAX_RUN_MS - EVIDENCE_RESERVE_MS;
  const checks = [];
  const qaConfigured = Boolean(env.EZIL_E2E_EMAIL && env.EZIL_E2E_PASSWORD);
  const skipped = qaConfigured ? [] : QA_CHECKS.map(check => ({ check, reason: 'qa_identity_not_configured' }));
  let active, finished = false;

  // configureAppContext's route rethrows a redacted error on an API failure
  // (deployed-target.mjs); unguarded it becomes an unhandled rejection that would
  // crash the process with no report. Convert it into a failure of the current
  // check, exactly as live-check.mjs does, without ever printing the exception.
  let rejectRoute;
  const routeFailure = new Promise((_, reject) => { rejectRoute = reject; });
  routeFailure.catch(() => {});
  const onUnhandled = () => rejectRoute(new Error('browser request failed'));
  process.on('unhandledRejection', onUnhandled);

  const record = (check, ok, ms) => {
    const result = redactEvidence({ check, ok, ms });
    checks.push(result);
    emit(result);
  };
  const remaining = (limit) => {
    const ms = Math.min(limit, deadline - now());
    if (ms <= 0) throw new Error('Deadline exceeded');
    return Math.max(1, Math.floor(ms));
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    const report = aggregate(checks, skipped);
    try { writeFileSync(join(out, 'os-preview-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); } catch {}
    emit(report);
  };

  async function bounded(action, ms) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Deadline exceeded')), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function check(name, timeout, action) {
    active = { check: name, started: now() };
    try {
      const value = await bounded(() => Promise.race([action(), routeFailure]), remaining(timeout));
      record(name, true, now() - active.started);
      return value;
    } catch {
      // The underlying driver/route error can carry headers, cookies and URLs;
      // it never reaches stdout. Only the allowlisted {check, ok, ms} is emitted.
      record(name, false, now() - active.started);
      throw new Error('preview smoke check failed');
    } finally { active = undefined; }
  }

  async function gotoDoc(page, url) {
    // Real document loads only (PLATFORM-NOTES §17): the /os <script src> tags
    // boot on a navigation the browser performs itself, never a soft nav.
    for (let attempt = 1; ; attempt++) {
      try { return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining(30_000) }); }
      catch (error) {
        if (attempt >= 3 || !/ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_NAME/.test(String(error))) throw error;
        await sleep(remaining(2000));
      }
    }
  }

  async function redactedScreenshot(page, path) {
    if (!page || page.isClosed()) return;
    // Copied verbatim from live-check.mjs's failureScreenshot: keep host layout,
    // hide every text run, input, image and remote frame. Never an unmasked shot.
    await page.screenshot({
      path, timeout: remaining(8000),
      mask: [page.locator('iframe, input, textarea, video, canvas, img, svg, object, embed')],
      style: `*, *::before, *::after { color: transparent !important;
        -webkit-text-fill-color: transparent !important; text-shadow: none !important;
        background-image: none !important; caret-color: transparent !important; }
        iframe, input, textarea, video, canvas, img, svg, object, embed { visibility: hidden !important; }`,
    }).catch(() => {});
    try { chmodSync(path, 0o600); } catch {}
  }

  async function signedOutCheck({ width, height, isMobile }) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile, hasTouch: isMobile });
    context.setDefaultTimeout(10_000);
    await context.route('**/*', signedOutRouteHandler(target.app, target.headers));
    try {
      const page = await context.newPage();
      await gotoDoc(page, `${app}/login`);
      // The sign-in UI live-check and login-layout both drive: the email
      // disclosure. Its visibility is the "sign-in UI rendered" signal.
      await page.locator('.ezil-lock-disclosure').waitFor({ state: 'visible', timeout: remaining(20_000) });
      // Settle hydration, fonts and animations before measuring, exactly as
      // login-layout.mjs's ready() does.
      await page.waitForFunction(() => document.querySelector('.ezil-lock-time')?.textContent.trim(),
        null, { timeout: remaining(15_000) });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      const noOverflow = await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1);
      if (!noOverflow) throw new Error('horizontal overflow on /login');
    } finally { await context.close(); }
  }

  async function signedInCheck({ width, height, isMobile }, shot) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile, hasTouch: isMobile });
    context.setDefaultTimeout(10_000);
    await deployment.configureAppContext(context, target); // bypass + probe-free API transport
    try {
      const page = await context.newPage();
      // The same flow live-check uses: email sign-in to /computers, then a
      // document load to /os. Never submits for the Auth0 flow (that is check 3).
      await gotoDoc(page, `${app}/login?method=email&returnUrl=%2Fcomputers`);
      await signIn(page, { email: env.EZIL_E2E_EMAIL, password: env.EZIL_E2E_PASSWORD, destination: '/computers' });
      // Sign-in is done (its POST went through). From here NOTHING writes: reaching
      // /os cannot start a computer, open Code/Browser, or send chat — see
      // blockWritesRouteHandler. The bundle's openDesktop is failure-first
      // (shell/ezil/warm.js), so the shell still paints.
      await context.route('**/*', blockWritesRouteHandler());
      await gotoDoc(page, `${app}/os`);
      const landed = new URL(page.url());
      if (landed.origin !== app || !landed.pathname.startsWith('/os')) {
        throw new Error('did not reach /os on this origin');
      }
      // The server renders #ezil-os-root only when it built a boot payload
      // (app/src/app/os/page.tsx:211) — it distinguishes the real OS shell document
      // from the "Couldn't open your computer" fallback, and needs no container.
      await page.locator('#ezil-os-root').waitFor({ state: 'attached', timeout: remaining(15_000) });
      await redactedScreenshot(page, join(out, `${shot}.png`));
    } finally { await context.close(); }
  }

  // Fires at started + MAX_RUN_MS, counting the time preconditions already spent,
  // so a hung check or a stuck browser close can never run past the cap.
  const hardTimer = setTimeout(() => {
    if (active) record(active.check, false, now() - active.started);
    else record('deadline', false, now() - started);
    finish();
    process.exit(1);
  }, Math.max(1, MAX_RUN_MS - (now() - started)));

  try {
    await check('health_sha', 20_000, async () => {
      const response = await deployment.appRequest(`${app}/api/health`, {
        headers: { ...target.headers, 'cache-control': 'no-cache' },
        timeout: remaining(20_000),
      });
      let json = null;
      try { json = JSON.parse(response.body.toString('utf8')); } catch {}
      if (response.status !== 200 || !healthMatches(json, expectedSha)) throw new Error('health sha mismatch');
    });

    await check('signed_out_desktop', 45_000, () => signedOutCheck({ width: 1440, height: 900, isMobile: false }));
    await check('signed_out_mobile', 45_000, () => signedOutCheck({ width: 390, height: 844, isMobile: true }));

    await check('auth_redirect_origin', 20_000, async () => {
      // Start the EZiL ID sign-in but never follow it: appRequest returns the
      // redirect, it does not chase it, and no credentials are submitted.
      const response = await deployment.appRequest(`${app}/auth/auth0/login`, {
        headers: { ...target.headers },
        timeout: remaining(20_000),
      });
      if (response.status < 300 || response.status >= 400) throw new Error('auth login did not redirect');
      assertAuthRedirect(response.headers.location, app); // throws without the URL
    });

    if (qaConfigured) {
      await check('signed_in_desktop', 70_000, () => signedInCheck({ width: 1440, height: 900, isMobile: false }, 'signed-in-desktop'));
      await check('signed_in_mobile', 70_000, () => signedInCheck({ width: 390, height: 844, isMobile: true }, 'signed-in-mobile'));
    }
  } catch {
    // The first failed check already recorded its line; stop the sequence.
  } finally {
    // Bound the close so a hung browser cannot wedge the process; keep the hard
    // timer armed until after finish() has emitted the {result} line.
    await bounded(() => browser.close(), 5000).catch(() => {});
    finish();
    clearTimeout(hardTimer);
    process.removeListener('unhandledRejection', onUnhandled);
  }

  const report = aggregate(checks, skipped);
  return { ...report, exitCode: exitCodeFor(report.result) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await runPreviewSmoke();
  if (result.unable) {
    // Fixed token only — never the raw EZIL_E2E_APP / EZIL_PREVIEW_SHA value.
    process.stderr.write(`UNABLE TO RUN: ${result.reason}\n`);
    process.exit(2);
  }
  process.exit(result.exitCode);
}

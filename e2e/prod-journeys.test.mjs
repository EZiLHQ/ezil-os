import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FINAL_STOP_TIMEOUT_MS, parseTerminalMarker } from './live-check.mjs';
import {
  COMPUTER_NAME_PREFIX, DEFAULT_JOURNEYS, JOURNEYS, MAX_COMPUTERS_PER_USER, READY_SETTLE_MS, REQUIRED_ENV,
  addApiFailure, addUnique, apiPathOf, assertSuiteComputer, awsFacts, capText, classifyStartFailure,
  describeCreateRefusal, describeError, describeReadinessWait, describeStartFailure, describeStopFailure,
  echoProbeCommand, errorCodesOf, exitCodeFor, framePixelVerdict, isPaidPlan, journeyBudgetMs, makeReport,
  newReadinessTracker, normalizeVisibleText, parseAppOrigin, parseEnv, pickSuiteComputers, readWindowSnapshot,
  readinessSettled, readinessTimings, redactDeep, redactEmail, redactText, remainingMs, runDeadlines,
  runProdJourneys, selectJourneys, shapeApiFailure, shapeConsoleError, shapeVisibleErrors, stepRecord,
  summarizeFeedbackRequest, trackReadiness, userReadiness, wantsBody,
} from './prod-journeys.mjs';

const APP = 'https://os-prod.ezil.work';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
const baseEnv = Object.freeze({
  EZIL_E2E_APP: APP, EZIL_E2E_EMAIL: 'qa.user@ezil.work', EZIL_E2E_PASSWORD: 'correct-horse-battery',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
  PLAYWRIGHT_REQUIRE_DIR: '/opt/testkit',
});

// ── journey selection ──────────────────────────────────────────────────────

test('journey selection defaults to every free journey and never the paid AWS one implicitly', () => {
  assert.deepEqual(selectJourneys(undefined), ['free-open-apps', 'feedback-diagnostics', 'billing-view']);
  assert.deepEqual(selectJourneys(''), [...DEFAULT_JOURNEYS]);
  assert.ok(!selectJourneys('  ').includes('paid-aws-computer'));
  assert.deepEqual(selectJourneys('paid-aws-computer'), ['paid-aws-computer']);
});

test('journey selection keeps canonical order, deduplicates and trims', () => {
  assert.deepEqual(selectJourneys('billing-view , free-open-apps,billing-view'), ['free-open-apps', 'billing-view']);
  assert.deepEqual(selectJourneys(JOURNEYS.join(',')), [...JOURNEYS]);
});

test('journey selection rejects unknown and empty entries instead of silently running fewer', () => {
  assert.throws(() => selectJourneys('free-open-apps,nope'), /Unknown journey\(s\): nope/);
  assert.throws(() => selectJourneys('free-open-apps,'), /\(empty\)/);
  assert.throws(() => selectJourneys('Free-Open-Apps'), /Unknown journey/);
});

// ── environment ────────────────────────────────────────────────────────────

test('env parsing names every missing variable and never a value', () => {
  assert.throws(() => parseEnv({}), error => REQUIRED_ENV.every(name => error.message.includes(name)));
  const partial = { ...baseEnv, EZIL_E2E_PASSWORD: '  ' };
  assert.throws(() => parseEnv(partial), error => /EZIL_E2E_PASSWORD/.test(error.message)
    && !error.message.includes('qa.user') && !error.message.includes('anon-key-value'));
});

test('env parsing returns the validated configuration with defaults', () => {
  const config = parseEnv(baseEnv);
  assert.equal(config.app, APP);
  assert.deepEqual(config.journeys, ['free-open-apps', 'feedback-diagnostics', 'billing-view']);
  assert.equal(config.awsTimeoutMs, 15 * 60_000, 'AWS first boot gets 15 minutes by default');
  assert.equal(config.awsComputer, 'new');
  assert.match(config.out, /ezil-prod-journeys$/);
  assert.equal(parseEnv({ ...baseEnv, EZIL_E2E_OUT: '/tmp/x/../y' }).out, '/tmp/y');
});

test('env parsing validates overrides', () => {
  assert.equal(parseEnv({ ...baseEnv, EZIL_E2E_AWS_TIMEOUT_MS: '600000' }).awsTimeoutMs, 600_000);
  for (const value of ['abc', '1.5', '-5', '0', '999999999']) {
    assert.throws(() => parseEnv({ ...baseEnv, EZIL_E2E_AWS_TIMEOUT_MS: value }), /EZIL_E2E_AWS_TIMEOUT_MS must be an integer/);
  }
  assert.throws(() => parseEnv({ ...baseEnv, EZIL_E2E_AWS_COMPUTER: 'delete' }), /"new" or "reuse"/);
  assert.equal(parseEnv({ ...baseEnv, EZIL_E2E_AWS_COMPUTER: 'reuse' }).awsComputer, 'reuse');
  assert.throws(() => parseEnv({ ...baseEnv, EZIL_E2E_JOURNEYS: 'bogus' }), /Unknown journey/);
  assert.throws(() => parseEnv({ ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: 'http://abc.supabase.co' }), /HTTPS/);
});

test('the app must be an HTTPS origin, with no credentials, path, query or fragment', () => {
  assert.equal(parseAppOrigin('https://os-prod.ezil.work/'), APP);
  assert.equal(parseAppOrigin('http://localhost:3000'), 'http://localhost:3000');
  for (const bad of ['http://os-prod.ezil.work', 'https://u:p@os-prod.ezil.work', 'https://os-prod.ezil.work/os',
    'https://os-prod.ezil.work/?x=1', 'https://os-prod.ezil.work/#a', 'not a url']) {
    assert.throws(() => parseAppOrigin(bad), /EZIL_E2E_APP/, bad);
  }
});

// ── redaction ──────────────────────────────────────────────────────────────

test('emails are masked to first-letter***@domain, including inside sentences, and the mask is stable', () => {
  assert.equal(redactEmail('qa.user@ezil.work'), 'q***@ezil.work');
  assert.equal(redactEmail('not-an-email'), '[invalid-email]');
  assert.equal(redactEmail(undefined), '[invalid-email]');
  const text = redactText('failed for qa.user@ezil.work and bob+tag@sub.example.co.uk today');
  assert.equal(text, 'failed for q***@ezil.work and b***@sub.example.co.uk today');
  assert.equal(redactText(text), text, 'redacting twice changes nothing');
});

test('tokens, cookies, query strings and literal secrets never survive redaction', () => {
  const dirty = [
    `Authorization: Bearer ${JWT}`, `jwt ${JWT}`,
    'cookie __Host-ezil-os-auth=base64-eyJhY2Nlc3NfdG9rZW4iOiJ4In0abcdef; Path=/',
    'cookie __Host-ezil-os-auth.1=chunkvalue123',
    'GET https://aws-8181-x.example.test/preview-bootstrap?token=abc123&computerId=9f8e7d6c&frameUrl=zzz failed',
    'refresh_token=r-12345 and apikey=sb_publishable_xyz', 'the password was correct-horse-battery',
  ].join('\n');
  const clean = redactText(dirty, { secrets: ['correct-horse-battery', 'x'] });
  for (const leak of [JWT, 'eyJhY2Nlc3N', 'chunkvalue123', 'abc123', '9f8e7d6c', 'zzz', 'r-12345', 'sb_publishable_xyz', 'correct-horse-battery']) {
    assert.ok(!clean.includes(leak), `leaked ${leak}`);
  }
  assert.match(clean, /https:\/\/aws-8181-x\.example\.test\/preview-bootstrap failed/, 'the URL path stays: it names the hop');
  assert.ok(clean.includes('x'), 'a secret shorter than four characters is not blanket-replaced');
});

test('redactDeep scrubs nested values without mutating its input', () => {
  const source = { a: ['qa.user@ezil.work', { b: `Bearer ${JWT}` }], n: 3, ok: true, none: null };
  const clean = redactDeep(source);
  assert.deepEqual(clean, { a: ['q***@ezil.work', { b: 'Bearer [jwt]' }], n: 3, ok: true, none: null });
  assert.equal(source.a[0], 'qa.user@ezil.work');
});

test('driver errors keep their first line only, redacted and capped', () => {
  const error = new Error(`locator.click: Timeout 10000ms exceeded for qa.user@ezil.work\nCall log:\n  - cookie: __Host-ezil-os-auth=base64-${'a'.repeat(40)}`);
  const described = describeError(error);
  assert.equal(described, 'locator.click: Timeout 10000ms exceeded for q***@ezil.work');
  assert.equal(describeError('x'.repeat(1000)).length, 300);
  assert.equal(capText('abcdef', 4), 'abc…');
  assert.equal(describeError(undefined), 'Unknown error');
});

// ── failure evidence ───────────────────────────────────────────────────────

test('error codes come from every body shape the app uses and nowhere else', () => {
  assert.deepEqual(errorCodesOf({ error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } }), ['UNAUTHORIZED']);
  assert.deepEqual(errorCodesOf({ error: { json: { message: 'UNAUTHORIZED', code: -32001, data: { code: 'UNAUTHORIZED', httpStatus: 401 } } } }), ['UNAUTHORIZED']);
  assert.deepEqual(errorCodesOf([{ result: {} }, { error: { json: { data: { code: 'NOT_FOUND' } } } }]), ['NOT_FOUND']);
  assert.deepEqual(errorCodesOf({ ok: false, error: 'sandbox_starting', errorCode: 'computer_starting' }), ['sandbox_starting', 'computer_starting']);
  assert.deepEqual(errorCodesOf({ ok: false, outcome: 'still_running', reason: 'stop_timeout' }), ['still_running', 'stop_timeout']);
  assert.deepEqual(errorCodesOf({ error: { code: 'FORBIDDEN', message: 'computer_limit_reached' } }), ['FORBIDDEN', 'computer_limit_reached']);
  assert.deepEqual(errorCodesOf({ ok: true, outcome: 'destroyed', reason: 'fine' }), [], 'a success body has no error codes');
  assert.deepEqual(errorCodesOf(null), []);
  assert.deepEqual(errorCodesOf('<html>502</html>'), []);
});

test('free text and personal data in a body are dropped: only code-shaped values are kept', () => {
  const body = { error: { code: 'BAD_REQUEST', message: 'Computer qa.user@ezil.work was not found. Sign in to continue.' },
    errorCode: 'has spaces and an email a@b.co', ok: false, reason: 'x'.repeat(65), outcome: 'tok=abc;def' };
  assert.deepEqual(errorCodesOf(body), ['BAD_REQUEST']);
  assert.deepEqual(errorCodesOf({ error: { message: 'Sign in to continue.' } }), []);
  assert.deepEqual(errorCodesOf({ error: { message: 'qa.user@ezil.work' } }), []);
  assert.deepEqual(errorCodesOf({ error: { message: 'alice' } }), [], 'a lone word could be a name, not a reason');
  assert.deepEqual(errorCodesOf({ error: { json: { message: 'Unauthorized' } } }), []);
  assert.deepEqual(errorCodesOf({ error: { message: 'computer_limit_reached' } }), ['computer_limit_reached']);
});

test('only same-origin /api paths are recorded, by pathname alone', () => {
  assert.equal(apiPathOf(`${APP}/api/shell/code-preview-url?computerId=abc&token=t`, APP), '/api/shell/code-preview-url');
  assert.equal(apiPathOf(`${APP}/api/trpc/computer.progress?input=%7B%7D`, APP), '/api/trpc/computer.progress');
  assert.equal(apiPathOf(`${APP}/os`, APP), null);
  assert.equal(apiPathOf('https://other.example/api/shell/stop', APP), null);
  assert.equal(apiPathOf('not a url', APP), null);
});

test('response bodies are read for refusals and for shell routes that refuse with a 200', () => {
  assert.equal(wantsBody('/api/trpc/billing.summary', 200), false, 'a healthy tRPC read is not parsed');
  assert.equal(wantsBody('/api/trpc/billing.summary', 401), true);
  assert.equal(wantsBody('/api/trpc/computer.list', 207), true);
  for (const route of ['desktop', 'code-preview-url', 'session', 'stop', 'switch']) assert.equal(wantsBody(`/api/shell/${route}`, 200), true, route);
  assert.equal(wantsBody('/api/shell/feedback', 200), false);
  assert.equal(wantsBody('/api/health', 200), false);
});

test('an unauthorized code-preview mint is shaped to status plus code, no message, no query', () => {
  const failure = shapeApiFailure({ method: 'post', pathname: '/api/shell/code-preview-url', status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } });
  assert.deepEqual(failure, { method: 'POST', path: '/api/shell/code-preview-url', status: 401, codes: ['UNAUTHORIZED'] });
  assert.ok(!JSON.stringify(failure).includes('Sign in'));
});

test('a refusal delivered as HTTP 200 is still a failure; a healthy 200 is not', () => {
  const refused = shapeApiFailure({ method: 'GET', pathname: '/api/shell/desktop', status: 200, body: { ok: false, error: 'computer_stopped' } });
  assert.deepEqual(refused, { method: 'GET', path: '/api/shell/desktop', status: 200, codes: ['computer_stopped'] });
  assert.equal(shapeApiFailure({ method: 'GET', pathname: '/api/shell/desktop', status: 200, body: { ok: true, url: 'https://x' } }), null);
  const unreadable = shapeApiFailure({ method: 'POST', pathname: '/api/shell/stop', status: 502, body: null });
  assert.deepEqual(unreadable, { method: 'POST', path: '/api/shell/stop', status: 502, codes: [] });
});

test('wake-loop answers are flagged pending and repeats are counted, not listed again', () => {
  const pending = shapeApiFailure({ method: 'POST', pathname: '/api/shell/code-preview-url', status: 200, body: { ok: false, error: 'sandbox_starting' } });
  assert.equal(pending.pending, true);
  assert.equal(shapeApiFailure({ method: 'POST', pathname: '/api/shell/code-preview-url', status: 200, body: { ok: false, error: 'unauthorized' } }).pending, undefined);
  const list = [];
  for (let i = 0; i < 5; i++) addApiFailure(list, pending);
  addApiFailure(list, { method: 'POST', path: '/api/shell/stop', status: 500, codes: ['INTERNAL_SERVER_ERROR'] });
  assert.equal(list.length, 2);
  assert.equal(list[0].count, 5);
  const capped = [];
  for (let i = 0; i < 60; i++) addApiFailure(capped, { method: 'GET', path: `/api/x${i}`, status: 500, codes: [] });
  assert.equal(capped.length, 40);
});

test('console errors lose URL queries, tokens and addresses, and are deduplicated and capped', () => {
  const line = shapeConsoleError(`Failed to load https://x.example/y?token=abc for qa.user@ezil.work\n    at stack`);
  assert.equal(line, 'Failed to load https://x.example/y for q***@ezil.work');
  const list = [];
  addUnique(list, line); addUnique(list, line); addUnique(list, '');
  assert.equal(list.length, 1);
  for (let i = 0; i < 40; i++) addUnique(list, `e${i}`, 5);
  assert.equal(list.length, 5);
  assert.match(shapeConsoleError('[ezil-os:apps/code] code-preview mint failed after 41ms: unauthorized'), /mint failed after 41ms: unauthorized/);
});

test('visible error text is redacted, deduplicated, capped, and junk entries are ignored', () => {
  const shaped = shapeVisibleErrors([
    { source: 'code start failure', text: "Something went wrong — We couldn't start your computer." },
    { source: 'alert', text: "Something went wrong — We couldn't start your computer." },
    { source: 'feedback', text: 'Sent from qa.user@ezil.work failed' },
    { source: 'x', text: '   ' }, { text: 7 }, null,
  ]);
  assert.deepEqual(shaped.map(item => item.text), ["Something went wrong — We couldn't start your computer.", 'Sent from q***@ezil.work failed']);
  assert.deepEqual(shapeVisibleErrors('nope'), []);
});

test('a start failure is read from the failed opening panel, not from a window that is merely loading', () => {
  assert.equal(classifyStartFailure({ open: false }), null);
  assert.equal(classifyStartFailure(null), null);
  const loading = { open: true, failed: null, unavailable: null, notice: null, spinnerKind: 'progress', alerts: [] };
  assert.equal(classifyStartFailure(loading), null);
  const failed = classifyStartFailure({ ...loading, spinnerKind: 'failed',
    failed: { title: 'Something went wrong', body: "We couldn't start your computer. Try again, and if it keeps happening, let us know." } });
  assert.equal(failed.kind, 'start_failed');
  assert.equal(describeStartFailure('code', failed), "Code did not start (start_failed): Something went wrong — We couldn't start your computer. Try again, and if it keeps happening, let us know.");
  assert.equal(classifyStartFailure({ ...loading, unavailable: { title: "Code isn't reachable right now" } }).kind, 'code_unreachable');
  assert.equal(classifyStartFailure({ ...loading, alerts: ['Unauthorized'] }).kind, 'alert');
  assert.equal(classifyStartFailure({ ...loading, alerts: ['Delete this computer?'] }), null);
  // The unverified-display strip is not a start failure: pixels decide that.
  assert.equal(classifyStartFailure({ ...loading, notice: { title: "We couldn't check your display", body: '' } }), null);
});

// ── pixels ─────────────────────────────────────────────────────────────────

function frame(colorAt = () => [0, 0, 0], width = 64, height = 36) {
  return Uint8ClampedArray.from(Array.from({ length: width * height }, (_, i) => [...colorAt(i), 255]).flat());
}

test('pixel verdict accepts a desktop-like frame and names why it rejects anything else', () => {
  const desktop = frame(i => (i % 64 < 12 ? [225, 230, 235] : [18, 32, 60]));
  assert.equal(framePixelVerdict(desktop).ok, true);
  assert.equal(framePixelVerdict(desktop).reason, 'ok');
  assert.equal(framePixelVerdict(frame()).reason, 'black');
  assert.equal(framePixelVerdict(frame(i => (i === 1152 ? [255, 255, 255] : [0, 0, 0]))).reason, 'few_visible_pixels', 'a lone cursor is not a desktop');
  assert.equal(framePixelVerdict(frame(() => [128, 128, 128])).reason, 'uniform');
  assert.equal(framePixelVerdict(frame(i => (i % 2 ? [50, 50, 50] : [80, 80, 80]))).reason, 'uniform');
  for (const pixels of [null, undefined, [], [255, 255, 255, 255], new Uint8ClampedArray(10)]) {
    assert.deepEqual(framePixelVerdict(pixels), { ok: false, reason: 'no_pixels' });
  }
  assert.equal(framePixelVerdict(desktop, 64, 72).reason, 'no_pixels', 'a frame of the wrong size is not judged');
});

test('the pixel verdict agrees with the deployed smoke test at the visible-area boundary', () => {
  const edge = count => frame(i => (i < count ? [255, 255, 255] : [0, 0, 0]));
  assert.equal(framePixelVerdict(edge(46)).ok, false);
  assert.equal(framePixelVerdict(edge(47)).ok, true);
});

// ── user-ready: content AND no opening overlay ─────────────────────────────

const OPEN = Object.freeze({ open: true, windowVisible: true, overlay: null });
const OVERLAY = Object.freeze({ kind: 'ezil-app-spinner', dataKind: 'progress', text: 'Opening the window' });

test('an app is ready only when its content is there and no opening overlay covers it', () => {
  assert.deepEqual(userReadiness({ snapshot: OPEN, contentReady: true }), { ready: true, state: 'ready' });
  // Overlay hidden, nothing painted yet: not ready.
  assert.deepEqual(userReadiness({ snapshot: OPEN, contentReady: false }), { ready: false, state: 'content_not_ready', overlay: null });
  // Overlay visible, nothing painted yet: still opening.
  assert.deepEqual(userReadiness({ snapshot: { ...OPEN, overlay: OVERLAY }, contentReady: false }),
    { ready: false, state: 'opening', overlay: OVERLAY });
});

test('pixels behind a visible opening overlay are not ready: the user sees the spinner, not the desktop', () => {
  const covered = userReadiness({ snapshot: { ...OPEN, overlay: OVERLAY }, contentReady: true });
  assert.equal(covered.ready, false);
  assert.equal(covered.state, 'overlay_covering_content');
  assert.deepEqual(covered.overlay, OVERLAY);
  assert.equal(userReadiness({ snapshot: { ...OPEN, overlay: { kind: 'ezil-boot', dataKind: 'progress', text: 'Opening the window' } }, contentReady: true }).ready, false);
});

test('readiness is strict: only contentReady === true, only an open and visible window', () => {
  for (const contentReady of [undefined, null, 'yes', 1, {}]) assert.equal(userReadiness({ snapshot: OPEN, contentReady }).ready, false);
  assert.equal(userReadiness({ snapshot: { open: false }, contentReady: true }).state, 'window_closed');
  assert.equal(userReadiness({ snapshot: null, contentReady: true }).ready, false);
  assert.equal(userReadiness({ snapshot: { ...OPEN, windowVisible: false }, contentReady: true }).state, 'window_hidden');
  assert.equal(userReadiness({ snapshot: { open: true, overlay: null }, contentReady: true }).ready, true, 'visibility unknown is not hidden');
});

test('the readiness timeline separates first pixels from the overlay going away, and waits for a stable ready state', () => {
  // The production case: the video paints at 3 s behind the overlay; the shell retires the overlay at 12 s.
  let tracker = newReadinessTracker();
  const observe = (elapsedMs, contentReady, overlayVisible) => { tracker = trackReadiness(tracker, { elapsedMs, contentReady, overlayVisible }); };
  observe(0, false, true);
  observe(3000, true, true);
  assert.equal(readinessSettled(tracker, 3000), false);
  observe(11000, true, true);
  assert.equal(tracker.readySinceMs, null, 'pixels under the overlay never start the ready clock');
  assert.equal(readinessSettled(tracker, 11000 + READY_SETTLE_MS * 10), false);
  observe(12000, true, false);
  assert.equal(readinessSettled(tracker, 12000), false, 'ready this instant is not yet settled');
  observe(12000 + READY_SETTLE_MS, true, false);
  assert.equal(readinessSettled(tracker, 12000 + READY_SETTLE_MS), true);
  assert.deepEqual(readinessTimings(tracker, 'firstPixelsMs'), { firstPixelsMs: 3000, overlaySeenMs: 0, overlayGoneMs: 12000, readyMs: 12000 });
});

test('an overlay that comes back resets the ready clock and the gone time', () => {
  let tracker = newReadinessTracker();
  for (const [at, content, overlay] of [[0, true, true], [1000, true, false], [1400, true, true], [2000, true, false], [2300, true, false]]) {
    tracker = trackReadiness(tracker, { elapsedMs: at, contentReady: content, overlayVisible: overlay });
    if (at === 1000) assert.equal(tracker.overlayGoneMs, 1000);
    if (at === 1400) assert.deepEqual([tracker.overlayGoneMs, tracker.readySinceMs], [null, null]);
  }
  assert.deepEqual(readinessTimings(tracker), { firstContentMs: 0, overlaySeenMs: 0, overlayGoneMs: 2000, readyMs: 2000 });
  assert.equal(readinessSettled(tracker, 2300, 400), false);
  assert.equal(readinessSettled(tracker, 2400, 400), true);
});

test('content that appears only after the overlay is gone is ready then, and an overlay never seen is reported as null', () => {
  let tracker = newReadinessTracker();
  tracker = trackReadiness(tracker, { elapsedMs: 500, contentReady: false, overlayVisible: false });
  tracker = trackReadiness(tracker, { elapsedMs: 4000, contentReady: true, overlayVisible: false });
  assert.deepEqual(readinessTimings(tracker, 'firstEditorMs'), { firstEditorMs: 4000, overlaySeenMs: null, overlayGoneMs: null, readyMs: 4000 });
  tracker = trackReadiness(tracker, { elapsedMs: 4500, contentReady: true, overlayVisible: false, windowOpen: false });
  assert.equal(tracker.readySinceMs, null, 'a closed window is not ready');
  assert.deepEqual(readinessTimings(newReadinessTracker()), { firstContentMs: null, overlaySeenMs: null, overlayGoneMs: null, readyMs: null });
});

test('a readiness timeout names the overlay that is still on screen', () => {
  const covered = userReadiness({ snapshot: { ...OPEN, overlay: OVERLAY }, contentReady: true });
  assert.equal(describeReadinessWait(covered, 'video pixels'), 'video pixels present but opening overlay visible ("Opening the window")');
  const opening = userReadiness({ snapshot: { ...OPEN, overlay: { ...OVERLAY, text: 'Opening Code…' } }, contentReady: false });
  assert.equal(describeReadinessWait(opening, 'editor', 'workbench not visible'), 'editor not yet [workbench not visible]; opening overlay visible ("Opening Code…")');
  assert.equal(describeReadinessWait(userReadiness({ snapshot: OPEN, contentReady: false }), 'video pixels', 'video black'), 'video pixels not yet [video black]; no overlay');
  assert.equal(describeReadinessWait({ state: 'window_hidden' }, 'editor'), 'window is not visible');
  assert.equal(describeReadinessWait({ state: 'window_closed' }, 'editor'), 'window not open');
});

// The overlay selectors run in the page. This drives the real function in Chromium over markup that mirrors
// the shell's (`.ezil-app-spinner` / `.ezil-boot` overlays in a `.window-body`, retired with `hidden`).
// Offline, but it needs a Playwright with a browser: set PLAYWRIGHT_REQUIRE_DIR, as for the live run.
test('the in-page snapshot sees an opening overlay only while the user can see it', {
  skip: process.env.PLAYWRIGHT_REQUIRE_DIR ? false : 'PLAYWRIGHT_REQUIRE_DIR is not set',
}, async () => {
  const { chromium } = createRequire(join(process.env.PLAYWRIGHT_REQUIRE_DIR, 'prod-journeys-test.cjs'))('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // The rules that matter, copied from shell/ezil/ui/ezil-shell.css.
    const css = `.window{position:absolute;width:600px;height:300px}.window-body{position:relative;width:100%;height:100%}
      .ezil-app-spinner,.ezil-boot{position:absolute;inset:0;z-index:2;display:flex}
      .ezil-app-spinner[hidden],.ezil-boot[hidden]{display:none}`;
    const surface = (cls, attrs = '', kind = 'progress') => `<div class="${cls}" data-kind="${kind}" ${attrs}>
      <h1 class="ezil-opening-status ezil-boot-title">Opening the window</h1></div>`;
    const snap = async (body, app = 'desktop') => {
      await page.setContent(`<style>${css}</style><div class="window" data-app="${app}"><div class="window-body">${body}
        <iframe class="window-app-iframe" src="about:blank"></iframe></div></div>`);
      return page.evaluate(readWindowSnapshot, app);
    };
    const visible = await snap(surface('ezil-app-spinner'));
    assert.deepEqual([visible.overlay.kind, visible.overlay.dataKind, visible.overlay.text], ['ezil-app-spinner', 'progress', 'Opening the window']);
    assert.equal(visible.windowVisible, true);
    assert.equal((await snap(surface('ezil-boot'))).overlay.kind, 'ezil-boot');
    // Retired the way desktop-window.js retires them, or hidden by any other means: no overlay.
    for (const hidden of [
      surface('ezil-app-spinner', 'hidden'), surface('ezil-boot', 'hidden') + surface('ezil-app-spinner', 'hidden'),
      surface('ezil-app-spinner', 'style="display:none"'), surface('ezil-app-spinner', 'style="opacity:0"'),
      surface('ezil-app-spinner', 'style="visibility:hidden"'), surface('ezil-app-spinner', 'style="width:2px;height:2px;inset:auto"'),
      `<div style="display:none">${surface('ezil-app-spinner')}</div>`, `<div style="opacity:0">${surface('ezil-app-spinner')}</div>`,
      '',
    ]) assert.equal((await snap(hidden)).overlay, null, hidden);
    // What counts is what paints: a `hidden` attribute that CSS overrides still shows the overlay.
    assert.equal((await snap(surface('ezil-app-spinner', 'hidden style="display:flex"'))).overlay.kind, 'ezil-app-spinner');
    // One retired surface does not hide the other that is still showing.
    assert.equal((await snap(surface('ezil-boot', 'hidden') + surface('ezil-app-spinner'))).overlay.kind, 'ezil-app-spinner');
    // A failed panel is an overlay too (it also reads as a start failure).
    const failed = await snap(surface('ezil-app-spinner', '', 'failed'));
    assert.equal(failed.failed.title, 'Opening the window');
    assert.equal(failed.overlay.dataKind, 'failed');
    assert.deepEqual(await page.evaluate(readWindowSnapshot, 'code'), { open: false });
  } finally { await browser.close(); }
});

// ── terminal probe ─────────────────────────────────────────────────────────

test('the echo probe can never be satisfied by the echoed command line', () => {
  const nonce = 'a1b2c3d4e5'.repeat(2);
  const command = echoProbeCommand(nonce);
  const marker = `N${nonce}`;
  assert.equal(parseTerminalMarker(command, marker), null);
  assert.equal(parseTerminalMarker(command.match(/.{1,17}/g).join('\n'), marker), null, 'soft-wrapped echo');
  assert.equal(parseTerminalMarker(`root@c:~# ${command}\r\nroot@c:~# `, marker), null, 'prompt plus echo only');
  assert.equal(parseTerminalMarker(`root@c:~# ${command}\n${marker}[ok]\nroot@c:~# `, marker), 'ok', 'real output');
  assert.equal(parseTerminalMarker(`${marker}[o`.concat('\n', 'k]'), marker), 'ok', 'output wrapped mid-marker');
  assert.equal(parseTerminalMarker(`N${'b2'.repeat(10)}[ok]`, marker), null, 'another run\'s marker');
});

test('the echo probe only accepts a hex nonce, so no shell text can be injected', () => {
  assert.match(echoProbeCommand('0123456789abcdef0123'), /^printf '%s\[%s\]\\n' N0123456789abcdef0123 ok$/);
  for (const bad of ['', 'xyz', '$(reboot)', 'a'.repeat(19), 'A'.repeat(20), undefined, 7]) {
    assert.throws(() => echoProbeCommand(bad), /Invalid probe nonce/);
  }
});

// ── paid journey helpers ───────────────────────────────────────────────────

test('paid plans are recognised in both billing contract versions; free and unreadable are not paid', () => {
  assert.equal(isPaidPlan({ enabled: true, plan: { sku: 'standard_monthly_v3' } }), true);
  assert.equal(isPaidPlan({ enabled: true, plan: { sku: 'premium_monthly_v3' } }), true);
  assert.equal(isPaidPlan({ enabled: true, plan: { family: 'compute', sku: 'compute_monthly_v2' } }), true);
  assert.equal(isPaidPlan({ enabled: true, plan: { family: 'pro_legacy' } }), true);
  assert.equal(isPaidPlan({ enabled: true, plan: { sku: 'free_v3' } }), false);
  assert.equal(isPaidPlan({ enabled: true, plan: { family: 'free', sku: 'free_v2' } }), false);
  assert.equal(isPaidPlan({ enabled: false, plan: { sku: 'standard_monthly_v3' } }), false);
  for (const bad of [null, undefined, {}, { plan: {} }, { plan: { sku: 7 } }]) assert.equal(isPaidPlan(bad), false);
});

test('AWS facts come from the placement lifecycle or an instance type, nothing else', () => {
  const aws = awsFacts({ lifecycleState: 'RUNNING', hardware: { instanceType: 'm6i.large' }, stage: 'running', operation: 'none' });
  assert.deepEqual(aws, { aws: true, lifecycleState: 'RUNNING', instanceType: 'm6i.large', stage: 'running', operation: 'none', needsOperator: false, paused: false });
  assert.equal(awsFacts({ lifecycleState: null, hardware: { instanceType: null }, stage: 'unavailable' }).aws, false);
  assert.equal(awsFacts({ lifecycleState: 'STOPPED', hardware: {} }).aws, true);
  assert.equal(awsFacts({ hardware: { instanceType: 'm6i.large' } }).aws, true);
  assert.equal(awsFacts({ hardware: { instanceType: 'drop table;' } }).instanceType, null);
  assert.equal(awsFacts({ lifecycleState: 'UNCONFIRMED', needsOperator: true, paused: true }).needsOperator, true);
  assert.equal(awsFacts(undefined).aws, false);
});

test('the suite recognises only its own computers, by name prefix', () => {
  const rows = [
    { id: 'id-1', name: 'My computer' }, { id: 'id-2', name: `${COMPUTER_NAME_PREFIX} 1a2b3c4d` },
    { id: 'id-3', name: `prefix ${COMPUTER_NAME_PREFIX}` }, { id: 7, name: `${COMPUTER_NAME_PREFIX} x` }, null,
  ];
  assert.deepEqual(pickSuiteComputers(rows).map(row => row.id), ['id-2']);
  assert.deepEqual(pickSuiteComputers(undefined), []);
});

test('stopping, waking or selecting is refused for any computer the run does not own', () => {
  const owned = new Set(['mine']);
  assert.equal(assertSuiteComputer('mine', owned), 'mine');
  for (const id of ['theirs', '', undefined, null, 5]) assert.throws(() => assertSuiteComputer(id, owned), /did not create/);
  assert.throws(() => assertSuiteComputer('mine', undefined), /did not create/);
  assert.throws(() => assertSuiteComputer('mine', new Set()), /did not create/);
});

test('a refused computer.create explains the computer limit and quotes nothing else', () => {
  assert.match(describeCreateRefusal({ status: 403, code: 'FORBIDDEN', reason: 'computer_limit_reached' }), /already has 2 computers.*EZIL_E2E_AWS_COMPUTER=reuse/);
  assert.equal(MAX_COMPUTERS_PER_USER, 2);
  assert.equal(describeCreateRefusal({ status: 500, code: 'INTERNAL_SERVER_ERROR', reason: null }), 'computer.create refused (HTTP 500 INTERNAL_SERVER_ERROR)');
  assert.equal(describeCreateRefusal({ status: 0, code: 'NETWORK' }), 'computer.create refused (HTTP 0 NETWORK)');
});

test('a stop that was not confirmed reports status and codes only', () => {
  const error = Object.assign(new Error('Cleanup stop unconfirmed'), { stop: { status: 200, ok: false, outcome: 'still_running', error: 'stop_timeout' } });
  assert.equal(describeStopFailure(error), 'Stop was not confirmed (HTTP 200 ok=false outcome=still_running error=stop_timeout)');
  assert.equal(describeStopFailure(new Error('Deadline exceeded')), 'Deadline exceeded');
});

// ── feedback diagnostics ───────────────────────────────────────────────────

test('a feedback request is summarised by field names, never by content', () => {
  const request = {
    v: 1, clientRequestId: 'u', category: 'bug', description: 'SECRET DESCRIPTION qa.user@ezil.work', computerId: 'cid',
    diagnostics: { shellVersion: '1', browser: { family: 'Chrome', major: 140 }, traceId: 'trace-1234',
      recentEvents: [
        { eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'unauthorized' },
        { eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'unauthorized' },
        { eventClass: 'display_failure', site: 'x', code: 'frame_not_answering' }, { eventClass: 'bad class', code: 'x' }, null,
      ] },
    screenshot: null,
  };
  const summary = summarizeFeedbackRequest(request, { id: 'rid', screenshotAccepted: false });
  assert.deepEqual(summary.requestKeys, ['category', 'clientRequestId', 'computerId', 'description', 'diagnostics', 'screenshot', 'v']);
  assert.deepEqual(summary.diagnosticsKeys, ['browser', 'recentEvents', 'shellVersion', 'traceId']);
  assert.equal(summary.diagnosticsAttached, true);
  assert.equal(summary.hasCorrelationId, true);
  assert.equal(summary.hasServerErrorCode, true);
  assert.deepEqual(summary.apiFailureCodes, ['unauthorized']);
  assert.deepEqual(summary.recentEventPairs, ['api_failure:unauthorized', 'display_failure:frame_not_answering']);
  assert.equal(summary.recentEventCount, 5);
  assert.deepEqual(summary.responseKeys, ['id', 'screenshotAccepted']);
  const text = JSON.stringify(summary);
  assert.ok(!text.includes('SECRET') && !text.includes('qa.user') && !text.includes('trace-1234'));
});

test('feedback with no diagnostics, or diagnostics without a correlation id or server code, says so', () => {
  const none = summarizeFeedbackRequest({ v: 1, description: 'x', diagnostics: null });
  assert.equal(none.diagnosticsAttached, false);
  assert.equal(none.hasCorrelationId, false);
  assert.equal(none.hasServerErrorCode, false);
  const bare = summarizeFeedbackRequest({ diagnostics: { os: 'Linux', recentEvents: [{ eventClass: 'boot_summary', site: 's', code: 'ok' }] } });
  assert.equal(bare.hasCorrelationId, false);
  assert.equal(bare.hasServerErrorCode, false, 'a boot summary is not a server error');
  assert.equal(summarizeFeedbackRequest({ diagnostics: { serverErrorReason: 'x' } }).hasServerErrorCode, true);
  assert.deepEqual(summarizeFeedbackRequest(null), summarizeFeedbackRequest({}));
});

test('visible billing text is collapsed, masked and capped', () => {
  assert.equal(normalizeVisibleText('  AI credits \n\n 1,200 of 1,500\tleft  '), 'AI credits 1,200 of 1,500 left');
  assert.equal(normalizeVisibleText('Billed to qa.user@ezil.work'), 'Billed to q***@ezil.work');
  assert.equal(normalizeVisibleText('x'.repeat(500)).length, 400);
  assert.equal(normalizeVisibleText(null), '');
});

// ── report shape, exit codes, deadlines ────────────────────────────────────

test('step records keep the {name, ok, ms, error?} contract and only carry an error when failed', () => {
  assert.deepEqual(stepRecord('open-code', true, 1234.6), { name: 'open-code', ok: true, ms: 1235 });
  assert.deepEqual(stepRecord('open-code', true, 5, { error: 'ignored' }), { name: 'open-code', ok: true, ms: 5 });
  assert.deepEqual(stepRecord('open-code', false, 7, { error: 'boom' }), { name: 'open-code', ok: false, ms: 7, error: 'boom' });
  assert.equal(stepRecord('x', 'yes', NaN).ok, false);
  assert.equal(stepRecord('x', true, -3).ms, 0);
  assert.equal(stepRecord('x', false, 1, { error: 'e'.repeat(900) }).error.length, 400);
});

test('a report passes only when every selected journey ran and passed', () => {
  const ran = name => ({ name, ok: true, ms: 1, steps: [], evidence: {} });
  const base = { startedAt: 't0', app: APP, account: 'q***@ezil.work', setup: [stepRecord('browser-launch', true, 1)] };
  const pass = makeReport({ ...base, selected: ['billing-view', 'free-open-apps'], journeys: [ran('free-open-apps'), ran('billing-view')] });
  assert.equal(pass.ok, true);
  assert.equal(exitCodeFor(pass), 0);
  assert.equal(pass.suite, 'prod-journeys');
  const missing = makeReport({ ...base, selected: ['billing-view', 'free-open-apps'], journeys: [ran('free-open-apps')] });
  assert.equal(missing.ok, false, 'a selected journey that never ran is a failure');
  assert.equal(exitCodeFor(missing), 1);
  const failed = makeReport({ ...base, selected: ['billing-view'], journeys: [{ ...ran('billing-view'), ok: false }] });
  assert.equal(exitCodeFor(failed), 1);
  assert.equal(makeReport({ ...base, selected: [], journeys: [] }).ok, false, 'nothing selected is not a pass');
  const badSetup = makeReport({ ...base, setup: [stepRecord('browser-launch', false, 1, { error: 'x' })], selected: ['billing-view'], journeys: [ran('billing-view')] });
  assert.equal(badSetup.ok, false);
  const config = makeReport({ startedAt: 't0', configError: 'Missing prod-journeys inputs: EZIL_E2E_APP' });
  assert.equal(config.ok, false);
  assert.equal(exitCodeFor(config), 2, 'could not run is never exit 0 or 1');
});

test('journey budgets follow the configured timeouts and the paid journey is the largest', () => {
  const config = { appTimeoutMs: 4 * 60_000, awsTimeoutMs: 15 * 60_000, awsWakeTimeoutMs: 10 * 60_000, stoppedTimeoutMs: 5 * 60_000 };
  const paid = journeyBudgetMs('paid-aws-computer', config);
  for (const name of JOURNEYS.filter(item => item !== 'paid-aws-computer')) assert.ok(journeyBudgetMs(name, config) < paid, name);
  assert.ok(paid >= config.awsTimeoutMs + config.awsWakeTimeoutMs + config.stoppedTimeoutMs + FINAL_STOP_TIMEOUT_MS);
  assert.equal(journeyBudgetMs('paid-aws-computer', { ...config, awsTimeoutMs: config.awsTimeoutMs + 60_000 }) - paid, 60_000);
  assert.ok(journeyBudgetMs('free-open-apps', { ...config, appTimeoutMs: config.appTimeoutMs * 2 }) > journeyBudgetMs('free-open-apps', config));
  assert.throws(() => journeyBudgetMs('nope', config), /Unknown journey/);
  assert.ok(journeyBudgetMs('billing-view', {}) > 0, 'defaults apply when a timeout is absent');
});

test('the hard deadline covers every step, the final-stop reserve and slack; the reserve exists only with the paid journey', () => {
  const config = parseEnv(baseEnv);
  const free = runDeadlines(['free-open-apps', 'billing-view'], config);
  assert.equal(free.finalStopMs, 0);
  assert.equal(free.hardMs, free.stepsMs + 30_000);
  assert.ok(free.stepsMs > journeyBudgetMs('free-open-apps', config) + journeyBudgetMs('billing-view', config));
  const paid = runDeadlines(['paid-aws-computer'], config);
  assert.equal(paid.finalStopMs, FINAL_STOP_TIMEOUT_MS);
  assert.equal(paid.hardMs, paid.stepsMs + FINAL_STOP_TIMEOUT_MS + 30_000);
  assert.ok(paid.hardMs > 15 * 60_000 + 10 * 60_000 + 5 * 60_000, 'a 15 minute boot, a 10 minute wake and a 5 minute stop fit');
  assert.ok(runDeadlines(['paid-aws-computer', 'free-open-apps'], config).stepsMs > paid.stepsMs);
});

test('waits are bounded by the nearest of their limit, their step and the run deadline', () => {
  const now = 1_000;
  assert.equal(remainingMs({ limit: 5_000, deadline: 100_000, stepDeadline: undefined, now }), 5_000);
  assert.equal(remainingMs({ limit: 5_000, deadline: 3_000, stepDeadline: undefined, now }), 2_000, 'the run deadline');
  assert.equal(remainingMs({ limit: 5_000, deadline: 100_000, stepDeadline: 1_500, now }), 500, 'the step deadline');
  assert.equal(remainingMs({ limit: 1.4, deadline: 100_000, now }), 1, 'never below one millisecond');
  assert.throws(() => remainingMs({ limit: 5_000, deadline: 1_000, now }), /Deadline exceeded/);
  assert.throws(() => remainingMs({ limit: 5_000, deadline: 100_000, stepDeadline: 999, now }), /Deadline exceeded/);
  assert.throws(() => remainingMs({ limit: 0, deadline: 100_000, now }), /Deadline exceeded/);
});

// ── the run, with a fake browser (offline) ─────────────────────────────────

/** Just enough of Playwright and the deployment helpers for a run that fails at sign-in. */
function fakeDependencies({ signInError, responses = [], visible = [] } = {}) {
  const handlers = { context: {}, page: {} };
  const calls = { launched: 0, closed: 0, signIn: 0 };
  const page = {
    on: (event, handler) => { handlers.page[event] = handler; },
    isClosed: () => false,
    url: () => 'about:blank',
    evaluate: async () => visible,
    locator: () => ({}),
    screenshot: async () => {},
  };
  const context = {
    on: (event, handler) => { handlers.context[event] = handler; },
    setDefaultTimeout() {},
    newPage: async () => page,
  };
  const chromium = {
    launch: async () => { calls.launched++; return { newContext: async () => context, close: async () => { calls.closed++; } }; },
  };
  const deployment = {
    deployedTarget: env => ({ app: new URL(env.EZIL_E2E_APP).origin, headers: {} }),
    configureAppContext: async () => {},
    appRequest: async () => { throw new Error('the fake run must not issue API calls'); },
  };
  const signIn = async () => {
    calls.signIn++;
    for (const response of responses) handlers.context.response?.(response);
    handlers.page.console?.({ type: () => 'error', text: () => `Failed to load ${APP}/api/shell/code-preview-url?computerId=abc&token=t0k3n 401 for qa.user@ezil.work` });
    handlers.page.pageerror?.(new Error(`Uncaught TypeError at Bearer ${JWT}`));
    throw signInError;
  };
  return { calls, load: async () => ({ deployment, signIn, chromium, stopIsolatedComputer: async () => {} }) };
}

function fakeResponse({ url, status, body, method = 'POST' }) {
  return {
    status: () => status, url: () => url, request: () => ({ method: () => method }),
    body: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('a run that cannot start reports exit code 2 and never loads a browser', async () => {
  const lines = [];
  let loaded = false;
  const report = await runProdJourneys({ env: { ...baseEnv, EZIL_E2E_PASSWORD: '' }, emit: line => lines.push(line),
    loadDependencies: async () => { loaded = true; throw new Error('must not load'); } });
  assert.equal(loaded, false);
  assert.equal(exitCodeFor(report), 2);
  assert.match(report.configError, /Missing prod-journeys inputs: EZIL_E2E_PASSWORD/);
  assert.equal(lines.at(-1).result, 'FAIL');
});

test('a failed browser launch fails the run, runs no journey, and still writes a redacted report', async () => {
  const out = mkdtempSync(join(tmpdir(), 'prod-journeys-test-'));
  try {
    const lines = [];
    const report = await runProdJourneys({ env: { ...baseEnv, EZIL_E2E_OUT: out, EZIL_E2E_JOURNEYS: 'billing-view,free-open-apps' },
      emit: line => lines.push(line),
      loadDependencies: async () => { throw new Error('playwright unresolvable for qa.user@ezil.work with correct-horse-battery'); } });
    assert.equal(exitCodeFor(report), 1);
    assert.equal(report.setup[0].name, 'browser-launch');
    assert.equal(report.setup[0].ok, false);
    assert.deepEqual(report.journeys, [], 'no journey ran, and the report says none passed');
    assert.equal(report.ok, false);
    const written = readFileSync(join(out, 'prod-journeys.json'), 'utf8');
    assert.equal(JSON.parse(written).setup[0].name, 'browser-launch');
    for (const secret of ['qa.user@ezil.work', 'correct-horse-battery', 'anon-key-value']) {
      assert.ok(!written.includes(secret) && !JSON.stringify(lines).includes(secret), `leaked ${secret}`);
    }
    assert.equal(lines[0].account, 'q***@ezil.work');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a failing step records the failing API codes, console errors, visible text and a screenshot, with nothing sensitive', async () => {
  const out = mkdtempSync(join(tmpdir(), 'prod-journeys-test-'));
  try {
    const fake = fakeDependencies({
      signInError: new Error(`Hosted sign-in was refused (HTTP 400) for qa.user@ezil.work using correct-horse-battery\nCall log:\n  cookie: ${JWT}`),
      responses: [
        fakeResponse({ url: `${APP}/api/shell/code-preview-url?computerId=aaaa&token=t0k3n`, status: 401,
          body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } }),
        fakeResponse({ url: `${APP}/api/shell/desktop?frameUrl=https%3A%2F%2Fx`, status: 200, body: { ok: false, error: 'computer_stopped' } }),
        fakeResponse({ url: `${APP}/api/trpc/billing.summary`, status: 200, body: { result: {} } }),
        fakeResponse({ url: 'https://other.example/api/shell/stop', status: 500, body: { error: { code: 'X' } } }),
        fakeResponse({ url: `${APP}/api/shell/stop`, status: 502, body: '<html>bad gateway</html>' }),
      ],
      visible: [{ source: 'code start failure', text: "Something went wrong — We couldn't start your computer." }],
    });
    const lines = [];
    const report = await runProdJourneys({ env: { ...baseEnv, EZIL_E2E_OUT: out, EZIL_E2E_JOURNEYS: 'billing-view,free-open-apps' },
      emit: line => lines.push(line), loadDependencies: fake.load });
    assert.equal(exitCodeFor(report), 1);
    assert.equal(fake.calls.closed, 1, 'the browser is closed');
    assert.equal(fake.calls.signIn, 1, 'sign-in is attempted once and its outcome shared');
    assert.deepEqual(report.journeys.map(journey => [journey.name, journey.ok]), [['free-open-apps', false], ['billing-view', false]]);
    const failed = report.journeys[0].steps[0];
    assert.equal(failed.name, 'sign-in');
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'Hosted sign-in was refused (HTTP 400) for q***@ezil.work using [redacted]');
    const byPath = [...failed.evidence.apiFailures].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(byPath, [
      { method: 'POST', path: '/api/shell/code-preview-url', status: 401, codes: ['UNAUTHORIZED'], count: 1 },
      { method: 'POST', path: '/api/shell/desktop', status: 200, codes: ['computer_stopped'], count: 1 },
      { method: 'POST', path: '/api/shell/stop', status: 502, codes: [], count: 1 },
    ], 'a foreign origin and a healthy 200 are not recorded; an unreadable 502 keeps its status');
    assert.deepEqual(failed.evidence.consoleErrors, ['Failed to load https://os-prod.ezil.work/api/shell/code-preview-url 401 for q***@ezil.work']);
    assert.equal(failed.evidence.pageErrors.length, 1);
    assert.deepEqual(failed.evidence.visibleError, [{ source: 'code start failure', text: "Something went wrong — We couldn't start your computer." }]);
    assert.equal(failed.evidence.screenshot, 'free-open-apps-sign-in.png');
    const text = readFileSync(join(out, 'prod-journeys.json'), 'utf8') + JSON.stringify(lines);
    for (const secret of ['qa.user@ezil.work', 'correct-horse-battery', 'anon-key-value', JWT, 't0k3n', 'aaaa', 'Sign in to continue', 'bad gateway']) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.deepEqual(readdirSync(out).filter(file => !file.endsWith('.png')), ['prod-journeys.json']);
    const summary = lines.at(-1);
    assert.equal(summary.result, 'FAIL');
    assert.deepEqual(summary.journeys.map(journey => journey.name), ['free-open-apps', 'billing-view']);
    assert.ok(lines.some(line => line.journey === 'free-open-apps' && line.step === 'sign-in' && line.ok === false));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

/**
 * Production user-journey suite. No Playwright or deployment imports at load
 * time, so the unit tests (`prod-journeys.test.mjs`) run offline.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Production, 2026-10-31: users clicked Code or Browser and got "Something went
 * wrong — We couldn't start your computer", and the in-app feedback only said
 * `unauthorized`. `live-check.mjs` answers "is this deployment healthy" with a
 * pass/fail and deliberately keeps no detail. This suite answers "what exactly
 * did a signed-in user see and which request refused them": on ANY failed step
 * it records the status and body error CODE of every failing `/api/*` response,
 * the console errors, the visible error text and a screenshot.
 *
 * Journeys (select with EZIL_E2E_JOURNEYS, comma list; default: all but paid and ezil-ai):
 *   free-open-apps        sign in, Code ready, terminal echo, Browser pixels
 *   ezil-ai               Code's EZiL AI status shows credits, one tiny chat reply (spends credits)
 *   paid-aws-computer     NEW computer on AWS: boot, stop, wake, stop (costs money)
 *   feedback-diagnostics  Settings → Feedback with diagnostics, what the report carries
 *   billing-view          Settings → Billing, read-only: plan, AI credits, compute
 *
 * Inputs come only from the environment (see e2e/README.md): EZIL_E2E_APP,
 * EZIL_E2E_EMAIL, EZIL_E2E_PASSWORD, PLAYWRIGHT_REQUIRE_DIR, and the sign-in:
 * EZIL_E2E_SIGNIN=supabase (default; e2e/sign-in.mjs, needs
 * NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY) or
 * EZIL_E2E_SIGNIN=ezilid (e2e/sign-in-ezilid.mjs: the real /login → EZiL ID UI).
 * Use a DEDICATED QA account. Evidence goes to EZIL_E2E_OUT (default:
 * <tmpdir>/ezil-prod-journeys).
 *
 * Exit 0 = every selected journey passed. 1 = a journey failed. 2 = could not
 * run (bad or missing inputs; never a pass).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openQuickInput } from './code-picker.mjs';
import { FINAL_STOP_TIMEOUT_MS, isMeaningfulFrame, parseTerminalMarker } from './live-check.mjs';

// ── Journeys, budgets, deadlines ────────────────────────────────────────────

export const SUITE_VERSION = 1;
export const JOURNEYS = Object.freeze(['free-open-apps', 'ezil-ai', 'paid-aws-computer', 'feedback-diagnostics', 'billing-view']);
/**
 * Never implicit: the paid journey creates an AWS computer that bills while it
 * runs, and `ezil-ai` spends AI credits and needs an account enrolled in EZiL
 * AI (one that signed in through EZiL ID, `EZIL_E2E_SIGNIN=ezilid`).
 */
export const DEFAULT_JOURNEYS = Object.freeze(JOURNEYS.filter(name => !['paid-aws-computer', 'ezil-ai'].includes(name)));
/** Every computer this suite creates carries this name prefix; it is how a re-run recognises its own. */
export const COMPUTER_NAME_PREFIX = '[QA automated] aws-journey';
export const FEEDBACK_PREFIX = '[QA automated]';
/** Mirrors MAX_COMPUTERS_PER_USER in app/src/server/api/routers/computer-store.ts. */
export const MAX_COMPUTERS_PER_USER = 2;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
export const SETUP_MS = 2 * MINUTE;
export const CLEANUP_SLACK_MS = 30 * SECOND;
const TERMINAL_MS = 2 * MINUTE;
const CLOSE_MS = 30 * SECOND;
const PRECHECK_MS = 2 * MINUTE;
const CREATE_MS = MINUTE;
const OS_READY_MS = MINUTE;
const SIGN_IN_MS = 90 * SECOND;
const AI_STATUS_MS = 2 * MINUTE;
/** How long the status item may stay on "Loading…" (or absent while the extension activates). */
const AI_STATUS_WAIT_MS = 90 * SECOND;
const CHAT_OPEN_MS = MINUTE;

export const DEFAULT_TIMEOUTS = Object.freeze({
  appTimeoutMs: 4 * MINUTE,
  awsTimeoutMs: 15 * MINUTE,
  awsWakeTimeoutMs: 10 * MINUTE,
  stoppedTimeoutMs: 5 * MINUTE,
  aiReplyTimeoutMs: 2 * MINUTE,
});

/** Which journeys run, in canonical order, deduplicated. Unknown names are an error, never ignored. */
export function selectJourneys(raw) {
  if (raw === undefined || String(raw).trim() === '') return [...DEFAULT_JOURNEYS];
  const names = String(raw).split(',').map(name => name.trim());
  const unknown = names.filter(name => !JOURNEYS.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown journey(s): ${unknown.map(name => (name || '(empty)').slice(0, 40)).join(', ')}; choose from ${JOURNEYS.join(', ')}`);
  }
  return JOURNEYS.filter(name => names.includes(name));
}

/** HTTPS origin only (HTTP on loopback for local runs): no credentials, path, query or fragment. */
export function parseAppOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('EZIL_E2E_APP must be a URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('EZIL_E2E_APP must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

function parseDurationEnv(env, name, fallback, { min = SECOND, max = 60 * MINUTE } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer number of milliseconds between ${min} and ${max}`);
  }
  return value;
}

/** Required with the default sign-in (`EZIL_E2E_SIGNIN=supabase`, e2e/sign-in.mjs). */
export const REQUIRED_ENV = Object.freeze([
  'EZIL_E2E_APP', 'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD',
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'PLAYWRIGHT_REQUIRE_DIR',
]);
/** `supabase`: password grant, no UI (sign-in.mjs). `ezilid`: the real /login → EZiL ID UI (sign-in-ezilid.mjs). */
export const SIGN_IN_MODES = Object.freeze(['supabase', 'ezilid']);
const SUPABASE_ENV = Object.freeze(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);

/** The variables a sign-in mode needs. EZiL ID signs in through the app's own UI: no Supabase inputs. */
export function requiredEnv(mode = 'supabase') {
  return mode === 'ezilid' ? REQUIRED_ENV.filter(name => !SUPABASE_ENV.includes(name)) : [...REQUIRED_ENV];
}

export function parseSignInMode(raw) {
  const mode = String(raw ?? '').trim().toLowerCase() || 'supabase';
  if (!SIGN_IN_MODES.includes(mode)) throw new Error(`EZIL_E2E_SIGNIN must be one of ${SIGN_IN_MODES.join(', ')}`);
  return mode;
}

/** Validate the environment. Errors name variables, never their values. */
export function parseEnv(env = process.env) {
  const signInMode = parseSignInMode(env.EZIL_E2E_SIGNIN);
  const missing = requiredEnv(signInMode).filter(name => String(env[name] ?? '').trim() === '');
  if (missing.length) throw new Error(`Missing prod-journeys inputs: ${missing.join(', ')}`);
  let supabaseUrl = null, anonKey = null;
  if (signInMode === 'supabase') {
    supabaseUrl = String(env.NEXT_PUBLIC_SUPABASE_URL);
    try {
      const url = new URL(supabaseUrl);
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('scheme');
    } catch { throw new Error('NEXT_PUBLIC_SUPABASE_URL must be an HTTPS URL'); }
    anonKey = String(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }
  const awsComputer = String(env.EZIL_E2E_AWS_COMPUTER ?? 'new').trim() || 'new';
  if (!['new', 'reuse'].includes(awsComputer)) throw new Error('EZIL_E2E_AWS_COMPUTER must be "new" or "reuse"');
  return {
    app: parseAppOrigin(env.EZIL_E2E_APP),
    email: String(env.EZIL_E2E_EMAIL).trim(),
    password: String(env.EZIL_E2E_PASSWORD),
    signInMode,
    supabaseUrl,
    anonKey,
    requireDir: resolve(String(env.PLAYWRIGHT_REQUIRE_DIR)),
    journeys: selectJourneys(env.EZIL_E2E_JOURNEYS),
    out: resolve(env.EZIL_E2E_OUT || join(tmpdir(), 'ezil-prod-journeys')),
    awsComputer,
    appTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_APP_TIMEOUT_MS', DEFAULT_TIMEOUTS.appTimeoutMs),
    awsTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AWS_TIMEOUT_MS', DEFAULT_TIMEOUTS.awsTimeoutMs),
    awsWakeTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AWS_WAKE_TIMEOUT_MS', DEFAULT_TIMEOUTS.awsWakeTimeoutMs),
    stoppedTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AWS_STOPPED_TIMEOUT_MS', DEFAULT_TIMEOUTS.stoppedTimeoutMs),
    aiReplyTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AI_REPLY_TIMEOUT_MS', DEFAULT_TIMEOUTS.aiReplyTimeoutMs, { min: 10 * SECOND, max: 10 * MINUTE }),
  };
}

/** The most time one journey may take, from its configured step timeouts. */
export function journeyBudgetMs(name, config) {
  const t = { ...DEFAULT_TIMEOUTS, ...config };
  switch (name) {
    case 'free-open-apps': return OS_READY_MS + 2 * (t.appTimeoutMs + 15 * SECOND) + TERMINAL_MS + CLOSE_MS;
    case 'ezil-ai': return SIGN_IN_MS + OS_READY_MS + (t.appTimeoutMs + 15 * SECOND) + AI_STATUS_MS
      + CHAT_OPEN_MS + t.aiReplyTimeoutMs + 30 * SECOND + CLOSE_MS;
    case 'paid-aws-computer': return OS_READY_MS + PRECHECK_MS + CREATE_MS + t.awsTimeoutMs + t.appTimeoutMs
      + FINAL_STOP_TIMEOUT_MS + t.stoppedTimeoutMs + t.awsWakeTimeoutMs + 3 * CLOSE_MS + 2 * MINUTE;
    case 'feedback-diagnostics': return OS_READY_MS + 2 * MINUTE;
    case 'billing-view': return OS_READY_MS + MINUTE;
    default: throw new Error(`Unknown journey: ${String(name).slice(0, 40)}`);
  }
}

/**
 * Deadlines for a run. `stepsMs` bounds every normal step; the final stop of a
 * created computer has its OWN reserve beyond it (a failed or late journey must
 * still stop what costs money), and `hardMs` is the process-level backstop.
 */
export function runDeadlines(names, config) {
  const stepsMs = SETUP_MS + names.reduce((sum, name) => sum + journeyBudgetMs(name, config), 0);
  const finalStopMs = names.includes('paid-aws-computer') ? FINAL_STOP_TIMEOUT_MS : 0;
  return { stepsMs, finalStopMs, hardMs: stepsMs + finalStopMs + CLEANUP_SLACK_MS };
}

/** Milliseconds a wait may still use; throws once any bound is spent. */
export function remainingMs({ limit = 10_000, deadline, stepDeadline, now }) {
  const ms = Math.min(limit, deadline - now, (stepDeadline ?? deadline) - now);
  if (!(ms > 0)) throw new Error('Deadline exceeded');
  return Math.max(1, Math.floor(ms));
}

// ── Redaction ───────────────────────────────────────────────────────────────

const EMAIL = /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTH_COOKIE = /(__Host-ezil-os-auth(?:\.\d+)?|sb-[a-z0-9]+-auth-token(?:\.\d+)?)=[^;\s"']+/g;
const SESSION_VALUE = /\bbase64-[A-Za-z0-9_-]{16,}/g;
const SECRET_PARAM = /\b(access_token|refresh_token|id_token|token|apikey|api_key|secret|password|signature|bypass)=[^&\s"'<>]+/gi;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;

/** `qa.user@ezil.work` → `q***@ezil.work`. Anything that is not an address says so. */
export function redactEmail(email) {
  const match = /^([^@\s])[^@\s]*@([^@\s]+)$/.exec(String(email ?? '').trim());
  return match ? `${match[1]}***@${match[2]}` : '[invalid-email]';
}

/**
 * Scrub text that may reach a log or the report: literal secrets, the auth
 * cookie and the session value inside it, JWTs, bearer tokens, token-looking
 * query parameters, URL queries (they carry computer ids and frame tokens) and
 * email addresses.
 */
export function redactText(value, { secrets = [] } = {}) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(AUTH_COOKIE, '$1=[redacted]')
    .replace(SESSION_VALUE, 'base64-[redacted]')
    .replace(JWT, '[jwt]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(URL_QUERY, '$1')
    .replace(SECRET_PARAM, '$1=[redacted]')
    .replace(EMAIL, (_all, first, domain) => `${first}***@${domain}`);
}

/** Redact every string in a JSON-like value; the source is not mutated. */
export function redactDeep(value, options) {
  if (typeof value === 'string') return redactText(value, options);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, options)]));
  }
  return value;
}

export function capText(value, max = 300) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Driver errors carry a "Call log" with request headers: keep the first line only. */
export function describeError(error, { secrets = [], max = 300 } = {}) {
  const first = String(error?.message ?? error ?? 'Unknown error').split('\n')[0];
  return capText(redactText(first, { secrets }), max);
}

// ── Failure evidence ────────────────────────────────────────────────────────

const CODE_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;
/** A snake-case reason such as `computer_limit_reached`; a sentence or an address never matches. */
const REASON_MESSAGE = /^[a-z][a-z0-9]*(?:[_:.-][a-z0-9]+)+$/;
/** Shell routes whose HTTP 200 answer can still be a refusal (`{ ok: false, ... }`). */
const OK_FALSE_ROUTES = new Set(['desktop', 'code-preview-url', 'preview-url', 'session', 'stop', 'switch',
  'relay-refresh', 'restart', 'capacity-retry', 'screen']);
/** Answers that mean "still waking": the shell re-asks them, so they are expected during a boot. */
const PENDING_CODES = new Set(['sandbox_starting', 'computer_starting', 'computer_stopping']);

export function safeCode(value) {
  return typeof value === 'string' && CODE_PATTERN.test(value) ? value : null;
}

/** The pathname of a same-origin `/api/` URL, else null. Never the query: it carries ids and tokens. */
export function apiPathOf(url, app) {
  try {
    const parsed = new URL(url);
    return parsed.origin === app && parsed.pathname.startsWith('/api/') ? parsed.pathname : null;
  } catch { return null; }
}

/** Is this response worth reading? Every refusal is; so are the shell routes that refuse with a 200. */
export function wantsBody(pathname, status) {
  if (status >= 400 || status === 207) return true;   // 207: a batched tRPC call that partly failed
  return pathname.startsWith('/api/shell/') && OK_FALSE_ROUTES.has(pathname.slice('/api/shell/'.length));
}

/**
 * Error codes in a response body, allowlisted. Shell routes answer
 * `{ error: { code, message } }` or `{ ok: false, error | errorCode | outcome }`;
 * tRPC answers `{ error: { json: { data: { code }, message } } }` (an array when
 * batched). Free text never survives: a `message` is kept only when it is itself
 * a snake-case reason (`computer_limit_reached`).
 */
export function errorCodesOf(body) {
  const codes = new Set();
  const take = value => { const code = safeCode(value); if (code) codes.add(code); };
  const takeMessage = value => { if (typeof value === 'string' && REASON_MESSAGE.test(value)) take(value); };
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const error = node.error;
    if (typeof error === 'string') take(error);
    else if (error && typeof error === 'object') {
      const inner = error.json && typeof error.json === 'object' ? error.json : error;
      take(error.code); take(inner.data?.code); take(inner.code);
      takeMessage(error.message); takeMessage(inner.message);
    }
    take(node.errorCode);
    if (node.ok === false) { take(node.outcome); take(node.reason); }
  };
  visit(body);
  return [...codes];
}

/** One failing `/api/*` response as `{ method, path, status, codes }`, or null when it did not fail. */
export function shapeApiFailure({ method, pathname, status, body }) {
  const codes = errorCodesOf(body);
  const refused = status >= 400 || body?.ok === false || (Array.isArray(body) && codes.length > 0);
  if (!refused) return null;
  const failure = { method: String(method ?? 'GET').toUpperCase(), path: pathname, status, codes };
  if (codes.length > 0 && codes.every(code => PENDING_CODES.has(code))) failure.pending = true;
  return failure;
}

/** Add to a deduplicated list; a repeat bumps `count` (a wake loop re-asks every 1.5 s). */
export function addApiFailure(list, failure, cap = 40) {
  const key = `${failure.method} ${failure.path} ${failure.status} ${failure.codes.join('|')}`;
  const seen = list.find(item => item.key === key);
  if (seen) { seen.count++; return list; }
  if (list.length < cap) list.push({ key, ...failure, count: 1 });
  return list;
}

/** Console errors and uncaught page errors: redacted, URL queries stripped, capped, deduplicated. */
export function shapeConsoleError(text, { secrets = [], max = 300 } = {}) {
  return capText(redactText(String(text ?? '').split('\n')[0], { secrets }), max);
}

export function addUnique(list, value, cap = 20) {
  if (value && !list.includes(value) && list.length < cap) list.push(value);
  return list;
}

/** Visible error text found in the shell (windows, alerts, dialogs), redacted and deduplicated. */
export function shapeVisibleErrors(found, { secrets = [], cap = 6 } = {}) {
  const shaped = [];
  for (const item of Array.isArray(found) ? found : []) {
    if (typeof item?.text !== 'string' || !item.text.trim()) continue;
    const entry = { source: capText(redactText(item.source ?? 'shell', { secrets }), 60), text: capText(redactText(item.text, { secrets }), 240) };
    if (!shaped.some(other => other.text === entry.text)) shaped.push(entry);
  }
  return shaped.slice(0, cap);
}

/**
 * Judge one window's DOM snapshot (`readWindowSnapshot`). A start failure is the
 * opening surface in its failed state, Code's "isn't reachable" panel, or an
 * alert that reads like one. The Browser's "couldn't check your display"
 * strip is NOT a failure here: real pixels decide that.
 */
const FAILURE_ALERT = /something went wrong|couldn.?t start|unauthori[sz]ed|isn.?t answering|isn.?t coming through|taking too long|not (?:available|reachable)|failed/i;
export function classifyStartFailure(snapshot) {
  if (!snapshot?.open) return null;
  if (snapshot.failed) return { kind: 'start_failed', title: snapshot.failed.title ?? '', body: snapshot.failed.body ?? '' };
  if (snapshot.unavailable) return { kind: 'code_unreachable', title: snapshot.unavailable.title ?? '', body: '' };
  const alert = (snapshot.alerts ?? []).find(text => FAILURE_ALERT.test(text));
  return alert ? { kind: 'alert', title: alert, body: '' } : null;
}

export function describeStartFailure(app, failure) {
  const copy = [failure.title, failure.body].filter(Boolean).join(' — ');
  return `${APP_LABEL[app] ?? app} did not start (${failure.kind}): ${copy || 'no text shown'}`;
}

export const APP_LABEL = Object.freeze({ code: 'Code', desktop: 'Browser', settings: 'Settings' });

// ── "Ready" is what the user sees ───────────────────────────────────────────

/**
 * An app is ready when its content is there (Browser: real pixels, Code: the
 * editor) AND no opening overlay covers it. The viewer starts streaming behind
 * the opening surface well before the shell retires it (`desktop-window.js`
 * hides `.ezil-app-spinner` and `.ezil-boot` at reveal), so pixels alone are a
 * desktop the user cannot yet see.
 */
export function userReadiness({ snapshot, contentReady }) {
  if (!snapshot?.open) return { ready: false, state: 'window_closed' };
  if (snapshot.windowVisible === false) return { ready: false, state: 'window_hidden' };
  const overlay = snapshot.overlay ?? null;
  if (contentReady === true && overlay === null) return { ready: true, state: 'ready' };
  if (contentReady === true) return { ready: false, state: 'overlay_covering_content', overlay };
  return { ready: false, state: overlay ? 'opening' : 'content_not_ready', overlay };
}

/** How long a ready state must hold before it counts: a tick that writes the spinner back is not "ready". */
export const READY_SETTLE_MS = 700;

export function newReadinessTracker() {
  return { firstContentMs: null, overlaySeenMs: null, overlayGoneMs: null, readySinceMs: null };
}

/**
 * Fold one observation (`elapsedMs` since the click) into the tracker.
 * `firstContentMs`: first time pixels or the editor existed, overlay or not.
 * `overlayGoneMs`: when the opening overlay last went away after being seen
 * (null if it was never seen). `readySinceMs`: start of the current unbroken
 * stretch of user-ready observations.
 */
export function trackReadiness(tracker, { elapsedMs, contentReady, overlayVisible, windowOpen = true }) {
  const next = { ...tracker };
  if (contentReady === true && next.firstContentMs === null) next.firstContentMs = elapsedMs;
  if (overlayVisible) { next.overlaySeenMs ??= elapsedMs; next.overlayGoneMs = null; }
  else if (windowOpen && next.overlaySeenMs !== null && next.overlayGoneMs === null) next.overlayGoneMs = elapsedMs;
  const ready = windowOpen && contentReady === true && !overlayVisible;
  next.readySinceMs = ready ? (next.readySinceMs ?? elapsedMs) : null;
  return next;
}

export function readinessSettled(tracker, elapsedMs, settleMs = READY_SETTLE_MS) {
  return tracker.readySinceMs !== null && elapsedMs - tracker.readySinceMs >= settleMs;
}

/**
 * Rounded timings for the report. `contentKey` names the first-content figure
 * (`firstPixelsMs` for Browser, `firstEditorMs` for Code); `readyMs` is when the
 * user could first see the app.
 */
export function readinessTimings(tracker, contentKey = 'firstContentMs') {
  const round = value => (value === null ? null : Math.round(value));
  return { [contentKey]: round(tracker.firstContentMs), overlaySeenMs: round(tracker.overlaySeenMs),
    overlayGoneMs: round(tracker.overlayGoneMs), readyMs: round(tracker.readySinceMs) };
}

/** Why an app is not ready yet, for the timeout message: names the overlay still on screen. */
export function describeReadinessWait(verdict, contentLabel, detail = '') {
  const overlay = verdict.overlay ? `opening overlay visible${verdict.overlay.text ? ` ("${verdict.overlay.text}")` : ''}` : 'no overlay';
  const more = detail ? ` [${detail}]` : '';
  switch (verdict.state) {
    case 'overlay_covering_content': return `${contentLabel} present but ${overlay}`;
    case 'opening': case 'content_not_ready': return `${contentLabel} not yet${more}; ${overlay}`;
    case 'window_hidden': return 'window is not visible';
    default: return 'window not open';
  }
}

// ── Reaching the dock ───────────────────────────────────────────────────────

/**
 * What to do about a dock icon, from `readDockProbe`. A full-bleed Browser
 * (`go_fullbleed`, desktop-window.js) hides the taskbar and its window head
 * (`enter_fullpage_mode`, UIDesktopFullpage.js), so the icon exists but
 * nothing can click it. The one way back is the window's own control drawer:
 * its Minimise button restores the taskbar first (`minimise_to_taskbar`).
 */
export function decideDockAction(probe) {
  const apps = (probe?.apps ?? []).join(', ') || 'nothing';
  if (!probe?.present) return { action: 'missing', reason: `the dock has: ${apps}` };
  if (probe.actionable) return { action: 'click' };
  // A full-bleed window is minimised through its drawer's Minimise button, or, when that is absent,
  // through the window's own minimise hook (the function the button calls).
  const target = (probe.fullbleed ?? []).find(item => item?.drawer === true || item?.hook === true);
  if (target) {
    return { action: 'minimise', app: target.app, drawer: target.drawer === true,
      reason: 'the dock is hidden behind a full-bleed window' };
  }
  const why = probe.fullbleed?.length ? 'a full-bleed window has no Minimise control'
    : probe.taskbar === 'shown' ? 'the icon is covered' : `the taskbar is ${probe.taskbar ?? 'unknown'} and no full-bleed window can be minimised`;
  return { action: 'wait', reason: why };
}

// ── Evidence helpers for the individual journeys ────────────────────────────

/** Reject blank frames, a lone cursor, uniform backgrounds. `reason` says which, so a failure is diagnosable. */
export function framePixelVerdict(pixels, width = 64, height = 36) {
  if (!pixels || pixels.length !== width * height * 4) return { ok: false, reason: 'no_pixels' };
  let visible = 0, min = 255, max = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    if (luma > 24) visible++;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
  }
  const visibleRatio = visible / (width * height), spread = max - min;
  const stats = { visibleRatio: Number(visibleRatio.toFixed(3)), spread: Math.round(spread) };
  if (isMeaningfulFrame(pixels, width, height)) return { ok: true, reason: 'ok', ...stats };
  const reason = max <= 24 ? 'black' : spread < 40 ? 'uniform' : visibleRatio < 0.02 ? 'few_visible_pixels' : 'blank';
  return { ok: false, reason, ...stats };
}

/**
 * Typed into the Code terminal. The marker is assembled by printf from two
 * arguments, so the echoed command line can never contain `N<nonce>[ok]`.
 */
export function echoProbeCommand(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{20}$/.test(nonce)) throw new Error('Invalid probe nonce');
  return `printf '%s[%s]\\n' N${nonce} ok`;
}

/** A paid plan (v3 `plan.sku`, v2 `plan.family`). Free, disabled or unreadable is not paid. */
export function isPaidPlan(summary) {
  if (!summary || summary.enabled === false) return false;
  const family = summary.plan?.family;
  if (typeof family === 'string') return family !== 'free';
  const sku = summary.plan?.sku;
  return typeof sku === 'string' && !/^free/.test(sku);
}

/** The AWS facts of a `computer.progress` read: a placement lifecycle or an instance type means EC2. */
export function awsFacts(progress) {
  const lifecycleState = typeof progress?.lifecycleState === 'string' ? progress.lifecycleState : null;
  const type = progress?.hardware?.instanceType;
  const instanceType = typeof type === 'string' && /^[a-z0-9-]+\.[a-z0-9]+$/.test(type) ? type : null;
  return {
    aws: lifecycleState !== null || instanceType !== null,
    lifecycleState, instanceType,
    stage: safeCode(progress?.stage), operation: safeCode(progress?.operation),
    needsOperator: progress?.needsOperator === true, paused: progress?.paused === true,
  };
}

/** The suite's own computers, recognised by name prefix in a `computer.list` answer. */
export function pickSuiteComputers(list) {
  return (Array.isArray(list) ? list : []).filter(row =>
    typeof row?.id === 'string' && typeof row.name === 'string' && row.name.startsWith(COMPUTER_NAME_PREFIX));
}

/** No stop, wake or window may touch a computer this run did not create or recognise as its own. */
export function assertSuiteComputer(id, owned) {
  if (typeof id !== 'string' || !owned?.has?.(id)) throw new Error('Refusing to operate on a computer this suite did not create');
  return id;
}

/** What a refused `computer.create` means for this journey, in words an operator can act on. */
export function describeCreateRefusal(result) {
  const reason = result?.reason ?? result?.code ?? 'unknown';
  if (reason === 'computer_limit_reached') {
    return `computer_limit_reached: the account already has ${MAX_COMPUTERS_PER_USER} computers. Delete an old one (Settings → Computer → Older computer) or set EZIL_E2E_AWS_COMPUTER=reuse to reuse this suite's computer`;
  }
  return `computer.create refused (HTTP ${result?.status ?? 0} ${reason})`;
}

export function describeStopFailure(error) {
  const stop = error?.stop;
  if (!stop) return describeError(error);
  return `Stop was not confirmed (HTTP ${stop.status} ok=${stop.ok}${stop.outcome ? ` outcome=${stop.outcome}` : ''}${stop.error ? ` error=${stop.error}` : ''})`;
}

/**
 * What a feedback request carried, by NAME only (never the description): the
 * top-level keys, the diagnostics keys, and whether a correlation id (`traceId`)
 * and server error codes (`api_failure` events) travelled with it.
 */
export function summarizeFeedbackRequest(payload, response = null) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const diagnostics = body.diagnostics && typeof body.diagnostics === 'object' ? body.diagnostics : null;
  const events = Array.isArray(diagnostics?.recentEvents) ? diagnostics.recentEvents : [];
  const pairs = [];
  const failureCodes = [];
  for (const event of events) {
    const eventClass = safeCode(event?.eventClass), code = safeCode(event?.code);
    if (!eventClass || !code) continue;
    addUnique(pairs, `${eventClass}:${code}`, 25);
    if (eventClass === 'api_failure') addUnique(failureCodes, code, 25);
  }
  const keys = Object.keys(diagnostics ?? {}).sort();
  const hasReasonField = keys.some(key => /reason|errorcode|error_code|servererror/i.test(key));
  return {
    requestKeys: Object.keys(body).sort(),
    diagnosticsAttached: diagnostics !== null,
    diagnosticsKeys: keys,
    hasCorrelationId: typeof diagnostics?.traceId === 'string' && diagnostics.traceId.length > 0,
    hasServerErrorCode: failureCodes.length > 0 || hasReasonField,
    apiFailureCodes: failureCodes,
    recentEventCount: events.length,
    recentEventPairs: pairs,
    computerIdIncluded: typeof body.computerId === 'string',
    responseKeys: response && typeof response === 'object' ? Object.keys(response).sort() : [],
  };
}

/** Visible text, whitespace collapsed, addresses masked, capped. */
export function normalizeVisibleText(text, { max = 400, secrets = [] } = {}) {
  return capText(redactText(String(text ?? '').replace(/\s+/g, ' ').trim(), { secrets }), max);
}

// ── EZiL AI in Code (the `ezil-ai` journey) ────────────────────────────────
//
// The ezil-models extension runs in Code's extension host ON THE COMPUTER, so
// its Gateway requests never pass through this browser: the only evidence is
// the copy Code renders. These helpers map that copy back to the codes behind
// it (extensions/ezil-models/src/status-data.ts `statusView`/`statusProblem`,
// gateway.ts `describeGatewayError`). In particular `os_ai_unavailable` (the
// OS proxy could not reach EZiL AI) has no status label of its own: the item
// reads "Credits unavailable", and a chat reply reads "EZiL OS could not reach
// EZiL AI". An "is the code absent" check would pass while AI is down; the
// journey instead requires a credit balance and a real reply.

/** The default chat model's display name: `"default": true` in worker/ezil-models/models.json. */
export const DEFAULT_AI_MODEL_NAME = 'Qwen3 Coder Next';
/** One tiny prompt. The reply is recorded by length and its first 40 characters only. */
export const AI_PROMPT = 'Reply with the single word: pong';
export const AI_REPLY_PREVIEW_CHARS = 40;
/** The status item: `createStatusBarItem('ezil-models.aiStatus', …)`, prefixed with the extension id by the workbench. */
export const AI_STATUS_ITEM = '.statusbar-item[id$="ezil-models.aiStatus" i]';

/** Status-bar attention labels (status-data.ts `statusProblem` and `statusView`) → the codes behind them. */
const AI_STATUS_LABELS = Object.freeze([
  [/^Session expired$/, 'session_expired'],
  [/^Not configured$/, 'not_configured'],
  [/^Sign-in needed$/, 'sign_in_needed'],          // os_session_missing, unauthorized, http_401
  [/^AI access needed$/, 'no_ai_access'],          // no_ezil_role, not_a_member, no_entitlement, http_403
  [/^Reconnect needed$/, 'os_proxy_unauthorized'],
  [/^AI access suspended$/, 'suspended'],
  [/^No credits available$/, 'insufficient_credits'],
  [/^Window credits used$/, 'window_budget_reached'],
  [/^Paused\b/, 'paused'],
  [/^Daily credit budget used$/, 'daily_budget_reached'],
  [/^Monthly credit budget used$/, 'monthly_budget_reached'],
  [/^Credits held$/, 'credits_held'],
]);

/**
 * The status item's text (`EZiL AI · 12.5 credits`, `EZiL AI · 3 credits left · resets 14:00`,
 * `EZiL AI · Loading…`, `EZiL AI · Credits unavailable · …`, `EZiL AI · Sign-in needed`) as
 * `{ state: 'credits' | 'loading' | 'unavailable' | 'attention' | 'missing' | 'unknown', … }`.
 */
export function classifyAIStatus(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { state: 'missing' };
  const match = /^EZiL AI\s*·\s*(.+)$/.exec(value);
  if (!match) return { state: 'unknown' };
  const rest = match[1];
  if (/^Loading\b/.test(rest)) return { state: 'loading' };
  // Every status read failed without an attention code: os_ai_unavailable, a timeout or a network error.
  if (/^Credits unavailable\b/.test(rest)) return { state: 'unavailable', code: 'credits_unavailable' };
  const credits = /^([\d,]+(?:\.\d+)?) credits( left)?(?= ·|$)/.exec(rest);
  if (credits) {
    const partial = ['limits unavailable', 'availability unknown', 'usage unavailable'].filter(part => rest.includes(part));
    return { state: 'credits', credits: credits[1], window: Boolean(credits[2]),
      zero: Number(credits[1].replace(/,/g, '')) === 0 || /· window used\b/.test(rest), ...(partial.length ? { partial } : {}) };
  }
  const label = rest.split(' · ')[0];
  const known = AI_STATUS_LABELS.find(([pattern]) => pattern.test(label));
  return { state: 'attention', label: capText(label, 60), code: known ? known[1] : 'unknown' };
}

/**
 * What the status quick pick (or, when it cannot be read, the item's aria-label, which joins
 * the same lines with ". ") says, by fact: the available balance, whether the credit read
 * failed, the entitlement and pause lines, and the recent-usage COUNT (never the rows).
 */
export function summarizeAIQuickPick(rows) {
  const lines = (Array.isArray(rows) ? rows : []).map(row => String(row ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const find = pattern => lines.find(line => pattern.test(line)) ?? null;
  const available = /^Available credits: ([\d,]+(?:\.\d+)?)/.exec(find(/^Available credits:/) ?? '');
  const header = lines.findIndex(line => /^Recent usage\b/.test(line));
  const usage = find(/^Usage unavailable\b/) ? 'unavailable' : find(/^No recent usage\b/) ? 'none'
    : header >= 0 ? `rows:${lines.slice(header + 1).filter(line => / · /.test(line)).length}` : null;
  return {
    rows: lines.length,
    availableCredits: available ? available[1] : null,
    creditsUnavailable: Boolean(find(/^Credits unavailable\b/)),
    entitlement: capText(find(/^Entitlement:/) ?? '', 80) || null,
    globalPause: capText(find(/^Global AI (?:pause|availability)\b/) ?? '', 80) || null,
    usage,
  };
}

/** Pass only with a non-zero balance on the item and, when the lines were read, an "Available credits" line. */
export function aiStatusVerdict(status, summary = null) {
  switch (status?.state) {
    case 'credits':
      if (status.zero) return { ok: false, reason: `EZiL AI shows ${status.credits} credits${status.window ? ' left in this window' : ''}: the free AI grant has not landed, or it is used up` };
      if (summary?.rows > 0 && summary.availableCredits === null) {
        return { ok: false, reason: `EZiL AI status lists no "Available credits" line${summary.creditsUnavailable ? ' ("Credits unavailable")' : ''}` };
      }
      return { ok: true };
    case 'loading': return { ok: false, reason: 'EZiL AI status never left "Loading…"' };
    case 'missing': return { ok: false, reason: 'Code shows no "EZiL AI" status-bar item (the ezil-models extension is not active)' };
    case 'unavailable': return { ok: false, reason: 'EZiL AI shows no credit balance ("Credits unavailable"): its Gateway reads failed (os_ai_unavailable, a timeout or a network error; the item does not say which)' };
    case 'attention': return { ok: false, reason: `EZiL AI needs attention: "${status.label}" (${status.code})` };
    default: return { ok: false, reason: 'EZiL AI status-bar text is not recognised' };
  }
}

/** Chat error copy (`EZiL AI: …`, gateway.ts `describeGatewayError`) → the code behind it. First match wins. */
const CHAT_ERRORS = Object.freeze([
  [/could not reach EZiL AI/i, 'os_ai_unavailable'],
  [/not available here yet/i, 'os_session_missing'],
  [/sign-in has expired/i, 'session_expired'],
  [/refused this computer.s AI connection/i, 'os_proxy_unauthorized'],
  [/no AI access|does not have AI (?:access|membership)/i, 'no_ai_access'],
  [/AI access is suspended/i, 'suspended'],
  [/Not enough AI credits|No AI credits|needs up to [\d.,]+ credits/i, 'insufficient_credits'],
  [/credits are used up/i, 'window_budget_reached'],
  [/\bAI is (?:temporarily )?paused\b/i, 'paused'],
  [/model is temporarily unavailable/i, 'model_unavailable'],
  [/did not answer in time/i, 'upstream_timeout'],
  [/Too many requests/i, 'rate_limited'],
  [/Wait for the current response/i, 'concurrency_limit'],
  [/Conversation too large/i, 'input_too_large'],
  [/refused (?:this account.s sign-in|authentication)|could not verify this account|does not accept this account/i, 'unauthorized'],
]);

/** A chat response's text as `{ state: 'reply' | 'error' | 'empty', code? }`. */
export function classifyChatReply(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return { state: 'empty' };
  const gateway = /\bEZiL AI:/.test(value);
  if (!gateway && !/Sorry, (?:your request failed|no response was returned)|\brequest failed\b|an error occurred/i.test(value)) {
    return { state: 'reply' };
  }
  const known = CHAT_ERRORS.find(([pattern]) => pattern.test(value));
  const coded = /AI request failed \(([a-z0-9_]{1,64})\)/.exec(value)?.[1] ?? /\(([a-z0-9_]{1,64})\); please report/.exec(value)?.[1];
  return { state: 'error', code: known ? known[1] : coded ?? (gateway ? 'gateway_error' : 'chat_failed') };
}

/** A response that is still a placeholder ("Working…", "Thinking"), not a reply. */
export function isPlaceholderReply(text) {
  return /^(?:thinking|working|loading|getting ready|preparing)[.…\s]*$/i.test(String(text ?? '').trim());
}

/** The model the chat input shows: the default by name, else anything that reads like a model. */
export function pickModelLabel(labels, expected = DEFAULT_AI_MODEL_NAME) {
  const list = (Array.isArray(labels) ? labels : []).map(label => String(label ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return list.find(label => label.includes(expected))
    ?? list.find(label => /qwen|kimi|coder|gpt|claude|gemini|llama|mistral|deepseek|nova|^auto$/i.test(label)) ?? null;
}

/** What the report keeps of a reply: its length and its first 40 characters, redacted. */
export function replyEvidence(text, { secrets = [] } = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return { replyLength: value.length, replyPreview: capText(redactText(value.slice(0, AI_REPLY_PREVIEW_CHARS), { secrets }), AI_REPLY_PREVIEW_CHARS),
    saysPong: /\bpong\b/i.test(value) };
}

// ── Report ──────────────────────────────────────────────────────────────────

export function stepRecord(name, ok, ms, { error, evidence, note } = {}) {
  const record = { name, ok: ok === true, ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0 };
  if (!record.ok && error) record.error = capText(error, 400);
  if (note) record.note = note;
  if (evidence) record.evidence = evidence;
  return record;
}

/** The JSON evidence report. A selected journey that never ran is a failure, never a silent pass. */
export function makeReport({ startedAt, finishedAt = null, app = null, account = null, selected = [], setup = [], journeys = [], configError = null }) {
  const ran = new Map(journeys.map(journey => [journey.name, journey]));
  const complete = selected.length > 0 && selected.every(name => ran.get(name)?.ok === true);
  return {
    suite: 'prod-journeys', schema: SUITE_VERSION, startedAt, finishedAt, app, account, selected, setup, journeys,
    ...(configError ? { configError } : {}),
    ok: !configError && setup.every(step => step.ok) && complete,
  };
}

export function exitCodeFor(report) {
  return report.configError ? 2 : report.ok ? 0 : 1;
}

// ── Code that runs inside the browser (serialised by Playwright: self-contained) ──

/** The state of one app window: failure panel, spinner, "isn't reachable" panel, alerts. */
export function readWindowSnapshot(app) {
  const win = document.querySelector(`.window[data-app="${app}"]:not([data-closing="1"])`);
  if (!win) return { open: false };
  const shown = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const text = (root, selector) => (root?.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  let failed = null;
  for (const panel of win.querySelectorAll('.ezil-app-spinner, .ezil-boot')) {
    if (panel.getAttribute('data-kind') === 'failed' && shown(panel)) {
      failed = { title: text(panel, '.ezil-opening-status, .ezil-boot-title'), body: text(panel, '.ezil-opening-sub, .ezil-boot-sub') };
      break;
    }
  }
  const unavailable = win.querySelector('.ezil-code-unavailable');
  const notice = win.querySelector('.ezil-display-notice');
  const src = win.querySelector('iframe.window-app-iframe')?.getAttribute('src') ?? '';
  // An opening overlay the user can see, judged by computed style (a `hidden`
  // attribute that CSS overrides still paints): not display:none or
  // visibility:hidden, not faded to nothing (it or any ancestor), real area.
  const covers = el => {
    for (let node = el; node && node !== document; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || Number(style.opacity) < 0.05 || (node === el && style.visibility !== 'visible')) return false;
    }
    const box = el.getBoundingClientRect();
    return box.width >= 8 && box.height >= 8;
  };
  const cover = [...win.querySelectorAll('.ezil-app-spinner, .ezil-boot, .ezil-code-unavailable, .ezil-preview-unavailable')].find(covers);
  const windowBox = win.getBoundingClientRect();
  return {
    open: true,
    computerId: win.getAttribute('data-ezil-computer-id'),
    windowVisible: getComputedStyle(win).display !== 'none' && windowBox.width > 0 && windowBox.height > 0,
    failed,
    unavailable: shown(unavailable) ? { title: text(unavailable, 'div') } : null,
    notice: shown(notice) ? { title: text(notice, '.ezil-display-notice-title'), body: text(notice, '.ezil-display-notice-body') } : null,
    overlay: cover ? { kind: cover.className.split(/\s+/)[0], dataKind: cover.getAttribute('data-kind'),
      text: text(cover, '.ezil-opening-status, .ezil-boot-title, div') } : null,
    frame: !src || src === 'about:blank' ? 'blank' : 'navigated',
    alerts: [...document.querySelectorAll('.window-alert .window-alert-message')]
      .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)).slice(0, 3),
  };
}

/** Every error the user can currently read, wherever the shell renders one. */
export function readVisibleErrors() {
  const shown = el => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const found = [];
  for (const panel of document.querySelectorAll('.window[data-app] [data-kind="failed"]')) {
    if (!shown(panel)) continue;
    const app = panel.closest('.window')?.getAttribute('data-app') ?? 'window';
    const title = panel.querySelector('.ezil-opening-status, .ezil-boot-title')?.textContent;
    const body = panel.querySelector('.ezil-opening-sub, .ezil-boot-sub')?.textContent;
    found.push({ source: `${app} start failure`, text: clean(`${title ?? ''} — ${body ?? ''}`) });
  }
  const others = [
    ['code unreachable', '.ezil-code-unavailable'], ['display notice', '.ezil-display-notice'],
    ['alert', '.window-alert .window-alert-message'], ['feedback', '.ezil-feedback-result'],
    ['settings error', '.ezil-settings-error'], ['computer notice', '[data-role="computer-notice"]'],
    ['billing error', '[data-role="billing-action-error"]'],
  ];
  for (const [source, selector] of others) {
    for (const el of document.querySelectorAll(selector)) if (shown(el) && clean(el.textContent)) found.push({ source, text: clean(el.textContent) });
  }
  return found.slice(0, 12);
}

/**
 * Draw the streamed desktop into a small canvas and read it. A `<video>` is the
 * viewer: while one exists only it counts (it may not have a frame yet). A
 * visible canvas is the fallback for a viewer that has no video element.
 */
export function sampleFramePixels({ width, height, allowCanvas }) {
  const videos = [...document.querySelectorAll('video')];
  let source = videos.find(el => el.videoWidth > 0 && el.readyState >= 2) ?? null;
  let kind = source ? 'video' : null;
  if (!source && videos.length === 0 && allowCanvas) {
    source = [...document.querySelectorAll('canvas')]
      .filter(el => el.width > 16 && el.height > 16 && el.getClientRects().length > 0)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
    kind = source ? 'canvas' : null;
  }
  if (!source) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return { kind, pixels: Array.from(ctx.getImageData(0, 0, width, height).data) };
}

/**
 * Can the user click this dock icon right now? Present, painted, and the
 * topmost element at its centre. Also names the full-bleed windows and whether
 * each has a Minimise control, which is what `decideDockAction` needs.
 */
export function readDockProbe(app) {
  const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const items = [...document.querySelectorAll('.taskbar-item')];
  const item = items.find(el => el.dataset.app === app) ?? null;
  const taskbar = document.querySelector('.taskbar');
  let actionable = false;
  if (item && shown(item)) {
    const box = item.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    actionable = !!hit && (hit === item || item.contains(hit));
  }
  const fullbleed = [...document.querySelectorAll('.window.ezil-fullbleed:not([data-closing="1"])')]
    .filter(win => shown(win) && !['1', 'true'].includes(win.getAttribute('data-is_minimized')))
    .map(win => ({ app: win.getAttribute('data-app'),
      drawer: !!win.querySelector('.ezil-app-drawer button[aria-label="Minimise"]'),
      hook: typeof win._ezil_minimise === 'function' }));
  return { present: !!item, actionable, taskbar: !taskbar ? 'absent' : shown(taskbar) ? 'shown' : 'hidden',
    fullbleed, apps: items.map(el => el.dataset.app ?? '') };
}

/**
 * In Code's frame: the EZiL AI status item (`AI_STATUS_ITEM`). `text` is what the status bar
 * shows; `aria` is its accessibility label, the full status lines joined with ". ".
 */
export function readAIStatusItem() {
  const item = document.querySelector('.statusbar-item[id$="ezil-models.aiStatus" i]');
  if (!item) return { present: false, text: '', aria: '' };
  const label = item.querySelector('a, [role="button"]') ?? item;
  return { present: true, text: (label.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    aria: String(label.getAttribute('aria-label') ?? item.getAttribute('aria-label') ?? '').slice(0, 4000) };
}

/** In Code's frame: the visible quick pick, its title and its rows in list order. */
export function readQuickPick() {
  const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const widget = [...document.querySelectorAll('.quick-input-widget')].find(shown);
  if (!widget) return { open: false, title: '', rows: [] };
  const rows = [...widget.querySelectorAll('.quick-input-list .monaco-list-row')]
    .sort((a, b) => Number(a.getAttribute('data-index') ?? 0) - Number(b.getAttribute('data-index') ?? 0))
    .map(row => String(row.getAttribute('aria-label') || row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean);
  return { open: true, title: (widget.querySelector('.quick-input-title')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    rows: rows.slice(0, 60) };
}

/**
 * In Code's frame: the Chat view as the user sees it. The input (`.chat-input-container`
 * with its Monaco editor), whether a request is in flight (a Stop/Cancel control in the
 * input), every response (`.interactive-item-container.interactive-response`: its `.value`
 * text, error widgets, and whether it is still loading), the input toolbar's labels (the
 * model picker is one of them) and any notification toasts.
 */
export function readChatState() {
  const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const clean = el => String(el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const input = [...document.querySelectorAll('.chat-input-container')].find(shown) ?? null;
  const session = input?.closest('.interactive-session') ?? document.querySelector('.interactive-session');
  // Error widgets: `.chat-notification-widget` holding a `.chat-error-codicon` (ChatErrorWidget), or
  // older `.chat-error` markup. Warnings and info notices are kept apart: they do not fail a reply.
  const isError = el => el.matches('.chat-error, [class*="chat-error-content"]') || !!el.querySelector('.chat-error-codicon');
  const responses = session ? [...session.querySelectorAll('.interactive-item-container.interactive-response')].map(item => {
    const widgets = [...item.querySelectorAll('.chat-notification-widget, .chat-error, .chat-warning, [class*="chat-error-content"]')].filter(shown);
    const texts = list => [...new Set(list.map(clean).filter(Boolean))].join(' ').slice(0, 400);
    const row = item.closest('.monaco-list-row') ?? item;
    return {
      text: clean(item.querySelector('.value') ?? item).slice(0, 2000),
      error: texts(widgets.filter(isError)),
      warning: texts(widgets.filter(el => !isError(el))),
      loading: item.classList.contains('chat-response-loading') || row.classList.contains('chat-response-loading')
        || [...item.querySelectorAll('.codicon-loading')].some(shown),
    };
  }) : [];
  const busy = !!input && [...input.querySelectorAll('[aria-label*="Cancel" i], [aria-label*="Stop" i], .codicon-stop-circle, .codicon-debug-stop')].some(shown);
  return {
    inputVisible: !!input,
    inputText: clean(input?.querySelector('.monaco-editor .view-lines')).slice(0, 200),
    busy,
    responses,
    labels: input ? [...input.querySelectorAll('.action-label')].filter(shown).map(clean).filter(Boolean).slice(0, 20) : [],
    toasts: [...document.querySelectorAll('.notifications-toasts .notification-list-item')].filter(shown).map(clean).filter(Boolean).slice(0, 3),
  };
}

/** The app's own non-batched tRPC wire format (shell/ezil/ui/Settings/trpc.js), same-origin with the session cookie. */
export async function trpcInPage({ method, path, input }) {
  let url = `/api/trpc/${path}`;
  const init = { method, credentials: 'same-origin' };
  if (method === 'GET') {
    if (input !== undefined) url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  } else {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify({ json: input ?? {} });
  }
  let res;
  try { res = await fetch(url, init); } catch { return { ok: false, status: 0, code: 'NETWORK', reason: null }; }
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  const error = parsed?.error ? (parsed.error.json ?? parsed.error) : null;
  if (error || !res.ok) {
    const message = typeof error?.message === 'string' ? error.message : '';
    return { ok: false, status: res.status, code: error?.data?.code ?? `HTTP_${res.status}`,
      reason: /^[a-z][a-z0-9]*(?:[_:.-][a-z0-9]+)+$/.test(message) ? message : null };
  }
  const data = parsed?.result?.data;
  return { ok: true, status: res.status, data: data && typeof data === 'object' && 'json' in data ? data.json : data };
}

/**
 * Make `app`'s dock icon clickable the way a user would. Usually it already is
 * (`path: 'direct'`). When a full-bleed window hides the dock: open the
 * window's control drawer (its handle, aria-label "Window controls") and press
 * Minimise (`path: 'drawer-minimise'`); if the drawer cannot be driven, call the
 * window's own minimise hook, the function that button calls
 * (`path: 'minimise-hook'`). Returns once the icon is actionable, or throws
 * saying why not. Never closes a window.
 */
export async function revealDock(page, app, { timeoutMs = 12_000, nap = ms => sleep(ms) } = {}) {
  const began = performance.now();
  let path = 'direct', minimised = null, attempts = 0;
  for (;;) {
    const probe = await page.evaluate(readDockProbe, app);
    const decision = decideDockAction(probe);
    if (decision.action === 'click') return { path, minimised };
    if (decision.action === 'missing') throw new Error(`${APP_LABEL[app] ?? app} icon is not in the dock (${decision.reason})`);
    if (performance.now() - began > timeoutMs) {
      throw new Error(`${APP_LABEL[app] ?? app} icon is not clickable (${decision.reason}${minimised ? `; ${minimised} was minimised via ${path}` : ''})`);
    }
    if (decision.action === 'minimise' && attempts < 2) {
      attempts++;
      const selector = `.window[data-app="${decision.app}"].ezil-fullbleed:not([data-closing="1"])`;
      const win = page.locator(selector).first();
      const toggle = win.locator('.ezil-app-drawer .dashboard-app-drawer-toggle');
      const button = win.locator('.ezil-app-drawer button[aria-label="Minimise"]');
      let used = 'drawer-minimise';
      try {
        if (!decision.drawer) throw new Error('no Minimise button');
        // The drawer shuts itself after a few seconds; only open it if it is shut
        // (clicking the handle of an open drawer would close it).
        if (await toggle.getAttribute('aria-expanded', { timeout: 1000 }) !== 'true') await toggle.click({ timeout: 3000 });
        await button.click({ timeout: 3000 });
      } catch {
        used = 'minimise-hook';
        await page.evaluate(selector => document.querySelector(selector)?._ezil_minimise?.(), selector).catch(() => {});
      }
      path = used; minimised = decision.app;
    }
    await nap(300);   // the window shrinks toward the dock; the dock repaints
  }
}

// ── The live run ────────────────────────────────────────────────────────────

async function loadLiveDependencies(env, config) {
  const deployment = await import('./deployed-target.mjs');
  // EZIL_E2E_SIGNIN=ezilid drives the real login UI; the default is the UI-less password grant.
  const { signIn } = config?.signInMode === 'ezilid' ? await import('./sign-in-ezilid.mjs') : await import('./sign-in.mjs');
  const { stopIsolatedComputer } = await import('./isolated-computer.mjs');
  const require = createRequire(join(resolve(env.PLAYWRIGHT_REQUIRE_DIR), 'prod-journeys.cjs'));
  const { chromium } = require('playwright');
  return { deployment, signIn, chromium, stopIsolatedComputer };
}

async function bounded(action, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Deadline exceeded')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** A step failed and was recorded; the journey stops, the run goes on. */
class StepFailed extends Error {}

export async function runProdJourneys({
  env = process.env,
  loadDependencies = loadLiveDependencies,
  emit = value => writeSync(1, `${JSON.stringify(value)}\n`),
  exit = code => process.exit(code),
} = {}) {
  const startedAt = new Date().toISOString();
  let config;
  try { config = parseEnv(env); } catch (error) {
    const report = makeReport({ startedAt, finishedAt: new Date().toISOString(), configError: describeError(error) });
    emit({ result: 'FAIL', error: report.configError });
    return report;
  }

  // Everything that reaches a log or a file passes through `redactDeep`.
  const secrets = [config.password, config.anonKey, env.VERCEL_AUTOMATION_BYPASS_SECRET].filter(Boolean);
  const scrub = value => redactDeep(value, { secrets });
  const say = value => emit(scrub(value));
  const names = config.journeys;
  const deadlines = runDeadlines(names, config);
  const started = performance.now();
  const deadline = started + deadlines.stepsMs;
  // The final stop may outlive `deadline`: it runs on its own reserve.
  const finalDeadline = deadline + deadlines.finalStopMs;
  const report = makeReport({ startedAt, app: config.app, account: redactEmail(config.email), selected: names });
  report.signIn = config.signInMode;
  const nonce = randomBytes(10).toString('hex');
  const owned = new Set();           // computers this run created (or recognised as its own)
  let browser, context, page, target, deployment, signIn, stopIsolatedComputer;
  let signedIn = null, stepDeadline, activeDeadline = deadline, active = null, finished = false, currentJourney = null;
  let buffers;
  const inflight = new Set();
  const resetBuffers = () => { buffers = { apiFailures: [], consoleErrors: [], pageErrors: [] }; };
  resetBuffers();

  const save = () => {
    try {
      mkdirSync(config.out, { recursive: true, mode: 0o700 });
      writeFileSync(join(config.out, 'prod-journeys.json'), `${JSON.stringify(scrub(report), null, 2)}\n`, { mode: 0o600 });
    } catch { /* The report is also on stdout; a full disk must not hide the verdict. */ }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    report.finishedAt = new Date().toISOString();
    report.ok = makeReport({ ...report }).ok;
    save();
    say({ result: report.ok ? 'PASS' : 'FAIL', out: config.out,
      journeys: report.journeys.map(({ name, ok, ms }) => ({ name, ok, ms })) });
  };
  const hardTimer = setTimeout(() => {
    report.setup.push(stepRecord('deadline', false, performance.now() - started, {
      error: active ? `Hard run deadline exceeded during ${active.journey}/${active.step}` : 'Hard run deadline exceeded' }));
    finish();
    exit(1);
  }, deadlines.hardMs);

  // Route-handler rejections can carry request headers (cookies) in their call
  // logs. Turn them into a failed CURRENT step without ever printing them; the
  // next step starts with a clean slate.
  let failCurrentStep = null;
  const onUnhandled = () => failCurrentStep?.(new Error('Browser request failed'));
  process.on('unhandledRejection', onUnhandled);

  const remaining = (limit = 10_000) => remainingMs({ limit, deadline: activeDeadline, stepDeadline, now: performance.now() });

  // ── evidence ──
  /**
   * Shell text stays readable (the error copy is the point). Form values and
   * Settings' Account pane (the address) are always hidden. Remote pixels and
   * frames are hidden too, except in a `showFrames` shot of an app that is
   * ready: those exist to show what the user sees, on a dedicated QA account.
   * A mask box is not used: it would hide the failure panel, which overlays
   * the app's own iframe.
   */
  const screenshot = async (name, { showFrames = false } = {}) => {
    if (!page || page.isClosed()) return null;
    const file = `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;
    try {
      // Off the app (an EZiL ID screen shows the address being signed in): mask the address.
      let foreign = true;
      try { foreign = new URL(page.url()).origin !== config.app; } catch { foreign = true; }
      await page.screenshot({ path: join(config.out, file), timeout: 5000,
        ...(foreign && config.email ? { mask: [page.locator(`text=${config.email}`)] } : {}),
        style: `${showFrames ? '' : 'iframe, video, canvas, object, embed, '}[data-pane="account"] { visibility: hidden !important; }
          input, textarea { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }` });
      return file;
    } catch { return null; }
  };
  const failureEvidence = async label => {
    await bounded(() => Promise.allSettled([...inflight]), 2000).catch(() => {});
    const visible = page && !page.isClosed()
      ? await bounded(() => page.evaluate(readVisibleErrors), 3000).catch(() => []) : [];
    const failures = [...buffers.apiFailures].sort((a, b) => Number(a.pending === true) - Number(b.pending === true))
      .map(({ key, ...rest }) => rest);
    return {
      apiFailures: failures, consoleErrors: [...buffers.consoleErrors], pageErrors: [...buffers.pageErrors],
      visibleError: shapeVisibleErrors(visible, { secrets }), screenshot: await screenshot(label),
    };
  };
  const onResponse = response => {
    const work = (async () => {
      const status = response.status();
      const pathname = apiPathOf(response.url(), config.app);
      if (!pathname || !wantsBody(pathname, status)) return;
      let body = null;
      try {
        const buffer = await response.body();
        if (buffer.length <= 65_536) body = JSON.parse(buffer.toString('utf8'));
      } catch { body = null; }
      const failure = shapeApiFailure({ method: response.request().method(), pathname, status, body });
      if (failure) addApiFailure(buffers.apiFailures, failure);
    })().catch(() => {});
    inflight.add(work);
    work.finally(() => inflight.delete(work));
  };
  const onRequestFailed = request => {
    const pathname = apiPathOf(request.url(), config.app);
    const reason = /^net::(ERR_[A-Z_]+)$/.exec(request.failure()?.errorText ?? '')?.[1];
    // Aborts are the shell cancelling its own polls (a closed window), not an outage.
    if (pathname && reason && reason !== 'ERR_ABORTED') {
      addApiFailure(buffers.apiFailures, { method: request.method(), path: pathname, status: 0, codes: [reason] });
    }
  };

  // ── steps ──
  const emitStep = (journey, record) => say({ journey: journey.name, step: record.name, ok: record.ok, ms: record.ms,
    ...(record.error ? { error: record.error } : {}), ...(record.note ? { note: record.note } : {}) });
  /** `soft`: a failure is recorded (the journey still fails) but the next step runs; `final`: runs on the reserve after the normal deadline. */
  async function step(journey, name, timeoutMs, action, { final = false, soft = false } = {}) {
    const began = performance.now();
    active = { journey: journey.name, step: name, began };
    activeDeadline = final ? finalDeadline : deadline;
    stepDeadline = Math.min(activeDeadline, began + timeoutMs);
    const routeFailure = new Promise((_, reject) => { failCurrentStep = reject; });
    routeFailure.catch(() => {});
    try {
      const value = await bounded(() => Promise.race([action(), routeFailure]), remaining(timeoutMs));
      const record = stepRecord(name, true, performance.now() - began, { note: value?.note });
      journey.steps.push(record); emitStep(journey, record); save();
      return value;
    } catch (error) {
      const record = stepRecord(name, false, performance.now() - began, {
        error: describeError(error, { secrets }), evidence: await failureEvidence(`${journey.name}-${name}`),
      });
      journey.steps.push(record); emitStep(journey, record); save();
      if (soft) return undefined;
      throw new StepFailed(name);
    } finally { active = null; failCurrentStep = null; stepDeadline = undefined; activeDeadline = deadline; }
  }

  // ── page helpers ──
  async function go(path) {
    for (let attempt = 1; ; attempt++) {
      try { return await page.goto(`${config.app}${path}`, { waitUntil: 'domcontentloaded', timeout: remaining(60_000) }); }
      catch (error) {
        if (attempt >= 5 || !/ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_NAME/.test(String(error))) throw error;
        await sleep(remaining(3000));
      }
    }
  }
  // Same call for both sign-ins: sign-in-ezilid.mjs ignores `env` and drives /login → EZiL ID instead.
  const ensureSignedIn = () => signedIn ??= signIn(page, { email: config.email, password: config.password,
    destination: '/os', app: target.app, ...(config.signInMode === 'ezilid' ? { timeoutMs: SIGN_IN_MS - 10 * SECOND } : {}),
    env: { NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: config.anonKey } });
  /** `/os` with a booted session; an already-booted page is kept (a reload forgets the chosen computer). */
  async function openOs() {
    await ensureSignedIn();
    const booted = () => page.evaluate(() => !!window.ezil?.session?.payload?.()?.computer?.id).catch(() => false);
    if (new URL(page.url()).pathname !== '/os') await go('/os');
    const began = performance.now();
    let reloaded = false;
    for (;;) {
      if (new URL(page.url()).pathname.startsWith('/login')) throw new Error('Signed-in session was sent back to /login');
      if (await booted()) break;
      // sign-in commits the navigation without waiting for the shell: give it time, then reload once.
      if (!reloaded && performance.now() - began > 25_000) { reloaded = true; await go('/os'); }
      await sleep(remaining(500));
    }
    return page.evaluate(() => window.ezil.session.payload().computer.id);
  }
  async function clickDock(app) {
    let reveal;
    try { reveal = await revealDock(page, app, { timeoutMs: remaining(12_000) }); } catch (error) {
      throw new Error(describeError(error, { secrets }));
    }
    const item = page.locator(`.taskbar-item[data-app="${app}"]`).first();
    try { await item.click({ timeout: remaining(5000) }); } catch (error) {
      throw new Error(`${APP_LABEL[app] ?? app} icon not clickable: ${describeError(error, { secrets })}`);
    }
    // Which way in was used, per click: a full-bleed Browser forces the drawer.
    if (currentJourney) (currentJourney.evidence.dock ??= []).push({ app, path: reveal.path, ...(reveal.minimised ? { minimised: reveal.minimised } : {}) });
  }
  async function appFrame(app) {
    const handle = await page.locator(`.window[data-app="${app}"]:not([data-closing="1"]) iframe.window-app-iframe`)
      .first().elementHandle({ timeout: 1000 }).catch(() => null);
    const frame = handle ? await handle.contentFrame().catch(() => null) : null;
    await handle?.dispose().catch(() => {});
    return frame;
  }
  /**
   * Poll one app window until the user could see the app: `check` says its
   * content is there AND no opening overlay covers it, held for READY_SETTLE_MS.
   * A failure panel fails it at once, with the copy on screen.
   */
  async function waitForApp(app, check, timeoutMs) {
    const began = performance.now();
    const contentLabel = app === 'code' ? 'editor' : 'video pixels';
    let tracker = newReadinessTracker();
    let waiting = 'window not open yet';
    for (;;) {
      remaining();
      const elapsed = performance.now() - began;
      if (elapsed > timeoutMs) throw new Error(`${APP_LABEL[app]} not ready after ${Math.round(timeoutMs / 1000)}s (${waiting})`);
      const snapshot = await page.evaluate(readWindowSnapshot, app);
      const failure = classifyStartFailure(snapshot);
      if (failure) throw new Error(describeStartFailure(app, failure));
      if (!snapshot.open && elapsed > 8000) throw new Error(`${APP_LABEL[app]} window closed before it was ready`);
      const content = snapshot.open ? await check(snapshot) : { contentReady: false };
      const verdict = userReadiness({ snapshot, contentReady: content.contentReady });
      const seen = performance.now() - began;
      tracker = trackReadiness(tracker, { elapsedMs: seen, contentReady: content.contentReady,
        overlayVisible: !!snapshot.overlay, windowOpen: snapshot.open });
      if (readinessSettled(tracker, seen)) {
        return { ...content, ...readinessTimings(tracker, app === 'code' ? 'firstEditorMs' : 'firstPixelsMs') };
      }
      waiting = describeReadinessWait(verdict, contentLabel, content.detail);
      await sleep(remaining(tracker.readySinceMs === null ? 1000 : 250));
    }
  }
  const codeReady = async () => {
    const frame = await appFrame('code');
    const workbench = frame ? await frame.locator('.monaco-workbench').first().isVisible().catch(() => false) : false;
    return { contentReady: workbench, frame, detail: workbench ? '' : 'workbench not visible' };
  };
  const desktopReady = async () => {
    const main = await appFrame('desktop');
    // The streamed viewer (video or canvas) lives in the desktop window's own
    // frame tree. AWS hosts do not match the Cloudflare frame-URL patterns.
    const own = main ? [main, ...main.childFrames()] : [];
    const others = main ? [] : page.frames().filter(frame => frame !== page.mainFrame());
    let last = null;
    for (const [frames, allowCanvas] of [[own, true], [others, false]]) {
      for (const frame of frames) {
        const sample = await frame.evaluate(sampleFramePixels, { width: 64, height: 36, allowCanvas }).catch(() => null);
        if (!sample) continue;
        last = { ...framePixelVerdict(sample.pixels), source: sample.kind };
        if (last.ok) return { contentReady: true, pixels: last, detail: '' };
      }
    }
    return { contentReady: false, detail: last ? `${last.source} ${last.reason}` : 'no video or canvas yet' };
  };
  const readinessEvidence = (ready, contentKey) => ({ [contentKey]: ready[contentKey], overlaySeenMs: ready.overlaySeenMs,
    overlayGoneMs: ready.overlayGoneMs, readyMs: ready.readyMs });
  /** Bring an app window to the front the way a user does (its title bar), then confirm nothing sits above it. */
  async function bringToFront(app) {
    const selector = `.window[data-app="${app}"]:not([data-closing="1"])`;
    const title = page.locator(`${selector} .window-head .window-head-title`).first();
    let clicked = false;
    try {
      if (await title.isVisible()) { await title.click({ timeout: remaining(3000) }); clicked = true; }
    } catch { clicked = false; }
    // Full-bleed windows hide their title bar: focus through the window manager, as registry.js does.
    if (!clicked) await page.evaluate(selector => { window.$(document.querySelector(selector)).focusWindow(); }, selector).catch(() => {});
    const top = await page.evaluate(selector => {
      const z = el => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
      const win = document.querySelector(selector);
      return !!win && ![...document.querySelectorAll('.window')].some(other => other !== win && other.getClientRects().length > 0 && z(other) > z(win));
    }, selector).catch(() => false);
    return { clicked, top };
  }
  /** Screenshot of an app right after it is user-ready, in front, showing the app itself. */
  async function readyShot(journey, label, app) {
    const front = await bringToFront(app).catch(() => ({ clicked: false, top: false }));
    await sleep(500);   // let the repaint after the focus change land
    const file = await screenshot(`${journey.name}-${label}-ready`, { showFrames: true });
    (journey.evidence.readyScreenshots ??= {})[label] = { file, titleBarClicked: front.clicked, inFront: front.top };
  }
  async function closeWindows(selector = '.window') {
    await page.evaluate(selector => { for (const win of document.querySelectorAll(selector)) window.$(win).close(); }, selector);
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0, selector, { timeout: remaining(10_000) });
  }
  /** Leave a clean desktop for the next journey: a modal feedback dialog left open would block every click. */
  const tidy = () => bounded(async () => {
    await page.evaluate(() => {
      for (const dialog of document.querySelectorAll('dialog.ezil-feedback-dialog')) dialog.querySelector('[data-action="cancel"]')?.click();
    }).catch(() => {});
    await closeWindows();
  }, 8000).catch(() => {});
  const trpc = (method, path, input) => page.evaluate(trpcInPage, { method, path, input });
  async function codeCommand(frame, name, id) {
    for (let attempt = 0; attempt < 5; attempt++) {
      remaining();
      try {
        const quick = await openQuickInput(frame, { attempts: 1, timeout: remaining(4000) });
        await quick.fill(`>${name}`, { timeout: remaining(2000) });
        await frame.locator(`.quick-input-list .monaco-list-row:visible [data-quick-input-id="${id}"]`).click({ timeout: remaining(3000) });
        return;
      } catch { await sleep(remaining(1000)); }
    }
    throw new Error(`Code command unavailable: ${name}`);
  }
  async function terminalEcho(frame) {
    // Screen-reader mode makes the terminal readable through the accessibility tree.
    if (!await frame.getByText('Screen Reader Optimized', { exact: true }).count()) {
      await codeCommand(frame, 'Toggle Screen Reader Accessibility Mode', 'editor.action.toggleScreenReaderAccessibilityMode');
      await sleep(remaining(1000));
    }
    await codeCommand(frame, 'Terminal: Create New Terminal', 'workbench.action.terminal.new');
    await sleep(remaining(4000));   // shell startup; the old terminal can stay visible meanwhile
    await frame.locator('.xterm-screen').last().click({ timeout: remaining() });
    const input = frame.locator('.xterm-helper-textarea').last();
    await input.pressSequentially(echoProbeCommand(nonce), { delay: 1, timeout: remaining() });
    await input.press('Enter', { timeout: remaining() });
    for (;;) {
      const text = await frame.locator('.xterm-accessibility-tree').last().innerText({ timeout: remaining(2000) }).catch(() => '');
      if (parseTerminalMarker(text, `N${nonce}`) === 'ok') return;
      await sleep(remaining(1000));
    }
  }
  async function openSettings(tab) {
    const win = page.locator('.window[data-app="settings"]:not([data-closing="1"])').first();
    if (!await win.count()) await clickDock('settings');
    const button = win.locator(`[data-tab="${tab}"]`);
    try { await button.waitFor({ state: 'visible', timeout: remaining(15_000) }); } catch {
      const tabs = await win.locator('[data-tab]').evaluateAll(els => els.map(el => el.dataset.tab)).catch(() => []);
      throw new Error(`Settings has no "${tab}" tab for this account (tabs: ${tabs.join(', ') || 'none'})`);
    }
    await button.click({ timeout: remaining(5000) });
    const pane = win.locator(`[data-pane="${tab}"]`);
    await pane.waitFor({ state: 'visible', timeout: remaining(10_000) });
    return { win, pane };
  }

  // ── journeys ──
  async function freeOpenApps(journey) {
    await step(journey, 'sign-in', 90 * SECOND, async () => { await ensureSignedIn(); });
    await step(journey, 'os-session-ready', OS_READY_MS, openOs);
    // Code and Browser are measured independently: one run says which of them fails.
    const code = await step(journey, 'open-code', config.appTimeoutMs + 15 * SECOND, async () => {
      await clickDock('code');
      const ready = await waitForApp('code', codeReady, config.appTimeoutMs);
      journey.evidence.code = readinessEvidence(ready, 'firstEditorMs');
      await readyShot(journey, 'code', 'code');
      return ready;
    }, { soft: true });
    if (code) await step(journey, 'terminal-echo', TERMINAL_MS, () => terminalEcho(code.frame), { soft: true });
    await step(journey, 'open-browser', config.appTimeoutMs + 15 * SECOND, async () => {
      await clickDock('desktop');
      const ready = await waitForApp('desktop', desktopReady, config.appTimeoutMs);
      journey.evidence.browser = readinessEvidence(ready, 'firstPixelsMs');
      journey.evidence.browserPixels = ready.pixels;
      await readyShot(journey, 'browser', 'desktop');
    });
  }

  async function paidAwsComputer(journey) {
    let created = null, started = false;
    const progressOf = async id => {
      const result = await trpc('GET', 'computer.progress', { computerId: id });
      if (!result.ok) throw new Error(`computer.progress failed (HTTP ${result.status} ${result.reason ?? result.code})`);
      return awsFacts(result.data);
    };
    const stopOwned = async (id, timeoutMs) => {
      assertSuiteComputer(id, owned);
      const cancel = new AbortController();
      try {
        await bounded(() => stopIsolatedComputer(context, id, target.app, target.headers, timeoutMs, (url, options) => {
          cancel.signal.throwIfAborted();
          return deployment.appRequest(url, { ...options, signal: cancel.signal });
        }), timeoutMs);
      } catch (error) { throw new Error(describeStopFailure(error)); } finally { cancel.abort(); }
    };
    try {
      await step(journey, 'sign-in', 90 * SECOND, async () => { await ensureSignedIn(); });
      await step(journey, 'os-session-ready', OS_READY_MS, openOs);
      const existing = await step(journey, 'preconditions', PRECHECK_MS, async () => {
        const summary = await trpc('GET', 'billing.summary');
        if (!summary.ok) throw new Error(`billing.summary failed (HTTP ${summary.status} ${summary.reason ?? summary.code})`);
        if (!isPaidPlan(summary.data)) throw new Error('Account is on the Free plan: this journey needs a paid (Standard) QA account');
        const list = await trpc('GET', 'computer.list');
        if (!list.ok) throw new Error(`computer.list failed (HTTP ${list.status} ${list.reason ?? list.code})`);
        const rows = list.data.map(({ id, name, slot }) => ({ id, name, slot }));
        const mine = pickSuiteComputers(rows);
        journey.evidence.existingComputers = rows.length;
        if (config.awsComputer === 'reuse') {
          if (mine.length !== 1) throw new Error(`EZIL_E2E_AWS_COMPUTER=reuse needs exactly one computer named "${COMPUTER_NAME_PREFIX}…" (found ${mine.length})`);
          return { reuse: mine[0], rows, full: list.data };
        }
        if (mine.length > 0) throw new Error(`This suite's computer from an earlier run still exists (${mine[0].id}); delete it in Settings → Computer, or set EZIL_E2E_AWS_COMPUTER=reuse`);
        if (rows.length >= MAX_COMPUTERS_PER_USER) throw new Error(`${describeCreateRefusal({ reason: 'computer_limit_reached' })}`);
        // Admission refuses a second AWS computer (`user_has_aws_computer`): find out before paying for a create.
        for (const row of rows) {
          const facts = await progressOf(row.id);
          if (facts.aws) throw new Error(`Another computer of this account already runs on AWS (${row.id}); the server would refuse a new one (user_has_aws_computer)`);
        }
        return { reuse: null, rows, full: list.data };
      });
      const computer = await step(journey, 'create-computer', CREATE_MS, async () => {
        if (existing.reuse) {
          // The full row, as the shell's own Computer tab holds it.
          owned.add(existing.reuse.id);
          created = existing.full.find(row => row.id === existing.reuse.id);
          return created;
        }
        const result = await trpc('POST', 'computer.create', { name: `${COMPUTER_NAME_PREFIX} ${nonce.slice(0, 8)}` });
        if (!result.ok) throw new Error(describeCreateRefusal(result));
        const listed = await trpc('GET', 'computer.list');
        const row = (listed.ok ? listed.data : []).find(item => item.id === result.data?.id
          && !existing.rows.some(old => old.id === item.id));
        if (!row) throw new Error('computer.create answered but the new computer is not in computer.list');
        owned.add(row.id);
        created = row;
        return row;
      });
      journey.evidence.computerId = computer.id;
      say({ event: 'computer', journey: journey.name, computerId: computer.id, mode: config.awsComputer });
      await step(journey, 'select-computer', 30 * SECOND, async () => {
        assertSuiteComputer(computer.id, owned);
        const chosen = await page.evaluate(row => { window.ezil.session.setCurrentComputer(row); return window.ezil.session.currentComputer()?.id ?? null; }, computer);
        if (chosen !== computer.id) throw new Error('The shell did not select the new computer');
      });
      await step(journey, 'open-desktop', config.awsTimeoutMs + 15 * SECOND, async () => {
        const chosen = await page.evaluate(() => window.ezil.session.currentComputer()?.id ?? null);
        if (chosen !== computer.id) throw new Error('Refusing to open: the shell is not on the new computer');
        started = true;
        await clickDock('desktop');
        const ready = await waitForApp('desktop', async snapshot => {
          if (snapshot.computerId && snapshot.computerId !== computer.id) throw new Error('The Browser window opened on a different computer');
          return desktopReady();
        }, config.awsTimeoutMs);
        journey.evidence.timeToDesktopMs = ready.readyMs;
        journey.evidence.desktop = readinessEvidence(ready, 'firstPixelsMs');
        await readyShot(journey, 'browser', 'desktop');
      });
      await step(journey, 'assert-aws', MINUTE, async () => {
        const facts = await progressOf(computer.id);
        journey.evidence.aws = facts;
        if (!facts.aws) throw new Error('The computer is not on AWS (computer.progress shows no placement and no instance type)');
        if (facts.lifecycleState !== 'RUNNING') throw new Error(`Desktop painted but the placement is ${facts.lifecycleState}`);
      });
      await step(journey, 'open-code', config.appTimeoutMs + 15 * SECOND, async () => {
        await clickDock('code');
        const ready = await waitForApp('code', codeReady, config.appTimeoutMs);
        journey.evidence.timeToCodeMs = ready.readyMs;
        journey.evidence.code = readinessEvidence(ready, 'firstEditorMs');
        await readyShot(journey, 'code', 'code');
      }, { soft: true });   // a broken Code must not skip the stop and wake checks: a boot costs minutes
      await step(journey, 'stop', FINAL_STOP_TIMEOUT_MS + 30 * SECOND, async () => {
        // Like Settings → Stop: windows close first and nothing may re-ask ensure() afterwards.
        await bounded(() => closeWindows('.window[data-app="desktop"], .window[data-app="code"]'), 10_000).catch(() => {});
        await page.evaluate(async id => {
          const session = window.ezil.session;
          session.holdAfterStop?.(id);
          await Promise.race([Promise.resolve(session.cancelComputerOpens?.(id)), new Promise(resolve => setTimeout(resolve, 3000))]);
        }, computer.id);
        await stopOwned(computer.id, FINAL_STOP_TIMEOUT_MS);
      });
      await step(journey, 'stopped', config.stoppedTimeoutMs, async () => {
        for (;;) {
          const facts = await progressOf(computer.id);
          if (facts.lifecycleState === 'STOPPED') { journey.evidence.stopped = facts; return; }
          if (facts.needsOperator) throw new Error('The computer needs operator attention after the stop');
          await sleep(remaining(5000));
        }
      });
      await step(journey, 'wake', config.awsWakeTimeoutMs + 15 * SECOND, async () => {
        // The Browser open is never held after a stop; Code's mint is refused for 60 s (`computer_stopped`).
        await clickDock('desktop');
        const ready = await waitForApp('desktop', async snapshot => {
          if (snapshot.computerId && snapshot.computerId !== computer.id) throw new Error('The Browser window opened on a different computer');
          return desktopReady();
        }, config.awsWakeTimeoutMs);
        journey.evidence.timeToWakeMs = ready.readyMs;
        journey.evidence.wake = readinessEvidence(ready, 'firstPixelsMs');
        await readyShot(journey, 'browser-wake', 'desktop');
      });
      await step(journey, 'running-again', MINUTE, async () => {
        const facts = await progressOf(computer.id);
        if (facts.lifecycleState !== 'RUNNING') throw new Error(`After the wake the placement is ${facts.lifecycleState}`);
      });
    } finally {
      // Always, even after a failure or a late deadline: this is the one thing that costs money.
      if (created && started) {
        await step(journey, 'final-stop', FINAL_STOP_TIMEOUT_MS + 30 * SECOND, async () => {
          await bounded(() => closeWindows('.window[data-app="desktop"], .window[data-app="code"]'), 10_000).catch(() => {});
          await stopOwned(created.id, FINAL_STOP_TIMEOUT_MS);
        }, { final: true }).catch(() => {});
      }
    }
  }

  async function feedbackDiagnostics(journey) {
    await step(journey, 'sign-in', 90 * SECOND, async () => { await ensureSignedIn(); });
    await step(journey, 'os-session-ready', OS_READY_MS, openOs);
    await step(journey, 'open-form', 60 * SECOND, async () => {
      const enabled = await page.evaluate(() => !!window.ezil.session.payload()?.desktopState?.endpoints?.feedback);
      if (!enabled) throw new Error('Feedback is not enabled for this account (the boot payload has no endpoints.feedback)');
      const { pane } = await openSettings('feedback');
      await pane.locator('[data-action="send-feedback"]').click({ timeout: remaining(5000) });
      await page.locator('dialog.ezil-feedback-dialog').waitFor({ state: 'visible', timeout: remaining(10_000) });
    });
    await step(journey, 'submit', 60 * SECOND, async () => {
      const dialog = page.locator('dialog.ezil-feedback-dialog');
      await dialog.locator('#ezil-feedback-description').fill(`${FEEDBACK_PREFIX} automated prod-journeys run ${nonce.slice(0, 8)}`, { timeout: remaining(5000) });
      await dialog.locator('input[name="diagnostics"]').check({ timeout: remaining(5000) });
      const responded = page.waitForResponse(response => apiPathOf(response.url(), config.app) === '/api/shell/feedback'
        && response.request().method() === 'POST', { timeout: remaining(30_000) });
      await dialog.locator('button[type="submit"]').click({ timeout: remaining(5000) });
      const response = await responded;
      const status = response.status();
      let answer = null;
      try { answer = await response.json(); } catch { answer = null; }
      journey.evidence.feedback = { status };
      if (status === 429) throw new Error('Feedback was rate limited (HTTP 429): wait an hour or use another QA account');
      if (status < 200 || status >= 300) {
        throw new Error(`POST /api/shell/feedback returned HTTP ${status}${errorCodesOf(answer).length ? ` ${errorCodesOf(answer).join(',')}` : ''}`);
      }
      journey.evidence.feedback = { status, ...summarizeFeedbackRequest(response.request().postDataJSON(), answer) };
      if (!journey.evidence.feedback.diagnosticsAttached) throw new Error('The request carried no diagnostics although the box was checked');
      await dialog.locator('.ezil-feedback-result', { hasText: 'Thanks' }).waitFor({ timeout: remaining(10_000) });
    });
    await step(journey, 'close-dialog', 15 * SECOND, async () => {
      await page.locator('dialog.ezil-feedback-dialog [data-action="cancel"]').click({ timeout: remaining(5000) });
      await page.locator('dialog.ezil-feedback-dialog').waitFor({ state: 'detached', timeout: remaining(5000) });
    });
  }

  async function billingView(journey) {
    await step(journey, 'sign-in', 90 * SECOND, async () => { await ensureSignedIn(); });
    await step(journey, 'os-session-ready', OS_READY_MS, openOs);
    await step(journey, 'open-billing', 60 * SECOND, async () => {
      const { pane } = await openSettings('billing');
      // Read only. Never reach billing through `?settings=billing&upgrade=…`: that opens checkout.
      await pane.locator('[data-role="billing-body"][aria-busy="false"]').waitFor({ state: 'attached', timeout: remaining(30_000) });
      const problem = await pane.evaluate(el => /couldn.t load billing|billing isn.t available/i.test(el.textContent ?? '')
        ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : null);
      if (problem) throw new Error(`Billing did not load: ${problem}`);
    });
    await step(journey, 'read-billing', 45 * SECOND, async () => {
      const pane = page.locator('.window[data-app="settings"] [data-pane="billing"]').first();
      const section = selector => pane.locator(selector).first();
      const read = async selector => normalizeVisibleText(await section(selector).innerText({ timeout: 1000 }).catch(() => ''), { secrets });
      const parts = {
        plan: '[data-role="plan-card"]',
        aiCredits: '[data-role="meter-ai"], [data-meter="ai"]',
        computeAllowance: '[data-role="meter-time"], [data-meter="compute"]',
        yourComputer: '[data-role="your-computer"]',
        storage: '[data-role="meter-storage"], [data-meter="storage"]',
      };
      // The computer-time meter fills in once `billing.usage` answers.
      const until = performance.now() + 15_000;
      let seen;
      do {
        seen = Object.fromEntries(await Promise.all(Object.entries(parts).map(async ([key, selector]) => [key, await read(selector)])));
        if (/\d/.test(seen.computeAllowance) && /left|hour|\bh\b/i.test(seen.computeAllowance)) break;
        await sleep(remaining(1000));
      } while (performance.now() < until);
      journey.evidence.billing = { ...seen,
        version: await section('[data-role="plan-card"]').getAttribute('data-version', { timeout: 1000 }).catch(() => null) ?? 'v2',
        planStatus: await read('[data-role="plan-status"]') };
      const missing = ['plan', 'aiCredits', 'computeAllowance'].filter(key => !seen[key]);
      if (missing.length) throw new Error(`Billing view is missing: ${missing.join(', ')}`);
      await screenshot(`${journey.name}-view`);
    });
  }

  /** Type into the chat input the way a user does, and send only what landed there. */
  async function sendChatPrompt(frame, prompt) {
    const lines = frame.locator('.chat-input-container .monaco-editor:visible .view-lines').first();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await lines.click({ timeout: remaining(5000) });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.type(prompt, { delay: 5 });
        await sleep(remaining(300));
        // Monaco renders spaces as U+00A0, which \s covers.
        const typed = (await lines.innerText({ timeout: remaining(2000) })).replace(/\s+/g, ' ');
        if (typed.includes(prompt.slice(0, 20))) { await page.keyboard.press('Enter'); return; }
      } catch { /* retried below */ }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(remaining(500));
    }
    throw new Error('The prompt never reached the chat input');
  }

  async function ezilAi(journey) {
    await step(journey, 'sign-in', SIGN_IN_MS, async () => { await ensureSignedIn(); });
    await step(journey, 'os-session-ready', OS_READY_MS, openOs);
    const code = await step(journey, 'open-code', config.appTimeoutMs + 15 * SECOND, async () => {
      await clickDock('code');
      const ready = await waitForApp('code', codeReady, config.appTimeoutMs);
      journey.evidence.code = readinessEvidence(ready, 'firstEditorMs');
      await readyShot(journey, 'code', 'code');
      return ready;
    });
    const frame = code.frame;
    // Soft: when the status is wrong the chat reply still runs, and its error copy names the code.
    await step(journey, 'ai-status', AI_STATUS_MS, async () => {
      // "EZiL AI · Loading…" until the extension's first Gateway reads answer; absent until it activates.
      const empty = { present: false, text: '', aria: '' };
      const waitUntil = performance.now() + AI_STATUS_WAIT_MS;
      let item, status;
      for (;;) {
        item = await frame.evaluate(readAIStatusItem).catch(() => empty);
        status = classifyAIStatus(item.text);
        if (!['missing', 'loading'].includes(status.state) || performance.now() > waitUntil) break;
        await sleep(remaining(2000));
      }
      // Its click target is a quick pick titled "EZiL AI": "Available credits: …", limits, "Recent usage …".
      let quick = null;
      if (item.present) {
        try {
          await frame.locator(AI_STATUS_ITEM).first().click({ timeout: remaining(5000) });
          const quickUntil = performance.now() + 20 * SECOND;
          for (;;) {
            quick = await frame.evaluate(readQuickPick).catch(() => null);
            if (quick?.open && quick.rows.some(row => /^(?:Available credits|Credits unavailable)\b/.test(row))) break;
            if (performance.now() > quickUntil) break;
            await sleep(remaining(500));
          }
        } catch { /* recorded as quickPick: null; the item's aria-label carries the same lines */ }
        // To the focused quick input (focusing another element first would only blur it shut).
        await page.keyboard.press('Escape').catch(() => {});
      }
      const fromQuick = quick?.open && quick.rows.length > 0;
      const summary = fromQuick ? { source: 'quick-pick', ...summarizeAIQuickPick(quick.rows) }
        : item.aria ? { source: 'aria-label', ...summarizeAIQuickPick(item.aria.split(/\.\s+(?=[A-Z])/)) } : null;
      journey.evidence.ai = {
        statusText: normalizeVisibleText(item.text, { secrets, max: 160 }), status,
        quickPickTitle: fromQuick ? normalizeVisibleText(quick.title, { secrets, max: 60 }) : null, quickPick: summary,
      };
      const verdict = aiStatusVerdict(status, summary);
      if (!verdict.ok) throw new Error(verdict.reason);
    }, { soft: true });
    await step(journey, 'chat-reply', CHAT_OPEN_MS + config.aiReplyTimeoutMs + 30 * SECOND, async () => {
      const input = frame.locator('.chat-input-container .monaco-editor:visible').first();
      if (!await input.isVisible().catch(() => false)) {
        await codeCommand(frame, 'Chat: Open Chat', 'workbench.action.chat.open');
        try { await input.waitFor({ state: 'visible', timeout: remaining(20_000) }); } catch {
          throw new Error('The Chat view did not open (no chat input)');
        }
      }
      const before = await frame.evaluate(readChatState);
      const model = pickModelLabel(before.labels);
      const chat = journey.evidence.chat = { model: model ? normalizeVisibleText(model, { secrets, max: 60 }) : null,
        defaultModel: DEFAULT_AI_MODEL_NAME, modelIsDefault: Boolean(model?.includes(DEFAULT_AI_MODEL_NAME)),
        prompt: AI_PROMPT, earlierResponses: before.responses.length };
      await sendChatPrompt(frame, AI_PROMPT);
      const sent = performance.now();
      const replyUntil = sent + config.aiReplyTimeoutMs;
      let state = before, reply = null, last = null, stableSince = 0;
      for (;;) {
        state = await frame.evaluate(readChatState).catch(() => state);
        reply = state.responses.slice(before.responses.length).at(-1) ?? null;
        if (reply) {
          const verdict = classifyChatReply(reply.error || reply.text);
          if (reply.error || verdict.state === 'error') {
            const code = verdict.state === 'error' ? verdict.code : 'chat_error';
            Object.assign(chat, { replyMs: Math.round(performance.now() - sent), errorCode: code });
            throw new Error(`Chat answered with an error (${code}): "${normalizeVisibleText(reply.error || reply.text, { secrets, max: 160 })}"`);
          }
          const settled = !state.busy && !reply.loading && verdict.state === 'reply' && !isPlaceholderReply(reply.text);
          if (settled && reply.text === last) {
            if (performance.now() - stableSince >= 1500) break;
          } else { last = settled ? reply.text : null; stableSince = performance.now(); }
        }
        if (performance.now() > replyUntil) {
          const toast = state.toasts.find(text => classifyChatReply(text).state === 'error');
          const why = toast ? `a notification says: "${normalizeVisibleText(toast, { secrets, max: 160 })}" (${classifyChatReply(toast).code})`
            : !reply ? 'no response appeared' : state.busy || reply.loading ? 'still generating' : 'the response stayed empty';
          chat.toasts = state.toasts.map(text => normalizeVisibleText(text, { secrets, max: 120 }));
          throw new Error(`No chat reply within ${Math.round(config.aiReplyTimeoutMs / 1000)}s: ${why}`);
        }
        await sleep(remaining(1000));
      }
      Object.assign(chat, { replyMs: Math.round(stableSince - sent), ...replyEvidence(reply.text, { secrets }),
        ...(reply.warning ? { warning: normalizeVisibleText(reply.warning, { secrets, max: 160 }) } : {}) });
      await screenshot(`${journey.name}-chat-reply`, { showFrames: true });
    });
  }

  const runners = {
    'free-open-apps': freeOpenApps, 'ezil-ai': ezilAi, 'paid-aws-computer': paidAwsComputer,
    'feedback-diagnostics': feedbackDiagnostics, 'billing-view': billingView,
  };

  async function runJourney(name) {
    const journey = { name, ok: false, ms: 0, steps: [], evidence: {} };
    report.journeys.push(journey);
    currentJourney = journey;
    resetBuffers();
    const began = performance.now();
    try { await runners[name](journey); } catch (error) {
      if (!(error instanceof StepFailed)) {
        journey.steps.push(stepRecord('journey', false, performance.now() - began, { error: describeError(error, { secrets }) }));
      }
    }
    journey.ms = Math.round(performance.now() - began);
    journey.ok = journey.steps.length > 0 && journey.steps.every(item => item.ok);
    journey.evidence.finalScreenshot = await screenshot(`${name}-final`);
    await tidy();   // after the screenshot: it shows what the user was left looking at
    save();
  }

  // ── run ──
  try {
    say({ suite: 'prod-journeys', app: config.app, account: redactEmail(config.email), signIn: config.signInMode, journeys: names, out: config.out });
    mkdirSync(config.out, { recursive: true, mode: 0o700 });
    const setupBegan = performance.now();
    try {
      ({ deployment, signIn, stopIsolatedComputer } = await bounded(async () => {
        const loaded = await loadDependencies(env, config);
        const { chromium } = loaded;
        target = loaded.deployment.deployedTarget({ EZIL_E2E_APP: config.app,
          ...(env.VERCEL_AUTOMATION_BYPASS_SECRET ? { VERCEL_AUTOMATION_BYPASS_SECRET: env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) });
        browser = await chromium.launch({ headless: true, timeout: 25_000, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        context.setDefaultTimeout(10_000);
        await loaded.deployment.configureAppContext(context, target);
        page = await context.newPage();
        context.on('response', onResponse);
        context.on('requestfailed', onRequestFailed);
        page.on('console', message => { if (message.type() === 'error') addUnique(buffers.consoleErrors, shapeConsoleError(message.text(), { secrets })); });
        page.on('pageerror', error => addUnique(buffers.pageErrors, shapeConsoleError(error?.message ?? error, { secrets })));
        return loaded;
      }, SETUP_MS));
      report.setup.push(stepRecord('browser-launch', true, performance.now() - setupBegan));
    } catch (error) {
      report.setup.push(stepRecord('browser-launch', false, performance.now() - setupBegan, { error: describeError(error, { secrets }) }));
    }
    save();
    if (report.setup.every(item => item.ok)) {
      for (const name of names) await runJourney(name);
    }
  } catch (error) {
    report.setup.push(stepRecord('run', false, 0, { error: describeError(error, { secrets }) }));
  } finally {
    if (browser) {
      const closing = performance.now();
      try {
        await bounded(() => browser.close(), 5000);
        report.setup.push(stepRecord('browser-close', true, performance.now() - closing));
      } catch { report.setup.push(stepRecord('browser-close', false, performance.now() - closing, { error: 'Browser did not close' })); }
    }
    finish();
    clearTimeout(hardTimer);
    process.removeListener('unhandledRejection', onUnhandled);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await runProdJourneys();
  // A failed browser shutdown must not leave the CLI held open by sockets.
  process.exit(exitCodeFor(report));
}

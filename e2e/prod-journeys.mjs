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
 * Journeys (select with EZIL_E2E_JOURNEYS, comma list; default: all but paid):
 *   free-open-apps        sign in, Code ready, terminal echo, Browser pixels
 *   paid-aws-computer     NEW computer on AWS: boot, stop, wake, stop (costs money)
 *   feedback-diagnostics  Settings → Feedback with diagnostics, what the report carries
 *   billing-view          Settings → Billing, read-only: plan, AI credits, compute
 *
 * Inputs come only from the environment (see e2e/README.md): EZIL_E2E_APP,
 * EZIL_E2E_EMAIL, EZIL_E2E_PASSWORD, NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, PLAYWRIGHT_REQUIRE_DIR. Use a DEDICATED QA
 * account. Evidence goes to EZIL_E2E_OUT (default: <tmpdir>/ezil-prod-journeys).
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
export const JOURNEYS = Object.freeze(['free-open-apps', 'paid-aws-computer', 'feedback-diagnostics', 'billing-view']);
/** The paid journey creates an AWS computer that bills while it runs: it is never implicit. */
export const DEFAULT_JOURNEYS = Object.freeze(JOURNEYS.filter(name => name !== 'paid-aws-computer'));
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

export const DEFAULT_TIMEOUTS = Object.freeze({
  appTimeoutMs: 4 * MINUTE,
  awsTimeoutMs: 15 * MINUTE,
  awsWakeTimeoutMs: 10 * MINUTE,
  stoppedTimeoutMs: 5 * MINUTE,
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

export const REQUIRED_ENV = Object.freeze([
  'EZIL_E2E_APP', 'EZIL_E2E_EMAIL', 'EZIL_E2E_PASSWORD',
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'PLAYWRIGHT_REQUIRE_DIR',
]);

/** Validate the environment. Errors name variables, never their values. */
export function parseEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter(name => String(env[name] ?? '').trim() === '');
  if (missing.length) throw new Error(`Missing prod-journeys inputs: ${missing.join(', ')}`);
  const supabase = String(env.NEXT_PUBLIC_SUPABASE_URL);
  try {
    const url = new URL(supabase);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('scheme');
  } catch { throw new Error('NEXT_PUBLIC_SUPABASE_URL must be an HTTPS URL'); }
  const awsComputer = String(env.EZIL_E2E_AWS_COMPUTER ?? 'new').trim() || 'new';
  if (!['new', 'reuse'].includes(awsComputer)) throw new Error('EZIL_E2E_AWS_COMPUTER must be "new" or "reuse"');
  return {
    app: parseAppOrigin(env.EZIL_E2E_APP),
    email: String(env.EZIL_E2E_EMAIL).trim(),
    password: String(env.EZIL_E2E_PASSWORD),
    supabaseUrl: supabase,
    anonKey: String(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    requireDir: resolve(String(env.PLAYWRIGHT_REQUIRE_DIR)),
    journeys: selectJourneys(env.EZIL_E2E_JOURNEYS),
    out: resolve(env.EZIL_E2E_OUT || join(tmpdir(), 'ezil-prod-journeys')),
    awsComputer,
    appTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_APP_TIMEOUT_MS', DEFAULT_TIMEOUTS.appTimeoutMs),
    awsTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AWS_TIMEOUT_MS', DEFAULT_TIMEOUTS.awsTimeoutMs),
    awsWakeTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AWS_WAKE_TIMEOUT_MS', DEFAULT_TIMEOUTS.awsWakeTimeoutMs),
    stoppedTimeoutMs: parseDurationEnv(env, 'EZIL_E2E_AWS_STOPPED_TIMEOUT_MS', DEFAULT_TIMEOUTS.stoppedTimeoutMs),
  };
}

/** The most time one journey may take, from its configured step timeouts. */
export function journeyBudgetMs(name, config) {
  const t = { ...DEFAULT_TIMEOUTS, ...config };
  switch (name) {
    case 'free-open-apps': return OS_READY_MS + 2 * (t.appTimeoutMs + 15 * SECOND) + TERMINAL_MS + CLOSE_MS;
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
  const spinner = win.querySelector('.ezil-app-spinner');
  const src = win.querySelector('iframe.window-app-iframe')?.getAttribute('src') ?? '';
  return {
    open: true,
    computerId: win.getAttribute('data-ezil-computer-id'),
    failed,
    unavailable: shown(unavailable) ? { title: text(unavailable, 'div') } : null,
    notice: shown(notice) ? { title: text(notice, '.ezil-display-notice-title'), body: text(notice, '.ezil-display-notice-body') } : null,
    spinnerKind: shown(spinner) ? spinner.getAttribute('data-kind') : null,
    spinnerStatus: shown(spinner) ? text(spinner, '.ezil-opening-status') : '',
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

// ── The live run ────────────────────────────────────────────────────────────

async function loadLiveDependencies(env) {
  const deployment = await import('./deployed-target.mjs');
  const { signIn } = await import('./sign-in.mjs');
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
  const nonce = randomBytes(10).toString('hex');
  const owned = new Set();           // computers this run created (or recognised as its own)
  let browser, context, page, target, deployment, signIn, stopIsolatedComputer;
  let signedIn = null, stepDeadline, activeDeadline = deadline, active = null, finished = false;
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
  const screenshot = async name => {
    if (!page || page.isClosed()) return null;
    const file = `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;
    try {
      // Shell text stays readable (the error copy is the point). Remote pixels,
      // frames, form values and Settings' Account pane (the address) are hidden.
      // A mask box would hide the failure panel too: it overlays the app's iframe.
      await page.screenshot({ path: join(config.out, file), timeout: 5000,
        style: `iframe, video, canvas, object, embed, [data-pane="account"] { visibility: hidden !important; }
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
  const ensureSignedIn = () => signedIn ??= signIn(page, { email: config.email, password: config.password,
    destination: '/os', app: target.app,
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
    const item = page.locator(`.taskbar-item[data-app="${app}"]`).first();
    try { await item.click({ timeout: remaining(12_000) }); } catch (error) {
      const apps = await page.evaluate(() => [...document.querySelectorAll('.taskbar-item')].map(el => el.dataset.app)).catch(() => []);
      throw new Error(`${APP_LABEL[app] ?? app} icon not clickable (dock has: ${apps.join(', ') || 'nothing'}): ${describeError(error, { secrets })}`);
    }
  }
  async function appFrame(app) {
    const handle = await page.locator(`.window[data-app="${app}"]:not([data-closing="1"]) iframe.window-app-iframe`)
      .first().elementHandle({ timeout: 1000 }).catch(() => null);
    const frame = handle ? await handle.contentFrame().catch(() => null) : null;
    await handle?.dispose().catch(() => {});
    return frame;
  }
  /** Poll one app window until `check` says ready. A failure panel fails it at once, with the copy on screen. */
  async function waitForApp(app, check, timeoutMs) {
    const began = performance.now();
    let waiting = 'window not open yet';
    for (;;) {
      remaining();
      const elapsed = performance.now() - began;
      if (elapsed > timeoutMs) throw new Error(`${APP_LABEL[app]} not ready after ${Math.round(timeoutMs / 1000)}s (${waiting})`);
      const snapshot = await page.evaluate(readWindowSnapshot, app);
      const failure = classifyStartFailure(snapshot);
      if (failure) throw new Error(describeStartFailure(app, failure));
      if (!snapshot.open && elapsed > 8000) throw new Error(`${APP_LABEL[app]} window closed before it was ready`);
      if (snapshot.open) {
        const verdict = await check(snapshot);
        if (verdict.ready) return { ...verdict, readyMs: Math.round(performance.now() - began) };
        waiting = verdict.waiting;
      }
      await sleep(remaining(1000));
    }
  }
  const codeReady = async snapshot => {
    const frame = await appFrame('code');
    const workbench = frame ? await frame.locator('.monaco-workbench').first().isVisible().catch(() => false) : false;
    return { ready: workbench && snapshot.spinnerKind === null, frame,
      waiting: `${snapshot.spinnerStatus || `frame ${snapshot.frame}`}; editor ${workbench ? 'visible' : 'not visible'}` };
  };
  const desktopReady = async snapshot => {
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
        if (last.ok) return { ready: true, pixels: last };
      }
    }
    return { ready: false, waiting: last ? `${last.source} ${last.reason}` : `${snapshot.spinnerStatus || 'no video or canvas yet'}` };
  };
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
      return waitForApp('code', codeReady, config.appTimeoutMs);
    }, { soft: true });
    if (code) await step(journey, 'terminal-echo', TERMINAL_MS, () => terminalEcho(code.frame), { soft: true });
    await step(journey, 'open-browser', config.appTimeoutMs + 15 * SECOND, async () => {
      await clickDock('desktop');
      const ready = await waitForApp('desktop', desktopReady, config.appTimeoutMs);
      journey.evidence.browserPixels = ready.pixels;
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
          return desktopReady(snapshot);
        }, config.awsTimeoutMs);
        journey.evidence.timeToDesktopMs = ready.readyMs;
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
          return desktopReady(snapshot);
        }, config.awsWakeTimeoutMs);
        journey.evidence.timeToWakeMs = ready.readyMs;
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

  const runners = {
    'free-open-apps': freeOpenApps, 'paid-aws-computer': paidAwsComputer,
    'feedback-diagnostics': feedbackDiagnostics, 'billing-view': billingView,
  };

  async function runJourney(name) {
    const journey = { name, ok: false, ms: 0, steps: [], evidence: {} };
    report.journeys.push(journey);
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
    say({ suite: 'prod-journeys', app: config.app, account: redactEmail(config.email), journeys: names, out: config.out });
    mkdirSync(config.out, { recursive: true, mode: 0o700 });
    const setupBegan = performance.now();
    try {
      ({ deployment, signIn, stopIsolatedComputer } = await bounded(async () => {
        const loaded = await loadDependencies(env);
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

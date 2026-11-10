// diagnostics.js — EZiL-authored. Feedback's small, explicit allowlist.
// No general-purpose state dump: even telemetry's redacted detail is excluded.
import { feedbackTraceSnapshot } from '../../trace.js';
import { recentEvents } from '../../telemetry.js';
import { isCorrelationId, isFailureReason } from './failure-shapes.js';
import { app_failures_for } from './app-failures.js';

/**
 * FEEDBACK-DIAG: at most this many recent events — the newest — carry the
 * server's `reason`/`correlationId`. Keeps the worst case well inside the
 * 32 KiB no-screenshot body. Mirrors `FEEDBACK_LIMITS.recentEventsAnnotatedMax`.
 */
const MAX_ANNOTATED_EVENTS = 10;

/**
 * FEEDBACK-DIAG: does THIS server's feedback schema accept
 * `recentEvents[].reason`/`.correlationId`? Read fresh every call; absent means
 * no — the `activityEndpoint()` contract in `../../session.js`. An older server
 * parses `recentEvents` strictly and would 400 the whole report on either key.
 */
export function event_diagnostics_accepted () {
    return globalThis.window?.__EZIL_BOOT__?.desktopState?.ui?.feedbackEventDiagnostics === true;
}

export function app_failure_diagnostics_accepted () {
    return globalThis.window?.__EZIL_BOOT__?.desktopState?.ui?.feedbackAppFailures === true;
}

const integer = value => Math.min(1_000_000_000, Math.max(0, Math.round(value)));

function visible (el) {
    for ( let node = el; node; node = node.parentElement ) {
        const style = window.getComputedStyle(node);
        if ( style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ) return false;
    }
    return true;
}

function browser () {
    // Low-entropy brands only; never request high-entropy client hints.
    const brands = navigator.userAgentData?.brands;
    for ( const [brand, family] of [['Microsoft Edge', 'Edge'], ['Google Chrome', 'Chrome'], ['Chromium', 'Chromium']] ) {
        const entry = brands?.find(item => item.brand === brand);
        if ( entry && /^\d+/.test(entry.version) ) return { family, major: integer(parseInt(entry.version, 10)) };
    }
    const ua = navigator.userAgent || '';
    for ( const [pattern, family] of [
        [/(?:Edg|EdgA|EdgiOS)\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'],
        [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'], [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
        [/Version\/(\d+).*Safari\//, 'Safari'],
    ] ) {
        const match = ua.match(pattern);
        if ( match ) return { family, major: integer(Number(match[1])) };
    }
}

function os_family () {
    const ua = navigator.userAgent || '';
    if ( /iPhone|iPad|iPod/.test(ua) ) return 'iOS';
    if ( /Android/.test(ua) ) return 'Android';
    if ( /Windows/.test(ua) ) return 'Windows';
    if ( /CrOS/.test(ua) ) return 'Chrome OS';
    if ( /Macintosh|Mac OS X/.test(ua) ) return 'macOS';
    if ( /Linux/.test(ua) ) return 'Linux';
}

/** @returns {object} Matches diagnosticsSchema; absent information is omitted. */
export function build_diagnostics (appContext) {
    const result = {};
    const trace = feedbackTraceSnapshot();
    const captured = Date.now();
    const expanded = globalThis.window?.__EZIL_BOOT__?.desktopState?.ui?.feedbackReportBundle === true;
    if (expanded) {
        result.session = { capturedAt: new Date(captured).toISOString(),
            pageAgeMs: integer(globalThis.performance?.now?.() ?? 0), online: navigator.onLine !== false,
            visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible' };
        const connection = navigator.connection;
        if (connection) {
            const network = {};
            if (['slow-2g', '2g', '3g', '4g'].includes(connection.effectiveType)) network.effectiveType = connection.effectiveType;
            if (typeof connection.saveData === 'boolean') network.saveData = connection.saveData;
            result.session.network = network;
        }
        result.tracePhases = trace?.phases ?? [];
        if (trace?.app) result.traceApp = trace.app;
    }
    const version = globalThis.ezil?.version;
    if ( typeof version === 'string' || typeof version === 'number' ) result.shellVersion = String(version).slice(0, 64);
    const agent = browser();
    if ( agent ) result.browser = agent;
    const os = os_family();
    if ( os ) result.os = os;
    result.deviceClass = document.body.classList.contains('device-phone') ? 'phone'
        : document.body.classList.contains('device-tablet') ? 'tablet' : 'desktop';
    if ( [window.innerWidth, window.innerHeight, window.devicePixelRatio].every(Number.isFinite) ) {
        result.viewport = { w: integer(window.innerWidth), h: integer(window.innerHeight),
            dpr: Math.min(16, Math.max(0, window.devicePixelRatio)) };
    }
    result.fullscreen = !! document.fullscreenElement;
    result.fullbleed = [...document.querySelectorAll('.ezil-fullbleed')].some(visible);
    if (trace) result.traceId = trace.id;
    // Expanded phase snapshots above never finish the active app-open.
    const events = recentEvents().slice(-50)
        .filter(event => ['eventClass', 'site', 'code'].every(key => typeof event[key] === 'string'
            && /^[a-zA-Z0-9_:#/.-]+$/.test(event[key]) && !event[key].includes('://') && !/[a-f0-9]{24,}/i.test(event[key])));
    // FEEDBACK-DIAG: `{code, reason, correlationId}` of a failed API call. Both
    // extra fields are re-checked against the allowlist, emitted only when
    // present, only on the newest MAX_ANNOTATED_EVENTS that have them, and only
    // to a server that advertises them (`event_diagnostics_accepted`).
    const annotated = new Set();
    const accepted = event_diagnostics_accepted();
    for ( let i = events.length - 1; accepted && i >= 0 && annotated.size < MAX_ANNOTATED_EVENTS; i-- ) {
        if ( isFailureReason(events[i].reason) || isCorrelationId(events[i].serverCorrelationId) ) annotated.add(i);
    }
    result.recentEvents = events.map((event, i) => {
        const out = { eventClass: event.eventClass.slice(0, 40), site: event.site.slice(0, 80), code: event.code.slice(0, 80) };
        if ( expanded && Number.isFinite(event.t) ) out.ageMs = integer(captured - event.t);
        if ( annotated.has(i) ) {
            if ( isFailureReason(event.reason) ) out.reason = event.reason;
            if ( isCorrelationId(event.serverCorrelationId) ) out.correlationId = event.serverCorrelationId;
        }
        return out;
    });

    if (app_failure_diagnostics_accepted()) {
        const context = app_failures_for(appContext);
        if (context.available) result.appFailures = context.failures;
    }
    return result;
}

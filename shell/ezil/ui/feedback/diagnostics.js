// diagnostics.js — EZiL-authored. Feedback's small, explicit allowlist.
// No general-purpose state dump: even telemetry's redacted detail is excluded.
import { ambientCorrelationId } from '../../trace.js';
import { recentEvents } from '../../telemetry.js';
import { isCorrelationId, isFailureReason } from '../../failure-diagnostics.js';

/**
 * FEEDBACK-DIAG: at most this many recent events — the newest — carry the
 * server's `reason`/`correlationId`. Keeps the worst case well inside the
 * 32 KiB no-screenshot body. Mirrors `FEEDBACK_LIMITS.recentEventsAnnotatedMax`.
 */
const MAX_ANNOTATED_EVENTS = 10;

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
export function build_diagnostics () {
    const result = {};
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
    const status = [...document.querySelectorAll('.window[data-app="desktop"] .ezil-drawer-status, .window[data-app="desktop"] .ezil-boot-title')]
        .find(el => visible(el) && el.textContent.trim());
    if ( status ) result.computerStatus = status.textContent.trim().slice(0, 32);
    const traceId = ambientCorrelationId();
    if ( typeof traceId === 'string' ) result.traceId = traceId.slice(0, 64);
    // trace.js exposes no non-mutating breadcrumb snapshot. Calling end() here
    // would finish the user's app-open; omit phases until a read API exists.
    const events = recentEvents().slice(-50)
        .filter(event => ['eventClass', 'site', 'code'].every(key => typeof event[key] === 'string'));
    // FEEDBACK-DIAG: `{code, reason, correlationId}` of a failed API call. Both
    // extra fields are re-checked against the allowlist, emitted only when
    // present, and only on the newest MAX_ANNOTATED_EVENTS that have them.
    const annotated = new Set();
    for ( let i = events.length - 1; i >= 0 && annotated.size < MAX_ANNOTATED_EVENTS; i-- ) {
        if ( isFailureReason(events[i].reason) || isCorrelationId(events[i].serverCorrelationId) ) annotated.add(i);
    }
    result.recentEvents = events.map((event, i) => {
        const out = { eventClass: event.eventClass.slice(0, 40), site: event.site.slice(0, 80), code: event.code.slice(0, 80) };
        if ( annotated.has(i) ) {
            if ( isFailureReason(event.reason) ) out.reason = event.reason;
            if ( isCorrelationId(event.serverCorrelationId) ) out.correlationId = event.serverCorrelationId;
        }
        return out;
    });

    // The stream controllers keep vitals private. Read ONLY the two numeric
    // measurements Settings already renders, without requesting new samples.
    const stream = {};
    for ( const row of document.querySelectorAll('.ezil-settings-system .ezil-sys-row') ) {
        const label = row.querySelector('.ezil-sys-k')?.textContent;
        const key = label === 'Bitrate' ? 'kbps' : label === 'Round trip' ? 'rttMs' : null;
        if ( ! key ) continue;
        const value = row.querySelector('.ezil-sys-v')?.textContent?.trim();
        if ( ! /^\d+(?:\.\d+)? (?:kbit\/s|ms)$/.test(value || '') ) continue;
        stream[key] = integer(parseFloat(value));
    }
    if ( Object.keys(stream).length ) result.stream = stream;
    return result;
}

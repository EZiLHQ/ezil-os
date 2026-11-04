// diagnostics.js — EZiL-authored. Feedback's small, explicit allowlist.
// No general-purpose state dump. Telemetry events are reduced to the CLOSED
// vocabulary in `app/src/server/feedback/event-vocabulary.js` (known class and
// site, listed code, else left out or `other`); no console text, event detail
// or error message is ever part of a report. The server applies the same
// projection again (`redact.ts`), whatever the shell sent.
import { ambientCorrelationId } from '../../trace.js';
import { recentEvents } from '../../telemetry.js';
import { routeName } from '../../app-link.js';
import { projectEvent, projectLogLine } from '../../../../app/src/server/feedback/event-vocabulary.js';

const integer = value => Math.min(1_000_000_000, Math.max(0, Math.round(value)));

/** Registry ids (`apps/registry.js` APPS) a report may name; anything else is left out. */
export const APP_IDS = Object.freeze(['desktop', 'code', 'settings', 'app-store', 'preview', 'secure-browser']);
/** The activity-log bounds: this tab's last 15 minutes, at most 60 events. */
export const LOG_WINDOW_MS = 15 * 60 * 1000;
export const LOG_MAX_LINES = 60;

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

/**
 * The app the report is about, by its address name (`/app/browser` →
 * `browser`). Settings is where Feedback is opened from, so it is named only
 * when no other app window is open; otherwise the shown window with the
 * highest z-index wins, then a minimised one (the Browser someone minimised
 * before reporting it). Read from `data-app` and checked against `APP_IDS`;
 * never a URL, an iframe `src` or a folder.
 */
function front_app () {
    let best = null;
    for ( const el of document.querySelectorAll('.window[data-app]:not(.window-alert):not(.window-filedialog)') ) {
        const id = el.getAttribute('data-app');
        if ( ! APP_IDS.includes(id) || el.getAttribute('data-closing') === '1' ) continue;
        const minimised = ['true', '1'].includes(el.getAttribute('data-is_minimized'));
        const shown = ! minimised && visible(el);
        if ( ! minimised && ! shown ) continue;
        const z = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
        const rank = [id === 'settings' ? 0 : 1, shown ? 1 : 0, Number.isFinite(z) ? z : 0];
        // Compared in order; a tie goes to the later window in the document.
        const differs = best ? rank.findIndex((value, i) => value !== best.rank[i]) : -1;
        if ( ! best || differs === -1 || rank[differs] > best.rank[differs] ) best = { id, rank };
    }
    return best === null ? null : routeName(best.id);
}

/**
 * @param {{ extended?: boolean, counts?: { omitted?: number } }} [options]
 *   `extended` adds the fields only a server that sets
 *   `desktopState.ui.feedbackLogs` accepts (today: `app`). `counts.omitted`
 *   receives how many recorded events were left out as unrecognised.
 * @returns {object} Matches diagnosticsSchema; absent information is omitted.
 */
export function build_diagnostics ({ extended = false, counts = {} } = {}) {
    const result = {};
    const version = globalThis.ezil?.version;
    if ( typeof version === 'string' || typeof version === 'number' ) result.shellVersion = String(version).slice(0, 64);
    if ( extended ) {
        const app = front_app();
        if ( app ) result.app = app.slice(0, 32);
    }
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
    const events = recentEvents().slice(-50);
    result.recentEvents = events.map(projectEvent).filter(Boolean);
    counts.omitted = events.length - result.recentEvents.length;

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

/**
 * The "Recent activity log" a user may add to a report: this tab's recorded
 * events (`telemetry.recentEvents()`) from the last `LOG_WINDOW_MS`, with
 * their time and outcome, reduced to the closed vocabulary, oldest first, at
 * most `LOG_MAX_LINES`. The console ring is not read: its text is free-form.
 * Throws when the events cannot be read; the form reports that and sends without.
 * @param {{ now?: number, counts?: { omitted?: number } }} [options]
 * @returns {Array<{ t: string, eventClass: string, site: string, code: string, outcome: string }>}
 */
export function build_recent_logs ({ now = Date.now(), counts = {} } = {}) {
    const since = now - LOG_WINDOW_MS;
    const recent = recentEvents().filter(event => Number.isFinite(event?.t) && event.t >= since && event.t <= now + 1000);
    const lines = recent
        .map(event => projectLogLine({ ...event, t: new Date(event.t).toISOString() }))
        .filter(Boolean)
        .sort((a, b) => a.t.localeCompare(b.t));
    counts.omitted = recent.length - lines.length;
    return lines.slice(-LOG_MAX_LINES);
}

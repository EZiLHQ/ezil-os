// diagnostics.js — EZiL-authored. Feedback's small, explicit allowlist.
// No general-purpose state dump: even telemetry's redacted detail is excluded.
// The one exception is `build_recent_logs`, which the user ticks separately
// ("Recent activity log"); every line it returns is redacted and bounded.
import { ambientCorrelationId } from '../../trace.js';
import { recentEvents, redact } from '../../telemetry.js';
import log from '../../log.js';
import { routeName } from '../../app-link.js';
import { scan } from './secret-scan.js';

const integer = value => Math.min(1_000_000_000, Math.max(0, Math.round(value)));

/** Registry ids (`apps/registry.js` APPS) a report may name; anything else is left out. */
export const APP_IDS = Object.freeze(['desktop', 'code', 'settings', 'app-store', 'preview', 'secure-browser']);
/** The recent-log bounds: this tab's last 15 minutes, at most 60 lines of 200 characters. */
export const LOG_WINDOW_MS = 15 * 60 * 1000;
export const LOG_MAX_LINES = 60;
export const LOG_LINE_MAX = 200;

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
 * The app in front, by its address name (`/app/browser` → `browser`): of the
 * open, rendered, not minimised app windows, the one with the highest z-index.
 * Read from `data-app` and checked against `APP_IDS`; never a URL, an iframe
 * `src` or a folder.
 */
function front_app () {
    let front = null;
    let front_z = -Infinity;
    for ( const el of document.querySelectorAll('.window[data-app]:not(.window-alert):not(.window-filedialog)') ) {
        const id = el.getAttribute('data-app');
        if ( ! APP_IDS.includes(id) || el.getAttribute('data-closing') === '1'
            || ['true', '1'].includes(el.getAttribute('data-is_minimized')) || ! visible(el) ) continue;
        const z = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
        const zz = Number.isFinite(z) ? z : 0;
        if ( zz >= front_z ) { front = id; front_z = zz; }
    }
    return front === null ? null : routeName(front);
}

/**
 * @param {{ extended?: boolean }} [options] `extended` adds the fields only a
 *   server that sets `desktopState.ui.feedbackLogs` accepts (today: `app`).
 * @returns {object} Matches diagnosticsSchema; absent information is omitted.
 */
export function build_diagnostics ({ extended = false } = {}) {
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
    result.recentEvents = recentEvents().slice(-50)
        .filter(event => ['eventClass', 'site', 'code'].every(key => typeof event[key] === 'string'))
        .map(event => ({ eventClass: event.eventClass.slice(0, 40), site: event.site.slice(0, 80), code: event.code.slice(0, 80) }));

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
 * One log line made safe to send: telemetry's `redact()` (links, paths, ids,
 * addresses, header and token shapes; 200 characters), then every match the
 * form's own secret scan still finds (emails, JWTs, keys) is replaced too.
 */
function scrub (text) {
    let s = redact(text) ?? '';
    for ( const match of scan(s).reverse() ) {
        const rest = s.slice(match.index);
        const length = rest.match(/^[^\s'"<>,;)]+/)?.[0].length ?? 0;
        if ( length ) s = `${s.slice(0, match.index)}[redacted]${rest.slice(length)}`;
    }
    return s.slice(0, LOG_LINE_MAX);
}

/**
 * The "Recent activity log" a user may add to a report: this tab's console
 * ring (`log.js`) and recorded events (`telemetry.recentEvents()`), from the
 * last `LOG_WINDOW_MS`, oldest first, at most `LOG_MAX_LINES`. Both rings live
 * only in this page; nothing from another tab, an app's iframe or the server.
 * Throws when a ring cannot be read; the form reports that and sends without.
 * @returns {Array<{ t: string, source: 'console'|'event', text: string }>}
 */
export function build_recent_logs ({ now = Date.now() } = {}) {
    const since = now - LOG_WINDOW_MS;
    const lines = [];
    const add = (t, source, text) => {
        if ( ! Number.isFinite(t) || t < since || t > now + 1000 ) return;
        const safe = scrub(text);
        if ( safe ) lines.push({ at: t, line: { t: new Date(t).toISOString(), source, text: safe } });
    };
    for ( const entry of log.ringBuffer() ) add(entry?.t, 'console', `${entry?.level ?? ''} ${entry?.msg ?? ''}`.trim());
    for ( const event of recentEvents() ) {
        add(event?.t, 'event', [event?.eventClass, event?.site, event?.code, event?.outcome, event?.detail]
            .filter(part => typeof part === 'string' && part).join(' '));
    }
    lines.sort((a, b) => a.at - b.at);
    return lines.slice(-LOG_MAX_LINES).map(item => item.line);
}

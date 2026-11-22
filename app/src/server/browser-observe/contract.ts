import { z } from 'zod';

export const BROWSER_OBSERVE_SCOPE = 'ezil:browser:read';
export const BROWSER_OBSERVE_PROCEDURE = 'browserSession.observe';
export const BROWSER_OBSERVE_PATH = /^\/api\/mcp\/browser-sessions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/observe$/;
export const BROWSER_STAGING_MCP = 'https://connect-staging.ezil.work';
export const BROWSER_STAGING_OS = 'https://os-staging.ezil.work';
export const BROWSER_STAGING_WORKER = 'https://api-desktop-staging.ezil.work';
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const browserObserveRequest = z.object({ browserSessionId: sessionId.optional() }).strict();
export type BrowserObserveRequest = z.infer<typeof browserObserveRequest>;
export const browserObserveSuccess = z.object({
    ok: z.literal(true),
    browserSessionId: sessionId,
    expiresAt: z.string().datetime({ precision: 3 }),
    observed: z.enum(['profile_builder', 'interactive_sign_in_required']),
    profileHeadingVisible: z.boolean(),
    universeIdentity: z.literal('unverified'),
}).strict();
export const browserRuntimeFailure = z.object({
    ok: z.literal(false),
    error: z.enum(['browser_page_unavailable', 'browser_session_stale', 'browser_unavailable']),
}).strict();

export const BROWSER_PAGE_SCOPE = 'ezil:browser:page:read';
export const BROWSER_PAGE_PROCEDURE = 'browserSession.readPage';
export const BROWSER_CONTROL_SCOPE = 'ezil:browser:control';
export const BROWSER_CONTROL_PROCEDURE = 'browserSession.control';
export const BROWSER_UI_FIXTURE_PATH = '/browser-mcp-fixture.html';
export const BROWSER_UI_FIXTURE_ORIGIN = BROWSER_STAGING_OS;

/*
 * Browser verbs v2 (docs/contracts/browser-verbs-v2.md §4): the modern read and control wires, declared exactly as
 * ezil-mcp `src/tools/workflow-browser.ts` declares them, so what the MCP sends this accepts and what this answers the
 * MCP accepts. The legacy observation above is untouched.
 */

/** A modern answer carries up to 64 elements and a masked JPEG; the MCP reads it under 160 KiB. */
export const BROWSER_UI_RESULT_MAX_BYTES = 160 * 1024;
/**
 * A modern request: the largest is `fill_form`, 20 fields of up to 4000 characters, which JSON can spell as up to
 * 24,000 bytes each (`\uXXXX` escapes). 512 KiB holds the worst case the schema below admits.
 */
export const BROWSER_UI_REQUEST_MAX_BYTES = 512 * 1024;

/** PRESS_KEYS and SENSITIVE_URL_PARAMS restate the sidecar's `contract.mjs` exactly. */
export const PRESS_KEYS = ['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const;
export const SENSITIVE_URL_PARAMS = ['code', 'state', 'id_token', 'access_token', 'refresh_token', 'token',
    'session_transfer_token', 'nonce', 'ticket', 'code_verifier'] as const;
export const TYPED_TEXT_MAX_CHARS = 4000;
export const TYPED_TEXT_MAX_BYTES = 16 * 1024;
export const FILL_FORM_MAX_FIELDS = 20;
export const SELECT_MAX_VALUES = 20;
export const SELECT_VALUE_MAX_CHARS = 200;
export const SCROLL_MAX_DY = 5000;
export const PAGE_ELEMENTS_MAX = 64;
export const SELECT_OPTIONS_MAX = 20;
export const OWNER_APP_EMAIL_MAX_CHARS = 254;
export const VIEWER_FRAME_MAX_BASE64_CHARS = 80_000;
export const VIEWER_FRAME_MAX_RAW_BYTES = 60_000;
/** The EZiL ID host: reached only by redirect, never a navigate target, never shown with a query. */
const EZIL_ID_HOST = 'id.ezil.work';
/** Frames exist for approved public pages, the Universe profile builder and owner-app pages: never the shell or sign-in. */
const FRAME_PAGES: ReadonlySet<string> = new Set(['approved_page', 'profile_builder', 'owner_app_page']);
/** The owner app shows its signed-in account e-mail only on its own pages. */
const OWNER_APP_PAGES: ReadonlySet<string> = new Set(['profile_builder', 'owner_app_page']);
const SENSITIVE: ReadonlySet<string> = new Set(SENSITIVE_URL_PARAMS);

const requestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const elementRef = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const isoInstant = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const noControl = (value: string) => !/[\r\n\u{2028}\u{2029}\x00-\x1f\x7f]/u.test(value);
function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}
/** The EZiL ID host on its default port. */
const isEzilId = (url: URL) => url.hostname.replace(/\.$/, '') === EZIL_ID_HOST && url.port === '';
const navigateUrl = z.string().max(2048).refine(value => {
    const parsed = parseUrl(value);
    return parsed !== null && parsed.protocol === 'https:' && parsed.href.length <= 2048 && !parsed.username
        && !parsed.password && !/\s/u.test(value) && noControl(value) && !isEzilId(parsed)
        && !/^(?:localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(parsed.hostname) && !/\.local$/i.test(parsed.hostname);
}, 'Use an approved public HTTPS page URL without embedded credentials. The EZiL ID sign-in is reached only by redirect.');
/** Typed text may hold line feeds and tabs. Every other control character (C0, DEL, C1) and U+2028/U+2029 is refused. */
const typedTextForbidden = /(?![\n\t])[\p{Cc}\u{2028}\u{2029}]/u;
const typedText = z.string().min(1).max(TYPED_TEXT_MAX_CHARS).refine(value => !typedTextForbidden.test(value)
    && new TextEncoder().encode(value).length <= TYPED_TEXT_MAX_BYTES,
'Text is 1 to 4000 characters and at most 16 KiB of UTF-8. Line feeds and tabs are allowed; other control characters are not.');
/**
 * Off owner-app pages the v1 bound holds (contract §4): 1 to 80 characters with no line break, as before verbs v2.
 * Only the sidecar knows which page a request lands on, so it enforces this there; it is declared here as the rule.
 */
export const browserPublicPageText = z.string().min(1).max(80).regex(/^[\p{L}\p{N} .,!?'_-]+$/u)
    .refine(value => Buffer.byteLength(value, 'utf8') <= 256);
const selectValue = z.string().min(1).max(SELECT_VALUE_MAX_CHARS)
    .refine(noControl, 'Option labels and values have no line breaks or control characters.');
const uniqueRefs = (items: readonly { ref: string }[]) => new Set(items.map(item => item.ref)).size === items.length;

/**
 * The exact control union (contract §4). No selector, script, coordinate, upload, raw CDP or relay: refs come from the
 * page's last listing and keys from PRESS_KEYS. A scroll names exactly one of a ref or a dy.
 */
const action = z.union([
    z.object({ kind: z.literal('navigate'), url: navigateUrl }).strict(),
    z.object({ kind: z.literal('click'), ref: elementRef }).strict(),
    z.object({ kind: z.literal('type'), ref: elementRef, text: typedText }).strict(),
    z.object({ kind: z.literal('fill_form'), fields: z.array(z.object({ ref: elementRef, text: typedText }).strict())
        .min(1).max(FILL_FORM_MAX_FIELDS).refine(uniqueRefs, 'Each field ref appears once.') }).strict(),
    z.object({ kind: z.literal('select'), ref: elementRef, values: z.array(selectValue).min(1).max(SELECT_MAX_VALUES) }).strict(),
    z.object({ kind: z.literal('scroll'), ref: elementRef }).strict(),
    z.object({ kind: z.literal('scroll'), dy: z.number().int().min(-SCROLL_MAX_DY).max(SCROLL_MAX_DY) }).strict(),
    z.object({ kind: z.literal('press'), key: z.enum(PRESS_KEYS), ref: elementRef.optional() }).strict(),
]);
const readAction = z.object({ kind: z.literal('read'), includeFrame: z.boolean().optional() }).strict();

/** A read (the MCP's `browser_read_page`) or one typed action (`browser_action`). */
export const browserUiRequest = z.union([
    z.object({ browserSessionId: sessionId.optional(), action: readAction }).strict(),
    z.object({ browserSessionId: sessionId, action, requestId }).strict(),
]);
export const browserSessionRequest = z.union([browserObserveRequest, browserUiRequest]);
export type BrowserSessionRequest = z.infer<typeof browserSessionRequest>;
export type BrowserUiRequest = z.infer<typeof browserUiRequest>;

/** Canonical credential-free HTTPS. The sidecar sends origin + path; see sanitizeBrowserPageUrl. */
const pageUrl = z.string().max(2048).refine(value => {
    const parsed = parseUrl(value);
    return parsed !== null && parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.href === value
        && noControl(value);
}).nullable();
const label = z.string().min(1).max(80).refine(value => noControl(value) && value.trim() === value);
/** Listed elements: never a password input, and never an href. */
const element = z.union([
    z.object({ ref: elementRef, kind: z.enum(['button', 'link', 'text_input', 'textarea', 'checkbox']), label }).strict(),
    z.object({ ref: elementRef, kind: z.literal('select'), label,
        options: z.array(z.string().max(80).refine(noControl)).max(SELECT_OPTIONS_MAX) }).strict(),
]);
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const viewerFrame = z.object({
    mimeType: z.literal('image/jpeg'),
    base64: z.string().min(4).max(VIEWER_FRAME_MAX_BASE64_CHARS).refine(value => value.length % 4 === 0 && base64.test(value)
        // Raw size from base64 length, exact to the padding: ((n / 4) * 3) - padding.
        && (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <= VIEWER_FRAME_MAX_RAW_BYTES
        // A JPEG starts with the SOI marker FF D8 FF, whose base64 is "/9j/".
        && value.startsWith('/9j/')),
}).strict().nullable();
const observed = z.enum(['browser_ready', 'approved_page', 'profile_builder', 'owner_app_page', 'interactive_sign_in_required']);
export const browserUiSuccess = z.object({
    ok: z.literal(true),
    browserSessionId: sessionId,
    expiresAt: isoInstant,
    observed,
    profileHeadingVisible: z.boolean(),
    // The OS never decides identity (contract §5): the MCP does.
    universeIdentity: z.literal('unverified'),
    pageUrl,
    pageTitle: z.string().max(120).refine(noControl).nullable(),
    elements: z.array(element).max(PAGE_ELEMENTS_MAX).refine(uniqueRefs),
    viewerFrame,
    // Optional: an OS without browser verbs v2 omits it.
    ownerAppAccountEmail: z.string().max(OWNER_APP_EMAIL_MAX_CHARS).nullable().optional(),
}).strict().refine(value => value.observed !== 'browser_ready' || (value.pageUrl === null && value.pageTitle === null && value.elements.length === 0))
    .refine(value => value.viewerFrame === null || FRAME_PAGES.has(value.observed))
    // The IdP is transit only: no heading and no ref to act on.
    .refine(value => value.observed !== 'interactive_sign_in_required' || (!value.profileHeadingVisible && value.elements.length === 0))
    .refine(value => value.ownerAppAccountEmail == null || OWNER_APP_PAGES.has(value.observed));
export type BrowserUiSuccess = z.infer<typeof browserUiSuccess>;
/** What the sidecar may answer instead; the receiver maps each to its HTTP status. */
export const browserUiFailure = z.object({
    ok: z.literal(false),
    error: z.enum(['browser_page_unavailable', 'browser_session_stale', 'browser_unavailable', 'browser_invalid_request',
        'browser_action_unavailable', 'browser_action_uncertain', 'browser_action_conflict', 'browser_action_pending',
        'origin_read_only']),
}).strict();

/** A query or fragment names a sensitive parameter: raw or percent-decoded once, split at `&`, `;`, `?` and `#`. */
function namesSensitiveParameter(part: string): boolean {
    let decoded = part;
    try {
        decoded = decodeURIComponent(part);
    } catch { /* A malformed escape is checked raw. */ }
    return [part, decoded].some(text => text.split(/[&;?#]/)
        .some(token => SENSITIVE.has((token.split('=', 1)[0] ?? '').trim().toLowerCase())));
}

/**
 * Every page URL the OS answers with, as `workflow-browser.ts` `sanitizePageUrl` treats it (contract §2, §4): an
 * EZiL ID URL keeps only its origin and path, and a URL whose query or fragment names a SENSITIVE_URL_PARAMS
 * parameter loses its whole query and fragment. The sidecar has already done this at its source.
 */
export function sanitizeBrowserPageUrl(value: string | null): string | null {
    if (value === null) return null;
    const parsed = parseUrl(value);
    if (parsed === null) return null;
    if (isEzilId(parsed) || namesSensitiveParameter(parsed.search.slice(1)) || namesSensitiveParameter(parsed.hash.slice(1))) {
        return parsed.origin + parsed.pathname;
    }
    return value;
}

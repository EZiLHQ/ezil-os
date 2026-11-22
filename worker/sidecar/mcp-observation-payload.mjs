/**
 * THE CLOSED BROWSER UI PROJECTION — what `/internal/mcp-browser-observe` may
 * answer to a v2 read or action, member by member (browser verbs v2 §4).
 *
 * `server.mjs` writes this object and nothing else for the modern observation
 * route, so whatever a reader or an action produced, only these members, in
 * these bounds, leave. It mirrors the App's `browser-observe/contract.ts` and
 * ezil-mcp `workflow-browser.ts`, and is stricter where the sidecar can be:
 * page URLs are origin + path, labels are trimmed and free of control and
 * bidi characters, and the whole answer fits `BROWSER_UI_RESULT_MAX_BYTES`.
 */
const SESSION = /^[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_-]{22}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OBSERVED = new Set(['browser_ready', 'approved_page', 'profile_builder', 'owner_app_page', 'interactive_sign_in_required']);
/** The pages that may carry a title, elements and the masked frame. Never the neutral shell or a sign-in page. */
const CONTENT_PAGES = new Set(['approved_page', 'profile_builder', 'owner_app_page']);
/** At most 64 elements on owner-app pages, 16 elsewhere. */
const ELEMENTS_MAX = { approved_page: 16, profile_builder: 64, owner_app_page: 64 };
const KINDS = new Set(['button', 'link', 'text_input', 'textarea', 'select', 'checkbox']);
const OPTIONS_MAX = 20;
const FAILURES = new Set(['browser_invalid_request', 'browser_page_unavailable', 'browser_session_stale',
    'browser_unavailable', 'browser_action_unavailable', 'browser_action_uncertain', 'browser_action_conflict', 'browser_action_pending',
    'origin_read_only']);
const DESKTOP_CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const FRAME_MAX_BASE64 = 80_000;
const FRAME_MAX_BYTES = 60_000;
const EMAIL_MAX = 254;

/** The MCP reads a modern answer under 160 KiB; this answer is never larger (contract §4). */
export const BROWSER_UI_RESULT_MAX_BYTES = 160 * 1024;

function confidentialFailure () {
    return { ok: false, error: 'browser_unavailable' };
}

function validLabel (value, max, min = 0) {
    return typeof value === 'string' && value.length >= min && value.length <= max && !DESKTOP_CONTROL.test(value);
}

function validUrl (value) {
    if (typeof value !== 'string' || value.length > 2048 || DESKTOP_CONTROL.test(value)) return false;
    try {
        const url = new URL(value);
        // An explicit port is allowed: owner-app origins may name one.
        return url.protocol === 'https:' && url.href === value && !url.username && !url.password
            && !url.search && !url.hash;
    } catch {
        return false;
    }
}

function validFrame (frame) {
    if (frame?.mimeType !== 'image/jpeg' || typeof frame.base64 !== 'string' || frame.base64.length < 4
        || frame.base64.length > FRAME_MAX_BASE64 || !BASE64.test(frame.base64) || !frame.base64.startsWith('/9j/')) return false;
    const padding = frame.base64.endsWith('==') ? 2 : frame.base64.endsWith('=') ? 1 : 0;
    return (frame.base64.length / 4) * 3 - padding <= FRAME_MAX_BYTES;
}

/** One listed element, closed: `ref`, `kind`, `label`, and `options` on a select only. Never an href. */
function element (item) {
    if (typeof item?.ref !== 'string' || !REF.test(item.ref) || !KINDS.has(item.kind)
        || !validLabel(item.label, 80, 1) || item.label.trim() !== item.label) return null;
    if (item.kind !== 'select') return item.options === undefined ? { ref: item.ref, kind: item.kind, label: item.label } : null;
    if (!Array.isArray(item.options) || item.options.length > OPTIONS_MAX
        || !item.options.every(option => validLabel(option, 80))) return null;
    return { ref: item.ref, kind: item.kind, label: item.label, options: [...item.options] };
}

/** Project closed page data, never serialise a raw browser response or viewer credentials. */
export function browserUiPayload (value) {
    if (value?.ok === false && FAILURES.has(value.error)) return { ok: false, error: value.error };
    const email = value?.ownerAppAccountEmail ?? null;
    if (value?.ok !== true || typeof value.browserSessionId !== 'string' || !SESSION.test(value.browserSessionId)
        || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)
        || !OBSERVED.has(value.observed) || typeof value.profileHeadingVisible !== 'boolean'
        || value.profileHeadingVisible && value.observed !== 'profile_builder'
        || (value.pageUrl !== null && !validUrl(value.pageUrl))
        || (value.observed === 'browser_ready' && value.pageUrl !== null)
        || (value.observed === 'approved_page' && value.pageUrl === null)
        || (value.pageTitle !== null && !validLabel(value.pageTitle, 120))
        || !Array.isArray(value.elements) || value.elements.length > (ELEMENTS_MAX[value.observed] ?? 0)
        || (!CONTENT_PAGES.has(value.observed) && (value.pageTitle !== null || value.elements.length || value.viewerFrame !== null))
        || (value.observed === 'approved_page' && value.pageTitle === null)
        // The account e-mail is read only on the Universe profile builder (contract §4).
        || (email !== null && (value.observed !== 'profile_builder' || !validLabel(email, EMAIL_MAX, 1)))) return confidentialFailure();
    const elements = [];
    for (const item of value.elements) {
        const projected = element(item);
        if (!projected) return confidentialFailure();
        elements.push(projected);
    }
    if (new Set(elements.map(item => item.ref)).size !== elements.length) return confidentialFailure();
    let viewerFrame = null;
    if (value.viewerFrame !== null) {
        if (!validFrame(value.viewerFrame)) return confidentialFailure();
        viewerFrame = { mimeType: 'image/jpeg', base64: value.viewerFrame.base64 };
    }
    const projected = { ok: true, browserSessionId: value.browserSessionId, expiresAt: value.expiresAt, observed: value.observed,
        profileHeadingVisible: value.profileHeadingVisible, universeIdentity: 'unverified', pageUrl: value.pageUrl,
        pageTitle: value.pageTitle, elements, viewerFrame, ownerAppAccountEmail: email };
    // The last line of the size bound: the readers trim first (`fitBrowserUiResult`), this never lets more out.
    return Buffer.byteLength(JSON.stringify(projected), 'utf8') <= BROWSER_UI_RESULT_MAX_BYTES ? projected : confidentialFailure();
}

const projectedBytes = value => Buffer.byteLength(JSON.stringify(browserUiPayload(value)), 'utf8');

/**
 * Fit a successful result under `limit` bytes as it will be written: trim the
 * element list from the end (spending each dropped element's handle), then
 * drop the frame, and only then give up (null). Never exceeds the bound.
 */
export function fitBrowserUiResult (result, refs, limit = BROWSER_UI_RESULT_MAX_BYTES) {
    const unbounded = { ...result, elements: [...result.elements] };
    const measure = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
    // Measured on the closed projection without the backstop, so trimming can see past it.
    const raw = value => {
        const projected = browserUiPayload({ ...value, elements: [] });
        if (projected.ok !== true) return Infinity;
        return measure({ ...projected, elements: value.elements.map(item => element(item)) });
    };
    let size = raw(unbounded);
    if (size === Infinity) return result;
    if (size <= limit) return unbounded;
    while (unbounded.elements.length > 0 && size > limit) {
        const dropped = unbounded.elements.pop();
        size -= measure(element(dropped)) + (unbounded.elements.length > 0 ? 1 : 0);
        const record = refs?.get(dropped.ref);
        refs?.delete(dropped.ref);
        if (record?.element && typeof record.element.dispose === 'function') void record.element.dispose().catch(() => {});
    }
    if (size > limit && unbounded.viewerFrame) {
        unbounded.viewerFrame = null;
        size = raw(unbounded);
    }
    return size <= limit && projectedBytes(unbounded) <= limit ? unbounded : null;
}

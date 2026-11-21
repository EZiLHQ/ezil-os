const SESSION = /^[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_-]{22}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OBSERVED = new Set(['browser_ready', 'approved_page', 'profile_builder', 'interactive_sign_in_required']);
const KINDS = new Set(['button', 'link', 'text_input']);
const FAILURES = new Set(['browser_invalid_request', 'browser_page_unavailable', 'browser_session_stale',
    'browser_unavailable', 'browser_action_unavailable', 'browser_action_uncertain', 'browser_action_conflict', 'browser_action_pending']);
const DESKTOP_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

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
        return url.protocol === 'https:' && url.href === value && !url.username && !url.password
            && !url.port && !url.search && !url.hash;
    } catch {
        return false;
    }
}

/** Project closed page data, never serialise a raw browser response or viewer credentials. */
export function browserUiPayload (value) {
    if (value?.ok === false && FAILURES.has(value.error)) return { ok: false, error: value.error };
    if (value?.ok !== true || typeof value.browserSessionId !== 'string' || !SESSION.test(value.browserSessionId)
        || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)
        || !OBSERVED.has(value.observed) || typeof value.profileHeadingVisible !== 'boolean'
        || value.profileHeadingVisible && value.observed !== 'profile_builder'
        || (value.pageUrl !== null && !validUrl(value.pageUrl))
        || (value.observed === 'browser_ready' && value.pageUrl !== null)
        || (value.observed === 'approved_page' && value.pageUrl === null)
        || (value.pageTitle !== null && !validLabel(value.pageTitle, 120))
        || !Array.isArray(value.elements) || value.elements.length > 16
        || (value.observed !== 'approved_page' && (value.pageTitle !== null || value.elements.length || value.viewerFrame !== null))
        || (value.observed === 'approved_page' && value.pageTitle === null)) return confidentialFailure();
    const elements = [];
    for (const item of value.elements) {
        if (typeof item?.ref !== 'string' || !REF.test(item.ref) || !KINDS.has(item.kind) || !validLabel(item.label, 80, 1)) {
            return confidentialFailure();
        }
        elements.push({ ref: item.ref, kind: item.kind, label: item.label });
    }
    if (new Set(elements.map(item => item.ref)).size !== elements.length) return confidentialFailure();
    let viewerFrame = null;
    if (value.viewerFrame !== null) {
        const frame = value.viewerFrame;
        if (frame?.mimeType !== 'image/jpeg' || typeof frame.base64 !== 'string' || frame.base64.length < 4
            || frame.base64.length > 80_000 || !BASE64.test(frame.base64)) return confidentialFailure();
        viewerFrame = { mimeType: 'image/jpeg', base64: frame.base64 };
    }
    return { ok: true, browserSessionId: value.browserSessionId, expiresAt: value.expiresAt, observed: value.observed,
        profileHeadingVisible: value.profileHeadingVisible, universeIdentity: 'unverified', pageUrl: value.pageUrl,
        pageTitle: value.pageTitle, elements, viewerFrame };
}

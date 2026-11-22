/**
 * OWNER-APP CONTROL — browser verbs v2 §4, the sidecar half.
 *
 * The approved Browser tab may be on one of the user's own signed-in apps
 * (an `owner_app` origin; staging: Universe) or passing through the identity
 * provider (an `idp_transit` origin; staging: EZiL ID). Those pages come here,
 * not to the example.* and fixture adapter in `mcp-tab-actions.mjs`:
 *
 *   - It works in Chromium's DEFAULT context — the user's profile, cookies and
 *     session, which is the point — with no CSP injection and no request
 *     interception. What keeps it narrow is what it will do, not a sandbox.
 *   - Reads list `button` (submit included), `link`, `text_input`, `textarea`,
 *     `select` (with up to 20 option labels) and `checkbox`, at most 64, labels
 *     at most 80 characters, every label, option and title through
 *     `sanitizeText`. 🔴 NEVER a password input (nor a one-time code): no
 *     sidecar ref is minted for one, so nothing can name it. No `href` leaves.
 *   - Each listed element gets a fresh 22-character single-use handle mapped
 *     to a sidecar ref (`data-ezil-ref`, registered with the surface, so refs
 *     stay page-bound and generation-checked).
 *   - Actions run through `VERBS` on the bound tab, so the tier gate and URL
 *     sanitising of `verbs.mjs` apply to every one of them. Before anything is
 *     sent, every named element is re-read and must still be what the read
 *     listed. `navigate` here only ever targets an owner-app origin; an IdP
 *     origin is never a target (the approved-page adapter handles the rest).
 *   - An `idp_transit` page is `interactive_sign_in_required` and nothing else:
 *     no title, no element, no frame, no e-mail. So is Universe's own sign-in
 *     handoff (`/auth/ezil-id/login`, `/builder/login`, `/creator/login`,
 *     `/?role=builder|creator`).
 *   - `ownerAppAccountEmail` is the readonly "E-mail address" field (Blade
 *     `#builderEmail`) on `/builder/profile-builder`, and null anywhere else.
 *   - Every page URL that leaves is origin + path through `sanitizeUrl`.
 */

import { randomBytes } from 'node:crypto';
import { isOriginPolicy, loadOriginPolicy, sanitizeText, sanitizeUrl, tierOf } from './origin-policy.mjs';
import { VERBS } from './verbs.mjs';
import { maskedJpeg, pageVisibility } from './mcp-tab-actions.mjs';

/** The owner-app reads that list elements and may carry the masked frame. */
export const OWNER_APP_READ_KINDS = new Set(['profile_builder', 'owner_app_page']);
export const OWNER_APP_ELEMENTS_MAX = 64;
const LABEL_MAX = 80;
const OPTIONS_MAX = 20;
const OPTION_MAX = 80;
const TITLE_MAX = 120;
const EMAIL_MAX = 254;
/** Controls stamped per read: more than are listed, because links that leave the owner app are dropped after. */
const SCAN_MAX = 256;
const PROFILE_BUILDER = '/builder/profile-builder';
const SIGN_IN_PATHS = new Set(['/auth/ezil-id/login', '/builder/login', '/creator/login']);
const EMPTY_POLICY = loadOriginPolicy({});
const KINDS = new Set(['button', 'link', 'text_input', 'textarea', 'select', 'checkbox']);
const ROLE = { button: 'button', link: 'link', text_input: 'textbox', textarea: 'textbox', checkbox: 'checkbox' };
/** Which listed kinds each action may name. */
const ACTS_ON = {
    click: new Set(['button', 'link', 'checkbox']),
    type: new Set(['text_input', 'textarea']),
    fill_form: new Set(['text_input', 'textarea']),
    select: new Set(['select']),
    scroll: KINDS,
    press: KINDS,
};
const SCAN_LIMITS = { scanMax: SCAN_MAX, labelMax: LABEL_MAX, optionsMax: OPTIONS_MAX, optionMax: OPTION_MAX, emailMax: EMAIL_MAX };

/** The surface's origin policy; a test double without one has no tiers at all, so nothing is owner-app. */
export function policyOf (surface) {
    return isOriginPolicy(surface?.originPolicy) ? surface.originPolicy : EMPTY_POLICY;
}

/** Text as it may leave: control, bidi and zero-width characters become spaces, then trimmed and cut. */
function clean (value, max) {
    const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u{00ad}\u{061c}\u{180e}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{206f}\u{feff}]/gu, ' ')
        .replace(/\s+/gu, ' ').trim();
    let out = text.length > max ? text.slice(0, max) : text;
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    return out.trim();
}

/** A page URL as it may leave: origin + path through `sanitizeUrl`, https only, else null. */
export function pageUrlOf (url, policy) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const sanitized = sanitizeUrl(parsed.origin + parsed.pathname, policy);
    return typeof sanitized === 'string' && sanitized.startsWith('https://') ? sanitized : null;
}

/** What an owner-app URL is: the profile builder, Universe's sign-in handoff, or any other page of the app. */
export function ownerAppKind (url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return 'owner_app_page';
    }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path === PROFILE_BUILDER) return 'profile_builder';
    if (SIGN_IN_PATHS.has(path)) return 'interactive_sign_in_required';
    const roles = parsed.searchParams.getAll('role');
    if (path === '/' && roles.length === 1 && (roles[0] === 'builder' || roles[0] === 'creator')) return 'interactive_sign_in_required';
    return 'owner_app_page';
}

/**
 * The display for a tiered page: `undefined` when the page is in neither tier
 * (the caller's other adapters decide), `null` when it is tiered but not the
 * visible tab, else `{observed, pageUrl, profileHeadingVisible}`. An IdP page
 * is only ever asked whether it is visible.
 */
export async function describeTiered (page, url, policy) {
    const tier = tierOf(url, policy);
    if (tier !== 'owner_app' && tier !== 'idp_transit') return undefined;
    if (!await pageVisibility(page, url)) return null;
    const pageUrl = pageUrlOf(url, policy);
    if (tier === 'idp_transit') return { observed: 'interactive_sign_in_required', pageUrl, profileHeadingVisible: false };
    const observed = ownerAppKind(url);
    if (observed !== 'profile_builder') return { observed, pageUrl, profileHeadingVisible: false };
    const heading = await page.evaluate(() => !!document.querySelector('main h1, [role="main"] h1')?.getClientRects().length)
        .catch(() => null);
    if (typeof heading !== 'boolean' || page.url() !== url) return null;
    return { observed, pageUrl, profileHeadingVisible: heading };
}

/**
 * IN THE PAGE (serialised by Playwright, so entirely self-contained). Nothing
 * here comes from a request: the refs it verifies are ones this process
 * minted, and they are reduced to `[a-z0-9]` before use in a selector.
 *
 *   mode 'collect'  clear every earlier `data-ezil-ref`, then stamp and
 *                   describe each actionable control in document order
 *   mode 'verify'   describe the controls carrying the given refs, as now
 *   mode 'meta'     neither; only the account e-mail, when asked
 */
function ownerAppScan (arg) {
    const CONTROL = /[\u0000-\u001f\u007f-\u009f\u{00ad}\u{061c}\u{180e}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{206f}\u{feff}]/gu;
    const cut = (text, max) => {
        let out = text.length > max ? text.slice(0, max) : text;
        const last = out.charCodeAt(out.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
        return out;
    };
    const clean = (value, max) => cut(String(value == null ? '' : value).replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim(), max).trim();
    const textOf = (el) => (el ? String(el.innerText || el.textContent || '') : '');
    const shown = (el) => {
        if (!el.isConnected || el.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility({
            checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true,
        })) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    const usable = (el) => !el.matches(':disabled') && !el.closest('[aria-disabled="true"]');
    // 🔴 A password field — or a one-time code, or a field the page marks as a password — is never a control.
    const secret = (el) => {
        const declared = String(el.getAttribute('type') || '').toLowerCase();
        const autocomplete = String(el.getAttribute('autocomplete') || '').toLowerCase();
        return el.type === 'password' || declared === 'password'
            || /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/.test(autocomplete);
    };
    const kindOf = (el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'button') {
            const type = String(el.getAttribute('type') || 'submit').toLowerCase();
            return type === 'submit' || type === 'button' ? 'button' : null;
        }
        if (tag === 'a') {
            return el.hasAttribute('href') && !el.hasAttribute('download') && (!el.target || el.target === '_self') ? 'link' : null;
        }
        if (tag === 'textarea') return el.readOnly || secret(el) ? null : 'textarea';
        if (tag === 'select') return 'select';
        if (tag === 'input') {
            if (secret(el)) return null;
            if (el.type === 'checkbox') return 'checkbox';
            if (el.type === 'submit' || el.type === 'button') return 'button';
            if (['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type)) return el.readOnly ? null : 'text_input';
            return null;
        }
        if (el.isContentEditable && el.hasAttribute('contenteditable') && tag !== 'body' && tag !== 'html'
            && !(el.parentElement && el.parentElement.isContentEditable)) return 'textarea';
        return null;
    };
    const labelOf = (el, kind) => {
        const candidates = [el.getAttribute('aria-label')];
        const by = el.getAttribute('aria-labelledby');
        if (by) candidates.push(by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '));
        if (el.labels && el.labels.length) candidates.push(Array.from(el.labels, textOf).join(' '));
        const named = kind === 'button' || kind === 'link';
        if (named) candidates.push(el.tagName === 'INPUT' ? el.value : textOf(el));
        candidates.push(el.getAttribute('placeholder'), el.getAttribute('title'));
        if (named) {
            const img = el.querySelector('img[alt]');
            if (img) candidates.push(img.getAttribute('alt'));
        } else {
            candidates.push(el.getAttribute('name'));
        }
        for (const candidate of candidates) {
            const label = clean(candidate, arg.labelMax);
            if (label) return label;
        }
        return '';
    };
    const describe = (el) => {
        const kind = kindOf(el);
        if (!kind || !usable(el) || !shown(el)) return null;
        const label = labelOf(el, kind);
        if (!label) return null;
        const out = { kind, label };
        if (kind === 'select') {
            out.options = Array.from(el.options || []).slice(0, arg.optionsMax).map((o) => clean(o.label || o.textContent, arg.optionMax));
            out.multiple = !!el.multiple;
        }
        if (kind === 'link') out.href = String(el.href || '');
        return out;
    };

    let email = null;
    if (arg.email) {
        const field = document.getElementById('builderEmail');
        if (field && field.tagName === 'INPUT' && field.readOnly && !secret(field) && field.labels
            && Array.from(field.labels).some((l) => clean(textOf(l), 200).toLowerCase() === 'e-mail address')) {
            const value = String(field.value || '').trim();
            email = value && value.length <= arg.emailMax && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
        }
    }
    if (arg.mode === 'verify') {
        return {
            email,
            controls: (arg.refs || []).map((ref) => {
                const safe = String(ref).replace(/[^a-z0-9]/gi, '');
                const el = safe ? document.querySelector('[data-ezil-ref="' + safe + '"]') : null;
                const found = el ? describe(el) : null;
                return found ? Object.assign({ ref: safe }, found) : null;
            }),
        };
    }
    if (arg.mode !== 'collect') return { email, controls: [] };
    for (const stale of document.querySelectorAll('[data-ezil-ref]')) stale.removeAttribute('data-ezil-ref');
    const controls = [];
    for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[contenteditable]')) {
        if (controls.length >= arg.scanMax) break;
        const found = describe(el);
        if (!found) continue;
        const ref = 'e' + (controls.length + 1);
        el.setAttribute('data-ezil-ref', ref);
        controls.push(Object.assign({ ref }, found));
    }
    return { email, controls };
}

/** A listed label or option as it may leave: every URL in it sanitised, then cleaned and cut. */
const leaving = (value, policy, max) => clean(sanitizeText(String(value ?? ''), policy), max);

/**
 * Read one owner-app page: its title, its e-mail (when asked) and, for a
 * read, its controls with fresh handles and the masked frame. Null when the
 * page is not, or stops being, the visible owner-app page it started as.
 */
export async function readOwnerApp (surface, page, policy, { includeFrame = false, collectElements = false, email = false } = {}) {
    const url = page.url();
    const here = async () => !page.isClosed() && page.url() === url && tierOf(url, policy) === 'owner_app'
        && await pageVisibility(page, url);
    if (!await here()) return null;
    const scan = await page.evaluate(ownerAppScan, { mode: collectElements ? 'collect' : 'meta', email, ...SCAN_LIMITS })
        .catch(() => null);
    if (!scan || !Array.isArray(scan.controls)) return null;
    const viewerFrame = includeFrame ? await maskedJpeg(page) : null;
    let title = '';
    try {
        title = await page.title();
    } catch { /* an unreadable title is an empty one */ }
    // Read again BEFORE any ref is registered or anything leaves: a page that
    // moved while it was read is not the page it started as.
    if (!await here()) return null;

    const refs = new Map();
    const entries = [];
    const elements = [];
    for (const control of scan.controls) {
        if (elements.length >= OWNER_APP_ELEMENTS_MAX) break;
        if (!control || typeof control.ref !== 'string' || !/^e[0-9]+$/.test(control.ref) || !KINDS.has(control.kind)) continue;
        // A link that leaves the owner app is not listed: clicking it is a navigation this adapter does not make.
        if (control.kind === 'link' && tierOf(String(control.href), policy) !== 'owner_app') continue;
        const label = leaving(control.label, policy, LABEL_MAX);
        if (!label) continue;
        const handle = randomBytes(16).toString('base64url');
        const element = { ref: handle, kind: control.kind, label };
        if (control.kind === 'select') {
            element.options = (Array.isArray(control.options) ? control.options : [])
                .slice(0, OPTIONS_MAX).map((option) => leaving(option, policy, OPTION_MAX));
        }
        refs.set(handle, { kind: control.kind, label, sidecarRef: control.ref });
        entries.push({
            ref: control.ref, role: control.kind === 'select' ? (control.multiple ? 'listbox' : 'combobox') : ROLE[control.kind],
            name: label, isPassword: false,
        });
        elements.push(element);
    }
    if (collectElements) {
        surface.attach?.(page);
        surface.registerRefs(entries, page);
    }
    return {
        refs, elements, pageTitle: leaving(title, policy, TITLE_MAX), viewerFrame,
        ownerAppAccountEmail: email && typeof scan.email === 'string' && scan.email.length > 0 && scan.email.length <= EMAIL_MAX
            ? scan.email : null,
    };
}

/** A navigate target this adapter takes: an https owner-app URL without credentials, else null. */
export function ownerAppNavigateTarget (value, policy) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/u.test(value)) return null;
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return tierOf(url.href, policy) === 'owner_app' ? url.href : null;
}

/**
 * The surface `VERBS` act through: the real one, except that the page a verb
 * acts on is the session's bound tab, never "whichever tab is visible now".
 */
function boundSurface (surface, page) {
    return {
        get originPolicy () { return surface.originPolicy; },
        get cdpUrl () { return surface.cdpUrl; },
        isConnected: () => surface.isConnected(),
        activePage: async () => {
            if (page.isClosed()) throw Object.assign(new Error('the bound tab closed'), { code: 'chrome_unreachable' });
            surface.attach?.(page);
            return page;
        },
        resolveRef: (target, ref) => surface.resolveRef(target, ref),
        registerRefs: (entries, target) => surface.registerRefs(entries, target),
        rememberSecret: (value) => surface.rememberSecret(value),
        consoleEntries: (target, deny) => surface.consoleEntries(target, deny),
        networkEntries: (target, deny) => surface.networkEntries(target, deny),
        allSecrets: () => surface.allSecrets(),
    };
}

/** The `VERBS` call for an action, after every element it names is checked as it is now; or `{error}`. */
async function prepare (surface, page, action, refs, policy) {
    const unavailable = { error: 'browser_action_unavailable' };
    if (action.kind === 'navigate') {
        const url = ownerAppNavigateTarget(action.url, policy);
        return url ? { route: 'POST /navigate', body: { url }, handles: [], mayNavigate: true } : unavailable;
    }
    if (action.kind === 'scroll' && action.ref === undefined) {
        return { route: 'POST /scroll', body: { dy: action.dy }, handles: [], mayNavigate: false };
    }
    if (action.kind === 'press' && action.ref === undefined) {
        return { route: 'POST /press', body: { key: action.key }, handles: [], mayNavigate: true };
    }
    const handles = action.kind === 'fill_form' ? action.fields.map((field) => field.ref) : [action.ref];
    const records = handles.map((handle) => refs?.get(handle));
    const allowed = ACTS_ON[action.kind];
    if (!allowed || records.some((record) => !record || typeof record.sidecarRef !== 'string' || !allowed.has(record.kind))) {
        return unavailable;
    }
    // The sidecar still knows each ref, on this tab and origin, from the read that minted it…
    for (const record of records) {
        try {
            await surface.resolveRef(page, record.sidecarRef);
        } catch {
            return unavailable;
        }
    }
    // …and each element is still the one that read listed, under the same label.
    const scan = await page.evaluate(ownerAppScan, { mode: 'verify', refs: records.map((record) => record.sidecarRef), ...SCAN_LIMITS })
        .catch(() => null);
    if (!scan || !Array.isArray(scan.controls) || scan.controls.length !== records.length) return unavailable;
    for (let i = 0; i < records.length; i++) {
        const now = scan.controls[i];
        if (!now || now.kind !== records[i].kind || leaving(now.label, policy, LABEL_MAX) !== records[i].label
            || (now.kind === 'link' && tierOf(String(now.href), policy) !== 'owner_app')) return unavailable;
    }
    const ref = records[0].sidecarRef;
    switch (action.kind) {
    case 'click': return { route: 'POST /click', body: { ref }, handles, mayNavigate: true };
    case 'type': return { route: 'POST /type', body: { ref, text: action.text }, handles, mayNavigate: false };
    case 'fill_form': return {
        route: 'POST /fill_form', handles, mayNavigate: false,
        body: { fields: action.fields.map((field, i) => ({ ref: records[i].sidecarRef, value: field.text })) },
    };
    case 'select': return { route: 'POST /select', body: { ref, values: action.values }, handles, mayNavigate: false };
    case 'scroll': return { route: 'POST /scroll', body: { ref }, handles, mayNavigate: false };
    case 'press': return { route: 'POST /press', body: { ref, key: action.key }, handles, mayNavigate: true };
    default: return unavailable;
    }
}

/** May this action move the tab to another document? A typed input, a selection or a scroll never may. */
export function ownerAppActionMayNavigate (action) {
    return action.kind === 'navigate' || action.kind === 'click' || action.kind === 'press';
}

/**
 * Run one action on an owner-app page through `VERBS`. Resolves `{done: true}`
 * once it ran, or `{error}` when it was refused before anything was sent
 * (`browser_action_unavailable`, or `origin_read_only` from the tier gate).
 * Throws when it may have acted and the outcome is not known: the caller
 * reports that as uncertain. Every handle the action names is spent.
 */
export async function applyOwnerAppAction (surface, page, action, refs, policy, markDispatched, stillBound) {
    const call = await prepare(surface, page, action, refs, policy);
    if (call.error) return call;
    if (!await stillBound()) return { error: 'browser_action_unavailable' };
    for (const handle of call.handles) refs.delete(handle);
    markDispatched();
    try {
        await VERBS[call.route](boundSurface(surface, page), call.body);
    } catch (error) {
        // These are raised before a verb touches the page: nothing happened.
        if (error?.code === 'origin_read_only') return { error: 'origin_read_only' };
        if (error?.code === 'bad_ref' || error?.code === 'bad_request') return { error: 'browser_action_unavailable' };
        throw error;
    }
    if (call.mayNavigate) await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
    return { done: true };
}

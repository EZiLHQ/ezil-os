import { randomBytes } from 'node:crypto';
import { STATUS_CODES } from 'node:http';

const QA_ORIGIN = 'https://os-staging.ezil.work';
const QA_PATH = '/browser-mcp-fixture.html';
const PUBLIC = new Set(['https://example.com', 'https://example.org', 'https://example.net']);
const CRITICAL = /(?:^|[\/_-])(?:accounts?|admin|auth|billing|checkouts?|download|login|logout|oauth|payments?|private|profile|settings|tokens?)(?=$|[\/_-])/i;
const CONTROL_TEXT = /^[\p{L}\p{N} .,!?'_-]{1,80}$/u;
const ID = /^[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_-]{22}$/;
const REQUEST = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PAGE_LIMIT = 16;
const FRAME_LIMIT = 60_000;
const DOCUMENT_POLICY = { name: 'Content-Security-Policy', value: "sandbox allow-scripts allow-same-origin; form-action 'none'" };

export function validUiInput (value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !/^[a-f0-9]{64}$/.test(value.binding ?? '')
        || Object.keys(value).some(key => !['binding', 'browserSessionId', 'requestId', 'action'].includes(key))
        || (value.browserSessionId !== undefined && !ID.test(value.browserSessionId))) return false;
    const action = value.action;
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
    const names = Object.keys(action);
    if (action.kind === 'read') {
        return value.requestId === undefined && names.every(key => key === 'kind' || key === 'includeFrame')
            && (action.includeFrame === undefined || typeof action.includeFrame === 'boolean');
    }
    if (typeof value.browserSessionId !== 'string' || typeof value.requestId !== 'string' || !REQUEST.test(value.requestId)) return false;
    if (action.kind === 'navigate') return names.length === 2 && typeof action.url === 'string';
    if (typeof action.ref !== 'string' || !REF.test(action.ref)) return false;
    if (action.kind === 'click') return names.length === 2;
    return action.kind === 'type' && names.length === 3 && typeof action.text === 'string'
        && CONTROL_TEXT.test(action.text) && Buffer.byteLength(action.text) <= 256;
}

function parseUrl (value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/u.test(value)) return null;
    try {
        const url = new URL(value);
        return !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
}

function namesOf (value) {
    return new Set((value ?? '').trim().split(/[\s,]+/u).filter(Boolean));
}

/** The normal Chromium context cannot acquire the disposable-tab proxy. Restrict this
 *  adapter to reviewed public DNS names and one exact static first-party fixture. */
export function browserTabPolicy ({ allowedOrigins, fixtureOrigin = QA_ORIGIN, allowHttpForTests = false } = {}) {
    const configured = namesOf(allowedOrigins);
    return function permitted (value, { resource = false, modern = true } = {}) {
        const url = parseUrl(value);
        if (!url) return null;
        if (allowHttpForTests && url.origin === fixtureOrigin && url.protocol === 'http:') return url;
        if (url.protocol !== 'https:' || url.port) return null;
        if (url.origin === fixtureOrigin && url.pathname === QA_PATH && !url.search && !url.hash) return url;
        if (url.origin === fixtureOrigin || !PUBLIC.has(url.origin)) return null;
        if (configured.size && !configured.has(url.origin) && url.origin !== 'https://example.com') return null;
        if (CRITICAL.test(url.pathname) || (!resource && (url.search || url.hash || /%/u.test(url.pathname)))) return null;
        if (modern && /\.(?:zip|exe|deb|dmg|tar|gz|pkg|msi)$/i.test(url.pathname)) return null;
        return url;
    };
}

export function neutralTab (value) {
    return value === 'about:blank' || value === 'chrome://newtab/' || value === 'chrome://new-tab-page/';
}

export async function pageVisibility (page, targetUrl) {
    return !page.isClosed() && page.url() === targetUrl && page.evaluate(() => document.visibilityState === 'visible')
        .catch(() => false);
}

function cleanLabel (value, max) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
        .replace(/\s+/gu, ' ').trim().slice(0, max);
}

/** Re-evaluate this exact ElementHandle on the approved document before any event. */
async function describe (element, permitted) {
    const surface = await element.evaluate(node => {
        if (!(node instanceof HTMLElement) || node.ownerDocument !== document || !node.isConnected
            || node.closest('form,[inert],[aria-hidden="true"],[aria-disabled="true"],[role="dialog"]')
            || node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true') return null;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) <= 0 || rect.width <= 0 || rect.height <= 0
            || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return null;
        const label = node.getAttribute('aria-label') || Array.from(node.labels ?? [], x => x.textContent).join(' ')
            || node.getAttribute('placeholder') || node.innerText;
        const text = (label ?? '') + ' ' + [node.id, node.getAttribute('name'), node.getAttribute('autocomplete')].join(' ');
        if (/\b(?:address|auth|billing|card|checkout|confirm|credit|delete|email|login|pass(?:word|key|code)?|pay|pin|save|secret|sign[\s_-]?(?:in|out|up)|submit|token|verification)\b/i.test(text)) return null;
        if (node instanceof HTMLButtonElement && node.getAttribute('type')?.toLowerCase() === 'button') return { kind: 'button', label };
        if (node instanceof HTMLAnchorElement && node.href && !node.hasAttribute('download') && (!node.target || node.target === '_self')) {
            return { kind: 'link', label, href: node.href };
        }
        if (node instanceof HTMLInputElement && ['text', 'search'].includes(node.type) && !node.readOnly) {
            return { kind: 'text_input', label, maxLength: node.maxLength };
        }
        return null;
    }).catch(() => null);
    if (!surface) return null;
    if (surface.href && !permitted(surface.href)) return null;
    const label = cleanLabel(surface.label, 80);
    return label ? { ...surface, label } : null;
}

export async function discardRefs (refs) {
    if (!refs) return;
    const handles = Array.from(refs.values(), item => item.element);
    refs.clear();
    await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
}

export async function readPublicTab (page, permitted, { includeFrame = false, collectElements = true } = {}) {
    const parsed = permitted(page.url());
    if (!parsed) return null;
    const pageTitle = cleanLabel(await page.title(), 120);
    const refs = new Map();
    let viewerFrame = null;
    try {
        if (!includeFrame && collectElements) {
            const candidates = page.locator('button[type="button"],a[href],input[type="text"],input[type="search"],input:not([type])');
            const count = Math.min(await candidates.count(), 64);
            for (let index = 0; index < count && refs.size < PAGE_LIMIT; index++) {
                const handle = await candidates.nth(index).elementHandle({ timeout: 250 }).catch(() => null);
                if (!handle) continue;
                const value = await describe(handle, permitted);
                if (value) refs.set(randomBytes(16).toString('base64url'), { ...value, element: handle });
                else await handle.dispose().catch(() => {});
            }
        } else if (includeFrame) {
            const screenshot = await page.screenshot({
                type: 'jpeg', quality: 36, scale: 'css', caret: 'hide', timeout: 1800,
                // Suppress editable values and every embedded application's pixels, regardless of origin.
                mask: [page.locator('input, textarea, [contenteditable], select, iframe, object, embed')],
                maskColor: '#64748b',
            }).catch(() => null);
            if (screenshot && screenshot.length > 0 && screenshot.length <= FRAME_LIMIT) {
                viewerFrame = { mimeType: 'image/jpeg', base64: screenshot.toString('base64') };
            }
        }
        if (!await pageVisibility(page, parsed.href)) throw new Error('page changed');
        return {
            refs, pageUrl: parsed.origin + parsed.pathname, pageTitle,
            elements: Array.from(refs, ([ref, { kind, label }]) => ({ ref, kind, label })),
            viewerFrame,
        };
    } catch (error) {
        await discardRefs(refs);
        throw error;
    }
}

/** This is the only internal CDP surface of the adapter: fixed request filtering
 * on the same existing page. There is no caller-supplied CDP command or payload. */
async function withPublicRequests (page, origin, permitted, work) {
    const cdp = await page.context().newCDPSession(page);
    let denied = false;
    let failed = false;
    const handler = event => {
        const parsed = permitted(event.request.url, { resource: event.resourceType !== 'Document' });
        const accepted = parsed?.origin === origin && ['GET', 'HEAD'].includes(event.request.method);
        if (!accepted) {
            if (event.resourceType === 'Document') denied = true;
            void cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
                .catch(() => { failed = true; });
            return;
        }
        const handled = event.responseStatusCode === undefined
            ? cdp.send('Fetch.continueRequest', {
                requestId: event.requestId, interceptResponse: event.resourceType === 'Document',
            })
            : cdp.send('Fetch.continueResponse', {
                requestId: event.requestId, responseCode: event.responseStatusCode,
                responsePhrase: event.responseStatusText || STATUS_CODES[event.responseStatusCode] || 'Unknown Status',
                responseHeaders: [...(event.responseHeaders ?? []), DOCUMENT_POLICY],
            });
        void handled.catch(() => { failed = true; });
    };
    try {
        await cdp.send('Network.enable');
        await cdp.send('Network.setBypassServiceWorker', { bypass: true });
        cdp.on('Fetch.requestPaused', handler);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        const value = await work();
        if (denied || failed) throw new Error('network blocked');
        return value;
    } finally {
        cdp.off('Fetch.requestPaused', handler);
        await cdp.send('Fetch.disable').catch(() => {});
        await cdp.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => {});
        await cdp.detach().catch(() => {});
    }
}

export async function applyPublicAction (page, action, refs, permitted, markDispatched, stillBound) {
    if (action.kind === 'navigate') {
        const target = permitted(action.url);
        if (!target) return false;
        return withPublicRequests(page, target.origin, permitted, async () => {
            if (!await stillBound()) return false;
            markDispatched();
            const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 3250 });
            const final = permitted(page.url());
            if (!response || final?.origin !== target.origin || !await pageVisibility(page, final.href)) throw new Error('navigation changed');
            return true;
        });
    }

    const record = refs?.get(action.ref);
    if (!record) return false;
    const current = await describe(record.element, permitted);
    if (!current || current.kind !== record.kind || current.label !== record.label || current.href !== record.href
        || (action.kind === 'type' && (current.kind !== 'text_input'
            || (current.maxLength >= 0 && action.text.length > current.maxLength)))
        || action.kind === 'click' && current.kind === 'text_input') return false;
    const active = permitted(page.url());
    if (!active || current.href && permitted(current.href)?.origin !== active.origin) return false;
    return withPublicRequests(page, active.origin, permitted, async () => {
        if (!await stillBound()) return false;
        const verified = await describe(record.element, permitted);
        if (!verified || verified.kind !== current.kind || verified.label !== current.label || verified.href !== current.href
            || (action.kind === 'type' && verified.maxLength >= 0 && action.text.length > verified.maxLength)
            || !await stillBound()) return false;
        // A single-use ref is spent even when the remote delivery becomes uncertain.
        refs.delete(action.ref);
        markDispatched();
        try {
            if (action.kind === 'type') await record.element.fill(action.text, { timeout: 1750 });
            else await record.element.click({ timeout: 1750 });
            if (current.kind === 'link') await page.waitForLoadState('domcontentloaded', { timeout: 1100 });
            const final = permitted(page.url());
            if (final?.origin !== active.origin || !await pageVisibility(page, final.href)) throw new Error('page changed');
            return true;
        } finally {
            await record.element.dispose().catch(() => {});
        }
    });
}

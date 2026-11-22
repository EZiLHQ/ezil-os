import { describe, expect, it } from 'vitest';
import {
    BROWSER_UI_REQUEST_MAX_BYTES, BROWSER_UI_RESULT_MAX_BYTES, PRESS_KEYS, browserPublicPageText, browserSessionRequest,
    browserUiFailure, browserUiSuccess, sanitizeBrowserPageUrl,
} from './contract';

/*
 * Browser verbs v2 §4: the App declares the same request and answer shapes as ezil-mcp
 * `src/tools/workflow-browser.ts`. These cases are that file's bounds, one by one.
 */
const browserSessionId = 'a'.repeat(43);
const requestId = '7bb70a50-cd7d-40f8-9539-45aee597ea48';
const ref = 'r'.repeat(22);
const control = (action: unknown) => ({ browserSessionId, requestId, action });
const accepts = (value: unknown) => browserSessionRequest.safeParse(value).success;
const char = (code: number) => String.fromCharCode(code);

describe('browser verbs v2 requests mirror the MCP control union', () => {
    it('accepts each of the seven action kinds and the read', () => {
        for (const action of [
            { kind: 'navigate', url: 'https://universe-staging.ezil.work/builder/profile-builder' },
            { kind: 'navigate', url: 'https://example.com/search?q=owner' },
            { kind: 'click', ref },
            { kind: 'type', ref, text: 'line one\nline two\twith a tab' },
            { kind: 'type', ref, text: 'x'.repeat(4000) },
            { kind: 'fill_form', fields: Array.from({ length: 20 }, (_, n) => ({ ref: String(n).padStart(22, 'f'), text: 'v' })) },
            { kind: 'select', ref, values: ['per hour', 'd'.repeat(200)] },
            { kind: 'scroll', ref }, { kind: 'scroll', dy: -5000 }, { kind: 'scroll', dy: 5000 },
            ...PRESS_KEYS.map(key => ({ kind: 'press', key })), { kind: 'press', key: 'Enter', ref },
        ]) expect([JSON.stringify(action).slice(0, 80), accepts(control(action))]).toEqual([JSON.stringify(action).slice(0, 80), true]);
        expect(accepts({ action: { kind: 'read' } })).toBe(true);
        expect(accepts({ browserSessionId, action: { kind: 'read', includeFrame: true } })).toBe(true);
        expect(accepts({ browserSessionId })).toBe(true);
    });

    it('refuses what the MCP refuses: control characters, sizes, members, keys, the IdP and private hosts', () => {
        const fields = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: String(i).padStart(22, 'f'), text: 'v' }));
        for (const action of [
            { kind: 'type', ref, text: '' }, { kind: 'type', ref, text: 'x'.repeat(4001) },
            { kind: 'type', ref, text: 'bell' + char(7) }, { kind: 'type', ref, text: 'cr' + char(13) },
            { kind: 'type', ref, text: 'nul' + char(0) }, { kind: 'type', ref, text: 'del' + char(0x7f) },
            { kind: 'type', ref, text: 'c1' + char(0x85) }, { kind: 'type', ref, text: 'line' + char(0x2028) },
            { kind: 'type', ref, text: 'para' + char(0x2029) }, { kind: 'type', ref, text: 'x', submit: true },
            { kind: 'fill_form', fields: [] }, { kind: 'fill_form', fields: fields(21) },
            { kind: 'fill_form', fields: [{ ref, text: 'a' }, { ref, text: 'b' }] }, { kind: 'fill_form', fields: [{ ref, value: 'a' }] },
            { kind: 'select', ref, values: [] }, { kind: 'select', ref, values: Array(21).fill('a') },
            { kind: 'select', ref, values: ['x'.repeat(201)] }, { kind: 'select', ref, values: ['a\nb'] },
            { kind: 'scroll' }, { kind: 'scroll', ref, dy: 1 }, { kind: 'scroll', dy: 5001 }, { kind: 'scroll', dy: 1.5 },
            { kind: 'press', key: 'a' }, { kind: 'press', key: 'Control+A' }, { kind: 'press', key: 'enter' },
            { kind: 'click', ref: 'e12' }, { kind: 'click', ref, selector: 'button' }, { kind: 'upload', ref },
            { kind: 'navigate', url: 'https://id.ezil.work/u/login' }, { kind: 'navigate', url: 'https://id.ezil.work./authorize' },
            { kind: 'navigate', url: 'http://example.com/' }, { kind: 'navigate', url: 'https://user:pw@example.com/' },
            { kind: 'navigate', url: 'https://localhost/' }, { kind: 'navigate', url: 'https://127.0.0.1/' },
            { kind: 'navigate', url: 'https://printer.local/' }, { kind: 'navigate', url: 'https://example.com/a b' },
            { kind: 'navigate', url: 'https://example.com/' + 'p'.repeat(2048) }, { kind: 'navigate', url: 'javascript:alert(1)' },
        ]) expect([JSON.stringify(action).slice(0, 80), accepts(control(action))]).toEqual([JSON.stringify(action).slice(0, 80), false]);
        // A control action needs its handle and a v4 requestId; a read takes neither requestId nor a foreign member.
        expect(accepts({ action: { kind: 'click', ref } })).toBe(false);
        expect(accepts({ browserSessionId, action: { kind: 'click', ref } })).toBe(false);
        expect(accepts({ ...control({ kind: 'click', ref }), requestId: '7bb70a50-cd7d-30f8-9539-45aee597ea48' })).toBe(false);
        expect(accepts({ requestId, action: { kind: 'read' } })).toBe(false);
        expect(accepts({ action: { kind: 'read', selector: 'input' } })).toBe(false);
    });

    it('keeps the 16 KiB UTF-8 bound and declares the v1 text bound for pages off the owner app', () => {
        // 4000 characters never exceed 16 KiB of UTF-8 (at most three bytes per UTF-16 unit), so the byte bound holds them all.
        expect(accepts(control({ kind: 'type', ref, text: char(0x20ac).repeat(4000) }))).toBe(true);
        expect(browserPublicPageText.safeParse('Plain words, ok!').success).toBe(true);
        for (const text of ['two\nlines', 'tab\there', 'x'.repeat(81), '<b>', '']) {
            expect([text, browserPublicPageText.safeParse(text).success]).toEqual([text, false]);
        }
    });

    it('the request bound holds the largest action the union admits', () => {
        const fields = Array.from({ length: 20 }, (_, n) => ({ ref: String(n).padStart(22, 'f'), text: char(0xd800).repeat(4000) }));
        const largest = JSON.stringify(control({ kind: 'fill_form', fields }));
        expect(accepts(JSON.parse(largest))).toBe(true);
        expect(Buffer.byteLength(largest)).toBeGreaterThan(470_000);
        expect(Buffer.byteLength(largest)).toBeLessThan(BROWSER_UI_REQUEST_MAX_BYTES);
    });
});

const result = {
    ok: true, browserSessionId, expiresAt: '2026-11-22T00:02:00.000Z', observed: 'profile_builder', profileHeadingVisible: true,
    universeIdentity: 'unverified', pageUrl: 'https://universe-staging.ezil.work/builder/profile-builder', pageTitle: 'Profile builder',
    elements: [
        { ref, kind: 'button', label: 'Save changes' },
        { ref: 's'.repeat(22), kind: 'select', label: 'Rate unit', options: ['per hour', 'per day'] },
        { ref: 't'.repeat(22), kind: 'textarea', label: 'Builder story' },
        { ref: 'c'.repeat(22), kind: 'checkbox', label: 'Available for work' },
    ],
    viewerFrame: { mimeType: 'image/jpeg', base64: '/9j/2Q==' },
    ownerAppAccountEmail: 'ada.builder@example.test',
};

describe('browser verbs v2 answers mirror the MCP success and failure schemas', () => {
    it('accepts owner-app pages with their elements, frame and account e-mail', () => {
        expect(browserUiSuccess.parse(result)).toEqual(result);
        expect(browserUiSuccess.safeParse({ ...result, observed: 'owner_app_page', profileHeadingVisible: false }).success).toBe(true);
        const { ownerAppAccountEmail: _absent, ...older } = result;
        expect(browserUiSuccess.safeParse(older).success).toBe(true);
        expect(browserUiSuccess.safeParse({ ...result, elements: Array.from({ length: 64 },
            (_, n) => ({ ref: String(n).padStart(22, 'h'), kind: 'link', label: 'L' + n })) }).success).toBe(true);
    });

    it('refuses an href, a password kind, untrimmed labels, frames off content pages and e-mail off owner-app pages', () => {
        for (const [name, over] of Object.entries({
            'href member': { elements: [{ ref, kind: 'link', label: 'Go', href: 'https://universe-staging.ezil.work/' }] },
            'password kind': { elements: [{ ref, kind: 'password', label: 'Password' }] },
            'options off a select': { elements: [{ ref, kind: 'button', label: 'Go', options: [] }] },
            'select without options': { elements: [{ ref, kind: 'select', label: 'Go' }] },
            '21 options': { elements: [{ ref, kind: 'select', label: 'S', options: Array(21).fill('o') }] },
            'option with a line break': { elements: [{ ref, kind: 'select', label: 'S', options: ['a\nb'] }] },
            'untrimmed label': { elements: [{ ref, kind: 'button', label: ' Save' }] },
            '81-character label': { elements: [{ ref, kind: 'button', label: 'x'.repeat(81) }] },
            'duplicate refs': { elements: [{ ref, kind: 'button', label: 'A' }, { ref, kind: 'button', label: 'B' }] },
            '65 elements': { elements: Array.from({ length: 65 }, (_, n) => ({ ref: String(n).padStart(22, 'h'), kind: 'button', label: 'B' })) },
            'frame on the IdP': { observed: 'interactive_sign_in_required', profileHeadingVisible: false, elements: [], ownerAppAccountEmail: null },
            'frame on the shell': { observed: 'browser_ready', profileHeadingVisible: false, pageUrl: null, pageTitle: null, elements: [], ownerAppAccountEmail: null },
            'elements on sign-in': { observed: 'interactive_sign_in_required', profileHeadingVisible: false, viewerFrame: null, ownerAppAccountEmail: null },
            'e-mail on an approved page': { observed: 'approved_page', profileHeadingVisible: false, pageUrl: 'https://example.com/' },
            'e-mail over 254': { ownerAppAccountEmail: 'x'.repeat(255) },
            'PNG frame': { viewerFrame: { mimeType: 'image/jpeg', base64: 'iVBORw0KGgo=' } },
            'oversized frame': { viewerFrame: { mimeType: 'image/jpeg', base64: '/9j/' + 'A'.repeat(80_000) } },
            'identity decided': { universeIdentity: 'same_ezil_id' },
            'http page': { pageUrl: 'http://universe-staging.ezil.work/' },
            'title with a line break': { pageTitle: 'a\nb' },
        })) expect([name, browserUiSuccess.safeParse({ ...result, ...over }).success]).toEqual([name, false]);
    });

    it('failures add origin_read_only to the codes the receiver maps', () => {
        for (const error of ['origin_read_only', 'browser_invalid_request', 'browser_action_uncertain', 'browser_session_stale']) {
            expect(browserUiFailure.safeParse({ ok: false, error }).success).toBe(true);
        }
        expect(browserUiFailure.safeParse({ ok: false, error: 'bad_ref' }).success).toBe(false);
        expect(BROWSER_UI_RESULT_MAX_BYTES).toBe(160 * 1024);
    });

    it('sanitises page URLs as the MCP does: EZiL ID to origin + path, sensitive parameters drop the query', () => {
        expect(sanitizeBrowserPageUrl('https://id.ezil.work/u/login?state=S')).toBe('https://id.ezil.work/u/login');
        expect(sanitizeBrowserPageUrl('https://universe-staging.ezil.work/cb?code=C&state=S')).toBe('https://universe-staging.ezil.work/cb');
        expect(sanitizeBrowserPageUrl('https://universe-staging.ezil.work/cb#access_token=T')).toBe('https://universe-staging.ezil.work/cb');
        expect(sanitizeBrowserPageUrl('https://universe-staging.ezil.work/cb?%63ode=C')).toBe('https://universe-staging.ezil.work/cb');
        // Positive controls: an ordinary query and a plain page are untouched.
        expect(sanitizeBrowserPageUrl('https://example.com/search?q=owner')).toBe('https://example.com/search?q=owner');
        expect(sanitizeBrowserPageUrl('https://universe-staging.ezil.work/builder/profile-builder'))
            .toBe('https://universe-staging.ezil.work/builder/profile-builder');
        expect(sanitizeBrowserPageUrl(null)).toBeNull();
    });
});

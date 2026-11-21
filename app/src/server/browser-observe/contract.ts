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
export const BROWSER_UI_RESULT_MAX_BYTES = 96_000;
export const BROWSER_UI_REQUEST_MAX_BYTES = 4096;

const elementRef = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const title = z.string().max(120);
const label = z.string().min(1).max(80);
const image = z.object({
    mimeType: z.literal('image/jpeg'),
    base64: z.string().min(4).max(80_000)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

export function browserPublicPageUrl(value: string): URL | undefined {
    if (value.length > 2048 || !value.startsWith('https://') || /[\s\\\x00-\x1f\x7f]/u.test(value)) return;
    try {
        const url = new URL(value);
        if (!url.username && !url.password && !url.port && !url.search && !url.hash
            && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname)
            && !url.hostname.endsWith('.localhost')
            && !/^\d+(?:\.\d+){3}$/.test(url.hostname)) return url;
    } catch { /* Refused by the caller. */ }
}

const action = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('read'), includeFrame: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal('navigate'), url: z.string().max(2048).refine(value => !!browserPublicPageUrl(value)) }).strict(),
    z.object({ kind: z.literal('click'), ref: elementRef }).strict(),
    z.object({
        kind: z.literal('type'), ref: elementRef,
        text: z.string().min(1).max(80).regex(/^[\p{L}\p{N} .,!?'_-]+$/u)
            .refine(value => Buffer.byteLength(value, 'utf8') <= 256),
    }).strict(),
]);

export const browserUiRequest = z.object({
    browserSessionId: sessionId.optional(),
    requestId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).optional(),
    action,
}).strict().refine(value => value.action.kind === 'read'
    ? value.requestId === undefined
    : value.browserSessionId !== undefined && value.requestId !== undefined);
export const browserSessionRequest = z.union([browserObserveRequest, browserUiRequest]);
export type BrowserSessionRequest = z.infer<typeof browserSessionRequest>;
export type BrowserUiRequest = z.infer<typeof browserUiRequest>;

export const browserUiSuccess = browserObserveSuccess.extend({
    observed: z.enum(['browser_ready', 'approved_page', 'profile_builder', 'interactive_sign_in_required']),
    pageUrl: z.string().max(2048).refine(value => browserPublicPageUrl(value)?.href === value).nullable(),
    pageTitle: title.nullable(),
    elements: z.array(z.object({
        ref: elementRef,
        kind: z.enum(['button', 'link', 'text_input']),
        label,
    }).strict()).max(16),
    viewerFrame: image.nullable(),
}).strict().superRefine((value, ctx) => {
    if (value.observed === 'browser_ready' && value.pageUrl !== null
        || value.observed !== 'approved_page'
            && (value.elements.length > 0 || value.viewerFrame !== null || value.pageTitle !== null)
        || value.observed === 'approved_page' && (value.pageUrl === null || value.pageTitle === null)
        || value.observed !== 'profile_builder' && value.profileHeadingVisible
        || new Set(value.elements.map(element => element.ref)).size !== value.elements.length) {
        ctx.addIssue({ code: 'custom', message: 'Invalid browser viewer projection' });
    }
});
export const browserUiFailure = z.object({
    ok: z.literal(false),
    error: z.enum(['browser_page_unavailable', 'browser_session_stale', 'browser_unavailable',
        'browser_action_unavailable', 'browser_action_uncertain', 'browser_action_conflict', 'browser_action_pending']),
}).strict();

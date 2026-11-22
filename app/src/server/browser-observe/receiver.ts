import {
    BROWSER_OBSERVE_PATH, BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE,
    BROWSER_CONTROL_PROCEDURE, BROWSER_CONTROL_SCOPE, BROWSER_PAGE_PROCEDURE, BROWSER_PAGE_SCOPE,
    BROWSER_UI_REQUEST_MAX_BYTES, BROWSER_UI_RESULT_MAX_BYTES, browserSessionRequest, browserObserveSuccess, browserRuntimeFailure,
    browserUiSuccess, browserUiFailure, sanitizeBrowserPageUrl, type BrowserSessionRequest, type BrowserUiRequest,
} from './contract';

/** The HTTP status of each failure the sidecar may answer, as ezil-mcp `workflow-browser.ts` expects it. */
const FAILURE_STATUS: Readonly<Record<string, number>> = {
    browser_session_stale: 409, browser_action_unavailable: 409, browser_action_conflict: 409, browser_action_pending: 409,
    browser_page_unavailable: 404, browser_invalid_request: 400,
    // Browser verbs v2: the page's origin tier does not allow the action (the IdP is transit only).
    origin_read_only: 403,
};

type Principal = { userId: string; clientId: string };
type BrowserTarget = { sandboxId: string; binding: string };
type Dependencies<T extends BrowserTarget> = {
    enabled: boolean;
    controlEnabled?: boolean;
    verify: (headers: Headers, input: string, procedure: string, scope: string) => Promise<Principal | null>;
    target: (principal: Principal, computerId: string) => Promise<T | null>;
    observe: (principal: Principal, computerId: string, target: T, input: BrowserSessionRequest) => Promise<unknown>;
    now: () => number;
};

export async function readSmallBody(message: Request | Response, limit: number, timeout = 2000): Promise<string> {
    const declared = message.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('body_size');
    if (!message.body) throw new Error('body_missing');
    const reader = message.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let expired = false;
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, timeout);
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (expired) throw new Error('body_timeout');
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error('body_size');
            chunks.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    } finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
    }
}

function reply(payload: unknown, status: number) {
    return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}
function fail(error: string, status: number) {
    return reply({ ok: false, error }, status);
}

export async function handleBrowserObserve<T extends BrowserTarget>(request: Request, deps: Dependencies<T>): Promise<Response> {
    if (!deps.enabled && !deps.controlEnabled) return fail('browser_unavailable', 404);
    const url = new URL(request.url);
    const computerId = BROWSER_OBSERVE_PATH.exec(url.pathname)?.[1];
    if (request.method !== 'POST' || url.search !== '' || !computerId || request.headers.get('content-type') !== 'application/json') {
        return fail('browser_invalid_request', 400);
    }
    let raw, input;
    try {
        raw = await readSmallBody(request, BROWSER_UI_REQUEST_MAX_BYTES);
        input = browserSessionRequest.parse(JSON.parse(raw));
        if (!('action' in input) && Buffer.byteLength(raw, 'utf8') > 1024) {
            return fail('browser_invalid_request', 400);
        }
    } catch {
        return fail('browser_invalid_request', 400);
    }
    const ui = 'action' in input ? input as BrowserUiRequest : null;
    const modern = ui !== null;
    const mutate = ui !== null && ui.action.kind !== 'read';
    if (modern ? !deps.controlEnabled : !deps.enabled) return fail('browser_unavailable', 404);
    const [transcript, procedure, scope] = mutate
        ? ['EZIL-BROWSER-CONTROL/1', BROWSER_CONTROL_PROCEDURE, BROWSER_CONTROL_SCOPE]
        : modern
            ? ['EZIL-BROWSER-PAGE/1', BROWSER_PAGE_PROCEDURE, BROWSER_PAGE_SCOPE]
            : ['EZIL-BROWSER-OBSERVE/1', BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE];
    let dispatched = false;
    try {
        const principal = await deps.verify(request.headers,
            [transcript, 'POST', url.pathname, raw].join('\n'), procedure!, scope!);
        if (!principal) return fail('browser_unauthorized', 401);
        const target = await deps.target(principal, computerId);
        if (!target) return fail('browser_not_found', 404);
        dispatched = true;
        const output = await deps.observe(principal, computerId, target, input);
        // The frame exists only on a deliberate viewer read, never a mutation result.
        const success = (modern ? browserUiSuccess : browserObserveSuccess).safeParse(output);
        if (success.success) {
            const value = success.data;
            const expires = Date.parse(value.expiresAt);
            if (expires <= deps.now() || expires > deps.now() + 125_000
                || (input.browserSessionId !== undefined && value.browserSessionId !== input.browserSessionId)
                || (value.observed === 'interactive_sign_in_required' && value.profileHeadingVisible)
                || ('viewerFrame' in value && value.viewerFrame !== null
                    && (ui?.action.kind !== 'read' || ui.action.includeFrame !== true))) {
                return fail(mutate ? 'browser_action_uncertain' : 'browser_unavailable', 503);
            }
            // Every page URL the OS answers with passes the MCP's own sanitiser too (contract §2, §4), and the
            // whole answer stays under the bound the MCP reads it with.
            const answer = 'pageUrl' in value ? { ...value, pageUrl: sanitizeBrowserPageUrl(value.pageUrl) } : value;
            if (modern && Buffer.byteLength(JSON.stringify(answer), 'utf8') > BROWSER_UI_RESULT_MAX_BYTES) {
                return fail(mutate ? 'browser_action_uncertain' : 'browser_unavailable', 503);
            }
            const fresh = await deps.target(principal, computerId);
            if (fresh?.binding !== target.binding || fresh.sandboxId !== target.sandboxId || expires <= deps.now()) {
                return fail('browser_session_stale', 409);
            }
            return reply(answer, 200);
        }
        const failure = (modern ? browserUiFailure : browserRuntimeFailure).safeParse(output);
        if (failure.success) {
            const status = FAILURE_STATUS[failure.data.error];
            if (status !== undefined) return reply(failure.data, status);
        }
        return fail(mutate ? 'browser_action_uncertain' : 'browser_unavailable', 503);
    } catch {
        return fail(dispatched && mutate ? 'browser_action_uncertain' : 'browser_unavailable', 503);
    }
}

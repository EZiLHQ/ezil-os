import {
    BROWSER_OBSERVE_PATH, BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE,
    BROWSER_CONTROL_PROCEDURE, BROWSER_CONTROL_SCOPE, BROWSER_PAGE_PROCEDURE, BROWSER_PAGE_SCOPE,
    BROWSER_UI_REQUEST_MAX_BYTES, browserSessionRequest, browserObserveSuccess, browserRuntimeFailure,
    browserUiSuccess, browserUiFailure, type BrowserSessionRequest, type BrowserUiRequest,
} from './contract';

type Principal = { userId: string; clientId: string };
type BrowserTarget = { sandboxId: string; binding: string };
type Dependencies = {
    enabled: boolean;
    controlEnabled?: boolean;
    verify: (headers: Headers, input: string, procedure: string, scope: string) => Promise<Principal | null>;
    target: (principal: Principal, computerId: string) => Promise<BrowserTarget | null>;
    observe: (principal: Principal, computerId: string, target: BrowserTarget, input: BrowserSessionRequest) => Promise<unknown>;
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

export async function handleBrowserObserve(request: Request, deps: Dependencies): Promise<Response> {
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
            const fresh = await deps.target(principal, computerId);
            if (fresh?.binding !== target.binding || fresh.sandboxId !== target.sandboxId || expires <= deps.now()) {
                return fail('browser_session_stale', 409);
            }
            return reply(value, 200);
        }
        const failure = (modern ? browserUiFailure : browserRuntimeFailure).safeParse(output);
        if (failure.success) {
            const { error } = failure.data;
            if (error === 'browser_session_stale' || error === 'browser_action_unavailable'
                || error === 'browser_action_conflict' || error === 'browser_action_pending') return reply(failure.data, 409);
            if (error === 'browser_page_unavailable') return reply(failure.data, 404);
        }
        return fail(mutate ? 'browser_action_uncertain' : 'browser_unavailable', 503);
    } catch {
        return fail(dispatched && mutate ? 'browser_action_uncertain' : 'browser_unavailable', 503);
    }
}

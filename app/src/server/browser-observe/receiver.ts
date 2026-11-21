import {
    BROWSER_OBSERVE_PATH, BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE,
    browserObserveRequest, browserObserveSuccess, browserRuntimeFailure,
    type BrowserObserveRequest,
} from './contract';

type Principal = { userId: string; clientId: string };
type BrowserTarget = { sandboxId: string; binding: string };
type Dependencies = {
    enabled: boolean;
    verify: (headers: Headers, input: string, procedure: string, scope: string) => Promise<Principal | null>;
    target: (principal: Principal, computerId: string) => Promise<BrowserTarget | null>;
    observe: (principal: Principal, computerId: string, target: BrowserTarget, input: BrowserObserveRequest) => Promise<unknown>;
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
    if (!deps.enabled) return fail('browser_unavailable', 404);
    const url = new URL(request.url);
    const computerId = BROWSER_OBSERVE_PATH.exec(url.pathname)?.[1];
    if (request.method !== 'POST' || url.search !== '' || !computerId || request.headers.get('content-type') !== 'application/json') {
        return fail('browser_invalid_request', 400);
    }
    let raw, input;
    try {
        raw = await readSmallBody(request, 1024);
        input = browserObserveRequest.parse(JSON.parse(raw));
    } catch {
        return fail('browser_invalid_request', 400);
    }
    try {
        const principal = await deps.verify(request.headers,
            ['EZIL-BROWSER-OBSERVE/1', 'POST', url.pathname, raw].join('\n'), BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE);
        if (!principal) return fail('browser_unauthorized', 401);
        const target = await deps.target(principal, computerId);
        if (!target) return fail('browser_not_found', 404);
        const output = await deps.observe(principal, computerId, target, input);
        const success = browserObserveSuccess.safeParse(output);
        if (success.success) {
            const value = success.data;
            const expires = Date.parse(value.expiresAt);
            if (expires <= deps.now() || expires > deps.now() + 125_000
                || (input.browserSessionId !== undefined && value.browserSessionId !== input.browserSessionId)
                || (value.observed === 'interactive_sign_in_required' && value.profileHeadingVisible)) {
                return fail('browser_unavailable', 503);
            }
            const fresh = await deps.target(principal, computerId);
            if (fresh?.binding !== target.binding || fresh.sandboxId !== target.sandboxId || expires <= deps.now()) {
                return fail('browser_session_stale', 409);
            }
            return reply(value, 200);
        }
        const failure = browserRuntimeFailure.safeParse(output);
        if (failure.success && failure.data.error !== 'browser_unavailable') {
            return reply(failure.data, failure.data.error === 'browser_session_stale' ? 409 : 404);
        }
        return fail('browser_unavailable', 503);
    } catch {
        return fail('browser_unavailable', 503);
    }
}

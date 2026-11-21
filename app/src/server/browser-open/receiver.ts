import { readSmallBody } from '../browser-observe/receiver';
import {
    BROWSER_OPEN_PATH, BROWSER_OPEN_PROCEDURE, BROWSER_OPEN_SCOPE,
    browserOpenFailure, browserOpenRequest, browserOpenSuccess, parseBrowserTestUrl,
    type BrowserOpenError, type BrowserOpenRequest, type BrowserOpenStage,
} from './contract';

export type BrowserPrincipal = { userId: string; clientId: string };
export type BrowserTarget = { sandboxId: string; binding: string };

type Dependencies = {
    enabled: boolean;
    allowedOrigins: ReadonlySet<string>;
    verify: (headers: Headers, input: string, procedure: string, scope: string) => Promise<BrowserPrincipal | null>;
    target: (principal: BrowserPrincipal, computerId: string) => Promise<BrowserTarget | null>;
    open: (
        principal: BrowserPrincipal, computerId: string, target: BrowserTarget,
        input: BrowserOpenRequest, signal: AbortSignal,
    ) => Promise<unknown>;
};

const statusByError: Record<BrowserOpenError, number> = {
    invalid_request: 400,
    invalid_url: 400,
    destination_denied: 403,
    browser_unauthorized: 401,
    computer_unavailable: 404,
    browser_session_stale: 409,
    browser_unavailable: 503,
    cdp_attach_failed: 503,
    navigation_timeout: 504,
    cancelled: 499,
    connection_lost: 503,
    target_closed: 409,
    request_conflict: 409,
    request_pending: 409,
    browser_busy: 429,
};

function reply(payload: unknown, status: number): Response {
    return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

function fail(runId: string | null, error: BrowserOpenError, stage: BrowserOpenStage, retryable = false): Response {
    return reply({ ok: false, runId, error, stage, retryable }, statusByError[error]);
}

export async function handleBrowserOpen(request: Request, deps: Dependencies): Promise<Response> {
    if (!deps.enabled) return reply({ ok: false, runId: null, error: 'browser_unavailable', stage: 'runtime', retryable: false }, 404);
    const requestUrl = new URL(request.url);
    const computerId = BROWSER_OPEN_PATH.exec(requestUrl.pathname)?.[1];
    if (!computerId || request.method !== 'POST' || requestUrl.search || request.headers.get('content-type') !== 'application/json') {
        return fail(null, 'invalid_request', 'request');
    }

    let raw: string;
    let input: BrowserOpenRequest;
    try {
        raw = await readSmallBody(request, 4096);
        input = browserOpenRequest.parse(JSON.parse(raw));
    } catch {
        return fail(null, 'invalid_request', 'request');
    }

    const { requestId } = input;
    try {
        const signedInput = ['EZIL-BROWSER-OPEN-URL/1', 'POST', requestUrl.pathname, raw].join('\n');
        const principal = await deps.verify(request.headers, signedInput, BROWSER_OPEN_PROCEDURE, BROWSER_OPEN_SCOPE);
        if (!principal) return fail(requestId, 'browser_unauthorized', 'authorization');

        const target = await deps.target(principal, computerId);
        if (!target) return fail(requestId, 'computer_unavailable', 'placement');

        const destination = parseBrowserTestUrl(input.url);
        if (!destination) return fail(requestId, 'invalid_url', 'destination');
        if (!deps.allowedOrigins.has(destination.origin)) return fail(requestId, 'destination_denied', 'destination');

        if (request.signal.aborted) return fail(requestId, 'cancelled', 'navigation');
        const output = await deps.open(principal, computerId, target, { ...input, url: destination.href }, request.signal);
        if (request.signal.aborted) return fail(requestId, 'cancelled', 'navigation');
        const failure = browserOpenFailure.safeParse(output);
        if (failure.success && failure.data.runId === requestId) {
            return reply(failure.data, statusByError[failure.data.error]);
        }

        const success = browserOpenSuccess.safeParse(output);
        if (!success.success || success.data.runId !== requestId) return fail(requestId, 'browser_unavailable', 'runtime');

        const finalUrl = parseBrowserTestUrl(success.data.finalUrl);
        if (!finalUrl || finalUrl.origin !== destination.origin) return fail(requestId, 'browser_unavailable', 'runtime');

        const fresh = await deps.target(principal, computerId);
        if (fresh?.binding !== target.binding || fresh.sandboxId !== target.sandboxId) {
            return fail(requestId, 'browser_session_stale', 'placement');
        }

        return reply({
            ...success.data,
            finalUrl: finalUrl.origin + finalUrl.pathname,
            title: success.data.title.replace(/[\x00-\x1f\x7f]/gu, ' ').trim(),
        }, 200);
    } catch {
        return request.signal.aborted
            ? fail(requestId, 'cancelled', 'navigation')
            : fail(requestId, 'browser_unavailable', 'runtime');
    }
}

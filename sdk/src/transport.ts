/**
 * The tRPC-over-HTTP wire, spoken directly.
 *
 * `@trpc/client` is deliberately not a dependency. This package speaks one
 * un-batched call at a time to a v11 endpoint with a superjson transformer,
 * which is a small enough surface to own outright — and owning it keeps the
 * SDK's dependency list at exactly one runtime package, which matters for
 * something a third party is asked to install.
 *
 * The shape, for anyone verifying it against the server
 * (`app/src/app/api/trpc/[trpc]/route.ts`):
 *
 *   query     GET  {base}/api/trpc/{path}?input={superjson}
 *   mutation  POST {base}/api/trpc/{path}   body: {superjson}
 *   success   200  { "result": { "data": {superjson} } }
 *   failure        { "error":  { "json": { "message", "code", "data" } } }
 *
 * An input of `undefined` is omitted entirely rather than sent as `null`,
 * because tRPC treats those differently for procedures with no input.
 */
import superjson from 'superjson';

import { EzilError } from './errors';

interface TrpcSuccess {
    result?: { data?: unknown };
}
interface TrpcFailure {
    error?: { json?: { message?: string; code?: string; data?: { code?: string; httpStatus?: number } } };
}

const joinUrl = (baseUrl: string, path: string): string => {
    const base = baseUrl.replace(/\/+$/, '');
    return `${base}/api/trpc/${path}`;
};

export interface CallOptions {
    baseUrl: string;
    token: string;
    fetchImpl: typeof globalThis.fetch;
    timeoutMs: number;
    signal?: AbortSignal;
}

export const call = async <T>(
    kind: 'query' | 'mutation',
    path: string,
    input: unknown,
    opts: CallOptions,
): Promise<T> => {
    const url = new URL(joinUrl(opts.baseUrl, path));
    const headers: Record<string, string> = {
        authorization: `Bearer ${opts.token}`,
        accept: 'application/json',
    };

    let body: string | undefined;
    if (kind === 'query') {
        if (input !== undefined) {
            url.searchParams.set('input', JSON.stringify(superjson.serialize(input)));
        }
    } else {
        headers['content-type'] = 'application/json';
        body = input === undefined ? '' : JSON.stringify(superjson.serialize(input));
    }

    // One timeout that also honours a caller-supplied signal. Without the
    // timeout a cold-boot call that never answers would hang a CLI or an MCP
    // server forever, which is the failure mode that looks like a crash.
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new Error(`timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
    const signal = opts.signal
        ? AbortSignal.any([opts.signal, timer.signal])
        : timer.signal;

    let res: Response;
    try {
        res = await opts.fetchImpl(url.toString(), {
            method: kind === 'query' ? 'GET' : 'POST',
            headers,
            ...(body === undefined ? {} : { body }),
            signal,
        });
    } catch (cause) {
        const timedOut = timer.signal.aborted;
        throw new EzilError(
            timedOut ? `${path} timed out after ${opts.timeoutMs}ms` : `${path} could not reach ${opts.baseUrl}`,
            { path, cause },
        );
    } finally {
        clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch (cause) {
        throw new EzilError(`${path} returned a non-JSON response (HTTP ${res.status})`, {
            path,
            status: res.status,
            cause,
        });
    }

    const failure = (parsed as TrpcFailure).error?.json;
    if (failure) {
        throw new EzilError(failure.message ?? `${path} failed`, {
            path,
            code: failure.code ?? failure.data?.code ?? null,
            status: failure.data?.httpStatus ?? res.status,
        });
    }

    if (!res.ok) {
        throw new EzilError(`${path} failed with HTTP ${res.status}`, { path, status: res.status });
    }

    const data = (parsed as TrpcSuccess).result?.data;
    if (data === undefined) {
        throw new EzilError(`${path} returned no result`, { path, status: res.status });
    }

    // superjson round-trips the Dates in `Computer` — without this,
    // `createdAt` arrives as a string that merely looks like one.
    return superjson.deserialize(data as Parameters<typeof superjson.deserialize>[0]) as T;
};

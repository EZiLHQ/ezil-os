/**
 * The local host's response layer — the twin of
 * `app/src/server/shell/http.ts`.
 *
 * The shell branches on this shape. `shell/ezil/session.js`'s `request()` reads
 * `data.error.code` and `data.error.message` off a non-2xx body and maps the
 * code (`UNAUTHORIZED`, `BAD_GATEWAY`, `GATEWAY_TIMEOUT`, …) onto its own
 * `errorCode` vocabulary; `apps/code.js` does the same independently. A local
 * host that answered a differently-shaped error would degrade every failure to
 * `unknown` and the generic "if it keeps happening, let us know" copy — the
 * exact defect `session.js:452`'s comment records having been fixed once
 * already.
 *
 * ── There is no authorization here, because there is nothing to authorize ───
 * The hosted handlers open with `if (!ctx.user) return shellUnauthenticated()`
 * because they are reachable from the internet by anyone with a session. This
 * host binds `127.0.0.1` only (`./server.ts`) and serves the one user the
 * process is running as. Adding a token would be authentication with no
 * authorization behind it — a second gate that gates nothing, which is exactly
 * the thing this project's rule about "one implementation" forbids. What DOES
 * gate every route is that `computerId` must be the id this host derived from
 * its own workspace path; see `./routes.ts`.
 */

/** Shell responses are per-user and can create state. Never cache them, anywhere. Same header set as the hosted twin. */
const NO_STORE = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
} as const;

export function shellJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

export interface ShellErrorBody {
    readonly error: {
        /** A tRPC error code, so this host and `/api/trpc` agree on the vocabulary the shell switches on. */
        readonly code: string;
        readonly message: string;
    };
}

/**
 * The tRPC codes this host can produce, and the HTTP status each maps to.
 *
 * Restated rather than imported: `getHTTPStatusCodeFromError` lives in
 * `@trpc/server`, which local mode does not depend on and must not start
 * depending on to serve a 400. The four entries are the ones the handlers can
 * actually reach, and `./shell-contract.test.ts` asserts each is the status the
 * shell's own branches expect.
 */
export const SHELL_ERROR_STATUS = {
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    METHOD_NOT_SUPPORTED: 405,
    PAYLOAD_TOO_LARGE: 413,
    INTERNAL_SERVER_ERROR: 500,
} as const;

export type ShellErrorCode = keyof typeof SHELL_ERROR_STATUS;

export function shellError(code: ShellErrorCode, message: string): Response {
    return shellJson({ error: { code, message } } satisfies ShellErrorBody, SHELL_ERROR_STATUS[code]);
}

/**
 * A thrown error becomes a 500 with a FIXED message.
 *
 * Same rule as the hosted `shellErrorResponse`: an internal error's real text
 * can carry a filesystem path, a container name or a stack fragment, and none
 * of that belongs in a browser. The detail is logged where it belongs and
 * nowhere else.
 */
const GENERIC_SERVER_ERROR = 'Something went wrong on this machine.';

export function shellThrownResponse(err: unknown, route: string): Response {
    console.error(`[ezil-local] ${route} threw`, {
        error: err instanceof Error ? err.message : String(err),
    });
    return shellError('INTERNAL_SERVER_ERROR', GENERIC_SERVER_ERROR);
}

/**
 * How much JSON any `/api/shell/*` route will read.
 *
 * 64KB, the same bound `TELEMETRY_LIMITS.MAX_BODY_BYTES` puts on the hostile
 * surface upstream. Every other route's body is two short fields, so the cap
 * only ever bites on a bug or an attempt.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export type BodyResult =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly response: Response };

/**
 * Read and parse a JSON body at the boundary, bounded by BYTES ACTUALLY READ.
 *
 * `Content-Length` is a claim by the caller and is not consulted: a chunked
 * body carries none, and a lying one is exactly what a cap is for. The bytes
 * are counted as they arrive and the read is abandoned the moment it exceeds
 * the cap.
 */
export async function readJsonBody(req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<BodyResult> {
    let text: string;
    try {
        text = await readBoundedText(req, maxBytes);
    } catch (err) {
        if (err instanceof BodyTooLargeError) {
            return { ok: false, response: shellError('PAYLOAD_TOO_LARGE', 'Body too large.') };
        }
        return { ok: false, response: shellError('BAD_REQUEST', 'Could not read the request body.') };
    }
    if (text.trim() === '') {
        // An empty body is a legal, meaningful request on this surface:
        // `session.js#openSession` POSTs `{}` and `shell/ezil` never sends a
        // bodyless POST, but a `sendBeacon` with an empty blob would. Treat it
        // as `{}` so a route's own field validation is the one that answers.
        return { ok: true, value: {} };
    }
    try {
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
        return { ok: false, response: shellError('BAD_REQUEST', 'Expected a JSON body.') };
    }
}

class BodyTooLargeError extends Error {}

async function readBoundedText(req: Request, maxBytes: number): Promise<string> {
    const body = req.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new BodyTooLargeError(`body_over_${maxBytes}_bytes`);
            }
            chunks.push(value);
        }
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        joined.set(c, offset);
        offset += c.byteLength;
    }
    return new TextDecoder().decode(joined);
}

/** A plain object, for a body whose fields are about to be read. `null` and arrays are not objects for this purpose. */
export function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * A correlation id for one request.
 *
 * The hosted procedures put one on every answer and the shell carries it into
 * telemetry, so a local answer without one would be the single field that goes
 * missing when someone compares a local trace to a hosted one.
 * `crypto.randomUUID()` — no entropy claim is being made, this is a log key.
 */
export function newCorrelationId(): string {
    return crypto.randomUUID();
}

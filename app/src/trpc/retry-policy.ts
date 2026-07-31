/**
 * Retry policy for tRPC queries — one rule, applied everywhere.
 *
 * ── The problem this exists to fix ──────────────────────────────────────────
 * TanStack Query retries EVERY failed query by default (`retry: 3` → four
 * attempts, with 1s/2s/4s backoff between them; `defaultRetryDelay` in
 * `@tanstack/query-core`). That default is only defensible for a failure a
 * second, byte-identical attempt could plausibly fix.
 *
 * For a DETERMINISTIC failure it is pure cost. The request was malformed, the
 * signature didn't verify, the caller doesn't own the resource, the cap is
 * already reached — the second and third attempts send exactly the same bytes
 * to exactly the same endpoint and get exactly the same answer, and the user
 * stares at a spinner for the whole round. Observed live on
 * `cloudflareGuacamole.previewUrl` (which set `retry: 2`): three attempts of
 * silence for an error that was never going to succeed.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *   DETERMINISTIC  → surface on the FIRST attempt, never retry.
 *     4xx from our own API: `BAD_REQUEST` (e.g. the Worker's
 *     `400 missing_project_id`), `UNAUTHORIZED`/`FORBIDDEN` (auth + HMAC
 *     signature failures, the `computer_limit_reached` cap), `NOT_FOUND`
 *     (the ownership rejection `assertOwnedComputer` raises),
 *     `PRECONDITION_FAILED`, `CONFLICT`.
 *
 *   RETRYABLE      → retry with backoff, up to the caller's budget.
 *     Transport/network failures (no HTTP status at all — the request never
 *     got an answer), any 5xx, and the two 4xx statuses that explicitly mean
 *     "ask again later" rather than "this request is wrong": 408 Request
 *     Timeout and 429 Too Many Requests.
 *
 * Note the asymmetry, and that it is deliberate: an error we cannot classify
 * is treated as RETRYABLE. Getting it wrong in that direction costs a
 * duplicate request; getting it wrong the other way silently converts a real
 * transient blip into a hard user-visible failure.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * This only governs failures that THROW. A tRPC procedure that returns a typed
 * `{ ok: false, errorCode }` result (the desktop-boot path's honest error
 * surface — see `server/api/routers/cloudflare-guacamole.ts`) is a successful
 * query as far as TanStack Query is concerned and is never retried by anyone.
 * That is the strongest possible guarantee for the deterministic cases routed
 * that way: they cannot be retried, whatever a caller passes for `retry`.
 */

/**
 * HTTP status for each tRPC error code, used only as a fallback when the
 * serialized error somehow carries `data.code` without `data.httpStatus`.
 * Mirrors `@trpc/server`'s own `TRPC_ERROR_CODES_BY_KEY` → HTTP mapping.
 */
const TRPC_CODE_HTTP_STATUS: Readonly<Record<string, number>> = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    PAYMENT_REQUIRED: 402,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_SUPPORTED: 405,
    TIMEOUT: 408,
    CONFLICT: 409,
    PRECONDITION_FAILED: 412,
    PAYLOAD_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    UNPROCESSABLE_CONTENT: 422,
    TOO_MANY_REQUESTS: 429,
    CLIENT_CLOSED_REQUEST: 499,
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
};

/**
 * The two 4xx statuses that are a genuine "later, not never". Everything else
 * in the 4xx family says the request itself is wrong, and repeating it
 * unchanged cannot help.
 */
const RETRYABLE_4XX = new Set([408, 429]);

/** TanStack Query's own default retry budget, kept so this change alters WHICH errors retry, not how many times. */
export const DEFAULT_QUERY_RETRIES = 3;

/**
 * Retry budget for the desktop preview boot. Deliberately smaller than the
 * global default: each attempt can carry a full container cold start
 * (`docs/PLATFORM-NOTES.md` §11, ~22s), so an extra attempt is expensive.
 */
export const DESKTOP_PREVIEW_RETRIES = 2;

/**
 * Recover the HTTP status from a thrown query error. `undefined` means the
 * failure never reached a status — a transport/network error — which is
 * treated as retryable by `isDeterministicQueryError` below.
 *
 * Reads the shape a `TRPCClientError` carries (`error.data.httpStatus`,
 * populated from the server's error formatter), so it works on the client
 * without importing the client error class.
 */
export function httpStatusFromQueryError(error: unknown): number | undefined {
    const data = (error as { data?: { httpStatus?: unknown; code?: unknown } } | null | undefined)?.data;
    if (!data || typeof data !== 'object') return undefined;
    if (typeof data.httpStatus === 'number') return data.httpStatus;
    if (typeof data.code === 'string') return TRPC_CODE_HTTP_STATUS[data.code];
    return undefined;
}

/**
 * True when re-sending the identical request cannot change the answer, so the
 * error should be shown to the user immediately instead of after N silent
 * duplicate attempts.
 */
export function isDeterministicQueryError(error: unknown): boolean {
    const status = httpStatusFromQueryError(error);
    if (status === undefined) return false; // no answer at all → transport → retryable
    if (RETRYABLE_4XX.has(status)) return false;
    return status >= 400 && status < 500;
}

/**
 * Build a TanStack Query `retry` predicate that retries transient failures up
 * to `maxRetries` times and deterministic ones never.
 *
 * `failureCount` is 0 on the first failure (query-core increments it *after*
 * consulting this predicate), so `failureCount < maxRetries` yields exactly
 * `maxRetries` retries — identical arithmetic to passing the number directly.
 */
export function retryTransientOnly(
    maxRetries: number = DEFAULT_QUERY_RETRIES,
): (failureCount: number, error: unknown) => boolean {
    return (failureCount: number, error: unknown): boolean => {
        if (isDeterministicQueryError(error)) return false;
        return failureCount < maxRetries;
    };
}

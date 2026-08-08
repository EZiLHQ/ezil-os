import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_QUERY_RETRIES,
    DESKTOP_PREVIEW_RETRIES,
    httpStatusFromQueryError,
    isDeterministicQueryError,
    retryTransientOnly,
} from './retry-policy';
import { surfacePreviewErrorAsValue } from '@/server/lib/cloudflare-guacamole-provider';

/**
 * The contract under test is a latency contract, not a correctness one, so it
 * is stated the way the user experiences it: on which ATTEMPT does the error
 * reach the screen?
 *
 * `failureCount` is 0 on the first failure (`@tanstack/query-core`'s retryer
 * increments it after consulting the predicate), so
 * `predicate(0, err) === false` is literally "the first attempt is the last
 * one — show it now".
 */

/** Build the error shape a `TRPCClientError` carries for a server-thrown `TRPCError`. */
function trpcError(code: string, httpStatus: number): Error & { data: unknown } {
    return Object.assign(new Error(`${code}: boom`), {
        data: { code, httpStatus, path: 'cloudflareGuacamole.previewUrl' },
    });
}

describe('httpStatusFromQueryError', () => {
    it('reads the status a tRPC client error carries', () => {
        expect(httpStatusFromQueryError(trpcError('NOT_FOUND', 404))).toBe(404);
    });

    it('falls back to the tRPC error code when httpStatus is absent', () => {
        expect(httpStatusFromQueryError({ data: { code: 'FORBIDDEN' } })).toBe(403);
        expect(httpStatusFromQueryError({ data: { code: 'BAD_GATEWAY' } })).toBe(502);
    });

    it('returns undefined for a transport failure that never reached a status', () => {
        expect(httpStatusFromQueryError(new TypeError('fetch failed'))).toBeUndefined();
        expect(httpStatusFromQueryError(undefined)).toBeUndefined();
        expect(httpStatusFromQueryError(null)).toBeUndefined();
        expect(httpStatusFromQueryError({ data: null })).toBeUndefined();
        expect(httpStatusFromQueryError({ data: { code: 'NOT_A_REAL_CODE' } })).toBeUndefined();
    });
});

describe('isDeterministicQueryError', () => {
    it.each([
        ['BAD_REQUEST', 400], // the Worker's 400 missing_project_id, surfaced by the router
        ['UNAUTHORIZED', 401], // session expired / HMAC signature failure
        ['FORBIDDEN', 403], // the computer_limit_reached cap
        ['NOT_FOUND', 404], // ownership rejection (assertOwnedComputer)
        ['CONFLICT', 409],
        ['PRECONDITION_FAILED', 412],
    ])('treats %s (%i) as deterministic', (code, status) => {
        expect(isDeterministicQueryError(trpcError(code, status))).toBe(true);
    });

    it.each([
        ['TIMEOUT', 408], // "later", not "never"
        ['TOO_MANY_REQUESTS', 429], // "later", not "never"
        ['INTERNAL_SERVER_ERROR', 500],
        ['BAD_GATEWAY', 502],
        ['SERVICE_UNAVAILABLE', 503],
        ['GATEWAY_TIMEOUT', 504],
    ])('treats %s (%i) as retryable', (code, status) => {
        expect(isDeterministicQueryError(trpcError(code, status))).toBe(false);
    });

    it('treats an unclassifiable error as retryable, not deterministic', () => {
        // Erring this way costs one duplicate request; erring the other way
        // turns a transient blip into a hard user-visible failure.
        expect(isDeterministicQueryError(new TypeError('fetch failed'))).toBe(false);
    });
});

describe('retryTransientOnly — a deterministic error surfaces on the FIRST attempt', () => {
    const retry = retryTransientOnly(DESKTOP_PREVIEW_RETRIES);

    it('never retries the Worker 400 missing_project_id path (BAD_REQUEST)', () => {
        expect(retry(0, trpcError('BAD_REQUEST', 400))).toBe(false);
    });

    it('never retries an auth/signature failure', () => {
        expect(retry(0, trpcError('UNAUTHORIZED', 401))).toBe(false);
    });

    it('never retries an ownership rejection', () => {
        expect(retry(0, trpcError('NOT_FOUND', 404))).toBe(false);
    });

    it('never retries a cap-reached rejection', () => {
        expect(retry(0, trpcError('FORBIDDEN', 403))).toBe(false);
    });

    it('refuses at every failureCount, not just the first (no accidental late retry)', () => {
        for (const failureCount of [0, 1, 2, 5]) {
            expect(retry(failureCount, trpcError('BAD_REQUEST', 400))).toBe(false);
        }
    });
});

describe('retryTransientOnly — a retryable error still retries, with the same budget', () => {
    const retry = retryTransientOnly(DESKTOP_PREVIEW_RETRIES);

    it('retries a 5xx up to the budget, then stops', () => {
        const err = trpcError('BAD_GATEWAY', 502);
        expect(retry(0, err)).toBe(true); // 2nd attempt
        expect(retry(1, err)).toBe(true); // 3rd attempt
        expect(retry(2, err)).toBe(false); // budget spent — surface it
    });

    it('retries a transport failure with no status at all', () => {
        expect(retry(0, new TypeError('fetch failed'))).toBe(true);
    });

    it('retries 408 and 429 — "later", not "never"', () => {
        expect(retry(0, trpcError('TIMEOUT', 408))).toBe(true);
        expect(retry(0, trpcError('TOO_MANY_REQUESTS', 429))).toBe(true);
    });

    it('honours the larger global budget when built with the default', () => {
        const globalRetry = retryTransientOnly();
        const err = trpcError('SERVICE_UNAVAILABLE', 503);
        expect(globalRetry(DEFAULT_QUERY_RETRIES - 1, err)).toBe(true);
        expect(globalRetry(DEFAULT_QUERY_RETRIES, err)).toBe(false);
    });

    it('keeps the same attempt arithmetic a bare number would have given', () => {
        // `retry: 2` retried while failureCount < 2 → 3 attempts total.
        expect(DESKTOP_PREVIEW_RETRIES).toBe(2);
        expect(DEFAULT_QUERY_RETRIES).toBe(3); // TanStack's own default count
    });
});

/**
 * A policy nothing calls is not a policy. These read the call sites, because
 * the defect being fixed was a literal `retry: 2` sitting in a component —
 * exactly the thing a unit test of the predicate cannot see.
 * (`docs/PLATFORM-NOTES.md` method note: verify the artifact that executes.)
 */
describe('the policy is actually wired in', () => {
    const src = (relative: string) =>
        readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

    it('is the QueryClient default, so every query without an explicit option gets it', () => {
        const text = src('trpc/query-client.ts');
        expect(text).toContain('retryTransientOnly');
        expect(text).toMatch(/retry:\s*retryTransientOnly\(\)/);
    });

    it('governs the desktop preview query, and no bare retry count survives there', () => {
        const text = src('components/desktop/cloudflare-guacamole-canvas.tsx');
        expect(text).toMatch(/retry:\s*retryTransientOnly\(DESKTOP_PREVIEW_RETRIES\)/);
        // The exact defect: a blanket count that retried deterministic
        // errors. Anchored to a line-leading option (prose about the old
        // `retry: 2` is allowed to survive in comments; the option is not).
        expect(text).not.toMatch(/^\s*retry:\s*\d/m);
    });

    it('leaves the 2s status poll on retry:false — the next poll IS the retry', () => {
        expect(src('components/desktop/cloudflare-guacamole-canvas.tsx')).toMatch(/retry:\s*false/);
    });

    it('lets the preview router surface a non-retryable Worker failure as a value, never a throw', () => {
        // A returned result cannot be retried by construction; a thrown
        // TRPCError is the only thing TanStack Query retries.
        //
        // The rule itself moved into the provider as
        // `surfacePreviewErrorAsValue` (the router imports the database and
        // cannot be loaded by a unit test, so the rule was unexaminable where
        // it was — see `server/lib/preview-error-code-transit.test.ts`, which
        // now sweeps its BEHAVIOUR). What stays here is the wiring: the router
        // must consult it, and must do so BEFORE it reaches for the throw.
        const text = src('server/api/routers/cloudflare-guacamole.ts');
        expect(text).toContain('surfacePreviewErrorAsValue(result.errorCode, result.retryable)');
        const surfaceIdx = text.indexOf('surfacePreviewErrorAsValue(result.errorCode, result.retryable)');
        const throwIdx = text.indexOf("code: 'BAD_GATEWAY'");
        expect(surfaceIdx).toBeGreaterThan(-1);
        expect(throwIdx).toBeGreaterThan(surfaceIdx);
        // ...at every one of the three procedures that call the Worker, not
        // just the first. A procedure that quietly kept the old inline test
        // would keep throwing away the code.
        expect(text.split('surfacePreviewErrorAsValue(result.errorCode, result.retryable)').length - 1).toBe(3);
        // And the rule is not ALSO restated here, where it could drift.
        expect(text).not.toContain('!result.retryable ||');
    });

    it('a deterministic failure really does come back as a value', () => {
        // The behavioural half of the check above, so "the router calls the
        // function" is not the only thing being asserted about the function.
        expect(surfacePreviewErrorAsValue('unauthorized', false)).toBe(true);
        expect(surfacePreviewErrorAsValue('custom_domain_required', false)).toBe(true);
    });
});

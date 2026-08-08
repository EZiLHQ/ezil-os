/**
 * 🔴 THE PLACE THE ERROR CODE WAS DESTROYED IN TRANSIT.
 *
 * The provider classifies a preview failure precisely. The router then decides
 * whether that classification reaches the browser at all:
 *
 *   - as a VALUE — `{ok:false, errorCode, ...}` on a 200 — the shell reads
 *     `data.errorCode` and renders the right copy; or
 *   - as a THROW — `TRPCError BAD_GATEWAY` — which `server/shell/http.ts`
 *     deliberately renders as `{error:{code:'BAD_GATEWAY', message:<generic>}}`
 *     with a 502, because a 5xx message can carry internals. Both shell
 *     clients (`session.js`'s `openDesktop`/`previewUrl`, `apps/code.js`'s
 *     mint) map every non-401 HTTP failure to `unknown`, whose copy is the
 *     dead end "We couldn't start your computer."
 *
 * That second path is how a hibernating container's failure arrived
 * unlabelled: the Worker's 500 `desktop_failed_to_start` classified as
 * `worker_http_error`, which is retryable and was NOT operational, so it threw
 * — and 187 seconds of waiting produced a message with no information in it.
 *
 * `surfacePreviewErrorAsValue` is that decision, extracted so it can be
 * tested. This suite is about ONE property: a code the browser has to act on
 * must survive the trip.
 */

import { describe, expect, it } from 'vitest';

import {
    isRetryablePreviewErrorCode,
    surfacePreviewErrorAsValue,
    type GuacamolePreviewErrorCode,
} from './cloudflare-guacamole-provider';

/** Every code `requestGuacamolePreview` can produce, so the sweep cannot go stale quietly. */
const EVERY_CODE: readonly GuacamolePreviewErrorCode[] = [
    'bad_request',
    'unauthorized',
    'preconditions_unmet',
    'custom_domain_required',
    'connection_refused',
    'fetch_failed',
    'sandbox_runtime_blocked',
    'sandbox_start_failed',
    'sandbox_starting',
    'worker_http_error',
    'timeout',
    'unknown',
];

describe('🔴 surfacePreviewErrorAsValue — a wake must reach the browser labelled', () => {
    it('surfaces `sandbox_starting` as a value, always', () => {
        // The regression, stated as one line. If this is false, a hibernation
        // wake becomes a 502, the shell calls it `unknown`, the wake loop never
        // runs, and the user is back to "We couldn't start your computer."
        expect(surfacePreviewErrorAsValue('sandbox_starting', isRetryablePreviewErrorCode('sandbox_starting'))).toBe(
            true,
        );
    });

    it('surfaces every DETERMINISTIC failure as a value — a throw is what TanStack retries', () => {
        for (const code of EVERY_CODE) {
            if (isRetryablePreviewErrorCode(code)) continue;
            expect(surfacePreviewErrorAsValue(code, false), code).toBe(true);
        }
    });

    it('surfaces the operational family as values too', () => {
        for (const code of [
            'connection_refused',
            'fetch_failed',
            'sandbox_start_failed',
            'sandbox_starting',
            'timeout',
        ] as const) {
            expect(surfacePreviewErrorAsValue(code, true), code).toBe(true);
        }
    });

    it('is not a rubber stamp — a retryable, non-operational code still throws', () => {
        // `worker_http_error` is a genuine 5xx from the Worker. It is retried
        // by the canvas on purpose (`retryTransientOnly`), and that only works
        // because it is thrown. Documented here so the sweep above is a
        // discrimination rather than "everything is a value".
        expect(surfacePreviewErrorAsValue('worker_http_error', true)).toBe(false);
    });

    it('cannot surface a failure with no code — there would be nothing to surface', () => {
        expect(surfacePreviewErrorAsValue(undefined, true)).toBe(false);
        expect(surfacePreviewErrorAsValue('', true)).toBe(false);
    });

    it('the sweep contains both answers, so none of the above is vacuous', () => {
        const answers = new Set(
            EVERY_CODE.map((c) => surfacePreviewErrorAsValue(c, isRetryablePreviewErrorCode(c))),
        );
        expect([...answers].sort()).toEqual([false, true]);
    });
});

/**
 * The `/computer/[id]` status pill.
 *
 * It used to be four lines of static JSX in the page's server component — a
 * green dot and the word "Live", derived from nothing. It said "Live" before
 * the preview request had been issued, through the whole ~22s cold boot, over
 * every failure panel the canvas rendered, and on 2026-07-31 over an HTTP 500
 * "Proxy routing error" from the desktop host. `/computer/[id]` is the escape
 * hatch when the shell fails, so a decorative status pill there is the last
 * thing a user has to go on.
 *
 * These assert the one rule that makes it not a decoration: green is reachable
 * from exactly one input, and that input is only produced by
 * `computeBootUiState` with a CONFIRMED desktop frame.
 */

import { describe, expect, it } from 'vitest';

import { computeBootUiState } from './boot-phases';
import { desktopSurfaceStatus } from './desktop-status';

describe('desktopSurfaceStatus — the pill claims only what was observed', () => {
    it('is "live" for a ready desktop, and for nothing else', () => {
        expect(desktopSurfaceStatus('ready')).toBe('live');
        expect(desktopSurfaceStatus('progress')).toBe('starting');
        expect(desktopSurfaceStatus('failed')).toBe('down');
        expect(desktopSurfaceStatus('not_configured')).toBe('off');
    });

    it('claims nothing before the canvas has observed anything', () => {
        // The state on first paint. Neither green nor red: we do not know yet,
        // and the old code's answer to "we do not know yet" was "Live".
        expect(desktopSurfaceStatus(undefined)).toBe('checking');
    });

    it('🔴 cannot go green over a desktop host that returned 500', () => {
        // `frameConfirmed: false` is what `probeDesktopFrame` produces for the
        // observed `HTTP 500 "Proxy routing error"` — see
        // `server/lib/desktop-frame-honesty.test.ts`, which drives that end of
        // the chain against a real 500 over a real socket.
        const state = computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            frameConfirmed: false,
        });
        expect(desktopSurfaceStatus(state.kind)).toBe('down');
    });

    it('cannot go green merely because the preview request succeeded', () => {
        // The exact old behaviour: a URL came back, so the pill went green.
        const state = computeBootUiState({ requestStatus: 'success', elapsedMs: 0 });
        expect(desktopSurfaceStatus(state.kind)).not.toBe('live');
    });

    it('cannot go green during the boot, however long it has been running', () => {
        for (const elapsedMs of [0, 21_500, 120_000]) {
            const state = computeBootUiState({
                requestStatus: 'pending',
                elapsedMs,
                confirmedGuacamoleRunning: true,
            });
            expect(desktopSurfaceStatus(state.kind)).toBe('starting');
        }
    });

    it('does go green for a confirmed desktop — the rule discriminates, it does not just refuse', () => {
        const state = computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            frameConfirmed: true,
        });
        expect(desktopSurfaceStatus(state.kind)).toBe('live');
    });
});

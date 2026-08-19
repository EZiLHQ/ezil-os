/**
 * The snap — the one decision that turns "this window is 390x844 CSS pixels on
 * a 3x phone" into "boot the desktop at 1080x1920".
 *
 * It is a pure function of two integers, so it is tested exhaustively and with
 * real device boxes rather than with round numbers chosen to make it pass. The
 * cases that matter are the ones where a plausible-but-wrong implementation
 * gives a different answer:
 *
 *   - a PORTRAIT request must never snap to a LANDSCAPE mode. The whole defect
 *     being fixed is a portrait phone showing a 16:9 strip; a snap that picks
 *     16:9 for a phone reproduces it exactly, while still passing any test that
 *     only checks "returns a mode from the table".
 *   - "nearest by area" must mean NEAREST, not LARGEST. Preferring the largest
 *     entry inside an aspect class puts every phone at the 2,073,600-pixel
 *     ceiling — the one thing `PLATFORM-NOTES` §23's CPU budget says not to do
 *     — while still producing a correctly-shaped desktop, so it would look
 *     right and cost double.
 *   - the aspect metric must be scale-symmetric. `|a − b|` on raw ratios gives
 *     portrait requests less discrimination than their landscape mirrors; the
 *     mirror tests below fail under it and pass under `|ln a − ln b|`.
 */

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SCREEN_MODE,
    MAX_REQUESTED_AXIS,
    MIN_REQUESTED_AXIS,
    SCREEN_MODES,
    SCREEN_PIXEL_CEILING,
    SCREEN_WIDTH_ALIGNMENT,
    classifyScreenFailure,
    describeAppliedScreen,
    isScreenMode,
    parseRequestedScreen,
    resolveScreenRequest,
    snapScreenMode,
} from './cloudflare-guacamole-provider';

const key = (m: { width: number; height: number }) => `${m.width}x${m.height}`;

describe('the mode table', () => {
    it('is entirely even (odd dimensions produce vp8 chroma artefacts)', () => {
        expect(SCREEN_MODES.filter((m) => m.width % 2 || m.height % 2)).toEqual([]);
    });

    it('never exceeds the 1920x1080 pixel ceiling', () => {
        expect(SCREEN_MODES.filter((m) => m.width * m.height > SCREEN_PIXEL_CEILING)).toEqual([]);
    });

    it('contains the default and has no duplicates', () => {
        expect(isScreenMode(DEFAULT_SCREEN_MODE.width, DEFAULT_SCREEN_MODE.height)).toBe(true);
        expect(new Set(SCREEN_MODES.map(key)).size).toBe(SCREEN_MODES.length);
    });

    it('🔴 has only 8-ALIGNED widths — Xvfb floors the width and reports success', () => {
        // MEASURED: requesting `900x1600` produces a display that is actually
        // `896x1600`, and `902x902` produces `896x902`. Height is not
        // quantised. An unaligned entry is a size the server would report as
        // applied and the platform would silently change — which is the exact
        // class of lie `source: 'requested'` exists to make impossible.
        expect(SCREEN_MODES.filter((m) => m.width % SCREEN_WIDTH_ALIGNMENT !== 0)).toEqual([]);
    });

    it('carries 896x1600, not the 900x1600 the contract first listed', () => {
        expect(isScreenMode(896, 1600)).toBe(true);
        expect(isScreenMode(900, 1600)).toBe(false);
    });
});

describe('parseRequestedScreen — the boundary with untrusted JSON', () => {
    it('accepts two plain integers in range', () => {
        expect(parseRequestedScreen({ width: 1170, height: 2532 })).toEqual({ width: 1170, height: 2532 });
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['a string', '1080x1920'],
        ['an array', [1080, 1920]],
        ['a numeric string', { width: '1080', height: '1920' }],
        ['a fraction', { width: 1080.5, height: 1920 }],
        ['NaN', { width: Number.NaN, height: 1920 }],
        ['Infinity', { width: 1080, height: Number.POSITIVE_INFINITY }],
        ['a negative', { width: -1080, height: 1920 }],
        ['zero', { width: 0, height: 0 }],
        ['an absurd size', { width: 1e9, height: 1e9 }],
        ['a half-supplied pair', { width: 1080 }],
        ['a boolean', { width: true, height: 1920 }],
        ['an object with valueOf', { width: { valueOf: () => 1080 }, height: 1920 }],
    ])('rejects %s as null, never a coerced guess', (_label, value) => {
        expect(parseRequestedScreen(value)).toBeNull();
    });

    it('rejects just outside the range and accepts just inside it', () => {
        expect(parseRequestedScreen({ width: MIN_REQUESTED_AXIS - 1, height: 1000 })).toBeNull();
        expect(parseRequestedScreen({ width: 1000, height: MAX_REQUESTED_AXIS + 1 })).toBeNull();
        expect(parseRequestedScreen({ width: MIN_REQUESTED_AXIS, height: MAX_REQUESTED_AXIS })).not.toBeNull();
    });
});

describe('snapScreenMode — real device boxes, not round numbers', () => {
    it('honours an exact table entry verbatim, and says so', () => {
        for (const mode of SCREEN_MODES) {
            expect(snapScreenMode(mode.width, mode.height)).toEqual({ ...mode, source: 'requested' });
        }
    });

    it.each([
        // label, requested (device pixels), expected mode
        ['iPhone 14 Pro portrait (390x844 @3x)', 1170, 2532, '1080x1920'],
        ['iPhone SE portrait (375x667 @2x)', 750, 1334, '720x1280'],
        ['a phone at dpr 1 (390x844)', 390, 844, '720x1280'],
        ['iPad portrait (820x1180 @2x)', 1640, 2360, '1200x1600'],
        ['iPad landscape (1180x820 @2x)', 2360, 1640, '1024x768'],
        ['a 1080p desktop, full-bleed', 1920, 1080, '1920x1080'],
        ['a MacBook Air (1440x900 @2x)', 2880, 1800, '1440x900'],
        ['a half-screen desktop window (960x540 @1x)', 960, 540, '1280x720'],
        ['a phone in landscape (844x390 @3x)', 2532, 1170, '1920x1080'],
    ])('%s -> %s', (_label, w, h, expected) => {
        expect(key(snapScreenMode(w as number, h as number))).toBe(expected);
    });

    it('🔴 never answers a portrait request with a landscape mode, or vice versa', () => {
        // The exact shape of the reported defect: a portrait phone shown a
        // 16:9 strip. A snap that returns a landscape mode here is that bug.
        //
        // 🔴 NOT asserted for a NEARLY SQUARE box, and that is a real property
        // of the table rather than a gap in this test. The nearest shape to
        // 1000x1001 is 5:4 (1280x1024), which is landscape by one axis — and
        // it is genuinely the closest thing the X server advertises. The
        // guarantee this test makes is about boxes that are unambiguously one
        // orientation; a square window has no orientation to preserve.
        const portrait = [
            [1170, 2532],
            [750, 1334],
            [1640, 2360],
            [390, 844],
            [1000, 1400],
        ];
        for (const [w, h] of portrait) {
            const got = snapScreenMode(w!, h!);
            expect(`${w}x${h} -> ${key(got)} portrait=${got.height > got.width}`).toBe(
                `${w}x${h} -> ${key(got)} portrait=true`,
            );
        }
        const landscape = [
            [2532, 1170],
            [1920, 1080],
            [2880, 1800],
            [1001, 1000],
        ];
        for (const [w, h] of landscape) {
            const got = snapScreenMode(w!, h!);
            expect(`${w}x${h} -> ${key(got)} landscape=${got.width > got.height}`).toBe(
                `${w}x${h} -> ${key(got)} landscape=true`,
            );
        }
    });

    it('🔴 is MIRROR-SYMMETRIC across every transposed pair the table actually contains', () => {
        // This is what fails under a raw `|a − b|` aspect metric and passes
        // under `|ln a − ln b|`: rotating a device must rotate its answer, not
        // change which family it lands in.
        const pairs: Array<[number, number]> = [
            [1170, 2532],
            [750, 1334],
            [1640, 2360],
            [960, 540],
            [2880, 1800],
        ];
        for (const [w, h] of pairs) {
            const upright = snapScreenMode(w, h);
            const rotated = snapScreenMode(h, w);
            const transposeExists = isScreenMode(upright.height, upright.width);
            if (!transposeExists) continue; // the table is not fully symmetric
            expect(`${w}x${h} rotated -> ${key(rotated)}`).toBe(
                `${w}x${h} rotated -> ${upright.height}x${upright.width}`,
            );
        }
    });

    it('🔴 picks the NEAREST area inside an aspect class, never the largest', () => {
        // All three of these are exactly 16:9 and differ only in area. A
        // "largest wins" implementation returns 1920x1080 for all three and
        // costs a small window the whole CPU budget.
        expect(key(snapScreenMode(1918, 1079))).toBe('1920x1080');
        expect(key(snapScreenMode(1500, 844))).toBe('1600x900');
        expect(key(snapScreenMode(1000, 562))).toBe('1280x720');
        expect(key(snapScreenMode(600, 338))).toBe('1280x720');
        // …and the same in portrait.
        expect(key(snapScreenMode(1070, 1902))).toBe('1080x1920');
        expect(key(snapScreenMode(880, 1565))).toBe('896x1600');
        expect(key(snapScreenMode(500, 889))).toBe('720x1280');
    });

    it('always returns a mode that is actually in the table', () => {
        // A coarse sweep over the whole plausible input space — the property
        // that stops a future "nearest" refinement from ever inventing a size
        // the X server cannot serve.
        for (let w = 100; w <= 4000; w += 137) {
            for (let h = 100; h <= 4000; h += 211) {
                const got = snapScreenMode(w, h);
                if (!isScreenMode(got.width, got.height)) {
                    throw new Error(`${w}x${h} -> ${key(got)} is not a table entry`);
                }
                expect(got.source).toBe(isScreenMode(w, h) ? 'requested' : 'snapped');
            }
        }
    });
});

describe('resolveScreenRequest — the server-side rule end to end', () => {
    it('is `default` at 1920x1080 for anything it cannot read', () => {
        for (const bad of [undefined, null, '1080x1920', { width: '1080', height: 1920 }, {}, [1, 2]]) {
            expect(resolveScreenRequest(bad)).toEqual({ width: 1920, height: 1080, source: 'default' });
        }
    });

    it('🔴 distinguishes "asked for 1920x1080" from "asked for nothing"', () => {
        // Same pixels, different `source` — and the difference is load-bearing:
        // `default` is what makes the app OMIT the field from the Worker call,
        // which is what keeps an old bundle byte-for-byte on today's path.
        expect(resolveScreenRequest(undefined).source).toBe('default');
        expect(resolveScreenRequest({ width: 1920, height: 1080 }).source).toBe('requested');
    });

    it('reports `snapped` when it chose something else', () => {
        expect(resolveScreenRequest({ width: 1170, height: 2532 })).toEqual({
            width: 1080,
            height: 1920,
            source: 'snapped',
        });
    });
});

describe('describeAppliedScreen — `requested` is a claim about REALITY', () => {
    it('says `requested` only when the OBSERVED screen matches the ask', () => {
        expect(describeAppliedScreen({ width: 1080, height: 1920 }, { width: 1080, height: 1920 })).toEqual({
            width: 1080,
            height: 1920,
            source: 'requested',
        });
    });

    it('🔴 says `snapped` when the platform quietly changed the size', () => {
        // The measured Xvfb case: asked 900x1600, got 896x1600. Reporting
        // `requested` here would tell the shell to letterbox to an aspect the
        // stream does not have — and it is precisely what neko's own POST echo
        // would have led us to do.
        expect(describeAppliedScreen({ width: 900, height: 1600 }, { width: 896, height: 1600 })).toEqual({
            width: 896,
            height: 1600,
            source: 'snapped',
        });
    });

    it('reports the OBSERVED size, never the ask', () => {
        expect(describeAppliedScreen({ width: 1170, height: 2532 }, { width: 1080, height: 1920 })).toEqual({
            width: 1080,
            height: 1920,
            source: 'snapped',
        });
    });

    it('nothing was asked -> `snapped`, never `requested`', () => {
        expect(describeAppliedScreen(null, { width: 1920, height: 1080 }).source).toBe('snapped');
    });
});

describe('classifyScreenFailure — the closed error set', () => {
    it("maps the Worker's own vocabulary before it looks at the status", () => {
        // Both of these arrive as a 502; only the Worker's string can tell them
        // apart, and the client behaves completely differently for each.
        expect(classifyScreenFailure(502, 'screen_unsupported_422')).toBe('UNSUPPORTED');
        expect(classifyScreenFailure(502, 'screen_upstream_500')).toBe('UPSTREAM');
        expect(classifyScreenFailure(504, 'screen_timeout')).toBe('TIMEOUT');
        expect(classifyScreenFailure(400, 'screen_bad_request')).toBe('BAD_REQUEST');
    });

    it('falls back to the status when the Worker said nothing useful', () => {
        expect(classifyScreenFailure(400, '')).toBe('BAD_REQUEST');
        expect(classifyScreenFailure(401, '')).toBe('NOT_FOUND');
        expect(classifyScreenFailure(404, '')).toBe('NOT_FOUND');
        expect(classifyScreenFailure(504, '')).toBe('TIMEOUT');
        expect(classifyScreenFailure(500, '')).toBe('UPSTREAM');
        expect(classifyScreenFailure(0, 'something nobody has seen before')).toBe('UPSTREAM');
    });

    it('only ever produces one of the five contract codes', () => {
        const allowed = new Set(['BAD_REQUEST', 'NOT_FOUND', 'UNSUPPORTED', 'UPSTREAM', 'TIMEOUT']);
        for (const status of [0, 200, 400, 401, 403, 404, 408, 422, 500, 502, 504]) {
            for (const err of ['', 'screen_unsupported_400', 'screen_login_failed_401', 'garbage']) {
                expect(allowed.has(classifyScreenFailure(status, err))).toBe(true);
            }
        }
    });
});

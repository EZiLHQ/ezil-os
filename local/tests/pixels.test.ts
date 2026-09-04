/**
 * The pixel oracle, fed buffers it cannot get from a container.
 *
 * 🔴 THIS IS THE HALF OF THE SMOKE TEST THAT CAN BE SHOWN TO FAIL.
 * `../tests/local-smoke.container.test.ts` asserts that a real desktop's
 * decoded frame is non-uniform. That assertion is only worth something if the
 * function behind it REJECTS a uniform frame — and producing a uniform frame
 * from a real container on demand needs a broken container, which is not a
 * thing a test suite can arrange. So the statistic is pure
 * (`../src/pixels.ts`) and every failure mode is constructed here by hand:
 *
 *   - an all-black frame (the exact `docs/PLATFORM-NOTES.md` §16b symptom),
 *   - a single non-black colour (a frame that "has pixels" and is not a
 *     picture — the case `e2e/prod.mjs`'s `max > 0` threshold would PASS),
 *   - a two-tone frame (enough variance, not enough tones),
 *   - a genuinely detailed frame (the positive control),
 *   - an empty buffer (no observation, which is not the same as blank).
 */

import { describe, expect, it } from 'bun:test';

import {
    MIN_BUCKETS,
    MIN_STD_DEV,
    describeStats,
    isNonUniform,
    luminanceStats,
} from '../src/pixels.ts';

/** A W*H RGBA buffer whose every pixel comes from `pixel(i)`. */
function frame(width: number, height: number, pixel: (i: number) => [number, number, number]): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const [r, g, b] = pixel(i);
        out[i * 4] = r;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = b;
        out[i * 4 + 3] = 255;
    }
    return out;
}

const SOLID_BLACK = frame(160, 100, () => [0, 0, 0]);
const SOLID_GREY = frame(160, 100, () => [128, 128, 128]);
const SOLID_WHITE = frame(160, 100, () => [255, 255, 255]);
/** Half black, half white: standard deviation 127.5 — the highest of any frame here — from exactly two tones. */
const TWO_TONE = frame(160, 100, (i) => (i < 8000 ? [0, 0, 0] : [255, 255, 255]));
/**
 * 🔴 THE FIXTURE THAT PROVES `MIN_STD_DEV` IS LOAD-BEARING. Luminance cycles
 * over 96..120 — FOUR distinct buckets, so it clears `MIN_BUCKETS` outright,
 * while a uniform spread of width 24 has a standard deviation of 24/sqrt(12) ≈
 * 6.9, under the threshold. This is what a nearly-flat frame looks like:
 * encoder noise over a blank screen, or a desktop whose only content is a
 * gradient. Without it, DELETING the `stdDev` condition from `isNonUniform`
 * leaves the whole suite GREEN — measured, and the reason this fixture exists.
 */
const NEARLY_FLAT = frame(160, 100, (i) => { const v = 96 + (i % 25); return [v, v, v]; });
/** One white pixel on black. A respectable-looking `max`, and not a picture. */
const ONE_HOT = frame(160, 100, (i) => (i === 0 ? [255, 255, 255] : [0, 0, 0]));
/**
 * A deterministic pseudo-noise frame standing in for a real desktop. Its
 * measured statistics bracket the real ones (stdDev 58.75, 30/32 buckets on the
 * live stream), so the thresholds are exercised from the passing side too.
 */
const DETAILED = frame(160, 100, (i) => {
    const v = (i * 2654435761) % 256;
    return [v, (v * 3) % 256, (v * 7) % 256];
});
/**
 * THE FIXTURE THAT PINS THE BUCKET ARITHMETIC. Every grey level 0..255
 * appears (16,000 pixels cycling i % 256), so this hits every possible
 * floor(l / 8) bucket exactly once: 0..31, i.e. 32 distinct values.
 * Math.round(l / 8) instead would additionally hit round(255 / 8) = 32,
 * an arithmetically impossible 33rd bucket over a /32 label -- the defect
 * docs/CONFIDENCE-MAP.md section 3.5(a) reported. This fixture fails
 * loudly if that regresses.
 */
const FULL_RANGE_RAMP = frame(160, 100, (i) => { const v = i % 256; return [v, v, v]; });

describe('luminanceStats — the numbers', () => {
    it('reads every pixel of a well-formed buffer', () => {
        expect(luminanceStats(SOLID_GREY).samples).toBe(16_000);
    });

    it('a solid colour has a standard deviation of exactly zero and one bucket', () => {
        for (const [label, buf, level] of [
            ['black', SOLID_BLACK, 0],
            ['grey', SOLID_GREY, 128],
            ['white', SOLID_WHITE, 255],
        ] as const) {
            const s = luminanceStats(buf);
            expect(`${label}: sd=${s.stdDev} buckets=${s.buckets} min=${s.min} max=${s.max}`)
                .toBe(`${label}: sd=0 buckets=1 min=${level} max=${level}`);
        }
    });

    it('an empty buffer reports zero samples — an absence, not a black frame', () => {
        const s = luminanceStats(new Uint8ClampedArray(0));
        expect(s.samples).toBe(0);
        // 🔴 The distinction the whole file turns on. `samples: 0` and
        // `max: 0` look identical if you only read `max`.
        expect(describeStats(s)).toMatch(/NO FRAME WAS CAPTURED/);
    });

    it('ignores a trailing partial pixel rather than reading past it', () => {
        // A buffer whose length is not a multiple of 4 is malformed; reading the
        // stub as a pixel would invent a dark sample and drag the mean down.
        const ragged = new Uint8ClampedArray([200, 200, 200, 255, 200, 200]);
        const s = luminanceStats(ragged);
        expect(s.samples).toBe(1);
        expect(s.mean).toBe(200);
    });

    it('accepts a plain array, which is how a browser frame arrives', () => {
        // `page.evaluate` cannot return a Uint8ClampedArray; the container suite
        // marshals `[...data]`. If this function only accepted typed arrays the
        // smoke test would have had to reimplement it.
        expect(luminanceStats([...SOLID_GREY])).toEqual(luminanceStats(SOLID_GREY));
    });

    it('a full-range ramp hits exactly 32 buckets -- never 33', () => {
        // The regression this fixture pins: floor(l / 8) over luminance
        // 0..255 lands in 0..31 (32 distinct buckets), matching the doc
        // comment on `LuminanceStats.buckets` and the `/32` suffix in
        // `describeStats`. The prior `Math.round(l / 8)` produced a 33rd,
        // impossible bucket (`round(255 / 8) === 32`) -- printing
        // `buckets=33/32`, reported in `docs/CONFIDENCE-MAP.md` section 3.5(a).
        const s = luminanceStats(FULL_RANGE_RAMP);
        expect(s.buckets).toBe(32);
        expect(s.buckets).not.toBe(33);
        expect(describeStats(s)).toMatch(/buckets=32\/32/);
    });
});

describe('isNonUniform — the verdict', () => {
    it('PASSES a detailed frame', () => {
        const s = luminanceStats(DETAILED);
        expect(isNonUniform(s)).toBe(true);
        // The positive control has real margin over both thresholds, so the
        // rejections below are about the frames and not about a threshold that
        // only the fixture happens to clear.
        expect(s.stdDev).toBeGreaterThan(MIN_STD_DEV * 2);
        expect(s.buckets).toBeGreaterThan(MIN_BUCKETS * 2);
    });

    it('REJECTS an all-black frame — the §16b symptom', () => {
        const s = luminanceStats(SOLID_BLACK);
        expect(isNonUniform(s)).toBe(false);
        expect(describeStats(s)).toMatch(/ALL BLACK/);
    });

    it('REJECTS a solid non-black frame, which `max > 0` alone would pass', () => {
        // 🔴 THE REASON THIS ORACLE IS NOT `e2e/prod.mjs`'s. That suite's
        // threshold is `px.max > 0`, which a uniform grey rectangle clears
        // outright. Locally there is no TURN relay and no sign-in to blame, so
        // a flat frame is a real possible outcome and has to be a failure.
        const s = luminanceStats(SOLID_GREY);
        expect(s.max).toBeGreaterThan(0);
        expect(isNonUniform(s)).toBe(false);
        expect(describeStats(s)).toMatch(/UNIFORM/);
    });

    it('REJECTS a two-tone frame despite its very high standard deviation', () => {
        const s = luminanceStats(TWO_TONE);
        // Higher than the real desktop's 58.75 — so a stdDev-only oracle would
        // rank a black-and-white split ABOVE an actual picture.
        expect(s.stdDev).toBeGreaterThan(100);
        expect(s.buckets).toBe(2);
        expect(isNonUniform(s)).toBe(false);
        expect(describeStats(s)).toMatch(/TOO FEW DISTINCT TONES/);
    });

    it('REJECTS a nearly-flat frame that clears the bucket count', () => {
        // The case only `MIN_STD_DEV` catches. Proven by mutation: with the
        // stdDev condition removed from `isNonUniform`, every other test in
        // this file still passes and this one turns red.
        const s = luminanceStats(NEARLY_FLAT);
        expect(s.buckets).toBeGreaterThanOrEqual(MIN_BUCKETS);
        expect(s.stdDev).toBeLessThan(MIN_STD_DEV);
        expect(isNonUniform(s)).toBe(false);
        expect(describeStats(s)).toMatch(/UNIFORM/);
    });

    it('REJECTS one white pixel on black — bright, varied, still not a picture', () => {
        const s = luminanceStats(ONE_HOT);
        expect(s.max).toBe(255);
        expect(isNonUniform(s)).toBe(false);
    });

    it('the thresholds sit where the measurement put them', () => {
        // Pinned so a later edit to `MIN_STD_DEV` is a decision, not a drift.
        // The live stream measured stdDev 58.75 over 30/32 buckets on
        // 2026-09-04; these are ~7x and 10x under it.
        expect(MIN_STD_DEV).toBe(8);
        expect(MIN_BUCKETS).toBe(3);
    });
});

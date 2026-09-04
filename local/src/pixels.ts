/**
 * "Is that a picture, or a rectangle?" — as a pure function.
 *
 * ── Why this is not three lines inside the smoke test ───────────────────────
 * `docs/PLATFORM-NOTES.md` §16b exists because the shell declared a desktop
 * READY in 4.6s while the frame's `<video>` reported `videoWidth: 0`. The
 * oracle that would have caught it is "read the decoded frame back and look at
 * it" — and an oracle is only worth what its own failure case is worth. An
 * assertion written inline in a test that needs a container, a browser and a
 * WebRTC connection to run can never be shown to FAIL on a blank picture,
 * because producing a blank picture on demand needs all of that too.
 *
 * So the statistic is a pure function of an RGBA buffer, and
 * `../tests/pixels.test.ts` feeds it buffers it constructs by hand: all-black,
 * a single non-black colour, two tones, and noise. The container suite gets the
 * buffer out of the browser (`ctx.getImageData(...).data`) and calls THE SAME
 * function. That is the difference between "the threshold looked right" and
 * "the threshold was shown to reject a uniform image".
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * It says nothing about WHAT is on the screen. A desktop showing the wrong
 * application, the wrong wallpaper or a rendering artefact passes every check
 * here, and should: this function's whole job is the one distinction §16b is
 * about — pixels arrived and they are not all the same pixel.
 */

/** Luminance statistics over an RGBA buffer. Every field is an observation; none is a verdict. */
export interface LuminanceStats {
    /** How many pixels were read. `0` means the buffer was empty — never treated as uniform. */
    readonly samples: number;
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    /** Population standard deviation of the per-pixel luminance. `0` for any single-colour image. */
    readonly stdDev: number;
    /**
     * How many distinct 8-level luminance buckets were hit (32 possible).
     *
     * Carried alongside `stdDev` because the two fail differently and a picture
     * has to survive both: a smooth two-tone gradient can post a healthy
     * standard deviation from only a handful of buckets, and a very
     * low-contrast but genuinely detailed frame does the reverse.
     */
    readonly buckets: number;
}

/**
 * Read luminance out of an RGBA byte buffer.
 *
 * `(r+g+b)/3` rather than a Rec.709 weighting, deliberately and to match
 * `e2e/prod.mjs`'s production oracle byte for byte — this is a "did anything
 * arrive" measure, not a colour-science one, and having the local and
 * production oracles compute the same number is worth more than having this one
 * be more correct in isolation. Alpha is ignored: a canvas `drawImage` of a
 * decoded video frame is always opaque.
 *
 * Accepts anything indexable so a `Uint8ClampedArray` from `getImageData`, a
 * plain array marshalled out of a browser, and a hand-built fixture all work.
 */
export function luminanceStats(rgba: ArrayLike<number>): LuminanceStats {
    const usable = Math.floor(rgba.length / 4) * 4;
    if (usable === 0) {
        // 🔴 NOT `{min: 0, max: 0, stdDev: 0}`. An empty buffer is the absence
        // of an observation, and a caller that treated it as "uniform" would
        // report a black screen for a frame that was never captured — which is
        // the §16b lie in miniature. `samples: 0` makes `isNonUniform` false
        // and `describeStats` say so.
        return { samples: 0, min: 0, max: 0, mean: 0, stdDev: 0, buckets: 0 };
    }
    let min = 255;
    let max = 0;
    let sum = 0;
    let sumSquares = 0;
    let samples = 0;
    const buckets = new Set<number>();
    for (let i = 0; i < usable; i += 4) {
        const l = ((rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0)) / 3;
        if (l < min) min = l;
        if (l > max) max = l;
        sum += l;
        sumSquares += l * l;
        samples++;
        // 🔴 `Math.floor`, not `Math.round`. Luminance ranges over `0…255`
        // inclusive; `floor(l / 8)` maps that onto `0…31` -- exactly 32
        // distinct buckets, matching the doc comment above and the `/32`
        // suffix in `describeStats`. `Math.round` was measured to produce
        // 33 (`0…32`, because `round(255 / 8) = 32`) -- an arithmetically
        // impossible "33/32" in the printed diagnostic. See
        // `docs/CONFIDENCE-MAP.md` section 3.5(a) and `local/tests/pixels.test.ts`.
        buckets.add(Math.floor(l / 8));
    }
    const mean = sum / samples;
    // `max(0, …)` because the one-pass form can go a hair negative on a
    // perfectly uniform buffer through floating-point cancellation, and a NaN
    // out of `sqrt` would make every comparison below silently false.
    const variance = Math.max(0, sumSquares / samples - mean * mean);
    return {
        samples,
        min: round1(min),
        max: round1(max),
        mean: round2(mean),
        stdDev: round2(Math.sqrt(variance)),
        buckets: buckets.size,
    };
}

/**
 * The thresholds, and where each number comes from.
 *
 * 🔴 DERIVED FROM A MEASUREMENT, NOT CHOSEN. Real desktop, real container, real
 * Chromium, 2026-09-04, a 160x100 downsample of the 1920x1080 stream:
 *
 *     min 11.3   max 255   mean 36.64   stdDev 58.75   buckets 30/32
 *
 * `MIN_STD_DEV = 8` is therefore a SEVEN-FOLD margin under the observed value,
 * and it is far above what the failure cases can reach: a uniform buffer is
 * exactly 0, and the only way to approach 8 without real content is a nearly
 * flat frame that nobody would call a desktop. `MIN_BUCKETS = 3` rejects a
 * solid colour (1 bucket) and a bare two-tone splash (2) while sitting ten
 * times under the observed 30.
 *
 * Both are needed. Dropping `stdDev` would pass a frame of three barely
 * distinguishable greys; dropping `buckets` would pass a black rectangle with
 * one white pixel, which has a respectable standard deviation and is not a
 * picture.
 */
export const MIN_STD_DEV = 8;
export const MIN_BUCKETS = 3;

/**
 * Did real, varied pixels arrive?
 *
 * FOUR conditions, and the first two are as load-bearing as the thresholds:
 * a buffer with no samples is not an observation, and an all-black frame
 * (`max === 0`) is the exact symptom §16b describes — reported separately so
 * `describeStats` can say WHICH one failed rather than "the numbers were bad".
 */
export function isNonUniform(stats: LuminanceStats): boolean {
    return stats.samples > 0
        && stats.max > 0
        && stats.stdDev >= MIN_STD_DEV
        && stats.buckets >= MIN_BUCKETS;
}

/** One line for a test's failure message: the numbers AND the reason, so a red run names what it saw. */
export function describeStats(stats: LuminanceStats): string {
    const numbers = `samples=${stats.samples} min=${stats.min} max=${stats.max} mean=${stats.mean}`
        + ` stdDev=${stats.stdDev} buckets=${stats.buckets}/32`;
    if (stats.samples === 0) return `${numbers} — NO FRAME WAS CAPTURED (not the same as a blank one)`;
    if (stats.max === 0) return `${numbers} — ALL BLACK`;
    if (stats.stdDev < MIN_STD_DEV) return `${numbers} — UNIFORM (stdDev below ${MIN_STD_DEV})`;
    if (stats.buckets < MIN_BUCKETS) return `${numbers} — TOO FEW DISTINCT TONES (below ${MIN_BUCKETS})`;
    return `${numbers} — non-uniform`;
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

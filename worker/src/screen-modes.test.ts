/**
 * Tests for the Worker's half of the screen-sizing wire.
 *
 * Three things are worth proving here and nothing else is:
 *
 *   1. `parseRequestedScreen` accepts ONLY plain integers. This is the
 *      boundary between untrusted JSON and `Xvfb -screen 0 "$NEKO_SCREEN"`,
 *      so the cases that matter are the ones that LOOK numeric — `"1080"`,
 *      `1080.5`, `1e9`, `NaN` — not the ones that obviously are not.
 *   2. `formatNekoScreen` cannot emit anything but `<int>x<int>x24` drawn from
 *      the closed table. It is given hostile input directly, including input
 *      that would be a shell metacharacter if it ever reached a command line.
 *   3. The table has not drifted from the app's copy. That one reads the app's
 *      source file, because the two are separate deploy targets and the ONLY
 *      way this pair goes wrong in production is one being edited alone.
 *
 * The properties in (1) and (2) are why there is deliberately no test asserting
 * "the code calls formatNekoScreen": that would assert the line that was typed.
 * These assert what the function does with values nobody typed.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_NEKO_SCREEN,
  DEFAULT_SCREEN_MODE,
  MAX_REQUESTED_AXIS,
  MIN_REQUESTED_AXIS,
  SCREEN_COLOUR_DEPTH,
  SCREEN_MODES,
  SCREEN_PIXEL_CEILING,
  SCREEN_WIDTH_ALIGNMENT,
  formatNekoScreen,
  isScreenMode,
  parseRequestedScreen,
} from './screen-modes';

describe('the mode table itself', () => {
  it('has only EVEN dimensions (odd dimensions produce vp8 chroma artefacts)', () => {
    const odd = SCREEN_MODES.filter((m) => m.width % 2 !== 0 || m.height % 2 !== 0);
    expect(odd).toEqual([]);
  });

  it('never exceeds the 1920x1080 pixel ceiling', () => {
    const over = SCREEN_MODES.filter((m) => m.width * m.height > SCREEN_PIXEL_CEILING);
    expect(over).toEqual([]);
  });

  it('contains the default, and the default is the largest entry', () => {
    expect(isScreenMode(DEFAULT_SCREEN_MODE.width, DEFAULT_SCREEN_MODE.height)).toBe(true);
    const largest = Math.max(...SCREEN_MODES.map((m) => m.width * m.height));
    expect(largest).toBe(DEFAULT_SCREEN_MODE.width * DEFAULT_SCREEN_MODE.height);
  });

  it('🔴 has only 8-ALIGNED widths — Xvfb floors the width and reports success', () => {
    // Measured: `900x1600` produces a display that is actually `896x1600`.
    // An unaligned entry is a size we would tell the client we applied and did
    // not, so the table cannot contain one.
    const unaligned = SCREEN_MODES.filter((m) => m.width % SCREEN_WIDTH_ALIGNMENT !== 0);
    expect(unaligned).toEqual([]);
  });

  it('has no duplicate entries', () => {
    const keys = SCREEN_MODES.map((m) => `${m.width}x${m.height}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offers both landscape and portrait (the whole point of the change)', () => {
    expect(SCREEN_MODES.some((m) => m.width > m.height)).toBe(true);
    expect(SCREEN_MODES.some((m) => m.height > m.width)).toBe(true);
  });

  it("DEFAULT_NEKO_SCREEN is byte-identical to start-neko.sh's own fallback", () => {
    expect(DEFAULT_NEKO_SCREEN).toBe('1920x1080x24');
    const script = readFileSync(fileURLToPath(new URL('../scripts/start-neko.sh', import.meta.url)), 'utf8');
    // The literal in the script, not a paraphrase of it: if someone changes
    // one default without the other, "no screen requested" and "1920x1080
    // requested" stop being the same container.
    expect(script).toContain(`NEKO_SCREEN="\${NEKO_SCREEN:-${DEFAULT_NEKO_SCREEN}}"`);
  });
});

describe('parseRequestedScreen accepts only plain integers', () => {
  it('accepts a well-formed pair', () => {
    expect(parseRequestedScreen({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
  });

  it('accepts a pair that is NOT in the table (membership is formatNekoScreen\'s job, not this one\'s)', () => {
    expect(parseRequestedScreen({ width: 1170, height: 2532 })).toEqual({ width: 1170, height: 2532 });
  });

  const rejected: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string body', '1080x1920'],
    ['an array', [1080, 1920]],
    ['a numeric string width', { width: '1080', height: 1920 }],
    ['a numeric string height', { width: 1080, height: '1920' }],
    ['a fractional width', { width: 1080.5, height: 1920 }],
    ['NaN', { width: Number.NaN, height: 1920 }],
    ['Infinity', { width: Number.POSITIVE_INFINITY, height: 1920 }],
    ['a negative axis', { width: -1080, height: 1920 }],
    ['zero', { width: 0, height: 0 }],
    ['an absurdly large axis', { width: 1e9, height: 1e9 }],
    ['a missing height', { width: 1080 }],
    ['a boolean', { width: true, height: 1920 }],
    ['an object axis', { width: { valueOf: () => 1080 }, height: 1920 }],
  ];

  for (const [name, value] of rejected) {
    it(`rejects ${name} — and returns null, never a coerced guess`, () => {
      expect(parseRequestedScreen(value)).toBeNull();
    });
  }

  it('rejects exactly at the range boundaries, and accepts just inside them', () => {
    expect(parseRequestedScreen({ width: MIN_REQUESTED_AXIS - 1, height: 1920 })).toBeNull();
    expect(parseRequestedScreen({ width: MAX_REQUESTED_AXIS + 1, height: 1920 })).toBeNull();
    expect(parseRequestedScreen({ width: MIN_REQUESTED_AXIS, height: MAX_REQUESTED_AXIS })).toEqual({
      width: MIN_REQUESTED_AXIS,
      height: MAX_REQUESTED_AXIS,
    });
  });
});

describe('formatNekoScreen cannot emit anything but a table entry', () => {
  it('formats every table entry as <W>x<H>x24', () => {
    for (const mode of SCREEN_MODES) {
      expect(formatNekoScreen(mode.width, mode.height)).toBe(
        `${mode.width}x${mode.height}x${SCREEN_COLOUR_DEPTH}`,
      );
    }
  });

  it('refuses a size that is plausible but not advertised by the X server', () => {
    expect(formatNekoScreen(1170, 2532)).toBeNull();
    expect(formatNekoScreen(1919, 1080)).toBeNull();
    expect(formatNekoScreen(3840, 2160)).toBeNull(); // over the ceiling
  });

  it('🔴 refuses the 900x1600 the contract originally listed — Xvfb would deliver 896x1600', () => {
    expect(formatNekoScreen(900, 1600)).toBeNull();
    expect(formatNekoScreen(896, 1600)).toBe('896x1600x24');
  });

  it('refuses a transposed table entry (1080x1920 is a mode; 1920x1080 is a different one)', () => {
    expect(formatNekoScreen(1600, 900)).toBe('1600x900x24');
    expect(formatNekoScreen(768, 1024)).toBe('768x1024x24');
    expect(formatNekoScreen(1024, 768)).toBe('1024x768x24');
    // …but a pair that is neither is still refused, in either order.
    expect(formatNekoScreen(1080, 1600)).toBeNull();
  });

  it('🔴 refuses every shell-metacharacter shape, so nothing can reach an X command line', () => {
    // These are the values a caller would have to smuggle through
    // `parseRequestedScreen` to reach a command line. They cannot — but this
    // function is exported, so it re-checks rather than trusting its caller.
    const hostile: unknown[] = [
      '1920x1080x24; rm -rf /',
      '1920x1080x24 -ac',
      '$(id)',
      '`id`',
      '1920x1080x24\n-nolisten',
      1080.5,
      Number.NaN,
    ];
    for (const value of hostile) {
      expect(formatNekoScreen(value as number, 1080)).toBeNull();
      expect(formatNekoScreen(1920, value as number)).toBeNull();
    }
  });

  it('every producible value matches /^\\d+x\\d+x24$/ — exhaustively, over the whole table', () => {
    for (const mode of SCREEN_MODES) {
      const formatted = formatNekoScreen(mode.width, mode.height);
      expect(formatted).toMatch(/^\d+x\d+x24$/);
    }
  });
});

// ── Drift guard ──────────────────────────────────────────────────────────────
//
// The app snaps, this Worker validates, and neither can import the other. The
// only way this pair fails in production is one list being edited alone — so
// this test reads the app's actual source and compares. Same reasoning (and
// same mechanism) as `./preview-timeouts.test.ts`.

const APP_PROVIDER = fileURLToPath(
  new URL('../../app/src/server/lib/cloudflare-guacamole-provider.ts', import.meta.url),
);

/** Pull `{ width: N, height: N }` pairs out of the app's `SCREEN_MODES` literal. */
function appScreenModes(): Array<{ width: number; height: number }> {
  const src = readFileSync(APP_PROVIDER, 'utf8');
  const start = src.indexOf('export const SCREEN_MODES');
  if (start < 0) throw new Error('app SCREEN_MODES not found — the drift guard has lost its target');
  const end = src.indexOf('];', start);
  if (end < 0) throw new Error('app SCREEN_MODES literal is unterminated');
  const literal = src.slice(start, end);
  return [...literal.matchAll(/\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
}

describe('the app and the Worker agree on the mode table', () => {
  it('has the app copy on disk where the guard expects it', () => {
    expect(existsSync(APP_PROVIDER)).toBe(true);
  });

  it('lists the SAME modes in the SAME order', () => {
    expect(appScreenModes()).toEqual(SCREEN_MODES.map((m) => ({ width: m.width, height: m.height })));
  });
});

// ── DELETED 2026-08-19 by integration: the Xorg modeline guard ──────────────
//
// A `describe`/`it.skipIf` pair lived here asserting that every SCREEN_MODES
// entry had a matching modeline in `worker/assets/ebuilder-xorg.conf`. That
// file does not exist and NEVER WILL: the Xorg `dummy`-driver migration was
// cancelled after Phase 0a — see the CORRECTED note in
// `docs/BROWSER-FIX-CONTRACT.md` §3 and `docs/NEKO-GROUND-TRUTH.md` §e. Xvfb's
// RandR is not a stub; `XRRSetScreenConfig` works against it and the startup
// framebuffer is a CEILING, not a fixed size, so there is no mode list to
// advertise and nothing for a modeline guard to check. W1 shipped one larger
// framebuffer (`EZIL_X_FRAMEBUFFER`) instead of an Xorg config.
//
// It was written before that was known, and armed on a file's existence, so it
// could only ever have done one of two things: skip forever, or wake up against
// a file that would have to mean something entirely different. A permanently
// skipped test is not a guard — it is a skip count nobody can explain. Removing
// it takes the worker suite's skips back from 2 to 1.

/**
 * The requestable X screen modes, and the only place this Worker turns a
 * caller-supplied width/height into an `NEKO_SCREEN` string.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * `NEKO_SCREEN` reaches the container as a process ENVIRONMENT VARIABLE which
 * `worker/scripts/start-neko.sh` interpolates unquoted into an `Xvfb`/`Xorg`
 * command line (`-screen 0 "$NEKO_SCREEN"`). A caller-supplied STRING on that
 * path is an injection surface. So nothing in this Worker ever forwards a
 * string: `parseRequestedScreen` accepts only two plain integers, and
 * `formatNekoScreen` REBUILDS the value from two integers it has itself
 * re-checked against the closed table below. There is deliberately no code
 * path from an inbound JSON string to `NEKO_SCREEN`.
 *
 * ── Why the table is duplicated ─────────────────────────────────────────────
 * The app (`app/src/server/lib/cloudflare-guacamole-provider.ts`) owns the
 * SNAPPING — it is what answers the shell's `source: requested|snapped|default`
 * — and this Worker owns the VALIDATION. They are separate deploy targets and
 * cannot import each other, exactly like `./preview-timeouts.ts` and its
 * canonical `@ezil/constants` twin. The copies are held together by a
 * drift-guard test (`./screen-modes.test.ts`) that reads the app's file, the
 * same way `preview-timeouts.test.ts` holds that pair together.
 *
 * ── The table itself ────────────────────────────────────────────────────────
 * These are exactly the modelines the container's X server advertises
 * (`worker/assets/ebuilder-xorg.conf`). Three properties are load-bearing:
 *
 *   - every width and height is EVEN. vp8 encoding of an odd dimension is a
 *     known source of chroma artefacts.
 *   - every WIDTH is a multiple of 8. 🔴 MEASURED, not assumed: Xvfb floors
 *     the screen width to a multiple of 8 and says nothing about it —
 *     requesting `900x1600` yields a display that is actually `896x1600`, and
 *     `902x902` yields `896x902`. Height is NOT quantised (`1080x1918` applies
 *     exactly). This is why the contract's original `900x1600` entry reads
 *     `896x1600` here: it was the one entry the platform could not deliver.
 *     `formatNekoScreen` enforces the alignment independently, so a width the
 *     platform would silently change can never leave this Worker.
 *   - no entry exceeds 1920x1080 = 2,073,600 px. A larger framebuffer spends
 *     the container's whole idle CPU budget with nobody asking for it.
 *   - 1920x1080 is the default AND the fallback. A request that cannot be
 *     honoured ends at 1920x1080, never at nothing.
 */

export interface ScreenMode {
  readonly width: number;
  readonly height: number;
}

/** The only colour depth. `NEKO_SCREEN`'s third field is always `x24`. */
export const SCREEN_COLOUR_DEPTH = 24;

/**
 * Xvfb rounds the screen WIDTH down to a multiple of this and reports success.
 * Measured against a real container: `900x1600` -> `896x1600`. Height is
 * unaffected. Enforced here so a width the platform would silently change can
 * never reach it.
 */
export const SCREEN_WIDTH_ALIGNMENT = 8;

/** The default, the fallback, and the largest mode there is. */
export const DEFAULT_SCREEN_MODE: ScreenMode = { width: 1920, height: 1080 };

/** No mode may exceed this many pixels. */
export const SCREEN_PIXEL_CEILING = 1920 * 1080;

/**
 * Sanity bounds on a REQUEST (not on a mode). A request outside these is
 * rejected outright rather than snapped, because it is not a plausible
 * measurement of anything and snapping it would silently invent a screen.
 */
export const MIN_REQUESTED_AXIS = 64;
export const MAX_REQUESTED_AXIS = 16384;

/** Fixed text. Order matters only as the final, deterministic tie-break. */
export const SCREEN_MODES: readonly ScreenMode[] = [
  { width: 1920, height: 1080 }, // 16:9  landscape — default; desktop
  { width: 1600, height: 900 },  // 16:9  landscape — smaller desktop window
  { width: 1280, height: 720 },  // 16:9  landscape — low-bandwidth / small window
  { width: 1440, height: 900 },  // 16:10 landscape — laptop
  { width: 1280, height: 800 },  // 16:10 landscape — laptop
  { width: 1024, height: 768 },  // 4:3   landscape — tablet landscape
  { width: 1280, height: 1024 }, // 5:4   landscape — legacy monitor
  { width: 1200, height: 1600 }, // 3:4   portrait  — tablet portrait
  { width: 1080, height: 1920 }, // 9:16  portrait  — phone portrait
  { width: 896, height: 1600 },  // 9:16  portrait  — phone portrait, cheaper (896, not 900: Xvfb floors width to a multiple of 8)
  { width: 720, height: 1280 },  // 9:16  portrait  — phone portrait, cheapest
  { width: 768, height: 1024 },  // 3:4   portrait  — tablet portrait, cheaper
  // ── ADDED 2026-08-22 — the two aspect classes the table had no answer for ──
  // APPENDED, never reordered: ties inside an aspect class are broken by table
  // order, so adding entries in NEW classes cannot disturb what the existing
  // ones already snap to. Measured with the shipped `snapScreenMode` over 15
  // real device boxes: 5 asks improved, 0 regressed, mean wasted picture
  // 8.5% -> 2.3%.
  //
  // 19.5:9 is what every phone made since the iPhone X actually is. The table
  // stopped at 9:16 (0.5625), so a 1170x2532 iPhone snapped to 1080x1920 and
  // threw away 17.9% of the picture in bands — on the one device class where
  // screen area is scarcest. These modes are also CHEAPER than what they
  // replace: 888x1920 is 1.70M pixels against 1080x1920's 2.07M, which was the
  // pixel ceiling itself.
  { width: 888, height: 1920 },  // 19.5:9 portrait — modern phone (iPhone X+, Pixel, Galaxy)
  { width: 720, height: 1560 },  // 19.5:9 portrait — modern phone, cheaper
  { width: 592, height: 1280 },  // 19.5:9 portrait — modern phone, cheapest
  // 21:9 was the worst case in the whole table: 3440x1440 snapped to 1920x1080
  // and lost 25.6% to side bands 880px wide.
  { width: 1920, height: 824 },  // 21:9  landscape — ultrawide monitor
  { width: 1680, height: 720 },  // 21:9  landscape — ultrawide, cheaper
];

/** Is this pair one of the modes above, exactly? */
export function isScreenMode(width: unknown, height: unknown): boolean {
  return SCREEN_MODES.some((m) => m.width === width && m.height === height);
}

/**
 * Read an inbound `screen` value off untrusted JSON.
 *
 * Returns `null` — never a coerced guess — for anything that is not an object
 * carrying two PLAIN INTEGERS inside `[MIN_REQUESTED_AXIS, MAX_REQUESTED_AXIS]`.
 * `"1080"`, `1080.5`, `NaN`, `Infinity`, `-1080` and `1e9` are all `null`.
 */
export function parseRequestedScreen(raw: unknown): ScreenMode | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { width, height } = raw as { width?: unknown; height?: unknown };
  if (!isPlainAxis(width) || !isPlainAxis(height)) return null;
  return { width, height };
}

function isPlainAxis(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_REQUESTED_AXIS &&
    value <= MAX_REQUESTED_AXIS
  );
}

/**
 * Build the `NEKO_SCREEN` value for a mode — or `null` if the pair is not one
 * of `SCREEN_MODES`.
 *
 * 🔴 The re-check is the point. This function is the LAST thing between an
 * inbound request and a shell command line, so it does not trust its caller to
 * have snapped: it re-derives membership itself and formats from the two
 * integers it just matched, never from anything the caller passed through.
 */
export function formatNekoScreen(width: number, height: number): string | null {
  const mode = SCREEN_MODES.find((m) => m.width === width && m.height === height);
  if (!mode) return null;
  // 🔴 Independent of the table, on purpose. Xvfb floors the width to a
  // multiple of 8 and reports success, so a mode whose width is not aligned is
  // a mode the platform will silently change underneath us — and a size we
  // told the client we applied but did not. Checking it HERE rather than only
  // when the table is edited means a future table entry cannot reintroduce the
  // problem without this failing first.
  if (mode.width % SCREEN_WIDTH_ALIGNMENT !== 0) return null;
  return `${mode.width}x${mode.height}x${SCREEN_COLOUR_DEPTH}`;
}

/**
 * The `NEKO_SCREEN` the container boots at when nobody asked for anything.
 * Identical to `start-neko.sh`'s own `${NEKO_SCREEN:-1920x1080x24}` default —
 * so setting it explicitly and leaving it unset are the same container.
 */
export const DEFAULT_NEKO_SCREEN = `${DEFAULT_SCREEN_MODE.width}x${DEFAULT_SCREEN_MODE.height}x${SCREEN_COLOUR_DEPTH}`;

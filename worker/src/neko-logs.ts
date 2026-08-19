/**
 * Pure (runtime-free) helpers for the CONTAINER BOOT LOG retrieval surface.
 *
 * Deliberately a near-twin of `./cpu-diag.ts` — same hardcoded path, same
 * stat-then-bounded-tail command pair, same kill-switch vocabulary — because
 * that module is the reviewed precedent for "return bounded file content from
 * a live container over an HMAC-gated route", and a second, differently-shaped
 * implementation of the same idea is how one of them drifts out of safety.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `scripts/start-neko.sh` writes every human-readable boot line to
 * `/tmp/neko.log` (`LOG=` near the top of that script) and additionally
 * redirects Xvfb, openbox, neko and every `supervise_app` child's stdout+stderr
 * into the same file. Nothing read it. Its content escaped exactly two ways:
 *
 *   1. `index.ts`'s desktop-start failure path folds a 600-BYTE stderr tail
 *      into an Error message — only when boot fails, and only 600 bytes.
 *   2. The structured NDJSON sidecar (`/var/log/ezil-telemetry.ndjson`, drained
 *      by `drainContainerBootTelemetry`) carries phase name + ok/error/skipped
 *      + an integer duration, and BY DESIGN never a message
 *      (`emit_telemetry()`'s own doc comment).
 *
 * So every human-readable ERROR STRING a boot produced reached a live
 * `wrangler tail` and nowhere else. This module is the missing read path.
 *
 * ── The safety argument, stated rather than assumed ─────────────────────────
 * `start-neko.sh`'s header claims it "never logs payloads, secrets, file
 * contents, or env values". That claim is TRUE OF `log()`/`phase_start`/
 * `phase_end` — the lines that script writes itself. It is NOT a claim about
 * the OTHER writers to the same file, which are third-party processes this
 * repo does not control:
 *
 *   - `Xvfb ... >>"$LOG" 2>&1`         (X server diagnostics)
 *   - `openbox ... >>"$LOG" 2>&1`      (WM diagnostics)
 *   - `setsid "$@" >>"$LOG" 2>&1`      (`supervise_app`: code-server, Chromium)
 *   - `"$NEKO_BIN" serve ... >>"$LOG" 2>&1`
 *   - the workspace bootstrap's stderr, tee'd in
 *
 * Chromium in particular writes `[ERROR:CONSOLE(n)] "...", source: <the page's
 * URL>` for page script errors, and code-server/neko both log absolute paths.
 * A raw tail of this file is therefore NOT safe to return, and the route must
 * not pretend otherwise.
 *
 * {@link redactNekoLogContent} is the answer: EVERY line is put through
 * `sanitizeErrorMessage` (`./observability.ts`) — the same function whose
 * output is the only thing ever written to the telemetry `detail` column, and
 * the function `docs/telemetry.md` cites as the reason "workspace file names,
 * paths, or contents are never collected" is true. URLs collapse to `<url>`,
 * absolute paths to `<path>`, IPs to `[redacted-ip]`, tokens/bearer/cookie
 * assignments to `[redacted]`.
 *
 * 🔴 KNOWN, ACCEPTED CONSEQUENCE: `sanitizeErrorMessage` hard-truncates at
 * `MAX_DETAIL_LEN` (200 chars) and collapses runs of whitespace. Applied per
 * line, that means a boot line longer than 200 characters comes back with a
 * trailing `…`. This is a deliberate trade: reusing the ONE audited redactor
 * verbatim is worth more than a bespoke redactor written for this route that
 * would have to be re-audited (and would drift from its twin in
 * `app/src/server/telemetry/sanitize.ts`, which `sanitize.test.ts` pins
 * byte-for-byte). The response reports the ceiling in `maxLineLen` so a reader
 * can tell a truncated line from a short one.
 */

import { sanitizeErrorMessage, MAX_DETAIL_LEN } from './observability';

/**
 * In-container path the boot log is written to. MUST match `LOG=` in
 * `scripts/start-neko.sh` exactly. Hardcoded HERE and never caller-supplied —
 * same rule as {@link import('./cpu-diag').CPU_DIAG_FILE}. A route that let a
 * caller name the file would be an arbitrary-file-read primitive inside a
 * container holding the user's workspace.
 */
export const NEKO_LOG_FILE = '/tmp/neko.log';

/**
 * Hard ceiling on bytes read off disk before the line cap is applied. Larger
 * than cpu-diag's 64 KiB because this file is prose, not fixed-shape JSONL,
 * and a busy Chromium can push a boot's worth of interesting lines past 64 KiB
 * of noise. 256 KiB read, then line-capped, then per-line capped at 200 chars —
 * so the response body is bounded three independent ways.
 */
export const NEKO_LOG_MAX_BYTES = 262_144;

/**
 * Default number of trailing lines returned. A healthy boot writes on the
 * order of 100 `[ezil-boot]` lines; 400 covers one whole boot plus the
 * surrounding third-party chatter without returning a session's entire
 * lifetime of Chromium warnings.
 */
export const NEKO_LOG_DEFAULT_MAX_LINES = 400;

/** Absolute ceiling a caller-supplied `maxLines` is clamped to. */
export const NEKO_LOG_MAX_LINES_CEILING = 2_000;

/** Re-exported so the route can report the per-line ceiling it actually applied. */
export const NEKO_LOG_MAX_LINE_LEN = MAX_DETAIL_LEN;

/**
 * Non-secret production kill-switch for this route. Enabled by DEFAULT (`on`)
 * per `docs/BROWSER-FIX-CONTRACT.md` §2, matching `cpuDiagRouteDisabled`
 * (`SANDBOX_CPU_DIAG`) and `diagDisabled` (`SANDBOX_WORKSPACE_DIAG`) exactly:
 * setting `EZIL_NEKO_LOGS` to any of `off`/`false`/`0`/`disabled`/`no`
 * hard-disables the route (404) WITHOUT a code change.
 */
export function nekoLogsRouteDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/**
 * Clamp a caller-supplied `maxLines` into `[1, NEKO_LOG_MAX_LINES_CEILING]`,
 * defaulting to {@link NEKO_LOG_DEFAULT_MAX_LINES} when absent/invalid. Never
 * allows the caller to request an unbounded read.
 */
export function resolveNekoLogMaxLines(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return NEKO_LOG_DEFAULT_MAX_LINES;
  return Math.min(Math.floor(n), NEKO_LOG_MAX_LINES_CEILING);
}

/**
 * Shell command reporting existence + total byte/line counts WITHOUT reading
 * any content. Identical shape to `cpuDiagStatCommand`. Output (stdout,
 * newline-separated): `missing`, or `exists` / `<bytes>` / `<lines>`.
 */
export function nekoLogStatCommand(path: string): string {
  return (
    `if [ -f '${path}' ]; then printf 'exists\\n'; wc -c < '${path}' 2>/dev/null; ` +
    `wc -l < '${path}' 2>/dev/null; else printf 'missing\\n'; fi`
  );
}

export interface NekoLogStat {
  exists: boolean;
  bytes: number;
  totalLines: number;
}

/** Parse {@link nekoLogStatCommand}'s stdout (already split into trimmed lines). */
export function parseNekoLogStatLines(lines: readonly string[]): NekoLogStat {
  if (lines[0] !== 'exists') return { exists: false, bytes: 0, totalLines: 0 };
  const bytes = Number(lines[1] ?? '');
  const totalLines = Number(lines[2] ?? '');
  return {
    exists: true,
    bytes: Number.isFinite(bytes) ? bytes : 0,
    totalLines: Number.isFinite(totalLines) ? totalLines : 0,
  };
}

/**
 * BOUNDED tail of the boot log: capped first by bytes (a hard disk-read
 * ceiling), then by lines. Byte-capping first can slice a line in half; the
 * subsequent line cap plus per-line redaction make that harmless, and it is
 * the same order `cpuDiagContentCommand` uses.
 */
export function nekoLogContentCommand(path: string, maxBytes: number, maxLines: number): string {
  return `tail -c ${Math.max(1, Math.floor(maxBytes))} '${path}' 2>/dev/null | tail -n ${Math.max(1, Math.floor(maxLines))}`;
}

/**
 * Strip ANSI SGR/CSI escapes and other C0 control characters from one line.
 *
 * MEASURED, not anticipated: a real container boot (image
 * `cf-guac-neko-test:local`, 2026-08-19) writes neko's zerolog output to this
 * file WITH colour, so genuine lines look like
 * `ESC[90m7:25AMESC[0m ESC[31mPNCESC[0m ...`. Left in, every one of those
 * bytes survives `sanitizeErrorMessage` (it collapses whitespace, not control
 * codes), gets JSON-escaped as `\u001b[90m`, and turns a readable boot log
 * into something a human has to decode. Stripping is also the safer order for
 * the redactor that runs next: neko writes `key=ESC[0mvalue`, and removing the
 * escape first means a `password=`/`token=` assignment is matched on its plain
 * form rather than relying on `\S+` to swallow an escape sequence.
 *
 * Only removes control characters. It cannot introduce content, and it runs
 * BEFORE the redactor, so it can never be the reason something leaks.
 */
export function stripTerminalControl(line: string): string {
  return (
    line
      // CSI sequences: ESC [ <params> <final byte>. Covers SGR colour,
      // cursor moves and erases — everything zerolog and friends emit.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // Other two-character escapes (ESC ] ..., ESC ( B, ...). The C0 rule
      // below mops up whatever terminator is left behind.
      .replace(/\u001b[@-Z\\-_]/g, '')
      // Any remaining C0 control byte (BEL, backspace, form feed, or a NUL
      // from a torn write) becomes a space so it cannot corrupt the JSON body.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
  );
}

export interface RedactedNekoLog {
  /** Redacted lines, in file order, empties dropped. */
  lines: string[];
  /** How many of `lines` were shortened by the 200-char per-line ceiling. */
  truncatedLines: number;
}

/**
 * Run raw `tail` output through `sanitizeErrorMessage` ONE LINE AT A TIME.
 *
 * Per line, not per blob, for two reasons: `sanitizeErrorMessage` collapses
 * ALL whitespace runs (including newlines) to single spaces, so a whole-blob
 * call would fuse the entire tail into one unreadable paragraph; and its
 * 200-char truncation would then throw away everything after the first line.
 *
 * A line that sanitizes to the empty string is dropped rather than returned as
 * a blank — `sanitizeErrorMessage('')` is `''`, and blank separator lines
 * carry no diagnosis.
 *
 * See this module's header for why raw lines are NOT safe to return.
 */
export function redactNekoLogContent(raw: string | null | undefined): RedactedNekoLog {
  if (!raw) return { lines: [], truncatedLines: 0 };
  const lines: string[] = [];
  let truncatedLines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const clean = sanitizeErrorMessage(stripTerminalControl(line));
    if (clean === '') continue;
    // `sanitizeErrorMessage` marks its own truncation with a trailing U+2026
    // and only ever produces a string of exactly MAX_DETAIL_LEN when it did.
    if (clean.length === MAX_DETAIL_LEN && clean.endsWith('…')) truncatedLines += 1;
    lines.push(clean);
  }
  return { lines, truncatedLines };
}

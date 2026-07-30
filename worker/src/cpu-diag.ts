/**
 * Pure (runtime-free) helpers for the CPU-saturation diagnostic surface.
 *
 * Factored out of `index.ts` — which imports `@cloudflare/sandbox` and can only
 * run in the Workers runtime — so the flag-forwarding contract and the
 * bounded-read command/parsing logic can be unit-tested with plain `bun test`,
 * exactly like `./workspace-diag` and `./twen`.
 *
 * Context: `scripts/start-neko.sh` carries an opt-in in-container CPU sampler
 * (see that script's "CPU saturation diagnostics" section) gated on the
 * `EZIL_NEKO_CPU_DIAG_ENABLED` process env var. It samples `/proc/stat` /
 * `/proc/loadavg` / `/proc/meminfo` every `NEKO_CPU_DIAG_INTERVAL` (default 5s)
 * seconds into `NEKO_CPU_DIAG_FILE` (default `/tmp/neko-cpu-diag.jsonl`,
 * {@link CPU_DIAG_FILE} below — MUST stay in sync with that script's default).
 *
 * This module supplies:
 *   1. `cpuDiagFlagEnabled` — normalizes the Worker-side flag so `ensureDesktop`
 *      forwards `EZIL_NEKO_CPU_DIAG_ENABLED=1` into the container process env
 *      ONLY when explicitly enabled (default OFF, zero cost when unset).
 *   2. `cpuDiagRouteDisabled` — a non-secret kill-switch for the RETRIEVAL route
 *      (independent of the sampler flag above — the route can be reachable even
 *      when the sampler itself is off; it just reports `exists: false` then),
 *      mirroring `diagDisabled` in `./workspace-diag` / `twenDisabled` in
 *      `./twen`.
 *   3. Shell command builders + a stat-line parser for a BOUNDED, tail-capped
 *      read of the sampler's JSONL file, so a long session can never make the
 *      retrieval route return an unbounded HTTP body.
 */

/**
 * In-container path the sampler writes to. MUST match
 * `scripts/start-neko.sh`'s `NEKO_CPU_DIAG_FILE` default exactly — the Worker
 * never overrides that env var, so this is always the real path in practice.
 */
export const CPU_DIAG_FILE = '/tmp/neko-cpu-diag.jsonl';

/**
 * Hard ceiling on bytes read off disk before the final line-cap is applied
 * (defense in depth against a pathologically long single line — the sampler
 * itself only ever appends short fixed-shape JSON lines, so this should never
 * bind in practice). 64 KiB comfortably covers {@link CPU_DIAG_DEFAULT_MAX_LINES}
 * lines at the sampler's real per-line size (~60 bytes) many times over.
 */
export const CPU_DIAG_MAX_BYTES = 65_536;

/**
 * Default number of trailing lines returned. At the sampler's 5s interval this
 * is ~41 minutes of trailing history — enough to characterize a diagnostic
 * session without risking an unbounded body on a long-running sandbox.
 */
export const CPU_DIAG_DEFAULT_MAX_LINES = 500;

/** Absolute ceiling a caller-supplied `maxLines` is clamped to. */
export const CPU_DIAG_MAX_LINES_CEILING = 2_000;

/**
 * Normalize the Worker-side opt-in flag (`env.EZIL_NEKO_CPU_DIAG_ENABLED`) the
 * exact same way `scripts/start-neko.sh` normalizes its own env var check
 * (`[ "${EZIL_NEKO_CPU_DIAG_ENABLED:-0}" = "1" ]`), plus a few common truthy
 * spellings so a Worker var of `true`/`on`/`yes` also works. Default OFF.
 */
export function cpuDiagFlagEnabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(flag.trim().toLowerCase());
}

/**
 * Non-secret production kill-switch for the RETRIEVAL route only. Enabled by
 * default (it is HMAC-gated, bounded, and read-only). Setting
 * `SANDBOX_CPU_DIAG` to any of `off`/`false`/`0`/`disabled`/`no` hard-disables
 * the route WITHOUT a code change — mirrors `diagDisabled` / `twenDisabled`.
 */
export function cpuDiagRouteDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/**
 * Clamp a caller-supplied `maxLines` request to a sane, bounded range
 * (`[1, CPU_DIAG_MAX_LINES_CEILING]`), defaulting to
 * {@link CPU_DIAG_DEFAULT_MAX_LINES} when absent/invalid. Never allows the
 * caller to request an unbounded read.
 */
export function resolveCpuDiagMaxLines(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return CPU_DIAG_DEFAULT_MAX_LINES;
  return Math.min(Math.floor(n), CPU_DIAG_MAX_LINES_CEILING);
}

/**
 * Shell command that reports existence + total byte/line counts WITHOUT
 * reading any content — mirrors the `statCmd` pattern in `handleWorkspaceDiag`
 * / `handleTwen`. Output (stdout, newline-separated):
 *   missing → `missing`
 *   exists  → `exists`, `<bytes>`, `<lines>`
 */
export function cpuDiagStatCommand(path: string): string {
  return (
    `if [ -f '${path}' ]; then printf 'exists\\n'; wc -c < '${path}' 2>/dev/null; ` +
    `wc -l < '${path}' 2>/dev/null; else printf 'missing\\n'; fi`
  );
}

export interface CpuDiagStat {
  exists: boolean;
  bytes: number;
  totalLines: number;
}

/** Parse {@link cpuDiagStatCommand}'s stdout (already split into trimmed lines). */
export function parseCpuDiagStatLines(lines: readonly string[]): CpuDiagStat {
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
 * Shell command that returns a BOUNDED tail of the sampler file: first capped
 * by bytes (`maxBytes`, a hard disk-read ceiling), then by lines (`maxLines`,
 * the caller-facing cap) — so the retrieval route's response body can never
 * grow unboundedly regardless of session length.
 */
export function cpuDiagContentCommand(path: string, maxBytes: number, maxLines: number): string {
  return `tail -c ${Math.max(1, Math.floor(maxBytes))} '${path}' 2>/dev/null | tail -n ${Math.max(1, Math.floor(maxLines))}`;
}

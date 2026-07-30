/**
 * Pure (runtime-free) helpers for the HMAC-gated workspace diagnostic endpoint.
 *
 * Factored out of `index.ts` — which imports `@cloudflare/sandbox` and can only
 * run in the Workers runtime — so the slot-allowlist / deterministic-marker
 * contract can be unit-tested with plain `bun test`.
 *
 * The diagnostic surface exists to prove two things on the Cloudflare-native
 * runtime (where the R2 FUSE mount actually works, unlike local `wrangler dev`):
 *   1. Deterministic R2 persistence — the SAME identity + SAME slot reads back
 *      the IDENTICAL SHA-256 across an explicit terminate + recreate.
 *   2. A/B/C isolation — a slot written under identity A is provably ABSENT
 *      under identities B/C (no cross-over).
 */

/**
 * Deterministic root-level filename prefix for diagnostic marker slots.
 *
 * IMPORTANT (R2 FUSE constraint): fresh R2 FUSE workspace mounts reject
 * `mkdir` under the mount root with `Operation not permitted`, so the marker
 * surface CANNOT live inside a created sub-directory. Instead every slot maps
 * deterministically to a single hidden file written DIRECTLY under the already
 * existing, writable mount root (e.g. `/workspace/.ezil-diag-<slot>`). This
 * eliminates the `mkdir` entirely while keeping the surface hidden (leading
 * dot), collision-proof (fixed prefix), and trivially auditable/removable.
 *
 * The prefix embeds no path separator, so combined with the strict
 * {@link DIAG_SLOT_RE} allowlist the mapping is guaranteed to resolve to
 * exactly one file at the mount root — no traversal, no nested directories.
 */
export const DIAG_SLOT_PREFIX = '.ezil-diag-';

/**
 * Map a validated slot name to its deterministic hidden root-level filename.
 * Callers MUST pass a slot already validated by {@link parseDiagRequest} /
 * {@link DIAG_SLOT_RE}; this function never sanitizes and never introduces a
 * path separator, so it cannot escape the mount root.
 */
export function diagSlotFile(slot: string): string {
  return `${DIAG_SLOT_PREFIX}${slot}`;
}

/**
 * Allowlist for diagnostic slot names. Deliberately strict: lowercase
 * alphanumerics plus `._-`, 1–64 chars, no path separators, no leading dot.
 * This guarantees the slot maps to exactly one hidden file at the mount root
 * via `DIAG_SLOT_PREFIX` (no traversal, no shell metacharacters) and is safe to
 * interpolate into an in-container `sh` command.
 */
export const DIAG_SLOT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const DIAG_OPS = ['write', 'ensure', 'stat', 'read', 'absent'] as const;
export type DiagOp = (typeof DIAG_OPS)[number];

/** Ops that write (idempotently) rather than read-only. */
export function isWriteOp(op: DiagOp): boolean {
  return op === 'write' || op === 'ensure';
}

/**
 * Non-secret production kill-switch. The diagnostic endpoint is enabled by
 * default (it is HMAC-gated, leaks no file content, and is confined to a hidden
 * per-workspace directory). Setting `SANDBOX_WORKSPACE_DIAG` to any of
 * `off`/`false`/`0`/`disabled`/`no` hard-disables the route WITHOUT a code
 * change, so operators can retire the surface if desired.
 */
export function diagDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/**
 * Deterministic, non-secret marker payload for a slot. Pure function of the
 * slot name only (NOT of the sandbox id, NOT of the wall clock), so:
 *   - the same slot always hashes to the same SHA-256, and
 *   - a cold remount / explicit terminate+recreate of the SAME identity that
 *     re-`ensure`s a slot reads back the IDENTICAL digest, proving R2-backed
 *     persistence rather than a fresh write.
 * Contains no secrets, credentials, user data, or entropy.
 */
export function diagMarkerContent(slot: string): string {
  return `ezil-workspace-diag;slot=${slot};v=1`;
}

/**
 * Validate and normalize an inbound diagnostic request's `op` + `slot`.
 * Returns a discriminated result so the caller can emit a precise 400.
 */
export function parseDiagRequest(
  rawOp: string | undefined,
  rawSlot: string | undefined,
):
  | { ok: true; op: DiagOp; slot: string; write: boolean }
  | { ok: false; error: string } {
  const op = (rawOp ?? 'ensure').toLowerCase();
  if (!(DIAG_OPS as readonly string[]).includes(op)) {
    return { ok: false, error: `diag_invalid_op: ${op} (allowed: ${DIAG_OPS.join(', ')})` };
  }
  const slot = (rawSlot ?? 'default').toLowerCase();
  if (!DIAG_SLOT_RE.test(slot)) {
    return { ok: false, error: `diag_invalid_slot: must match ${DIAG_SLOT_RE.source}` };
  }
  return { ok: true, op: op as DiagOp, slot, write: isWriteOp(op as DiagOp) };
}

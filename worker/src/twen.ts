/**
 * Twen workspace orchestration — pure (runtime-free) contract helpers.
 *
 * "Twen" is a first-class, named EZiL OS orchestration action that operates on
 * an already-authenticated EZiL project's EXISTING Cloudflare Sandbox identity
 * and its persistent `/workspace` (the same R2-backed workspace the Neko/VS Code
 * desktop mounts). Its initial, deliberately minimal capability is to create or
 * idempotently update a single, server-generated, non-secret **status artifact**
 * at a FIXED reserved path — nothing else.
 *
 * This module is factored out of `index.ts` (which imports `@cloudflare/sandbox`
 * and can only run in the Workers runtime) so the orchestration contract can be
 * unit-tested with plain `bun test`, exactly like `./workspace-diag`, `./hmac`,
 * and `./desktop-mode`.
 *
 * HARD SAFETY CONTRACT (enforced here, asserted by tests):
 *   - The request NEVER accepts arbitrary shell commands, arbitrary paths, or
 *     arbitrary file contents. The ONLY caller-supplied inputs are a bounded
 *     `op` (from a fixed allowlist) and a bounded `operationId` (idempotency
 *     key) validated against a strict allowlist regex — no traversal, no shell
 *     metacharacters, no path separators.
 *   - The artifact path is FIXED server-side ({@link TWEN_STATUS_FILE}); the
 *     caller can never influence it. It is a hidden, root-level file so the R2
 *     FUSE mount never has to `mkdir` (fresh R2 mounts reject `mkdir` under the
 *     mount root with EPERM — see `./workspace-diag`).
 *   - The artifact content is DETERMINISTIC (a pure function of the schema
 *     version + operationId), contains no secrets/credentials/user data/entropy,
 *     and is generated entirely server-side. Deterministic content is what lets
 *     a same-identity re-run (even across an explicit terminate + recreate) read
 *     back the IDENTICAL SHA-256, proving R2-backed persistence.
 *   - Responses return safe metadata and the SHA-256 only — NEVER raw file
 *     content and never secret material.
 *
 * This is a REAL server orchestration capability with tests. It is intentionally
 * NOT a fake UI/chat experience: no Twen UI surface exists yet, so the future UI
 * seam is a thin client that calls the authenticated tRPC `twen` mutation. The
 * diagnostic (`workspace-diag`) surface is verification evidence only and is a
 * SEPARATE concern — it is never represented as Twen.
 */

/** Schema identifier embedded in the Twen status artifact. */
export const TWEN_SCHEMA = 'ezil.twen.status/v1';

/**
 * FIXED, reserved, server-side artifact path (relative to the workspace mount
 * root). Hidden (leading dot) + root-level so it is FUSE-safe (no `mkdir`) and
 * can never be influenced by caller input.
 *
 * A dotted `.ezil/twen-status.json` would require creating the `.ezil`
 * directory, which fresh R2 FUSE mounts reject; the root-level equivalent
 * encodes the same intent without a directory.
 */
export const TWEN_STATUS_FILE = '.ezil-twen-status.json';

/**
 * Allowlist for the Twen orchestration ops. `sync` is the single mutating
 * operation (create-or-idempotently-update the status artifact); `status` is
 * read-only (report the current artifact metadata without writing).
 */
export const TWEN_OPS = ['sync', 'status'] as const;
export type TwenOp = (typeof TWEN_OPS)[number];

/** Ops that write (idempotently) rather than read-only. */
export function isTwenWriteOp(op: TwenOp): boolean {
  return op === 'sync';
}

/**
 * Strict allowlist for the caller-supplied `operationId` (idempotency key):
 * lowercase alphanumerics plus `._-`, 1–64 chars, no leading dot, no path
 * separators, no shell metacharacters. This guarantees the value is safe to
 * embed verbatim in the deterministic artifact content and to interpolate into
 * an in-container `sh` command, and that it can never encode path traversal.
 */
export const TWEN_OP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Non-secret production kill-switch. The Twen orchestration route is enabled by
 * default (it is HMAC-gated, leaks no file content, writes only the fixed
 * status artifact). Setting `SANDBOX_TWEN` to any of
 * `off`/`false`/`0`/`disabled`/`no` hard-disables the route WITHOUT a code
 * change.
 */
export function twenDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/**
 * Deterministic, non-secret status artifact payload.
 *
 * Pure function of the schema version + validated `operationId` only (NOT of the
 * sandbox id, NOT of the wall clock, NOT of any entropy), so:
 *   - the same operationId always serializes to the same bytes / same SHA-256,
 *     and a same-identity re-`sync` (even across terminate + recreate) reads
 *     back the IDENTICAL digest, proving R2-backed persistence; and
 *   - the artifact is trivially auditable and contains no secrets, credentials,
 *     user data, or entropy.
 *
 * Emitted as canonical (stable-key-order, no whitespace) JSON so the byte
 * representation — and therefore the SHA-256 — is deterministic.
 */
export function twenStatusContent(operationId: string): string {
  // Canonical JSON with a fixed key order; no Date.now()/random.
  return JSON.stringify({
    schema: TWEN_SCHEMA,
    operationId,
    origin: 'twen',
    version: 1,
  });
}

/**
 * Validate and normalize an inbound Twen request's `op` + `operationId`.
 * Returns a discriminated result so the caller can emit a precise 400.
 *
 * Note there is deliberately NO `path`, `content`, `command`, or `slot` input —
 * accepting any of those would violate the hard safety contract. This helper
 * validates only the two bounded scalar inputs; whole-body validation
 * (including rejecting unknown/hostile fields) is done by {@link parseTwenBody}.
 */
export function parseTwenRequest(
  rawOp: string | undefined,
  rawOperationId: string | undefined,
):
  | { ok: true; op: TwenOp; operationId: string; write: boolean }
  | { ok: false; error: string } {
  const op = (rawOp ?? 'sync').toLowerCase();
  if (!(TWEN_OPS as readonly string[]).includes(op)) {
    return { ok: false, error: `twen_invalid_op: ${op} (allowed: ${TWEN_OPS.join(', ')})` };
  }
  const operationId = (rawOperationId ?? 'default').toLowerCase();
  if (!TWEN_OP_ID_RE.test(operationId)) {
    return { ok: false, error: `twen_invalid_operation_id: must match ${TWEN_OP_ID_RE.source}` };
  }
  return { ok: true, op: op as TwenOp, operationId, write: isTwenWriteOp(op as TwenOp) };
}

/**
 * Bounded settle-retry budget for the request-level FUSE stat convergence loop.
 *
 * The R2 egress FUSE mount serves a short-TTL attribute/data cache, so a stat
 * issued immediately after a write can keep observing the stale/empty pre-write
 * view. The route therefore re-stats across SEPARATE `exec` calls spaced by a
 * real wall-clock await until the read-back converges — but the retry budget is
 * STRICTLY BOUNDED so the request can never wait forever:
 *   - a write op waits (up to {@link TWEN_STAT_MAX_ATTEMPTS_WRITE} passes) for
 *     the read-back digest to equal the deterministic expected digest; and
 *   - a read-only op takes at most {@link TWEN_STAT_MAX_ATTEMPTS_READ} passes
 *     (a legitimately-absent file returns on the first pass).
 * Between passes the loop sleeps {@link TWEN_STAT_RETRY_DELAY_MS}, giving a hard
 * worst-case wall-clock ceiling of (attempts − 1) × delay.
 */
export const TWEN_STAT_MAX_ATTEMPTS_WRITE = 10;
export const TWEN_STAT_MAX_ATTEMPTS_READ = 4;
export const TWEN_STAT_RETRY_DELAY_MS = 1200;

/** Max stat attempts for the given op kind (write ops need the digest to settle). */
export function twenStatMaxAttempts(isWrite: boolean): number {
  return isWrite ? TWEN_STAT_MAX_ATTEMPTS_WRITE : TWEN_STAT_MAX_ATTEMPTS_READ;
}

/**
 * Hard wall-clock ceiling (seconds) for the bounded fixed-slot rewrite.
 *
 * The only write operation supported by all live evidence is an ordinary
 * truncate/write/close to an existing, root-level file path. Explicit durability
 * syscalls are not a valid primitive on this R2 FUSE mount: `sync <path>` can
 * report success yet leave a 0-byte object, `dd count=0 conv=fsync` fsyncs an
 * empty fd without re-issuing bytes, and `dd conv=fsync` over real bytes can fail
 * with EPERM on a clean mount. The rewrite is still wrapped in `timeout` so a
 * stuck close cannot wedge the request, but command exit is never treated as
 * durability proof; that comes only from separated stat observations.
 */
export const TWEN_WRITE_TIMEOUT_SECONDS = 15;

/**
 * Build the in-container shell command that rewrites `content` to `path`.
 *
 * ROOT-CAUSE MODEL FROM LIVE EVIDENCE:
 *   - Ordinary root-level writes are accepted by the R2 FUSE mount, but the
 *     mount can serve stale cached data immediately after close.
 *   - Explicit flush attempts are not authoritative on this mount: bounded
 *     `sync <path>` and zero-byte `dd conv=fsync` produced command success while
 *     fresh readers saw 0-byte R2 objects; real-byte `dd conv=fsync` sometimes
 *     landed bytes but is unsupported on clean mounts and returned EPERM.
 *   - Therefore the write primitive must do only the supported operation
 *     (timeout-bounded fixed-file rewrite/close) and move the durability proof
 *     out of the command into repeated, separated read-backs.
 *
 * `printf %s` emits the fixture bytes with NO trailing newline, preserving the
 * exact byte count / SHA-256. The redirection is inside the timeout-wrapped
 * shell, so a blocked close surfaces as a non-zero command exit.
 *
 * Contract / safety properties:
 *   - No `mkdir`, temp path, rename, global/bare `sync`, `sync <path>`, `fsync`,
 *     `dd`, or arbitrary path/content surface is introduced here.
 *   - A timed-out/failed close-only rewrite is a REAL failure — it is NOT
 *     swallowed with `|| true`.
 *   - CRITICAL: `echo wrote` (command exit) is NOT authoritative for success.
 *     The route derives its `wrote` flag from separated fresh-boundary
 *     server-side read-backs ({@link twenWriteDurable}) — non-zero byte counts
 *     whose SHA-256 equals the expected digest, observed by SEPARATE `exec`
 *     calls issued AFTER the write.
 *
 * `path`/`content` are server-generated (fixed mount-root slot + pure-function
 * marker), never caller-influenced, so no untrusted interpolation occurs here.
 */
export function twenWriteCommand(
  path: string,
  content: string,
  writeTimeoutSeconds: number = TWEN_WRITE_TIMEOUT_SECONDS,
): string {
  return (
    `timeout ${writeTimeoutSeconds} sh -c 'printf %s "$1" > "$2"' sh '${content}' '${path}' && ` +
    `echo wrote`
  );
}

/**
 * Authoritative success predicate for a WRITE op — PURE, no I/O.
 *
 * `wrote:true` is IMPOSSIBLE unless the server-side read-back proves the marker
 * actually landed on the backing store: the file must exist, carry a non-zero
 * byte count, AND its on-disk SHA-256 must equal the deterministic expected
 * digest. This structurally forbids the zero-byte false-success (an empty file
 * hashes to `e3b0c442…`, which can never equal a non-empty marker digest) and
 * guarantees the flag reflects durable persistence, never mere command exit.
 */
export function twenWriteConfirmed(
  obs: TwenStatObservation,
  expectedSha256: string,
): boolean {
  return obs.exists && obs.bytes > 0 && obs.sha256 === expectedSha256;
}

/**
 * Authoritative CROSS-BOUNDARY success predicate for a WRITE op — PURE, no I/O.
 *
 * This is what makes `wrote:true` require a SECOND, INDEPENDENT read-back rather
 * than the same command/cache observation. Same-boundary convergence is
 * NECESSARY but NOT SUFFICIENT: the live false success (`f6588b9dd6`) had the
 * same-request stat report a matching 34-byte view served from the FUSE
 * write-back cache while an independent stat saw a 0-byte object with an empty
 * SHA — the R2 object was never committed.
 *
 * `twenWriteDurable` therefore requires ALL of:
 *   - `converged` — the in-request stat-retry loop's final observation confirms
 *     the durable expected-digest file; AND
 *   - `firstFresh` — a SEPARATE `exec`/stat issued AFTER convergence ALSO
 *     confirms it; AND
 *   - `secondFresh` — another separated `exec`/stat confirms the same digest
 *     after a wall-clock gap.
 *
 * Modeling `converged=confirmed` + `fresh=empty` as `false` structurally rejects
 * the same-mount cache false success. Modeling `firstFresh=confirmed` +
 * `secondFresh=mismatch` as `false` keeps the route from declaring success on a
 * single lucky fresh read; two separated fresh matches are required before the
 * server reports `wrote:true`.
 */
export function twenWriteDurable(
  converged: TwenStatObservation,
  firstFresh: TwenStatObservation,
  secondFresh: TwenStatObservation,
  expectedSha256: string,
): boolean {
  return (
    twenWriteConfirmed(converged, expectedSha256) &&
    twenWriteConfirmed(firstFresh, expectedSha256) &&
    twenWriteConfirmed(secondFresh, expectedSha256)
  );
}

/**
 * True when a slot is a STALE-ZERO artifact: it exists on the mount but carries
 * zero bytes (the poisoned object a prior never-flushed R2 FUSE write-back left
 * behind). Such a slot's SHA-256 (`e3b0c442…`) can never match a non-empty
 * marker, so it must be UNCONDITIONALLY rewritten (never preserved) to
 * self-heal. The write path is already an idempotent rewrite; this predicate
 * makes the stale-zero condition explicit and testable.
 */
export function twenStaleZero(obs: TwenStatObservation): boolean {
  return obs.exists && obs.bytes === 0;
}

/**
 * Structured, content-free view of one stat pass.
 *
 * The in-container stat command emits ONLY existence, byte count, and SHA-256 —
 * never the raw file bytes — so this parser (and everything downstream) can
 * never expose file content. `exists=false` maps `missing` back to a terminal
 * absent state.
 */
export interface TwenStatObservation {
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

/** Parse the trimmed lines emitted by the fixed stat command into a safe view. */
export function parseTwenStatLines(lines: readonly string[]): TwenStatObservation {
  const exists = lines[0] === 'exists';
  return {
    exists,
    bytes: exists ? Number(lines[1] ?? '') : 0,
    sha256: exists ? (lines[2] ?? '') : null,
  };
}

/**
 * Convergence predicate for the request-level stat-retry loop — PURE, no I/O.
 *
 * Returns true when the current observation is a terminal state the loop may
 * stop on:
 *   - write op: the artifact exists AND its read-back digest equals the
 *     deterministic expected digest (weak read-after-write has settled); or
 *   - read-only op: the artifact is absent (legitimate isolation result) OR it
 *     exists with a non-transient (>0 byte) view.
 *
 * `expectedSha256` is only consulted for write ops; a read-only convergence
 * check never needs it.
 */
export function twenStatConverged(
  isWrite: boolean,
  obs: TwenStatObservation,
  expectedSha256: string,
): boolean {
  if (isWrite) {
    return obs.exists && obs.sha256 === expectedSha256;
  }
  return !obs.exists || obs.bytes > 0;
}

/**
 * The EXHAUSTIVE set of wire fields the Twen request body may carry:
 *   - `token`       — the HMAC auth envelope (validated separately by the route).
 *   - `op`          — bounded op allowlist ({@link TWEN_OPS}).
 *   - `operationId` — bounded idempotency key ({@link TWEN_OP_ID_RE}).
 *
 * Anything else (`path`, `content`, `command`, `slot`, nested payloads, …) is a
 * contract violation and MUST be REJECTED, not ignored — silently dropping an
 * unexpected `path`/`content`/`command` would mask a caller (or a compromised
 * client) attempting to smuggle an out-of-contract capability, so we fail
 * closed with a precise 400 instead.
 */
export const TWEN_ALLOWED_FIELDS = ['token', 'op', 'operationId'] as const;

/**
 * Upper bound (bytes) on the raw Twen request body. The legitimate body is a
 * tiny JSON object (an HMAC token plus two short bounded scalars), so anything
 * materially larger is malformed/hostile (e.g. an attempt to smuggle file
 * content) and is rejected up front — before JSON parsing — rather than buffered.
 */
export const TWEN_MAX_BODY_BYTES = 4096;

/** True when a raw request body of `byteLength` exceeds {@link TWEN_MAX_BODY_BYTES}. */
export function twenRequestTooLarge(byteLength: number): boolean {
  return byteLength > TWEN_MAX_BODY_BYTES;
}

/**
 * Strictly validate a fully-parsed Twen request body.
 *
 * Enforces the bounded contract end-to-end:
 *   - the body MUST be a plain JSON object (not null, not an array, not a scalar);
 *   - EVERY field must be in {@link TWEN_ALLOWED_FIELDS} — an unknown field
 *     (`path`, `content`, `command`, `slot`, or any nested payload key) is
 *     REJECTED, never ignored;
 *   - `op`/`operationId`, when present, must be strings (a nested object/array
 *     value is rejected, not coerced) matching their allowlists.
 *
 * Returns a discriminated result so the route can emit a precise 400. `token`
 * is intentionally NOT returned here — the route reads it directly for the HMAC
 * check; this helper only proves the body carries nothing out of contract.
 */
export function parseTwenBody(
  raw: unknown,
):
  | { ok: true; op: TwenOp; operationId: string; write: boolean }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'twen_invalid_body: expected a JSON object' };
  }

  const body = raw as Record<string, unknown>;
  const allowed = new Set<string>(TWEN_ALLOWED_FIELDS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        error: `twen_unknown_field: ${key} (allowed: ${TWEN_ALLOWED_FIELDS.join(', ')})`,
      };
    }
  }

  // Reject nested/non-scalar payloads smuggled in `op`/`operationId` rather than
  // coercing them (String(obj) / obj.toLowerCase()).
  if (body.op !== undefined && typeof body.op !== 'string') {
    return { ok: false, error: 'twen_invalid_op: must be a string' };
  }
  if (body.operationId !== undefined && typeof body.operationId !== 'string') {
    return { ok: false, error: 'twen_invalid_operation_id: must be a string' };
  }

  return parseTwenRequest(body.op as string | undefined, body.operationId as string | undefined);
}

/**
 * Boot test — proves the Worker entrypoint (`./index.ts`) actually starts
 * inside workerd, not just that it typechecks or bundles.
 *
 * Why this exists: every other test in this package imports a pure submodule
 * (`./desktop-mode`, `./cpu-diag`, etc.) directly, so workerd never loads
 * `./index`. `wrangler deploy --dry-run` and `tsc --noEmit` both bundle/check
 * without booting the runtime. None of that catches workerd's own validation
 * of top-level entrypoint exports: every export of the default-exported
 * module must be a function/class/`ExportedHandler` binding target — a plain
 * `const` re-export (e.g. `export { CPU_DIAG_DEFAULT_MAX_LINES } from
 * './cpu-diag'`) aborts startup with:
 *
 *   Uncaught TypeError: Incorrect type for map entry '<NAME>': the provided
 *   value is not of type 'function or ExportedHandler'
 *   The Workers runtime failed to start.
 *
 * This regressed once already (2026-07-13 introduced it, caught 2026-07-30 —
 * see `fix(cf-guacamole-sandbox): stop re-exporting plain constants from the
 * Worker entrypoint`). This test is the guard against it happening again
 * silently.
 *
 * Mechanism: `wrangler`'s `unstable_dev()` API boots the *real* workerd
 * runtime locally against this package's actual `wrangler.toml` +
 * `src/index.ts`, then makes a real HTTP request against it. This is not a
 * mock — if workerd rejects the entrypoint's exports, `unstable_dev()`
 * itself throws/hangs and the request never succeeds.
 *
 * IMPORTANT — why this spawns a `node` child process instead of calling
 * `unstable_dev()` inline: this package's tests run under `bun test`, but
 * `unstable_dev()` relies on Node-specific runtime internals that HANG
 * INDEFINITELY under Bun's JS runtime, with no error, no rejection, nothing
 * — verified empirically while building this test. The exact same call
 * resolves in ~1-2s under `node`. So the boot check cannot run in-process
 * here; it is delegated to `scripts/boot-check.mjs`, which this test spawns
 * as a genuine `node` child process and communicates with over stdout (one
 * line of JSON — see that script's doc comment for the wire format). This is
 * the whole reason `boot-check.mjs` exists as a separate file rather than a
 * helper function: it MUST run under `node`, not `bun`.
 *
 * Cost/timeout: `unstable_dev`'s local boot builds this package's
 * `[[containers]]` Docker image (`./Dockerfile`, declared in `wrangler.toml`)
 * via the local Docker daemon BEFORE workerd itself becomes ready to serve —
 * this happens even though the `/health` route this test hits never starts
 * or touches the container at runtime. A cold build (no cached layers — a
 * fresh CI runner, or the first run after a `Dockerfile` change) has been
 * observed to take on the order of 100s; a warm build (Docker layer-cache
 * hit — the common case on a long-lived dev machine, or a CI runner whose
 * Docker daemon/layer cache persists across jobs) completes in a couple of
 * seconds. This test does NOT attempt to pre-build or pre-pull the image
 * itself: doing that would just relocate the same one-time cost earlier and
 * add image-lifecycle bookkeeping to the test for no real benefit — Docker's
 * own layer cache already makes every run after the first one fast, for
 * free, as long as the Docker daemon's cache persists (which it does on a
 * normal dev box and on most self-hosted/persistent CI runners). Instead,
 * the timeout below is simply sized to comfortably tolerate a fully cold
 * build.
 *
 * CI / Docker constraint: this test REQUIRES a working local Docker daemon
 * reachable by `wrangler`/`unstable_dev` (because of the `[[containers]]`
 * image-build step above) AND a `node` binary on `PATH` (because of the
 * Bun-hangs-forever issue above), in addition to the `bun` runtime the rest
 * of the suite uses. A CI runner that lacks a Docker daemon cannot run this
 * test — `boot-check.mjs` will fail (not hang) with an ordinary Docker/CLI
 * error surfaced through its JSON failure shape, which fails this test
 * loudly rather than silently skipping the guard.
 */

import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** This package's root directory (parent of `src/`, where `wrangler.toml` and `scripts/` live). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT_CHECK_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'boot-check.mjs');

/**
 * Hard ceiling on the `boot-check.mjs` child process itself. Sized well past
 * the ~100s observed cold-Docker-build case (see file doc comment above),
 * with headroom for a slow CI disk/network pull of base layers.
 */
const CHILD_TIMEOUT_MS = 170_000;
/**
 * bun:test's own per-test timeout — kept slightly above
 * {@link CHILD_TIMEOUT_MS} so our own descriptive timeout message below
 * fires first, instead of bun:test's generic "timed out after Nms".
 */
const TEST_TIMEOUT_MS = 180_000;

interface BootCheckOutcome {
  ok: boolean;
  status?: number;
  body?: { ok?: boolean; service?: string; mode?: string } | null;
  error?: string;
}

/**
 * Spawn `scripts/boot-check.mjs` under `node` (never `bun` — see file doc
 * comment) from this package's root, and resolve its single-line JSON
 * verdict.
 *
 * Deliberately never rejects: every failure mode (spawn failure, non-JSON
 * output, timeout) resolves to `{ ok: false, error }` so the caller gets one
 * uniform, readable assertion failure instead of an unhandled-rejection
 * stack trace.
 */
function runBootCheck(): Promise<BootCheckOutcome> {
  return new Promise((resolve) => {
    const child = spawn('node', [BOOT_CHECK_SCRIPT], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Fires only if the child hangs past the cold-Docker-build ceiling
    // (e.g. a genuinely stuck Docker daemon, or an environment where `node`
    // itself is missing and `spawn` degrades instead of erroring). Killing
    // the child here can leave a workerd/Docker process orphaned (its own
    // `worker.stop()` cleanup never runs) — acceptable because the test has
    // already failed at that point.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        ok: false,
        error:
          `boot-check.mjs did not complete within ${CHILD_TIMEOUT_MS}ms. This is expected ONLY on a ` +
          `fully cold Docker image build (no cached layers) that is unusually slow; otherwise this ` +
          `likely means the local Docker daemon is unavailable/stuck, or 'node' is missing from PATH. ` +
          `stderr (tail): ${stderr.slice(-2000)}`,
      });
    }, CHILD_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `failed to spawn 'node ${BOOT_CHECK_SCRIPT}': ${err.message}` });
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const lastLine = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      if (!lastLine) {
        resolve({
          ok: false,
          error: `boot-check.mjs produced no stdout output. stderr (tail): ${stderr.slice(-2000)}`,
        });
        return;
      }
      try {
        resolve(JSON.parse(lastLine) as BootCheckOutcome);
      } catch {
        resolve({
          ok: false,
          error: `failed to parse boot-check.mjs stdout as JSON: ${lastLine} | stderr (tail): ${stderr.slice(-2000)}`,
        });
      }
    });
  });
}

describe('Worker entrypoint boots in workerd', () => {
  it(
    'starts the real runtime and serves GET /health',
    async () => {
      const result = await runBootCheck();

      expect(result.ok, result.error ?? 'boot-check.mjs reported ok:false with no error detail').toBe(true);
      expect(result.status).toBe(200);
      expect(result.body?.ok).toBe(true);
      expect(result.body?.service).toBe('cf-guacamole-sandbox');
    },
    TEST_TIMEOUT_MS,
  );
});

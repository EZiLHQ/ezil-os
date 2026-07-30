#!/usr/bin/env node
/**
 * Helper for src/boot.test.ts.
 *
 * Boots the real Worker entrypoint (src/index.ts) inside workerd via
 * wrangler's `unstable_dev()` API, hits GET /health, and prints the outcome
 * as one line of JSON on stdout so the bun:test parent process (which
 * cannot reliably call `unstable_dev` itself — see note in boot.test.ts) can
 * assert on it.
 *
 * This is run as a plain `node` child process deliberately: `unstable_dev`
 * spins up a workerd instance in-process, which relies on Node-specific
 * runtime internals that hang indefinitely under Bun's JS runtime (verified
 * empirically while building this test — the same call that resolves in
 * ~1-2s under `node` never resolves under `bun`, with no error). Node child
 * process + Bun test runner parent is the combination that actually works.
 *
 * Fast-fail for the exact regression this test exists to catch: empirically,
 * when the entrypoint has a bad top-level export (a plain `const` re-export
 * — see boot.test.ts's doc comment), `unstable_dev()` itself still RESOLVES
 * (Miniflare's internal reload/config step fails asynchronously afterwards,
 * without rejecting or throwing), and the follow-up `worker.fetch('/health')`
 * then hangs FOREVER with no further output — there is nothing to `await`
 * or `catch`. The only observable signal is workerd's own startup-failure
 * line, written internally via `console.error`/`process.stderr.write` a
 * fraction of a second after `unstable_dev()` resolves:
 *
 *   ✘ [ERROR] service core:user:<name>: Uncaught TypeError: Incorrect type
 *   for map entry '<NAME>': the provided value is not of type 'function or
 *   ExportedHandler'.
 *
 * `logLevel: 'error'` (rather than `'none'`) keeps this one line visible
 * without the noisy info/debug chatter `unstable_dev` otherwise prints, and
 * `watchForRuntimeFailure()` below intercepts `process.stderr.write` to spot
 * it. `main()` races that signal against the `/health` fetch so a broken
 * entrypoint fails in ~1s flat instead of only via boot.test.ts's ~170s
 * hard timeout — that hard timeout still exists as the fallback for any
 * OTHER hang (e.g. a genuinely stuck Docker daemon during the
 * `[[containers]]` image build), just not as the primary detection path for
 * THIS specific, previously-seen regression.
 *
 * On success prints: {"ok":true,"status":200,"body":{...}}
 * On failure (including workerd's own boot-time TypeError for a bad
 * entrypoint export) prints: {"ok":false,"error":"<message>"} and exits 1.
 */

import { unstable_dev } from 'wrangler';

/** Matches workerd/Miniflare's own wording for a bad entrypoint export, and the generic Miniflare startup-failure code, so this stays robust to minor message rewording. */
const RUNTIME_FAILURE_SIGNATURE = /ERR_RUNTIME_FAILURE|is not of type 'function or ExportedHandler'/;

/**
 * Intercepts `process.stderr.write` (still forwarding every chunk to the
 * real stream — this is observation, not suppression) and resolves the
 * first time a chunk matches {@link RUNTIME_FAILURE_SIGNATURE}. Never
 * rejects; if no matching chunk ever appears the returned promise simply
 * never settles, which is fine — it is always raced against other promises
 * that either can settle.
 */
function watchForRuntimeFailure() {
  const originalWrite = process.stderr.write.bind(process.stderr);
  return new Promise((resolve) => {
    process.stderr.write = (chunk, ...rest) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (RUNTIME_FAILURE_SIGNATURE.test(text)) {
        resolve(text.trim());
      }
      return originalWrite(chunk, ...rest);
    };
  });
}

/** Best-effort teardown with its own short ceiling — a worker whose boot already failed may not tear down cleanly, and that must never block process exit. */
async function stopWithTimeout(worker, timeoutMs = 5_000) {
  await Promise.race([
    worker.stop().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function main() {
  const runtimeFailure = watchForRuntimeFailure();

  let worker;
  try {
    worker = await unstable_dev('src/index.ts', {
      config: 'wrangler.toml',
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true },
    });
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.stack ?? err) })}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const outcome = await Promise.race([
      worker.fetch('/health').then((res) => ({ kind: 'response', res })),
      runtimeFailure.then((detail) => ({ kind: 'runtime_failure', detail })),
    ]);

    if (outcome.kind === 'runtime_failure') {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: `workerd_boot_failure: ${outcome.detail}` })}\n`,
      );
      process.exitCode = 1;
      return;
    }

    const body = await outcome.res.json().catch(() => null);
    process.stdout.write(`${JSON.stringify({ ok: true, status: outcome.res.status, body })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.stack ?? err) })}\n`);
    process.exitCode = 1;
  } finally {
    await stopWithTimeout(worker);
  }
}

main();

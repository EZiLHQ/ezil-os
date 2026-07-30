/**
 * Regression test for the vendored `./preview-timeouts.ts` — see that file's
 * doc comment for why this Worker vendors a local copy of
 * `WORKER_DESKTOP_READY_TIMEOUT_MS` instead of importing
 * `packages/constants/src/preview-timeouts.ts` by relative path (the
 * relative import broke `wrangler deploy --dry-run` when this Worker is
 * built from an isolated copy of just `infra/cf-guacamole-sandbox`).
 *
 * The drift-guard test below mirrors the existing pattern in
 * `apps/web/client/src/server/lib/cloudflare-guacamole-provider.test.ts`
 * ("app-preview literals stay in sync with infra/cf-guacamole-sandbox"):
 * compare source text against the canonical file, but only when that file
 * is actually reachable in the current checkout. This Worker's own package
 * IS the one that gets built/deployed in isolation, so the guard must
 * degrade to a no-op skip (not a failure) in that context — never break the
 * isolated build it exists to protect.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WORKER_DESKTOP_READY_TIMEOUT_MS } from './preview-timeouts';

const canonicalPath = fileURLToPath(
  new URL('../../../packages/constants/src/preview-timeouts.ts', import.meta.url),
);

const canonicalSrc = existsSync(canonicalPath) ? readFileSync(canonicalPath, 'utf8') : null;

// Only run the drift comparison when the sibling `packages/constants` source
// is present (i.e. NOT in an isolated copy of just this Worker directory).
const itIfPresent = canonicalSrc ? it : it.skip;

describe('vendored preview-timeouts.ts', () => {
  it('WORKER_DESKTOP_READY_TIMEOUT_MS is a sane positive duration', () => {
    expect(WORKER_DESKTOP_READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(WORKER_DESKTOP_READY_TIMEOUT_MS)).toBe(true);
  });

  itIfPresent(
    'matches the canonical WORKER_DESKTOP_READY_TIMEOUT_MS in packages/constants/src/preview-timeouts.ts',
    () => {
      // Extract-and-compare-numerically rather than a literal string
      // `.toContain()` so a purely cosmetic formatting difference (e.g.
      // `180_000` vs `180000`) can never produce a false "drift" failure —
      // only an actual value mismatch should.
      const match = canonicalSrc?.match(
        /export const WORKER_DESKTOP_READY_TIMEOUT_MS = ([\d_]+);/,
      );
      expect(match).not.toBeNull();
      const canonicalValue = Number((match?.[1] ?? '').replaceAll('_', ''));
      expect(WORKER_DESKTOP_READY_TIMEOUT_MS).toBe(canonicalValue);
    },
  );
});

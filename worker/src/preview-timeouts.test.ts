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
 *
 * 🔴 INVESTIGATED (wave-h/t23) — the `itIfPresent` guard below is the
 * project's one permanent `bun test` skip (461 pass / 1 skip, ten rounds
 * running per prior task reports). Read to ground, documented here so nobody
 * re-investigates it:
 *
 * `this` `EZiL-OS/worker` directory *is*, verbatim, a vendored copy of
 * `EBuilder/infra/cf-guacamole-sandbox` (compare `worker/README.md`'s own
 * header, "EBuilder — Cloudflare Sandbox Browser Desktop", and
 * `worker/src/preview-timeouts.ts`'s module doc, which still describes
 * itself in terms of `infra/cf-guacamole-sandbox`). The canonical file this
 * guard wants, `packages/constants/src/preview-timeouts.ts`, lives in
 * `EBuilder` — a **separate repository** that is standing doctrine to never
 * touch from EZiL-OS (`cf-guacamole-sandbox` is on the do-not-touch list).
 * EZiL-OS has no `packages/` directory, is not a multi-package monorepo, and
 * is not meant to become one merely to satisfy this inherited guard — so
 * `canonicalPath` will not resolve in ANY EZiL-OS checkout, on any machine,
 * ever. This is not a flaky or environment-dependent skip; it is permanent
 * by construction, and "make it run" would mean either (a) hardcoding a path
 * into a sibling repo's location on disk — fragile, wrong on any other
 * clone/CI box, and the kind of coupling the vendoring was done specifically
 * to avoid — or (b) copying EBuilder's `packages/constants` into this repo,
 * which reintroduces exactly the duplication-drift problem the vendoring
 * comment already accepted as the tradeoff. Neither is warranted here.
 *
 * (Incidentally, the inherited relative path — `../../../` from
 * `worker/src/` — is even off by one directory level for what a from-scratch
 * EZiL-OS-rooted monorepo layout would need: `infra/cf-guacamole-sandbox/src/`
 * was 3 levels below ITS repo root, but `worker/src/` is only 2 levels below
 * EZiL-OS's root, so a corrected same-repo path would be `../../`. Left as
 * `../../../`, matching the file EZiL-OS actually vendored, since "fixing"
 * the depth cannot make the test run — there is no `packages/constants` at
 * either depth — and rewriting an inherited path that no longer means
 * anything here would just manufacture a false sense that this was tuned for
 * EZiL-OS, when it was not and does not need to be.)
 *
 * Manually cross-checked against the canonical source, since the automated
 * guard structurally cannot be: `EBuilder/packages/constants/src/
 * preview-timeouts.ts` defines `WORKER_DESKTOP_READY_TIMEOUT_MS = 180_000`
 * (last touched 2026-07-29, commit 1365e3b) — identical to this Worker's
 * vendored copy, as of 2026-08-02. That numeric literal is pinned as a real
 * assertion below (not the toothless "is a positive integer" check alone),
 * so a change to the vendored constant at least forces a deliberate edit
 * here — the one regression class this repo CAN catch on its own — rather
 * than silently drifting unnoticed the way a value nobody asserts on would.
 * If `WORKER_DESKTOP_READY_TIMEOUT_MS` is intentionally changed, update the
 * pinned literal below AND re-verify (and if needed update) the EBuilder
 * canonical source by hand; there is no way to automate that link from here.
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
// In EZiL-OS this is ALWAYS false — see the module doc above for why that is
// correct, permanent, and by design, not a gap.
const itIfPresent = canonicalSrc ? it : it.skip;

describe('vendored preview-timeouts.ts', () => {
  it('WORKER_DESKTOP_READY_TIMEOUT_MS is a sane positive duration', () => {
    expect(WORKER_DESKTOP_READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(WORKER_DESKTOP_READY_TIMEOUT_MS)).toBe(true);
  });

  // Substitute guard for the (structurally unreachable, see module doc)
  // cross-repo comparison: pins the value manually verified against
  // EBuilder's canonical `packages/constants/src/preview-timeouts.ts` on
  // 2026-08-02. Weaker than a live drift check, but real — it fails the
  // instant someone edits the vendored constant without updating this file,
  // which is the one half of "drift" this repo can detect unassisted.
  it('matches the value manually verified against the EBuilder canonical source (180000ms, as of 2026-08-02)', () => {
    expect(WORKER_DESKTOP_READY_TIMEOUT_MS).toBe(180_000);
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

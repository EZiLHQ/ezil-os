---
id: KBD-01
title: Reconcile wip/mobile-keyboard
labels: [shell, worker, "size/M"]
prereq:
state: open
---

## The problem

The branch `wip/mobile-keyboard` is 1 commit ahead of `main` and 202 behind, and its single
commit (`57363e7`, "keyboard work in progress — container tests failing") touches exactly the
files row `M1` already fixed on `main`: `worker/scripts/mobile-keyboard.container.test.ts` and
`worker/assets/neko-branding/www/ezil-mobile.js`. `main`'s mobile keyboard suite has passed
**9/9** since M1 landed (`docs/CONFIDENCE-MAP.md`'s M1 row). Worse than merely stale: the two
branches disagree on the actual design. `wip/mobile-keyboard`'s copy of
`e2e/prod-mobile-keyboard.mjs` asserts the visible keyboard-dismiss control is *not*
`ezil-kbd-btn` ("the client's own control, not one we overlay on the picture"); `main`'s current
version of the same file asserts the opposite — that the single floating control *is*
`ezil-kbd-btn`, "with the client's menu hidden." These are two different answers to the same
question, not a merge conflict. Nobody has decided which one is current.

## Acceptance criteria

- A decision is made and recorded (in the PR, and in this issue's closing comment) on whether
  `wip/mobile-keyboard` has anything not already superseded by `main`'s M1 fix.
- If nothing is salvageable, the branch is closed with a comment naming M1's PR as the
  superseding work — not silently deleted with no trail.
- If something is salvageable (e.g. a real UX improvement `main`'s current design lacks), it is
  extracted as its own PR against current `main`, passing the **current** `e2e/prod-mobile-keyboard.mjs`
  assertions or replacing them with a reviewed, consistent update — never a mix of the two
  designs' assertions in one file.
- `worker/scripts/mobile-keyboard.container.test.ts` stays at 9/9 (or better) after
  reconciliation — measured with the pinned image present, not skipped.

## Where to look

- `docs/CONFIDENCE-MAP.md`'s M1 row — "at the tip with the image: **32 pass / 0 fail / 0
  skip**... `mobile-keyboard` contributing **9 honest skips**" — the current, tested state on
  `main`.
- `e2e/prod-mobile-keyboard.mjs` on `main` — the current design's assertion that the visible
  control **is** `ezil-kbd-btn`.
- The `wip/mobile-keyboard` branch's own copy of the same file (commit `57363e7`) — the
  conflicting assertion that it is **not** `ezil-kbd-btn`.
- `git rev-list --left-right --count main...wip/mobile-keyboard` → `202 1` — the exact
  staleness, measured directly.

## How to prove it

```
./tools/test.sh worker
```
Expected: the mobile-keyboard container suite passes with the real image present (9/9 or
better), whichever way the reconciliation resolves.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request).

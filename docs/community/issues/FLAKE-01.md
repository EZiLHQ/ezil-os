---
id: FLAKE-01
title: The flaky [phone-portrait] tap-Settings/tap-close browser check
labels: [shell, ci, "good first issue", "size/S"]
prereq:
state: open
---

## The problem

The `[phone-portrait]` scenario in `shell/ezil/apps/mobile-browser-test.mjs` opens Settings,
closes it by tapping its close button, and asserts the desktop window loses focus
(`defocusDesktopByTapping`, `mobile-browser-test.mjs:564-633`). It has been measured flaky
twice this week — red on PR #24, red again on PRs #31 and #32 — passing on a re-run each time
with the same job green on `main` at the same commit, which is the exact signature of a flake
rather than a regression. The function already fixed one flake source (fixed `sleep()` calls
replaced with `waitFor`/`waitForTappable` polling, per the file's own header comment on why the
old sleeps produced "2/3 on `main` and 1/3 on a branch that had not touched focus at all") and a
second (waiting for the close button to stop moving before measuring where to tap). When the
tap still misses, the code's own diagnostic path
(`mobile-browser-test.mjs:600-622`) logs the measured hit-test result (`elementFromPoint` at
the button's centre) and falls back to `el.click()`, which is what let Settings actually close
on the runs where the direct tap did not land — the DIAG output showed the touchscreen tap
missing the close control's live target and the fallback click succeeding instead.

## Acceptance criteria

- The specific `[phone-portrait]` tap-Settings/tap-close round trip is reproduced locally at
  least 10 times in a row with no failure, or the failure is reproduced and its exact mechanism
  is identified from the DIAG output (`mobile-browser-test.mjs:600-622`), not guessed.
- The fix addresses the actual mechanism found — e.g. a further wait condition, a different hit
  point, or a documented reason `el.click()` should be the primary mechanism rather than a
  fallback — not a longer fixed sleep (the file's own header comment explains why that already
  failed once).
- A negative control accompanies the fix: proof that a real focus/close regression still fails
  the check (the check is not weakened into always passing).
- CI's `shell (bundle check + browser suites)` job passes on all three OS legs at least twice in
  a row for the PR that lands the fix, to distinguish a real fix from a lucky run.

## Where to look

- `shell/ezil/apps/mobile-browser-test.mjs:564-633` — `defocusDesktopByTapping`, the full tap
  round trip including both prior flake fixes (documented inline) and the current failure mode.
- `shell/ezil/apps/mobile-browser-test.mjs:600-622` — the DIAG block: `elementFromPoint`
  hit-testing at the close button's measured centre, and the `el.click()` fallback that closes
  Settings when the direct tap does not land.
- `shell/ezil/apps/mobile-browser-test.mjs:636-654` — `waitForTappable`, whose own doc comment
  explains the closest prior diagnosis: "Tapping is a COORDINATE operation... whatever is
  topmost at that point receives it," with a real measured example of an occluding element.
- `shell/ezil/apps/mobile-browser-test.mjs:795-796` — where this round trip is invoked inside
  the `[phone-portrait]` scenario and asserted as a setup precondition.

## How to prove it

```
node shell/ezil/apps/mobile-browser-test.mjs
```
run at least 10 times in a row locally with no failure in the `[phone-portrait]` scenario, and
the negative control (a deliberately broken focus/close path) still failing the check every
time.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../CONTRIBUTING.md#how-to-send-a-pull-request).

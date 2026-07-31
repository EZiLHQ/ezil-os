// boot-phases.js — EZiL-authored ADOPTION SEAM. Five lines of re-export and a
// paragraph explaining why it is not a copy.
//
// The real module is `app/src/components/desktop/boot-phases.shell.js`. It was
// handed off with a note saying to `git mv` it here. This file exists because
// moving it would have cost more than it bought:
//
//   `app/src/components/desktop/boot-phases.shell.test.ts` contains a 6-test
//   DRIFT GUARD that runs the .js copy and the TypeScript original
//   (`boot-phases.ts`, still used by the /computer/[id] React canvas) against
//   each other input by input — 576 `computeBootUiState` combinations plus
//   every `phaseVisualState` pair. That guard is the only thing stopping the
//   two copies of this logic from quietly diverging, and it can only live
//   next to the TypeScript file it compares against. Moving the .js out of
//   `app/` and dropping the guard (as the handoff proposed) would have traded
//   a real safety net for a tidier directory.
//
// So there is exactly ONE copy of the module, it stays where its test can see
// it, and esbuild follows this import across the tree at bundle time. When
// `/computer/[id]` is eventually retired and `boot-phases.ts` with it, the
// guard becomes moot and the file can move here — at which point only this
// re-export changes.
//
// The logic itself is deliberately untouched: it already refused to lie
// during a live failure (it marks a phase `confirmed` ONLY on the real
// `guacamoleRunning` signal, never on a timer), which is the entire reason it
// is worth carrying into the shell.

export * from '../../app/src/components/desktop/boot-phases.shell.js';

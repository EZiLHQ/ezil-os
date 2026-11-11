# Desktop bridge blocker fixes — 2026-11-11

Scope: minimal follow-up to `d88287f6164fb650f9a53b28e4c5f666eab6bd0d`.
No backend, deployment, image, authentication configuration or live service changes.

## Fixes

- Recheck the bridge owner fence after asynchronous session lookup/open/load boundaries,
  before revealing/loading a session, selecting a model, sending a request or returning
  session data. A disposed bridge also fails the fence. A partially created session stays
  `uncertain` if its owner changes while opening; its command ID cannot create it again.
- Account availability preserves the original Gateway catalog read timestamp, including
  joined pending reads. Evidence is returned only if the exact result remains in cache.
  Existing Gateway request deduplication and cache behavior are unchanged.

## Verification

The initial four ownership regression cases and two joined-read timestamp cases failed
against the original implementation, then passed with these fixes.

- `node --test worker/copilot-chat/chat-bridge.test.cjs`: 39 passed, zero skipped.
  Includes deterministic paused lookups/opens, ownership takeover, disposal, partial
  creation deduplication and stale read/list rejection.
- `/root/.bun/bin/bun test extensions/ezil-models/tests/{account-availability,chat-bridge-client,sent-effort,gateway}.test.ts`:
  136 passed, 486 assertions, zero failures. Covers stale and fresh joined pending reads,
  request deduplication and existing Gateway cache/model access behavior.
- `COPILOT_TEST_ROOT=/tmp/u6-mcp-pristine/usr/lib/code-server/lib/vscode node --test worker/copilot-chat/{chat-bridge,chat-bridge-patch,chat-layout-patch}.test.cjs`:
  51 passed, zero skipped (36 bridge tests at that point plus 15 bundle/layout checks;
  the final standalone bridge run above adds three fence regressions). Patch application,
  verification, exact bridge inlining, configuration gating and U6 layout/touch checks passed.
  Removing the two bridge hunks restores pinned U6 workbench SHA-256
  `9f1818b42d9475adfc024caeea2fafb8c91cc66eececcd3f5dad54a98f6dca26`.
- In `extensions/ezil-models`, `/root/.bun/bin/bun run typecheck`: passed.
- `PATH=/root/.bun/bin:$PATH worker/ezil-models/build-vsix.sh`, followed by `--check`:
  passed, byte-identical rebuild using existing Bun **1.3.14** (not system Bun 1.3.1).

## Artifact provenance

The enclosing commit identifies the exact source and tests; the parent above identifies
its baseline. The extension VSIX contains the Gateway fix. The workbench bridge fix is
shipped separately by the existing Copilot patch script, which inlines `chat-bridge.js`.

SHA-256:

| File | Hash |
| --- | --- |
| `worker/ezil-models/dist/ezil-models-0.1.0.vsix` | `e871264bae759b5e58d51204b005d4c09de50227377eea841624e0c5fbf323b4` |
| VSIX `extension/dist/extension.js` | `9136239ac5c667b073ea26a25105956144149c8e0ac911411327993b2fe78c21` |
| `extensions/ezil-models/src/gateway.ts` | `38b78f0ca88481ab55125e85ed5e85bd1ac94fd019e9011eb268e6967a5d1b30` |
| `worker/copilot-chat/chat-bridge.js` | `ec36a8f663cf93da04739ad317bbd3fe3145ed315e9613d9d7080edfc6c5a787` |

This is source, mock-service and artifact verification, not live browser/provider acceptance.
The earlier backend review remains scoped to its immutable slice; backend suites were not
rerun for this desktop-only change. The full extension suite was not rerun.

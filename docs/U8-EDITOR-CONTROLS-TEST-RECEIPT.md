# Source test receipt — 2026-11-11

No live calls, accounts, model requests, compute starts, financial operations, schema writes or deployment. Existing qualified dependency symlinks were reused; no installs or full app/image builds. Test inputs are synthetic.

- Helper slice e498b1ac438beeab04c0a733ecf971c69173757d: 192 pass / 0 fail; extension typecheck passed. See U8-EFFORT-HELPER-RECEIPT.md.
- `node --test worker/copilot-chat/chat-bridge.test.cjs`: 43 pass / 0 fail. Includes pending approval with requestInProgress=false, two-chat adapter isolation, bound input-model readback, no shared preference setter, unchanged mode, ownership-after-await and key/concurrency fences.
- `bun test extensions/ezil-models/tests/chat-bridge-client.test.ts`: 21 pass / 0 fail. Explicit old protocol-1/2 fixtures retained; new protocol-3 capability intersection and downgrade stripping tests added.
- `bun test worker/src/editor-effort-transport.test.ts`: 1 pass / 0 fail. Actual unchanged U8 transport preserves body/response bytes and boot identity checks.
- App `env -u DELEGATION_TEST_DATABASE_URL node node_modules/vitest/vitest.mjs run src/server/agent-session/effort-contract.test.ts src/server/api/delegation-auth.test.ts src/server/agent-session/control.pg.test.ts src/server/agent-session/chain.pg.test.ts`: 44 pass, 76 SKIPPED (70 control.pg, 6 chain.pg; no database URL supplied or target connection authorized). Skips are not passes or fixture/schema approval.
- 0026 passes unchanged production engine `additiveSQL` source grammar. No SQL execution occurred.

Pending evidence: A provider hooks and Gateway projection, actual provider request flow, native editor close/reopen/reload persistence, SQL integration on a separately authorized disposable fixture, and real compatible staging acceptance. Final VSIX must be rebuilt from composed source after A integration; existing binary is intentionally not presented as matching these source edits. Prior failed expectations and one temporary test-fixture type error were corrected; final result commands/commits are the review boundary.

- App `node node_modules/typescript/bin/tsc --noEmit --incremental false`: passed after the test fixture gained its required leaseMs field. Extension and MCP typechecks also passed.
- `COPILOT_TEST_ROOT=/tmp/u6-mcp-pristine/usr/lib/code-server/lib/vscode node --test worker/copilot-chat/chat-bridge-patch.test.cjs`: 1 pass / 0 fail using the real pristine bundle. Initial run without COPILOT_TEST_ROOT skipped; the configured rerun passed. This validates patch bytes/inertness, not native reload persistence.

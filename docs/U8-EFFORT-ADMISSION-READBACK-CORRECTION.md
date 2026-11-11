# Effort admission and mismatched readback correction

Source-only correction atop 6636fd540da0b958b7a50518c774208cc9a544b6. Root reported actual PG17.11: 72 passed, 8 failed, zero skipped; all four effort-witness regressions passed.

Explicit effort requires the current EZIL_EDITOR_BRIDGE_EFFORT value `enabled` before database access, durable key consumption or bridge waits. Disabled/absent/unknown values return BAD_REQUEST / effort_not_per_session irrespective of resource existence. Route authentication, scopes and client restrictions still precede store admission. Model-only retries retain existing reconciliation. After disabling effort, an effort-bearing mutation retry is refused too: operators/clients must use read-only agentSession.control to reconcile its existing row. Re-enabling restores ordinary exact-key replay; disabling never permits a fresh mutation merely because the editor lease still says protocol3. Existing queued work is not cancelled by this admission check; sync gating and release drain remain necessary.

Protocol2 preserves its observed-model semantics: backend accepts actual readback, not the requested model, including model_not_applied. Workbench legacy create returns created with actual model; legacy failed model configuration returns failed/model_not_applied. Protocol3 retains strict uncertain/settings_readback_mismatch on contradictory applied reports. This avoids silently changing older-reader contracts; consumers must inspect effective selection. No effort success is accepted through legacy reports. No wire schema changes.

Focused tests cover admission without any database access and extend the existing real-PG gate test with owned/foreign/missing computers and unchanged session/operation/event state. The two original protocol2 PG mismatch assertions are unchanged. A new real-PG case disables the gate while retaining live protocol3 evidence and checks no key consumption or session/operation/event change. The four effort-witness PG cases are unchanged. Root owns the real PG rerun; local collection/skips are not database qualification. No migration, provider, desktop bundle, flag or live change.

Validation for this correction:

- `node --test worker/copilot-chat/chat-bridge.test.cjs`: 46 passed, zero skipped; includes distinct untagged/protocol2/protocol3 mismatch cases.
- `/root/.bun/bin/bun test extensions/ezil-models/tests/chat-bridge-mixed-version.test.ts`: 3 passed, 29 assertions, pinned old/new peers.
- `DELEGATION_TEST_DATABASE_URL= /root/.bun/bin/bun run --cwd app test src/server/agent-session/effort-contract.test.ts src/server/agent-session/control.pg.test.ts`: 7 passed; 75 real-PG cases intentionally skipped. No SQL executed. Root's combined control+chain rerun now totals 81 PG cases.
- `/root/.bun/bin/bun run --cwd app typecheck`: passed.
- `git diff --check`: passed.

An initial new unit assertion incorrectly checked Error.message for the public reason; SessionStoreError stores BAD_REQUEST in message and effort_not_per_session in reason. Corrected the assertion to inspect code/reason, then reran successfully. No production change was made to accommodate that test error.

A provider refresh 3facc3b60517218f5e8f217861f606a5b2570762 independently passed its focused six cases (39 assertions); review is recorded separately under artifacts/gateway-provider-independent-review-20261111/REVIEW.md. No A source was edited or composed here.


Follow-up to root's actual PG17.11 run at 51c4f9cd: 80 passed, one failed,
zero skipped. The remaining expectation rejected kind=start, but the reviewed
router deliberately accepts start for MCP get_control, and getControl reads only
the caller/client's computer.start row. No production change is needed. The
existing reconciliation case now proves exact StartRow shape, kind/owner/client
isolation, stable mutation retry plus readback, no second provider/gate call,
one durable row, unchanged session/operation/event state, and read-scope
requirements. It retains 81 total control+chain cases for root to rerun. No SQL
was executed here; local collection skips the 75 control PG cases explicitly.

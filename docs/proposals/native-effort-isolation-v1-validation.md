# Native isolation source validation and handoff

Base: 137922554da5230c8121fafe5caa66bdde0d11d1. Contract checkpoint e395dc07.
Owned worktree: EZiL-OS.worktrees/os-u8-native-isolation-20261111.

Implementation is native input-state isolation, not a request-body workaround.
No extension/provider/backend/SQL source or binary VSIX changed. The patch script
must travel with chat-bridge.js AND session-effort-isolation.js. Docker COPY added
for the new helper; no image build or native instance launched by this lane.

Executed focused source checks:

- `COPILOT_TEST_ROOT=/tmp/u6-mcp-pristine/usr/lib/code-server/lib/vscode node --test worker/copilot-chat/session-effort-isolation.test.cjs worker/copilot-chat/chat-bridge.test.cjs`: 53 PASS, zero skips.
- Native-method test pins pristine SHA, executes actual configuration getter,
  local apply/restore, input synchronization/current-state, P4i state merge and
  JSON export, N4i import and draft codecs. Services/observables and generic schema
  utilities are synthetic; it is not a running native window. It reproduces old
  shared draft plus bucket promotion and verifies corrected two-session/draft,
  JSON restoration, existing manual preferences, malformed/rebound provenance,
  unmarked EZiL history restore and unchanged other-vendor restore behavior.
- Patch test applies seven exact source anchors to pristine workbench, refuses
  21 missing/duplicate/malformed variants, and checks JavaScript syntax.
- Bridge tests retain explicit legacy protocol fixtures, add missing-native-hook,
  unsupported-mode/no-mutation/no-send and post-create uncertain identity/retry
  checks. Existing ownership-after-await and pending-approval tests remain.
- Full patch/verify and pinned Copilot request-expression regression are rerun on
  disposable copies via request-effort-patch.test.cjs; see final handoff receipt.
- `bash -n worker/copilot-chat/patch-copilot-chat.sh` and `git diff --check`: PASS.

No install, TypeScript/API change, app build, deployment, schema execution, native
VSIX build or cloud access. Root owns clean v8 real UI/persistence/wire acceptance.
A owns independent read-only review. No live acceptance or release GO is claimed.

Remaining acceptance: fresh baseline; A-low/B-high actual requests and responses;
C no override; fresh close/reopen then full reload A/B; no shared defaults changed;
pre-existing manual effort and unrelated text/attachments/mode/permissions preserved;
Ask/unknown mode rejection without mutation/send. Native pending approval coverage
must be recorded honestly. Uncertain post-create maps to a terminal uncertain OS
operation: workbench keeps its new resource, but current adapter/backend do not
publish an applied session association. No duplicate is safe to create automatically.

Read capability limit: computer-level models are not per-mode session guarantees;
Agent request-time admission is authoritative. Older Code lacks the native hook
and is model-only for bridge controls. Rolling new marked histories back to old
Code is not qualified; old restore ignores provenance. This source does not clear
or migrate any existing user preferences/test profile state.

Final frozen-source full patch result: 1 PASS, zero skips (52.5s), including full
patch application/verification, pinned Copilot expression and removed-forwarding
refusal. Final patched Copilot SHA256 remains
`54261c2e1a1192e29304749dbf9431c95f3919b695fe8c6d6b2641ab784ae361`.
Patched workbench SHA256:
`a0485fa26d94394c04c69be88ea9acccb2806ff5ca3b5c22bc84f05843fc174f`.
Helper source SHA256:
`036b37ceb7fd5a01f9e4eb2970093afedf4668464bfbd0edaba69f27c14afb9c`.
Logs: parent artifacts/native-effort-isolation-source-20261111/{focused,full-patch}.log.
During test construction a missing synthetic selection controller caused one
fixture error; the fixture was completed and final runs above passed. No native
v8, actual close/reopen/reload, or live acceptance result is claimed.

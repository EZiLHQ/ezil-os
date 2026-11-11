# Protocol3 actual-native qualification (source candidate)

Base6bea5be35e4a2ed92e6f1f5819838fe57dee314c composes B6636 and provider hooks. B's eight outstanding PG failures are being corrected separately: **hold builds/execution until their correction is reviewed and composed**. These files are additive; existing protocol2 controls/workbench suite is unchanged. No native PASS claimed.

Files:
- chat-bridge-effort-local.sh: portable prepared-Code runner, no Docker dependency, no installs/builds/downloads; loopback ports only, private disposable profile retained under output.
- chat-bridge-effort.mjs: actual Playwright UI + native bridge client, new chats/configure/send/output, three-chat isolation, actual close/reopen of each editor, full browser-process restart and fresh readback. No adapter/native-state injection.
- chat-bridge-effort-standin.mjs: local OS stand-in adapted from controls stand-in; NOT actual OS/PostgreSQL. Real extension/Code generates all session reports and outbound requests. Leases/epochs/attempts and enqueue roles retained. Production DB tests remain independent.
- chat-bridge-effort-responses.mjs and copilot-ezil-models-effort.json: synthetic authoritative Responses-only catalog, two explicit models, low/high choices/default null. Nothing is inferred about production model support. Actual request bodies are recorded without headers/tokens. Only exact registered synthetic markers/models/efforts pass. A no-override request carrying reasoning is rejected; revoked/unlisted/wrong effort and unknown fields are rejected. No network upstream exists.
- chat-bridge-effort-responses.test.mjs: six pure fixture authority tests.

## Prepare locally only after combined-source review

1. Root's official code-server4.141.0 amd64.deb is244626666 bytes, SHA256 f384beb4f3ba207e0bca27d0dbd36dd825d5aa909d78c6d4baa8703eaf6b77ba (matches worker/Dockerfile pin). Extract into a disposable local directory; do not install or patch a shared/served tree. Required runtime: Linux amd64 compatible Node/system libraries and existing Playwright+Chromium.
2. Apply final composed worker/copilot-chat/patch-copilot-chat.sh to its lib/vscode directory, then --verify. Keep CopilotChat0.69.0, all patch inputs and companion changed files; do not overlay only workbench.js into an unrelated version. Record source SHA and hashes of patched workbench and Copilot extension.
3. With exact Bun1.3.14 run worker/ezil-models/build-vsix.sh and --check on the reviewed composition. Record archive SHA and embedded extension JS SHA. This is a future operator step, not performed here. No mutable writer files; no stale tracked VSIX substitution. Runner extracts package.json and dist/extension.js from the exact hash-pinned VSIX into its private extensions directory.
4. Use an operator-verified isolated no-egress local environment that still supports loopback. Runner acknowledgment is not an automatic firewall; browser routes also reject non-Code origins. There are no paid endpoints, but the patched extension stack must not reach unrelated networks. Do not run against a user's Code profile.

Example command (placeholders must be replaced from reviewed artifact manifest):

```sh
EZIL_EFFORT_ISOLATED=yes \
EZIL_CODE_SERVER_BIN=/scratch/code-server/bin/code-server \
EZIL_PREPARED_VSCODE_ROOT=/scratch/code-server/lib/vscode \
EZIL_EXPECTED_WORKBENCH_SHA256=<reviewed-patched-workbench-sha256> \
EZIL_EFFORT_VSIX=/scratch/reviewed/ezil-models.vsix \
EZIL_EXPECTED_VSIX_SHA256=<reviewed-vsix-sha256> \
PLAYWRIGHT_REQUIRE_DIR=/existing/qualified/node_modules \
EZIL_E2E_OUT=/scratch/private/native-effort \
EZIL_E2E_PORT=18444 EZIL_EFFORT_FIXTURE_PORT=18442 \
bash e2e/chat-bridge-effort-local.sh
```

Both ports bind127.0.0.1 only and must be free. EZIL_STANDIN_LEASE_MS (default30000) and EZIL_E2E_SETTLE_MS (default45000) parameterize native timing. Runner never alters existing profiles; it does not remove its evidence directory. All processes it launches are stopped on exit. The operator must confirm process descendants are gone in its disposable environment before reuse.

Acceptance: results.json must have no false result; fixture-state.json must show three new resources, actual A/low and B/high wire bodies, C with no reasoning, model-change wire/output, and fresh observed effort after every close/reopen and new-browser epoch. Each checked synthetic marker must have exactly one request and matching output. Null on reloaded low/high is a FAILURE, never repaired by reapplying configuration. Assertions use fresh native session snapshots, not the saved stand-in catalog. UI selector/timeouts are unresolved until actual execution; do not weaken checks to obtain green.

Pending native tool approval is explicitly NOT_EXERCISED: this Responses fixture returns text, not a tool requiring approval. A separate real tool-approval fixture is needed to claim that scenario. Existing fake-adapter pending-approval tests are not native proof. Production Gateway, actual OS DB, live staging, account entitlement and ChatGPT acceptance are outside this harness.

Source validation performed: node --check for driver/stand-in/Responses module, bash -n runner, six node:test fixture checks PASS, git diff --check. No Code/browser/server/container launch, install, build, real credentials, database or paid request performed.

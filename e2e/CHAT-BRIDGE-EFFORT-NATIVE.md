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
EZIL_CODE_SERVER_ROOT=/scratch/code-server \
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

## Bare-local refinement

No desktop image or Neko is required. EZIL_CODE_SERVER_ROOT is the extracted distribution root containing bin/code-server and lib/vscode; for a deb extracted with dpkg-deb -x it is typically <extraction>/usr/lib/code-server. The executable and checked patched workbench/Copilot files derive from the SAME root. Use the official verified deb already available; no download/install is performed by runner.

Instead of EZIL_EFFORT_VSIX/EXPECTED_VSIX_SHA256, accept a prepared extracted extension directory:

```
EZIL_EFFORT_EXTENSION_DIR=/scratch/verified-extension
EZIL_EXPECTED_EXTENSION_SHA256=<reviewed-dist-extension-js-hash>
EZIL_EXPECTED_PACKAGE_SHA256=<reviewed-package-json-hash>
```

Directory must contain package.json and dist/extension.js; both hashes are checked before copying into the private profile. Set those variables alongside the other variables in the example. Directory mode takes precedence if both are specified. The source VSIX manifest should bind these hashes to the reviewed combined source SHA.

Startup config is now explicit in e2e/copilot-ezil-effort-settings.json, derived from worker/scripts/editor-state.sh:53–79: anonymous BYOK chat, mainAgent utilities, visible secondary chat sidebar, disabled cloud/background agents/local indexing, no automatic tasks or telemetry. The synthetic fixture deliberately does not use the production Gemini utility-model names. User/chatLanguageModels.json is seeded with [{"name":"EZiL","vendor":"ezil"}], matching seed_codeserver_chat_models; without this BYOK group a fresh bare Code profile may not list EZiL models. Profiles persist on the server for the whole run and remain on disk after browser restarts. No production settings are read or changed.

Driver e2e/chat-bridge-effort.mjs has no docker exec calls: all fixture controls use fetch to EZIL_EFFORT_FIXTURE_URL (http://127.0.0.1:<port>). It can also drive an existing container wrapper if the operator separately runs this protocol3 stand-in and forwards both Code and fixture control ports to host loopback. Supply EZIL_CODE_URL, EZIL_EFFORT_FIXTURE_URL, EZIL_EFFORT_WORKSPACE (runtime workspace path, e.g. /home/neko/project only for that container), PLAYWRIGHT_REQUIRE_DIR and EZIL_E2E_OUT, then node e2e/chat-bridge-effort.mjs. The driver itself does not assume Neko/container paths. Original protocol2 wrapper remains byte-identical.

Offline conditions still required: patched Code/Copilot cloud suppression, local synthetic gateway only, browser request allowlist and operator no-egress environment. No real API keys are needed; runner generates only disposable local bearer strings. Requests to unregistered models/efforts or without registered synthetic markers are refused, never routed to a cloud service.

Refinement checks: bash -n runner; JSON settings parse; node --check driver; original P2 scripts unchanged. Native execution remains NOT RUN.

## Existing system Chromium

For a host with an existing qualified Chromium but no Playwright browser download, set `EZIL_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. Both initial launch and post-reload new browser process use this per-run option; nothing changes global Playwright paths. Optional `EZIL_CHROMIUM_ARGS_JSON='["--disable-dev-shm-usage"]'` accepts a JSON string array. Only if required inside an operator-verified disposable environment, adding `--no-sandbox` or `--disable-setuid-sandbox` requires `EZIL_CHROMIUM_NO_SANDBOX_ALLOWED=yes`; neither flag is default. Record executable/version/args in the native execution receipt. Browser can remain outside the internal Code/fixture container using separate host127.0.0.1 forwards; driver workspace path is the path inside Code's runtime.

## Independent-review corrections (harness only)

R1: A/B requests now share an actual HTTP barrier, same native-a model and different low/high effort. Both must arrive from distinct resources before either response is released. Thirty-second timeout fails the overlap request/run; it never falls back to sequential success. Arrival/release timestamps and full synthetic bodies are retained. Whether native bridge achieves overlap remains UNRUN until actual execution.

R2: fixture permits only the actual serializer's text message/string input subset (system/user/assistant). Unknown fields, malformed content, function-call/output items, malformed tools/tool_choice, duplicate tool names, unregistered or multiple markers, mismatched model/effort and over512KiB payload are refused. Offered function-tool definitions may be syntactically present but are never invoked; pending native approval remains NOT_EXERCISED. Strictness does not assert a production capability. Warmup has one explicit fixture-only registration with no effort. Repeated actual request markers are refused.

R3: each chat's initial actual send report establishes its native mode witness (workbench sendOptions reads that chat's input); later configure/reopen/reload/overlap send reports must preserve it. No mode is injected or assumed. This checks fresh per-request native mode, not an independent DOM mode selector or approval setting. Existing real-native output/snapshot comparisons remain.

R4: every driver invocation creates a fresh evidence-XXXXXX child under EZIL_E2E_OUT and prints that path. Required final fixture-state.json fetch/write failures set nonzero exit and a false result; result-file write failure also propagates. Do not read a prior sibling run as evidence. Acceptance requires current run results, final fixture state and runner input hashes together.

Controller boundary: runner creates a third independent random secret, supplied ONLY to stand-in and driver through EZIL_EFFORT_CONTROLLER_TOKEN. It is neither the AI nor bridge bearer, never included in responses/logs, and is removed from Code/browser environments. State, enqueue and gateway-mode endpoints require this bearer and reject any Origin header; POST requires application/json. Enqueue has a strict per-kind field allowlist and cannot overwrite IDs/status/attempt/history/response or put effort/model into sends. Only existing created-session roles may be targeted. Duplicate roles/markers and more than100 operations refuse.

For separately hosted local fixture/driver, operator generates one random controller bearer and securely passes the same env variable to ONLY those two processes (not Code); do not print it or include it in shell logs. Bridge/AI credentials remain distinct. All control traffic stays http://127.0.0.1 via the operator's isolated container forwards. No change to original P2 suite or production source/VSIX.

Validation:15 pure tests pass (strict Responses, controller refusals, overlap versus sequential barrier, mandatory final evidence failures), syntax checks and diff --check pass. Actual Code/native overlap/mode/persistence still NOT RUN by this author; root's separate experiment supplies that evidence.

## First-run machine scope and diagnostics correction

Root's first actual native run loaded/activated the provider but logged chatBridge=off and produced zero syncs. This is a failure, not native PASS. ezil.chatBridge.enabled is machine-scoped (extensions/ezil-models/package.json:104–108); bare runner now copies the explicit synthetic settings to BOTH data/Machine/settings.json and data/User/settings.json before Code starts or a browser opens. Production default=false and all production source remain unchanged.

On failure, current fresh evidence directory gains failure-diagnostics.json (at most12000 visible-text characters and100 console/pageerror entries of2000 characters each) and a viewport-only failure.png when page capture succeeds. No request/response/network/header/cookie logging. URL strings, bearer strings, credential-like assignments and known fixture secrets are scrubbed; screenshot inputs/editable fields are masked and visible text sanitized only after failure. Diagnostic capture errors are recorded as failures, never as successful native evidence. Mode/model/native state is not repaired. Two pure redaction/bounds tests and syntax checks pass; no new native run performed by author.

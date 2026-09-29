# Changelog

All notable changes to EZiL-OS are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by tagging `v*`, which triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (deploys, then
runs the production suites against what it deployed) and
[`.github/workflows/release.yml`](.github/workflows/release.yml) (builds the
downloadable local-mode tarball plus signed/notarized macOS DMG and opens a
GitHub Release for them as a **draft**) side by side. `deploy.yml` publishes that draft — only once its own
production suites pass — so a green deploy that was never verified is not a
release here, and neither is a release whose tarball built but whose deploy
did not. See [`docs/RELEASE.md`](docs/RELEASE.md) for the full mechanics.

## [Unreleased]

### Added

- **Copilot Chat on EZiL models in the desktop image.** The right panel of
  the editor is the open-source GitHub Copilot Chat UI that code-server
  4.139.1 bundles (Agent mode, tools, clarifying questions, attachments,
  Manage Models), running with **no GitHub account** on models EZiL
  configures: the new `extensions/ezil-models` extension — a VS Code
  `LanguageModelChatProvider` (vendor `ezil`) for Anthropic direct, Claude and
  OpenAI deployments on Microsoft Foundry, OpenAI, Azure OpenAI and
  OpenAI-compatible endpoints, with tool calling, images, thinking and
  Anthropic prompt caching — is baked into `worker/Dockerfile` as a built-in
  and reads `/etc/ezil/models.json` (`EZIL_MODELS_CONFIG`), shipped from
  `worker/ezil-models/models.json` with `{env:ANTHROPIC_API_KEY}` /
  `{env:AZURE_RESOURCE_NAME}` + `{env:AZURE_API_KEY}` / `{env:OPENAI_API_KEY}`
  references only ("just put the key"). `start-neko.sh` writes the Machine
  settings that make a cold browser work without sign-in
  (`chat.allowAnonymousAccess`, utility calls routed to the main model,
  sign-in affordances and Copilot completions off) and seeds the `ezil`
  vendor group into `User/chatLanguageModels.json` on every boot, merging
  with groups a user added. code-server is pinned by version and checksum
  (4.139.1) instead of installed from `install.sh`; `product.json` is left
  as shipped. `e2e/copilot-ezil-image.sh` boots the image and proves, in a
  fresh browser against a mock model, that the Chat view opens, no sign-in
  dialog appears, an Agent-mode `create_file` round trip lands in the
  workspace and the EZiL model is listed in the Language Models editor, then
  repeats it as a returning user whose persisted settings say the opposite.
- **Image revision 3: the chat stack makes no GitHub calls, and it is
  "EZiL Chat".** Measured behind a DNS sink, anonymous Copilot Chat on
  revision 2 still minted a Copilot device token at
  `api.github.com/copilot_internal/v2/nltoken` (retrying nine times when it
  failed), fetched `main.vscode-cdn.net/extensions/copilotChat.json`, posted
  applicationinsights Statsbeat to `westus-0.in.applicationinsights.azure.com`,
  and code-server polled `api.github.com` for its latest release — while the
  UI read "By continuing with GitHub Copilot, you agree to GitHub's Terms and
  Privacy Statement", "Copilot status" and "Sign in to use GitHub Copilot…",
  and the system prompt told the model to call itself GitHub Copilot. The
  new `worker/copilot-chat/patch-copilot-chat.sh` (run by the Dockerfile on
  the pinned bundles, each patch an exact-match anchor with an occurrence
  count and a post-patch gate — `worker/copilot-chat/PATCHES.md`) removes
  both fetches from the extension, hides the Accounts-menu sign-in entry, and
  rebrands the strings: the welcome line is now "AI responses may be
  inaccurate. Review changes before applying them." (no links), the status
  item "EZiL Chat status", the identity "You are EZiL Chat, an AI coding
  assistant". The tool/settings embeddings cache the extension pulls from
  `embeddings.vscode-cdn.net` once Agent tooling runs is patched out too.
  `--disable-update-check` and `APPLICATION_INSIGHTS_NO_STATSBEAT`
  stop the other two callers; a returning user's own `User/settings.json`
  now gets `telemetry.telemetryLevel: off` merged in at boot (every other
  key kept — without it the GitHub telemetry sender came back on, measured
  in the e2e's returning-user pass); the Copilot/telemetry-only hosts are also
  mapped to loopback in `/etc/hosts` at boot (never `github.com` /
  `api.github.com`); `github.copilot.chat.backgroundAgent.enabled` /
  `cloudAgent.enabled` are off so the session-target picker offers Local
  only. Strings only — no command id, setting key, `product.json` field or
  LICENSE changes; `ATTRIBUTIONS.md` records the modification.
  `e2e/copilot-ezil-image.sh` now boots the image behind the same DNS sink
  and fails on any GitHub / githubusercontent / githubcopilot / Microsoft-
  telemetry / vscode-cdn attempt during boot plus a full Agent-mode prompt,
  on any visible "Copilot" or "GitHub" text in the workbench, and unless
  the EZiL notice is in the chat welcome.
- **EZiL Chat (OpenCode) panel, installed but dormant.** The
  `extensions/ezil-chat` extension (an AI coding panel in the secondary
  sidebar that drives a pinned [OpenCode](https://opencode.ai) v2 server on
  loopback) is baked in as a built-in next to `opencode` v2.0.19 and a
  managed `/etc/opencode/opencode.json` (autoupdate off, sharing off, Azure
  AI Foundry wired through `{env:...}` references, no secrets). Since image
  revision 2 it no longer auto-starts or steals the sidebar
  (`ezilChat.autoStart` / `ezilChat.revealOnStartup` false in the Machine
  settings): click its "EZiL" icon or run "EZiL Chat: Open" to use OpenCode
  next to Copilot Chat. `e2e/ezil-chat-image.sh` still proves the OpenCode
  round trip against a mock provider in a real browser.
- **Local-first Apple Silicon app.** The macOS 14+ Swift app creates an
  anonymous, application-owned workspace, provides a native WebKit browser,
  and boots a pinned ARM Linux developer runtime with code-server through
  Apple's Virtualization framework. Files cross the boundary only through
  explicit copy-based import and export; removing a workspace also removes
  its VM disk, editor state, managed files, and isolated browser profile.
  Internal CI produces an ad-hoc-signed DMG, while releases still require
  Developer ID signing, notarization, stapling, checksums, and provenance.

## [0.2.0] - 2026-09-04

Local mode, three-OS CI, signed GHCR images, invite-only access, and the
public-repo governance a project with outside contributors needs.

### Added

- **Local mode.** A native Bun host (`local/`) runs EZiL OS entirely on your
  own machine against a Docker container — no Cloudflare account, no Vercel
  project, no Supabase project. A `doctor` preflight names what is missing
  before anything tries to boot, and a launcher pair
  (`deploy/launcher/ezil-os.sh` for macOS/Linux, `ezil-os.ps1` for Windows)
  checks Docker and Bun, pulls the pinned desktop image, runs the doctor,
  starts the host, and opens the browser once `/os` answers.
- **Release tarballs.** Tagging `v*` now also builds `ezil-os-<tag>.tar.gz` —
  local mode plus the built shell bundle and the pinned image reference —
  with `SHA256SUMS` and a build-provenance attestation, published to the
  tag's GitHub Release once it is live (see [`docs/RELEASE.md`](docs/RELEASE.md)).
- **Three-OS CI.** `worker`, `app`, `sdk + mcp` and `shell` now run on
  `ubuntu-latest`, `windows-latest` and `macos-latest` on every pull request —
  it found cross-platform defects a Linux-only pipeline never could (bash 3.2
  vs. bash-4-only builtins, BSD vs. GNU `base64`, Windows path handling and
  CRLF checkouts, `npx` not resolving Bun's own shims).
- **Signed container images.** `.github/workflows/image.yml` publishes the
  EZiL-branded Neko + VS Code base and the desktop image to GHCR, each signed
  keylessly with [cosign](https://github.com/sigstore/cosign) and carrying a
  build-provenance attestation.
- **Invite-only access.** `os.ezil.work` no longer accepts open sign-up: an
  allow-list gates every protected route and page load, with a landing page
  for the Supabase invite flow and a CLI for adding accounts.
- **Public-repo governance.** A branch ruleset (linear history, required PR,
  required status checks), a DCO check, CodeQL scanning, path-based PR
  labeling, a stale-issue/PR sweep, and `GOVERNANCE.md` / `ROADMAP.md`
  describing how decisions get made and what ships next.
- **The orchestration kit.** `tools/waves.ts` and `tools/ledger.ts` compute
  dependency waves and rung transitions over `docs/TASKS.csv`;
  `tools/worktree.sh` and `tools/test.sh` give parallel work its own
  lightweight worktree and a test runner where a skipped suite is never
  reported as a pass.
- **[`docs/RELEASE.md`](docs/RELEASE.md)** — the secret inventory, the
  first-run checklist, the order of events on a tag, how to confirm a
  rollout, and how to roll one back.

### Changed

- CI's Windows and macOS legs surfaced real portability bugs in
  `shell/build-shell.sh`, now fixed: it no longer depends on the bash-4-only
  `mapfile` builtin or GNU-only `base64 -i` (macOS ships bash 3.2 and BSD
  `base64`), so the committed-bundle drift check now actually runs on a Mac.
  Three `app/` unit tests now resolve their own source paths with
  `fileURLToPath` and normalize CRLF, instead of assuming a POSIX path and an
  LF checkout.
- `.github/workflows/deploy.yml`'s `worker` job now waits for
  `.github/workflows/image.yml` to publish the desktop image under the
  tagged commit's short SHA before deploying it, and a new `release` job
  publishes the GitHub Release `release.yml` opened as a draft — only after
  the production suites (`verify`) pass against the live deployment.

### Fixed

- `CODEOWNERS` named a GitHub login that does not exist; corrected to a real
  maintainer account.

## [0.1.0]

First public release. EZiL-OS was developed privately before this point; the
full commit history is included, so this entry describes the state at
publication rather than enumerating three months of pre-release change.

### Added

- **Streamed Linux desktop.** A Cloudflare Sandbox container running a real
  browser and [code-server](https://github.com/coder/code-server) against a
  persistent per-user workspace, streamed over either Apache Guacamole (HTML5)
  or Neko (WebRTC, the configured default).
- **App preview bridge.** A dev server running inside the container is reachable
  at its own signed, expiring preview URL, not only through the streamed screen.
- **Boot-honesty contract.** Named boot phases surfaced as they happen, and an
  explicit "don't know" state instead of a false "ready".
- **Crash telemetry**, documented field-by-field in
  [`docs/telemetry.md`](docs/telemetry.md) and designed in
  [`docs/telemetry-design.md`](docs/telemetry-design.md).
- **`sdk/`** — a typed client for the computer-lifecycle API.
- **`mcp/`** — an optional Model Context Protocol connector exposing that same
  surface to MCP clients. A connector, not a dependency of the product.
- Community health files: `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR
  templates, `CODEOWNERS`, Dependabot.

[Unreleased]: https://github.com/EZiLHQ/ezil-os/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/EZiLHQ/ezil-os/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/EZiLHQ/ezil-os/releases/tag/v0.1.0

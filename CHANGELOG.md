# Changelog

All notable changes to EZiL-OS are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by tagging `v*`, which triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (deploys, then
runs the production suites against what it deployed) and
[`.github/workflows/release.yml`](.github/workflows/release.yml) (builds the
downloadable local-mode tarball and opens a GitHub Release for it as a
**draft**) side by side. `deploy.yml` publishes that draft — only once its own
production suites pass — so a green deploy that was never verified is not a
release here, and neither is a release whose tarball built but whose deploy
did not. See [`docs/RELEASE.md`](docs/RELEASE.md) for the full mechanics.

## [Unreleased]

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

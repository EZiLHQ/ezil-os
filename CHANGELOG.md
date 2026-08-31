# Changelog

All notable changes to EZiL-OS are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by tagging `v*`, which is what triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). That pipeline
deploys and then runs the production suites against what it deployed — a green
deploy that was never verified is not a release here.

## [Unreleased]

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

[Unreleased]: https://github.com/EZiLHQ/ezil-os/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/EZiLHQ/ezil-os/releases/tag/v0.1.0

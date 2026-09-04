# The community backlog

This directory is the project's backlog, kept as files instead of only as GitHub issues, so it
is reviewable in a pull request and re-creatable if it is ever lost. Each file in
[`issues/`](issues/) is one issue: a YAML front-matter block (`id`, `title`, `labels`, `prereq`,
`state`) followed by a body with four fixed sections — **The problem**, **Acceptance
criteria**, **Where to look**, and **How to prove it** — plus a stated **Prerequisite** and a
line on how to claim it.

**We (the maintainers) do not implement any of these 22 issues ourselves.** They exist so an
outside contributor has somewhere concrete to start: a real gap, verified `file:line`
pointers into the code that gap sits next to, and an exact command that proves the fix.

## How an issue here becomes a GitHub issue

`tools/issues.ts` reads every file in `issues/` and publishes it as a real GitHub issue —
idempotently, matching by an `<!-- ezil-backlog-id: X -->` marker in the issue body rather than
by title, so re-running it never creates a duplicate. It is dry-run by default; `--apply`
creates missing issues only, and never edits or closes one that already exists — drift between
a file here and its published issue is reported, not silently corrected.

**If `tools/issues.ts` has not merged yet, it does not exist** — check
[`docs/TASKS.csv`](../TASKS.csv) row `I6a` before assuming it is available. Until it lands (or
is run), the files in `issues/` are the backlog; a maintainer runs it by hand to publish them.

## How to claim one

Comment on the issue (once it is published on GitHub) saying you are picking it up. This
project uses 72-hour lazy consensus for claims — see
[Picking something up](../../CONTRIBUTING.md#picking-something-up) in `CONTRIBUTING.md`.
If you are working from the file in this directory before it has been published as a GitHub
issue, open a draft PR against the corresponding change and reference the file by its `id`
(e.g. `SFA-01`) in the PR description instead.

Read [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for how this repository builds, tests and
signs off commits, and — for anything that touches the desktop shell —
[`CONTRIBUTING-APPS.md`](../CONTRIBUTING-APPS.md) for the app registry, the boot-trace
contract, and how a new shell app gets vendored and tested.

## The prerequisite chain

`SFA-01` (a shell-callable file API) comes first: it is the prerequisite for every one of the
five viewer apps below it. Nothing else in this backlog blocks on anything else in it except
`AGENT-01`, which needs `MCP-01`'s tool group to call into.

```
SFA-01 ──┬──> FILES-01
         ├──> PDF-01
         ├──> SHEET-01
         ├──> DOC-01
         └──> IMG-01

MCP-01 ──────> AGENT-01
```

Every other issue below has no prerequisite in this backlog.

## All 22 issues

| id | title | labels | prereq |
|---|---|---|---|
| [SFA-01](issues/SFA-01.md) | Shell-callable file API | `app`, `worker`, `help wanted`, `size/L` | none |
| [FILES-01](issues/FILES-01.md) | A Files app to browse the workspace | `shell`, `help wanted`, `size/L` | SFA-01 |
| [PDF-01](issues/PDF-01.md) | PDF viewer (pdf.js, vendored UMD) | `shell`, `help wanted`, `size/L` | SFA-01 |
| [SHEET-01](issues/SHEET-01.md) | Spreadsheet viewer — CSV first, then XLSX | `shell`, `help wanted`, `size/L` | SFA-01 |
| [DOC-01](issues/DOC-01.md) | Markdown and DOCX viewer | `shell`, `help wanted`, `size/M` | SFA-01 |
| [IMG-01](issues/IMG-01.md) | Image viewer | `shell`, `good first issue`, `size/S` | SFA-01 |
| [MCP-01](issues/MCP-01.md) | Local MCP tool group over the ten sidecar verbs | `mcp`, `help wanted`, `size/M` | none |
| [AGENT-01](issues/AGENT-01.md) | Agent driver loop | `mcp`, `worker`, `help wanted`, `size/L` | MCP-01 |
| [GPU-01](issues/GPU-01.md) | GPU passthrough on Linux | `local`, `help wanted`, `size/M` | none |
| [ARM-01](issues/ARM-01.md) | arm64 image | `worker`, `blocked`, `size/XL` | none (blocked) |
| [AUDIO-01](issues/AUDIO-01.md) | Audio in the stream, exercised locally | `worker`, `local`, `help wanted`, `size/M` | none |
| [SYNC-01](issues/SYNC-01.md) | Opt-in workspace sync from a local install to R2 | `local`, `worker`, `size/L` | none |
| [OSOS-01](issues/OSOS-01.md) | Build the OS inside the OS | `app`, `size/XL` | none |
| [TEL-01](issues/TEL-01.md) | The telemetry drain outage has no drill | `worker`, `docs`, `size/M` | none |
| [COV-01](issues/COV-01.md) | Coverage reporting — revive the branch | `ci`, `good first issue`, `size/M` | none |
| [KBD-01](issues/KBD-01.md) | Reconcile `wip/mobile-keyboard` | `shell`, `worker`, `size/M` | none |
| [AUTH-01](issues/AUTH-01.md) | Forgot-password UI and re-auth before `updateUser` | `app`, `help wanted`, `size/M` | none |
| [NEKO-01](issues/NEKO-01.md) | `EZIL_NEKO_IMAGE` means two different shapes | `worker`, `local`, `good first issue`, `size/S` | none |
| [DB-01](issues/DB-01.md) | A `db:apply-0002` script matching `db:apply-0001` | `app`, `good first issue`, `size/S` | none |
| [TAURI-01](issues/TAURI-01.md) | Native installers via a Tauri wrapper | `local`, `blocked`, `size/XL` | none (blocked) |
| [SLIM-01](issues/SLIM-01.md) | Slim the local desktop image | `worker`, `help wanted`, `size/L` | none |
| [FLAKE-01](issues/FLAKE-01.md) | The flaky `[phone-portrait]` tap-Settings/tap-close check | `shell`, `ci`, `good first issue`, `size/S` | none |

Three of these (`ARM-01`, `AUDIO-01`, `DB-01`) are opened directly from measurements in
[`docs/CONFIDENCE-MAP.md`](../CONFIDENCE-MAP.md), the interim verification pass for round
ANYWHERE — each issue's **Where to look** section cites the exact finding. Two (`ARM-01`,
`TAURI-01`) are `state: blocked`: both need something no amount of code in a pull request can
produce (arm64-compatible Chrome and hardware; an Apple Developer ID and an Authenticode
certificate), so they are recorded here rather than scheduled.

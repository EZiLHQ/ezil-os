---
id: SHEET-01
title: Spreadsheet viewer — CSV first, then XLSX via SheetJS
labels: [shell, "help wanted", "size/L"]
prereq: SFA-01
state: open
---

## The problem

A `.csv` or `.xlsx` file in a project's workspace can only be read through code-server's text
editor (raw CSV, unreadable for XLSX's binary format) or inside the fully-streamed desktop.
There is no lightweight shell app for either. CSV needs no third-party library at all — a
`.csv` file can be parsed and rendered as a table with nothing beyond what the bundle already
ships — so it is the natural first slice; XLSX needs a real parser (SheetJS Community
Edition, Apache-2.0) vendored the same way `shell/src/lib` vendors everything else.

## Acceptance criteria

- **CSV first, as its own shippable slice**: a shell-local app parses and renders a `.csv`
  file fetched via `SFA-01`'s `GET /api/shell/files/get` as a scrollable table — no vendored
  dependency required for this half.
- **XLSX second**: SheetJS is vendored as UMD under `shell/src/lib/` (not ES-module — see
  `ATTRIBUTIONS.md` §6) and the same viewer app reads `.xlsx` through it, with a new
  `ATTRIBUTIONS.md` entry naming the version and license in the same PR.
- Large files degrade honestly — a documented row/column ceiling with a visible "truncated"
  notice, never a silent partial render.
- Registered in `shell/ezil/apps/registry.js`'s `APPS` array, one `AppDescriptor` per the
  existing shape (`registry.js:266` onward), honoring the boot-trace contract.
- `shell/build-shell.sh --check` passes with the new app (and, once XLSX lands, the vendored
  library) committed.

## Where to look

- `shell/ezil/apps/registry.js:286-409` — the `APPS` array.
- `shell/src/lib/` — the vendored-UMD pattern this issue's XLSX half follows.
- `ATTRIBUTIONS.md` §1 and §6 — provenance/license recording method for a new vendored
  library.
- `SFA-01`'s `GET /api/shell/files/get` route (once it lands).

## How to prove it

```
shell/build-shell.sh --check
```
Expected: no diff, and the app's own test (jsdom for parsing/rendering logic, browser test if
it has real table geometry) passes with zero skips — separately for the CSV-only PR and the
follow-up XLSX PR if they land as two.

## Prerequisite

`SFA-01`.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request) and
[Building an app for the desktop](../../CONTRIBUTING-APPS.md).

---
id: DOC-01
title: Markdown and DOCX viewer
labels: [shell, "help wanted", "size/M"]
prereq: SFA-01
state: open
---

## The problem

Reading a `.md` or `.docx` file in a project's workspace today means opening it raw in
code-server (Markdown unrendered, DOCX unreadable binary) or streaming the full desktop.
Markdown needs no vendored dependency to render acceptably (or a small, already
license-compatible parser); DOCX needs a real parser vendored under `shell/src/lib/` the same
way every other third-party script in this shell is vendored.

## Acceptance criteria

- A shell-local app renders a `.md` file fetched via `SFA-01`'s `GET /api/shell/files/get` as
  formatted text (headings, lists, code fences, links at minimum) — no execution of embedded
  scripts or unsafe HTML, since the content is another user's file, not trusted shell code.
- The same app (or a sibling one, same `APPS` entry pattern) renders a `.docx` file's text and
  basic structure using a vendored UMD library under `shell/src/lib/`, with a new
  `ATTRIBUTIONS.md` entry naming its version and license.
- Registered in `shell/ezil/apps/registry.js`'s `APPS` array per the existing `AppDescriptor`
  shape, honoring the boot-trace contract (`ctx.trace.end`, 240s fallback).
- A file too large or too malformed to render fails visibly (a named error state), never a
  blank window.
- `shell/build-shell.sh --check` passes with the new app and any vendored library committed.

## Where to look

- `shell/ezil/apps/registry.js:286-409` — the `APPS` array.
- `shell/src/lib/` and `ATTRIBUTIONS.md` §1/§6 — the vendoring pattern and its license-recording
  method.
- `SFA-01`'s `GET /api/shell/files/get` route (once it lands).

## How to prove it

```
shell/build-shell.sh --check
```
Expected: no diff, and the app's jsdom test (rendering a fixture `.md`/`.docx` file) passes
with zero skips.

## Prerequisite

`SFA-01`.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request) and
[Building an app for the desktop](../../CONTRIBUTING-APPS.md).

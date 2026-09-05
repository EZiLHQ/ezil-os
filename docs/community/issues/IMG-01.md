---
id: IMG-01
title: Image viewer
labels: [shell, "good first issue", "size/S"]
prereq: SFA-01
state: open
github: 63
---

## The problem

There is no way to look at a `.png`/`.jpg`/`.gif`/`.svg` file in a project's workspace
without streaming the whole desktop. This is the smallest of the five planned viewers — the
browser already knows how to render an `<img>` — which makes it a reasonable first PR for
someone new to the shell's app registry.

## Acceptance criteria

- A shell-local app fetches an image file's bytes via `SFA-01`'s `GET /api/shell/files/get`
  and renders it in an `<img>` (or `<canvas>`, for consistency with zoom/pan if added), scoped
  to common raster formats plus `.svg`.
- Registered in `shell/ezil/apps/registry.js`'s `APPS` array with its own icon, following the
  `AppDescriptor` shape (`registry.js:266` onward).
- Honors the boot-trace contract: a file that fails to load reports a named error, not a
  perpetually-loading window.
- `shell/build-shell.sh --check` passes with the new app committed.

## Where to look

- `shell/ezil/apps/registry.js:286-409` — the `APPS` array new entries join.
- `shell/ezil/apps/registry.js:22-34`, `:491-515` — the `shell_local` vs. hosted handshake.
- `SFA-01`'s `GET /api/shell/files/get` route (once it lands) — the only way this app may
  fetch a file's bytes.

## How to prove it

```
shell/build-shell.sh --check
```
Expected: no diff, and the app's own jsdom test (asserting the `<img src>` resolves to the
fetched blob, not a raw file-API URL leaking through) passes with zero skips.

## Prerequisite

`SFA-01`.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr) and
[Building an app for the desktop](../../CONTRIBUTING-APPS.md).

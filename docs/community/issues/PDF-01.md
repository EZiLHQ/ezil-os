---
id: PDF-01
title: PDF viewer (pdf.js, vendored UMD)
labels: [shell, "help wanted", "size/L"]
prereq: SFA-01
state: open
---

## The problem

There is no way to look at a PDF that lives in a project's workspace without downloading it
through code-server or opening it inside the streamed desktop's own PDF viewer (a full
container boot for one document). `shell/src/lib` already vendors third-party UMD scripts this
way for other needs (`jquery-3.6.1`, `jquery-ui-1.13.2`, `ezil-vendor.js`, `html-entities.js`,
`isMobile.min.js`) — the pattern exists, pdf.js has not been added to it.

## Acceptance criteria

- Mozilla's `pdf.js` (Apache-2.0, license-compatible per `ATTRIBUTIONS.md`'s existing method)
  is vendored as a plain UMD build under `shell/src/lib/`, **not** as an ES module — this
  bundle ships no `"type":"module"` anywhere (see `ATTRIBUTIONS.md` §6, Method, for why).
  `ATTRIBUTIONS.md` gets a new entry naming the exact version and license in the same PR.
- A new shell-local app (`shell_local: true`) opens a `.pdf` file fetched via `SFA-01`'s
  `GET /api/shell/files/get` and renders it with pdf.js — page navigation and zoom at minimum.
- Registered in `shell/ezil/apps/registry.js`'s `APPS` array with its own icon, following the
  same `AppDescriptor` shape every other entry uses.
- Honors the boot-trace contract (`ctx.trace.end`, 240s fallback) so a PDF that fails to parse
  reports failure honestly rather than hanging on a blank window.
- `shell/build-shell.sh --check` passes with the vendored library and the new app's bundle
  committed.

## Where to look

- `shell/src/lib/` — the existing vendored UMD libraries (`ezil-vendor.js`, `jquery-*`,
  `html-entities.js`) — the pattern this issue extends.
- `ATTRIBUTIONS.md` §1 ("Forked application source") and its Method section (§6) — how a
  vendored library's provenance and license get recorded.
- `shell/ezil/apps/registry.js:286-409` — the `APPS` array; `:266` onward — the
  `AppDescriptor` JSDoc shape.
- `SFA-01`'s `GET /api/shell/files/get` route (once it lands) — the only way this app may
  fetch a file's bytes.

## How to prove it

```
shell/build-shell.sh --check
```
Expected: no diff (the committed bundle matches the sources, including the vendored library
and the new app), and the new app's own jsdom/browser test passes with zero skips.

## Prerequisite

`SFA-01` — nothing can fetch a PDF's bytes into the browser without it.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../CONTRIBUTING.md#how-to-send-a-pull-request) and
[Building an app for the desktop](../CONTRIBUTING-APPS.md).

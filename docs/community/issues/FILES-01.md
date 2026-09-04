---
id: FILES-01
title: A Files app to browse the workspace
labels: [shell, "help wanted", "size/L"]
prereq: SFA-01
state: open
---

## The problem

The shell can only be reached today by streaming the whole Linux desktop
(`shell/ezil/apps/desktop-window.js`, `desktop-screen.js`) or by opening a running web app in
an iframe (`shell/ezil/apps/preview.js`). There is no way to just look at what is in a
project's workspace — its file tree — without paying for a full container boot. `shell/ezil/apps/`
holds exactly five files today (`code.js`, `desktop-screen.js`, `desktop-window.js`,
`preview.js`, `registry.js`); none of them lists a directory. Once `SFA-01` exposes
`list`/`get` over HTTP, nothing renders them.

## Acceptance criteria

- A new shell-local app (`shell_local: true`, per `shell/ezil/apps/registry.js:29-34`) appears
  in the `APPS` array (`registry.js:286-409`) with its own inline-SVG icon, following the
  `AppDescriptor` shape documented at `registry.js:266` and above.
- Opening it calls `GET /api/shell/files/list` (from `SFA-01`) and renders a tree/list for the
  caller's own project; opening a file calls `GET /api/shell/files/get` and hands the bytes to
  the matching viewer app when one exists (`PDF-01`, `SHEET-01`, `DOC-01`, `IMG-01`), or offers
  a plain-text/hex fallback otherwise.
- Follows the boot-trace contract other apps must honor: it calls `ctx.trace.end` and is
  bounded by the 240s fallback described in `docs/CONTRIBUTING-APPS.md` (once merged — see
  `../../CONTRIBUTING-APPS.md`) so a broken boot reports "don't know", never a false "ready".
- A `*-test.mjs` jsdom test against the committed bundle (`shell/build-shell.sh`'s output),
  plus a `*-browser-test.mjs` if the app has real geometry (window sizing, list virtualization).
- `shell/build-shell.sh --check` passes with the new app's bundle committed.

## Where to look

- `shell/ezil/apps/registry.js:286-409` — the static `APPS` array new entries join.
- `shell/ezil/apps/registry.js:22-34` and `:491-515` — the `shell_local` vs. hosted
  two-sided handshake (`resolve()`), and its counterpart `SHELL_APPS` in
  `app/src/server/shell/boot-payload.ts:185`.
- `shell/ezil/apps/preview.js` — the closest existing pattern for a shell-local window that
  fetches data from a server route rather than streaming a container.
- `SFA-01`'s two routes (`app/src/app/api/shell/files/{list,get}/route.ts`, once it lands) —
  the only file API this app may call.

## How to prove it

```
shell/build-shell.sh --check
node --test shell/ezil/apps/files-test.mjs   # or the repo's actual jsdom test runner — see docs/CONTRIBUTING-APPS.md
```
Expected: `--check` reports the bundle is up to date (no diff), and the app's own test file
passes with zero skips.

## Prerequisite

`SFA-01` — the file-list/file-get API this app is built on does not exist yet.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pr) and
[Building an app for the desktop](../../CONTRIBUTING-APPS.md).

---
id: SFA-01
title: A shell-callable file API — expose worker/src/project-files.ts to the desktop
labels: [app, worker, "help wanted", "size/L"]
prereq:
state: open
---

## The problem

`worker/src/project-files.ts` already implements a full `list`/`get`/`head`/`put`/`delete`
surface over a project's R2-backed workspace, behind an HMAC-gated dispatcher
(`authorizeProjectFilesRequest`, `worker/src/index.ts:5536`) reached at
`POST /project-files/{put,get,head,delete,list}` (`worker/src/index.ts:6125-6143`), with a
20 MiB decode cap on `put` (`PROJECT_FILES_MAX_PUT_BYTES`, `worker/src/project-files.ts:154`).
Nothing in the app or the shell calls it. `app/src/app/api/shell/` has nine route directories
today (`activity`, `code-preview-url`, `desktop`, `focus`, `preview-url`, `restart`, `screen`,
`session`, `telemetry`) and none of them is `files`. So the desktop can stream a whole Linux
box but cannot open a single file inside it from a shell app — every planned viewer
(`FILES-01`, `PDF-01`, `SHEET-01`, `DOC-01`, `IMG-01`) is blocked on exactly this gap.

## Acceptance criteria

- `app/src/app/api/shell/files/list/route.ts` and `.../files/get/route.ts` exist as siblings
  of the other nine `/api/shell/*` routes, authenticating the caller via
  `createTRPCContext`/`appRouter.createCaller` the same way `preview-url/route.ts` does
  (`app/src/app/api/shell/preview-url/route.ts:44-49`) — no new auth mechanism.
- `list` is scoped to the authenticated caller's own project/computer; a request naming
  another caller's project is refused, proven by a test.
- `get` enforces a documented byte cap and returns **413** above it, not a truncated body.
- **No `put` or `delete` route ships in v1.** The new route files must not import
  `putProjectFile` or `deleteProjectFile` from `worker/src/project-files.ts` — a lint or
  grep-based test should assert this so a later PR cannot quietly widen the surface.
- A vitest proves a cross-project key is refused (401/403, not a silent empty result).

## Where to look

- `worker/src/project-files.ts:115-165` — the byte caps (`PROJECT_FILES_MAX_KEY_BYTES`,
  `PROJECT_FILES_MAX_PUT_BYTES`) and the five exported functions
  (`putProjectFile`, `getProjectFileBytes`, `getProjectFileProperties`, `deleteProjectFile`,
  `listProjectFiles`, lines 206-409).
- `worker/src/index.ts:5536` — `authorizeProjectFilesRequest`, the HMAC gate every
  `/project-files/*` route goes through today.
- `worker/src/index.ts:6125-6143` — the `POST /project-files/*` dispatcher and its
  `SANDBOX_PROJECT_FILES_PROXY=off` kill switch.
- `app/src/app/api/shell/preview-url/route.ts:44-49` — the session-context pattern
  (`createTRPCContext` + `appRouter.createCaller`) the new routes should reuse.
- `app/src/app/api/shell/` — the nine existing route directories; `files/` is not one of them
  (verified by directory listing).

## How to prove it

```
cd app && bun run test src/app/api/shell/files && bun run typecheck
```
Expected: the new test file passes, including the cross-project-key-refused case, and
`typecheck` reports zero errors.

## Prerequisite

None. This is the prerequisite for `FILES-01`, `PDF-01`, `SHEET-01`, `DOC-01` and `IMG-01`.

---

Want to work on this? Comment on the issue to claim it (72-hour lazy consensus — see
[Picking something up](../../CONTRIBUTING.md#how-to-send-a-pull-request) in CONTRIBUTING),
then read [How to send a pull request](../../CONTRIBUTING.md#how-to-send-a-pull-request).

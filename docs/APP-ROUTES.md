# App routes, link parameters and history

How the EZiL OS shell is addressed, as implemented on branch
`feat/os-app-code-a1-20261030` (lane A1). This file describes behaviour that
exists and is tested. Where a rule is a choice this lane made inside the
shared A1/A2 contract, it says so.

| Concern | Code | Tests |
|---|---|---|
| Server route `/app/<appId>` | `app/src/app/app/[appId]/page.tsx` → `app/src/app/os/page.tsx` | `app/src/app/os/page.test.ts` |
| App id allowlist, return URLs | `app/src/utils/constants.ts` | `app/src/utils/constants.test.ts` |
| Parsing a URL into an app link | `shell/ezil/app-link.js` | `shell/ezil/app-link-test.mjs` |
| The address bar (history) | `shell/ezil/app-history.js` | `shell/ezil/app-history-test.mjs`, `app-link-test.mjs`, `app-link-browser-test.mjs` |
| Launch context, relaunch hook | `shell/ezil/apps/registry.js`, `shell/ezil/boot.js` | `app-link-test.mjs` |
| Window focus/close events | `shell/src/UI/UIWindow.js` | `app-link-test.mjs`, `app-link-browser-test.mjs` |

## 1. Routes

The canonical URL of an open app is **`/app/<appId>`**, where `appId` is a
shell registry id (`APPS` in `shell/ezil/apps/registry.js`):
`desktop`, `code`, `settings`, `app-store`, `preview`, `secure-browser`.
`browser` is an alias of `desktop`; there is no `launcher` app in the
registry today.

- **`/app/<appId>` renders the same document as `/os`.** Not a redirect: the
  `/app/[appId]` page calls the `/os` page component with `params.appId`.
  Same boot payload, same sign-in gate, same `?computer=<uuid>` handling
  (ownership-checked `computer.get`), same hydration contract. Route segment
  config (`dynamic = 'force-dynamic'`, `metadata`) is declared in both files.
- **An id outside the allowlist is a 404**, before any session lookup.
  `SHELL_APP_IDS` + `SHELL_APP_ALIASES` in `app/src/utils/constants.ts` are the
  allowlist; a test reads `registry.js` and `app-link.js` and fails if they
  drift apart.
- An allowlisted id that this boot cannot show (`secure-browser` outside the
  native Mac app) renders the shell and opens nothing, as `/os?app=<id>` did.
- **`/os` stays.** `/os?app=<id>` and `/os?settings=<tab>` are aliases. On
  boot the shell rewrites them in place (`replaceState`, no new entry) to
  `/app/<id>` and `/app/settings?tab=<tab>`. Every other query pair is kept
  byte for byte (so `computer`, `section`, anything unknown, and a value the
  parser rejected stay exactly as they were).
- **Billing deep links keep working.** `/os?settings=billing&upgrade=<tier>`
  (the pricing page, the in-app Billing links) and
  `/app/settings?tab=billing&upgrade=<tier>` both open Settings → Billing
  with the upgrade sheet; afterwards `upgrade` (and `section=ai-credits`) are
  dropped and the URL becomes `/app/settings?tab=billing…`.
- **Hosts that serve only `/os` are never rewritten.** The native Mac host
  (`provider: 'native-macos'`, which also refuses any query string) and the
  local runtime (`provider: 'local-vm'`) serve the shell at `/os` alone.
  There the shell never changes the path; Back/Forward still focus apps.
- No cookie is scoped to `Path=/os`, there is no service worker, and
  `app/next.config.ts` has no per-path CSP, so nothing else needs to know
  about the second path. `app/src/proxy.ts` needed no change.
- Assets are loaded from absolute `/os/...` URLs, so they resolve identically
  under `/app/<id>`. The Chromium suite serves the document only at `/os` and
  `/app/<id>` and fails on any request to a path it does not serve.
  Pre-existing and path-independent: `bundle.min.css` references jQuery UI's
  `images/ui-icons_*.png` sprites, which resolve to `/os/images/…` and are not
  shipped, so they 404 at `/os` exactly as at `/app/<id>`.

## 2. Link parameters

`parseAppLink(location, apps)` (`shell/ezil/app-link.js`) takes
`window.location`, a `"/path?query"` string, or the original bare `"?query"`
string. It returns `null` (open nothing) or
`{ id, initialTab?, project?, projectRejected?, pathRejected? }`.

- **Selecting the app.** Path form: the path names the app; an `app` key as
  well is a conflict (`null`). Alias form: `app=<id>`, or `settings=<tab>`
  alone for Settings. Settings' tab is `tab=` (path form) or `settings=`
  (alias form); both present and different is `null`. An unknown tab opens
  Settings at its default.
- **Duplicate keys reject the whole link.** Any repeated `app`, `settings`,
  `tab`, `project`, `repo` or `path` returns `null`.
- **Code's project** (`/app/code?project=<uuid>&repo=<uuid>[&path=<rel>]`,
  also accepted on the alias form). Parsed only; resolving it is a later
  lane. Both ids are required and must be lowercase canonical UUIDs
  (8-4-4-4-12 hex). Otherwise the project is dropped, Code still opens, and
  `projectRejected` says why: `project_missing`, `repo_missing`,
  `project_invalid`, `repo_invalid`.
  Result: `project: { projectId, repoId, path? }`.
- **`path`.** A relative POSIX path, at most 255 UTF-8 bytes, segments
  matching `/^[A-Za-z0-9._-]+$/`, no `.` or `..` segment, no leading `/`, no
  backslash, no NUL/control character, no empty segment, and no
  percent-encoded separator (`%2F`, `%5C`, checked on the raw query value).
  An invalid path is dropped (the project is not) with `pathRejected`:
  `empty`, `encoded_separator`, `too_long`, `absolute`, `backslash`,
  `control`, `dot_segment`, `segment`.
- **Never read from the URL:** a repo URL, a ref, a folder, a user or account
  id, a token. Unknown keys are ignored by the parser and preserved in the
  address bar.
- **Writing `path`.** `/` is left unencoded in query values everywhere this
  codebase writes one (`appUrl` in `app-history.js`, `returnUrlFor` in
  `constants.ts`), so `path=src/main.ts` survives sign-in as written. A link
  that arrives with `path=src%2Fmain.ts` has its path dropped. Known
  asymmetry, by design of the server API: Next hands the page decoded search
  params, so a signed-out visitor's `src%2Fmain.ts` is re-serialised as
  `src/main.ts` on the way through sign-in and is then accepted.

## 3. Launch context (contract item 3)

The router calls `registry.launch(id, { ...registry.launchContext(ctx), initialTab?, view?, project?, historyMode })`.

- **`view`** is passed only for Code launched from a route (the boot's link,
  including a canonicalised `/os?app=code`, and Back/Forward):
  1. the view this history entry recorded (`history.state.ezilView`, when
     `history.state.ezilApp === 'code'`), else
  2. `'full'` if no Code window exists yet, else
  3. nothing (Back/Forward to an already-open Code does not resize it).
  Rule 1 also applies to a reload, since `history.state` survives one: a
  Code entry the user switched to windowed reloads windowed. This is this
  lane's reading of contract item 3 + 5.
- Dock, Start menu, App Store and Settings-drawer launches pass no `view`,
  `project` or `initialTab` (A2 decides Code's view). A click inside a
  window that a route opened does not inherit that route's keys
  (`gestureContext` in `registry.js`).
- **`historyMode`**: `'push'` (default: a user's click), `'replace'` (a route),
  `'none'` (restoring the native desktop's windows). See §5.

## 4. Single-instance relaunch (contract item 4)

Relaunching an app whose single-instance window exists calls
`el._ezil_relaunch?.(ctx)` on that window, after `showWindow()`, with the
same `ctx` object the caller passed. This also happens for a launch that
coalesced with one still opening. A throwing hook is logged and the launch
still returns the window. Settings keeps its existing `ezilActivateSettings`.

## 5. History (contract item 5)

`shell/ezil/app-history.js` is the only code that calls
`history.pushState`/`replaceState`. (`UIWindow.js` still contains Puter's
dashboard-mode URL code; it is gated on `window.is_dashboard_mode`, which
nothing sets.)

| Event | Effect |
|---|---|
| A user's click launches an app (dock, Start, App Store, Settings drawer, Settings → open a computer, spinner's "Settings") | **push** `/app/<id>` **before** the window is built; nothing if the address bar already names that app (its URL is rewritten in place only if the launch changed the app's own parameters, e.g. Settings opened at another tab). If the app does not open, the previous URL and state are put back (the extra entry stays, as a duplicate). |
| Focus moves to another app's window | **replace** with that app's URL |
| A window closes | **replace** with the front app: the focused app window, else the visible one focused most recently, else `/os` |
| Code reports a view change (`ezil:app-view-changed`, `{appId, view}`) | **replace** state `ezilView` on the current entry, only if the entry is that app's |
| Back/Forward (`popstate`) | focus that app's window, or launch it, with the entry's own parameters and `historyMode: 'replace'`. Never closes a window, stops a computer, deletes state or pushes. An entry that names no usable app (`/os`, an invalid link) does nothing. |
| Boot with a link | **replace** (canonicalise) before launching |

Why the push happens first: in Chromium a frame navigation is filed under
the entry that was current when it started. The Code and Browser windows
start their iframes' navigations while they are built; committing after a
later push, those navigations pruned it (measured: `history.length` 3 → 2,
and Back skipped the app).

**URLs written.** `/app/<id>` plus the app's own parameters (Code's
`project`/`repo`/`path` from its link, Settings' `tab` from its launch) plus
page-level `computer` (captured once at boot; the server picks the computer
from it on reload). Synthesised URLs carry only validated values.

**State.** Every write merges into `history.state`: unknown keys are kept
(Next.js keeps `__NA` and its route tree there, and its popstate handler
reloads the page on a non-null state without `__NA`; a later lane may add
e.g. `ezilProjectLaunchIntent`). Known keys: `ezilApp` (the entry's app) and
`ezilView` (that app's view; removed when the entry's app changes).

**Events this relies on**, emitted by `shell/src/UI/UIWindow.js`:
`ezil:window-focus` (`{window}`, from `$.fn.focusWindow`) and
`ezil:window-closed` (`{window, app}`, from `delete_window_element`, the
funnel every close goes through). A2 dispatches `ezil:app-view-changed` and
never calls history APIs.

**Next.js.** `/os` and `/app/<id>` are App Router pages. After hydration,
Next patches `pushState`/`replaceState` to copy its keys and to point its
router at the new URL (a `restore` action with the same route tree, which
keeps custom state). Back/Forward across a reload of an entry made by the
previous document is a full document load in the browser, which boots the
shell at that entry's URL.

## 6. Sign-in return URLs

The `/os` page builds its return URL from the allowlisted literal
(`/os` or `/app/<id>`) plus the request's query (`returnUrlFor`), never from
the raw request path. `safeReturnUrl` (`app/src/utils/constants.ts`), used by
the login page, the login action, `/auth/callback`, `/auth/confirm` and the
Auth0 flow:

- accepts only this app's own return pages, with their query and hash:
  `/os`, `/app/<allowlisted id>`, `/computers`, `/computer/<uuid>`,
  `/billing/return`;
- rejects `//`, `/\`, any backslash, schemes, control characters and
  whitespace, and, in the path only, dot segments and `%2f`/`%5c`/`%2e`
  (the query is data: `%2F` there is ordinary encoding);
- has three outcomes: nothing supplied → `/os`; a failed `/app…` path → `/os`;
  anything else that failed → `/computers` (unchanged from before, and
  asserted by the Auth0, confirm and login tests).

## 7. Known gaps and hand-offs (as of this lane)

- `shell/ezil/ui/Settings/tabs/billing.js:843-844` reads `settings=billing`
  and `section=ai-credits` from the address bar; on
  `/app/settings?tab=billing&section=ai-credits` the AI-credits section does
  not auto-open. It should also accept `tab=billing` on `/app/settings`.
- In-app links `href="/os?settings=billing…"` (`Settings/tabs/computers.js`
  545, 602, 711; `Settings/tabs/usage.js` 39) and `/os` links in
  `app/src/app/billing/return/*`, `app/src/app/computers/_components/select-computers.tsx`
  still work through the alias, as full document loads.
- Comments that say the shell does not own the address bar or that `/os` is
  one URL are now stale: `shell/ezil/ui/app-drawer.js:21-23`,
  `shell/ezil/ui/Settings/index.js:28-29`.
- Settings does not report tab changes, so a URL's `tab` reflects the tab it
  was opened at.

## 8. Visual choices

None. This lane changes no pixels.

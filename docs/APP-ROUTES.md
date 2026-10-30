# App routes, link parameters and history

How the EZiL OS shell is addressed, as implemented on branch
`feat/os-app-code-a1-20261030` (lane A1) and integrated on
`feat/os-app-code-20261030` (§5's launch order, §6's compatibility cases
and return review, §7). This file describes behaviour that exists and is
tested. Where a rule is a choice this lane made inside the shared A1/A2
contract, it says so.

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
  1. nothing if a Code window is already open: Back/Forward only focuses it
     and never resizes it. Its relaunch hook (`_ezil_relaunch`) still runs,
     with no `view`. An entry's recorded view can be older than the user's
     latest choice, which was recorded on whichever entry was current then;
     else
  2. the view this history entry recorded (`history.state.ezilView`, when
     `history.state.ezilApp === 'code'`), else
  3. `'full'`.
  Rule 2 also applies to a reload, since `history.state` survives one: a
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
| A user's click launches an app (dock, Start, App Store, Settings drawer, Settings → open a computer, spinner's "Settings") | **push** `/app/<id>` **before** the window is built; nothing if the address bar already names that app (its URL is rewritten in place only if the launch changed the app's own parameters, e.g. Settings opened at another tab). If the app does not open, the previous URL and state are put back (the extra entry stays, as a duplicate). A launch that resolves after a newer intent writes nothing ("Order" below). |
| Focus moves to another app's window | **replace** with that app's URL |
| A window closes | **replace** with the front app: the focused app window, else the visible one focused most recently, else `/os` |
| Code reports a view change (`ezil:app-view-changed`, `{appId, view}`) | **replace** state `ezilView` on the current entry, only if the entry is that app's |
| Back/Forward (`popstate`) | focus that app's window, or launch it, with the entry's own parameters and `historyMode: 'replace'` (an already-open window gets no `view`, §3). Never closes a window, stops a computer, deletes state or pushes. An entry that names no usable app (`/os`, an invalid link) launches nothing. Either way, a launch still pending loses its say ("Order" below). |
| Boot with a link | **replace** (canonicalise) before launching; the billing link after its launch. Either launch is numbered ("Order" below). |

Why the push happens first: in Chromium a frame navigation is filed under
the entry that was current when it started. The Code and Browser windows
start their iframes' navigations while they are built; committing after a
later push, those navigations pruned it (measured: `history.length` 3 → 2,
and Back skipped the app).

### Order: only the latest intent decides

Launches resolve out of order: a click on Code, whose window is slow to
build, then a click on Settings, which opens first. `app-history.js` numbers
every intent as it happens (one counter per controller, never reset): a
click's launch (`begin`), Back/Forward (whatever entry it lands on, `/os`
included), a route launch the boot starts (`route`), the close of an app
window, and a focus it writes for. A click, Back/Forward or boot route is
also the latest **launch** intent. The intent that
decides is the latest one, unless the latest launch failed ("gives back",
below).

| Pending | When it resolves it writes | only if, since it began, there was no newer |
|---|---|---|
| A click's launch that opened a window (`end(el)`) | that app's URL (replace), if the entry does not already name it | click or Back/Forward. A close in between does not stop it: the window that opened is in front. |
| A click's launch that opened nothing (`end(null)`) | the URL and state it replaced, and gives the address bar back | intent of any kind (a close has already named the front app), other than a newer click's launch that failed and gave it back. The app's own parameters go back only if no later launch has set them. |
| A Back/Forward launch (`commit`) | the entry's app and parameters, in place | intent of any kind |
| A launched window's own late focus, until its launch settles | that app's URL (replace) | click or Back/Forward |

- **A superseded launch writes nothing**: no push, no replace, no rollback,
  and it is not recorded as a focus either, even when its window ends up in
  front. The address bar names that window at its next focus that counts.
- **A failed launch gives back.** A click's launch that fails while it
  decides is undone: the URL and state it replaced, and the address bar
  goes back to the intent it took it from. If that is an older click's
  launch still pending, that launch decides again (its `end`, its window's
  late focus and its `ensureOnTop` count). If that launch has failed
  meanwhile, it gives back in turn. So three clicks that end
  Settings fails, Code fails, Desktop opens leave `/app/desktop`, and two
  that both fail leave the URL from before them, in either order. A close
  or Back/Forward in between ends the chain: nothing is given back over it.
- **Settling.** UIWindow focuses a restored window 80ms after `showWindow`,
  and `ensureOnTop` (`registry.js`) re-focuses a launched window at 120ms.
  Neither is the user's. Until `ensureOnTop` has run (it calls
  `settled(el)` on every path), a focus of that window counts only while its
  launch is the latest launch intent (a window two launches resolved with,
  in either order, belongs to the newer one). Every other focus counts as
  before.
- **The front window follows too.** `ensureOnTop` of a launch that a newer
  click or Back/Forward has superseded (`superseded(el)`) does not re-focus
  its window, so it cannot take the front back from the newer launch's
  window. The newest launch's own `ensureOnTop` always runs, and still
  overrides a late focus that landed on top of it.
- While any click's launch is pending, focus events write nothing (as
  before: the new window focuses itself while it is built, and a late focus
  of another window cannot be told from a click).
- **The boot's own route launches are numbered too** (`route`): its link
  and the billing link, as Back/Forward is. A click made while either
  opens decides: the launch's `commit` writes nothing, and nor does the
  billing link's `adopt` after it (a click that failed gave the address
  bar back, and then both write). The billing link's one-shot keys
  (`upgrade`, `section`) then stay on the boot's entry, as they did
  before: Back to it shows Settings at Billing (a Settings window opened
  by it scrolls to the AI credits card), never a checkout or upgrade
  sheet (`openUpgrade` comes from the boot's own launch alone).

Known limits, not changed here:

- A superseded launch's window still takes the front with its own focus
  while it is built (UIWindow). If that happens more than about 120ms after
  the newer launch opened, after the newer `ensureOnTop` has run, it stays
  in front while the address bar keeps the newer intent, until the next
  focus that counts.
- If the newer launch fails only after the older launch's `ensureOnTop` has
  already stood down, nothing re-asserts the older launch's window against
  a late focus of some other window.
- A click on a window that is still settling after a newer launch is
  ignored until it settles (at most 120ms).
- A launch that never resolves keeps every focus write off, as before.
- A failed launch's pushed entry stays behind the URL it gave back, as
  before (the current entry is rewritten, not removed). Back to it launches
  that app again.
- A reopen that coalesces with a launch whose window was closed meanwhile
  (`launchSingle`) resolves with that closed window, so the URL names an app
  with no window open.

Tests: `app-history-test.mjs` ("order": the coordinator's two cases, three
launches in every end order with every open/fail outcome, the failure
cascade spelled out (with a close ending it), late focus,
close and reopen, closing another window, Back and Forward while a launch
is pending, overtaken Back launches, the boot's link and billing link
overtaken by a click, parameters, positive controls) and
`app-link-test.mjs` (the bundle through `registry.launch`: a slow open, the
80/120ms focuses run by hand one at a time, a Back launch; the address bar
and the focused window are checked after each; and through `boot.js`, its
link and billing link held open while a click lands).

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

**Next.js.** `/os` and `/app/<id>` are App Router pages. After hydration
Next patches `pushState`/`replaceState`, but a state that already carries
`__NA` takes the patch's pass-through branch
(`next/dist/client/components/app-router.js`). Every write here merges
`history.state`, so it does: Next's router is NOT told about these URL
changes and keeps the boot URL as its `canonicalUrl` until a Back/Forward,
when its own popstate handler traverses to `location.href` with the entry's
route tree (the tree of the document that wrote it).

- 🔴 Known risk: any Next router action on these pages (`router.refresh()`, a
  server action, a client `<Link>` navigation) would make Next's history
  updater write its stale `canonicalUrl` back into the address bar. Today
  the shell pages trigger none; their only `<Link>`s are on the stall and
  could-not-open screens, which leave the page.
- Deliberately not done: handing Next a state without its keys, so its
  patch re-adds them and dispatches a `restore`, would keep its router in
  step but run that router on every focus change. Without a real Next run
  proving the restore never refetches (a different route's tree would
  remount the page and destroy the shell), this lane did not take that on.
- Back/Forward to an entry written by a document that has since been
  reloaded is a full document load, which boots the shell at that entry's
  URL.

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
  whitespace. The path must equal an allowlisted page, which is also what
  refuses dot segments (`/app/../admin`) and encoded separators or dots
  (`/app/%2e%2e/x`, `/os%2fadmin`). The query is data (`%2F` there is
  ordinary encoding);
- has three outcomes: nothing supplied → `/os`; a failed `/app…` path → `/os`;
  anything else that failed → `/computers` (unchanged from before, and
  asserted by the Auth0, confirm and login tests).

The rule is five numbered cases, in this order, each commented in
`constants.ts` and pinned by its own test (`constants.test.ts`,
"compatibility decisions"):

| # | Input | Lands on |
|---|---|---|
| 1 | nothing: absent, `''`, `[]`, `['']` (a repeat counts by its first value) | `/os` |
| 2 | hostile shape: a scheme or non-path, `//`, `/\`, a backslash anywhere (query included), a control character or whitespace | `/computers` |
| 3 | a return page: `/os`, `/app/<registry id or alias>`, `/computers`, `/computer/<uuid>` (either case), `/billing/return` | itself, byte for byte, query and hash included (`path=src/main.ts` keeps its `/`) |
| 4 | any other path under `/app` (`/app`, `/app/`, `/app/unknown`, `/app/Code`, `/app/../x`, `/app/%2e%2e/x`, `/app/code%2fx`, `/app/code%5cx`, `/app/code/x`) | `/os` |
| 5 | any other path (`/apps`, `/app%2fcode` included) | `/computers` |

Case 2 is decided before case 4 on purpose: `/app\..\admin` or `/app/code`
followed by a tab is a smuggling attempt, not an `/app` path the list could
not vouch for, so it lands on `/computers`. Case 2's `/computers` is also
asserted by four other suites, each with hostile or foreign input only:
`app/src/app/login/page.test.ts`,
`app/src/app/auth/auth0/callback/route.test.ts`,
`app/src/server/auth/auth0.test.ts` and
`app/src/app/auth/confirm/confirm-route.test.ts` (measured: case 2 → `/os`
turns all four red). None of them feeds a well-formed path that is not a
return page, so case 5, the new rejection, is pinned by `constants.test.ts`
alone (case 5 → `/os` leaves all four green).

**Compatibility with the rule before `/app/<id>`** (base `74ed2c92`: any
value starting with `/`, except `//` and `/\`, with no control character or
whitespace, came back as given):

| Path that base kept | Now | Why | Sent by anything in this repo? |
|---|---|---|---|
| `/` | `/computers` | Not a return page. `/` itself sends a signed-in visitor to `/os`, and a sign-in with no `returnUrl` lands on `/os` too. | No |
| `/pricing` | `/computers` | Marketing page. The pricing CTA sends `/os?settings=billing&upgrade=<tier>`. | No |
| `/login` | `/computers` | Would loop. | No |
| `/admin/*` | `/computers` | Admin pages are not return pages. `/admin/telemetry` sends a signed-out visitor to a bare `/login`. | No |
| `/os/`, `/os/<anything>` | `/computers` | Whole-path match: the shell is `/os`, exactly. | No |
| `/computers/` | `/computers` | Same page, without the slash. | No |
| `/app/<anything not allowlisted>` | `/os` | Case 4. Base kept it and the page then answered 404. | No |
| a backslash past the start (`/os?x=\y`, `/app\..\admin`) | `/computers` | Case 2 (base refused only a leading `/\`). | No |
| `/os%2fadmin`, `/os/../admin`, `/api/…`, `/auth/…` | `/computers` | Not return pages. | No |

The producer audit behind the last column (grep for `returnUrl=`,
`getReturnUrlQueryParam`, `RETURN_URL_PARAM` and `next=` in `app/src`,
`shell/ezil`, `landing`, `e2e`, `worker/src`): the `/os` and `/app/[appId]`
pages (`returnUrlFor` of the allowlisted literal), `computers/layout.tsx`
and `computer/layout.tsx` (`x-pathname`: `/computers`, `/computer/<id>`),
`billing/return/page.tsx` (`/billing/return?session_id=…`), the pricing CTA
(`/os?settings=billing&upgrade=<tier>`), `EZIL_ID_SIGN_IN_URL`
(`/auth/auth0/login?returnUrl=/os`), and the e2e scripts (`/computers`,
`/os`, `/os?settings=billing&upgrade=pro`). Every one is a case-3 page. Not
auditable from here: the `next` that Supabase's hosted email templates put
on `/auth/confirm` links. An absent `next` lands on `/os`.

### After sign-in: what each return opens (review, 2026-10-30)

Sign-in returns to the exact path and query: `/app/code?…` and
`/app/desktop?…` come back as written (`app/src/app/os/page.test.ts`, which
also runs the return through the shell's parser and `routeLaunchContext`).
The return is a full document load, and the boot then opens the linked app
from the URL alone, with no click:

| Return to | The boot opens | What that open does |
|---|---|---|
| `/app/code` | Code, in full view (§3: a route with nothing recorded is `'full'`) | `code.js` `start_boot()` on open → `mintCodePreviewUrl` → `session.cancellableWake` → the server's `ensure()`, which **starts a stopped computer** |
| `/app/desktop`, `/app/browser` | the Browser, no view | `desktop-window.js` `start_boot()` on open → `session.openDesktop` → `cancellableWake` → `ensure()`: **starts or wakes the computer** |
| `/app/preview` | Preview (shell-local, so it resolves on the web) | `preview.js` `start_boot()` → `session.previewUrl` → `cancellableWake` → `ensure()`: **starts the computer** |
| `/app/settings`, `/app/app-store` | that window | nothing on the computer (Settings → Billing only reads) |
| `/app/secure-browser` (web) | nothing (native-only) | nothing |
| `/os` | nothing (login opens nothing, W3) | nothing |

**Finding: yes, a return path starts a computer without a click.** Every
page load at `/app/code`, `/app/desktop`/`/app/browser` or `/app/preview`
starts a stopped computer: a sign-in return, a reload, a bookmark, a
restored tab, and Back/Forward to the entry of a window that is no longer
open (§5 launches it). Not changed here, because it is not a clear bug:

- It is the behaviour `/os?app=<id>` already had at base (`boot.js` launched
  the linked app on boot), and §1/§3 make `/app/<id>` that same link.
- What is new is how often the address bar carries such a link: the shell
  now writes `/app/<id>` for the app in front, where base left `/os` in
  place. A reload of an ordinary session used to open nothing; now it
  reopens the front app and, for Code, the Browser and Preview, starts the
  computer.
- Settings → Stop closes every window on the computer first, so this tab's
  own address bar falls back to `/os` (or the app still in front). Earlier
  entries keep their `/app/desktop` URLs, so Back to one relaunches the
  Browser. `session.holdAfterStop` blocks only hover warms; any window open
  releases it, a route launch included.
- Contrast for the owner: since lane A2, Code's return-from-away check no
  longer starts a stopped computer (docs/APP-CODE-FULL-VIEW.md §4), but
  reloading `/app/code` after an idle stop, or a stop from another device,
  does.
- A shell rebuild (`ensure_intact`) never relaunches from the URL
  (`appLinkHandled`), and Billing's deep link never touches the computer.

Owner decision (not taken here): keep it, or have a page load that starts
at a compute app ask before starting a stopped computer.

## 7. Known gaps and hand-offs

Closed at integration (branch `feat/os-app-code-20261030`, 2026-10-30):

- Billing's AI-credits deep link works on the path form:
  `shell/ezil/ui/Settings/tabs/billing.js` reads the query through
  `settingsAliasSearch`, so `/app/settings?tab=billing&section=ai-credits`
  opens the card exactly as `/os?settings=billing&section=ai-credits` does
  (`billing-test.mjs`). Billing reads the boot URL: Settings calls
  `onActivate` before its window resolves, and the route's history write
  comes after that.
- The stale "`/os` is one URL" comments in `shell/ezil/ui/app-drawer.js` and
  `shell/ezil/ui/Settings/index.js` are corrected.
- `appearance-browser-test.mjs`'s fixture serves `/app/<id>`, which its
  reload now requests.
- CI runs `app-history-test.mjs` and `full-view-test.mjs` (the "Shell unit
  suites" list in `.github/workflows/ci.yml`).

Still open:

- In-app links `href="/os?settings=billing…"` (`Settings/tabs/computers.js`
  545, 602, 711; `Settings/tabs/usage.js` 39) and `/os` links in
  `app/src/app/billing/return/*`, `app/src/app/computers/_components/select-computers.tsx`
  still work through the alias, as full document loads.
- Settings does not report tab changes, so a URL's `tab` reflects the tab it
  was opened at.
- A page load at a compute app's URL starts a stopped computer with no
  click (§6, "After sign-in"). Owner decision.
- Launch order (§5, "Order"): a superseded launch's window that is built
  more than about 120ms after the newer launch opened still takes the front
  (UIWindow's own focus) without the address bar, and a reopen that
  coalesces with a closed window's launch names an app with no window.
- The committed bundle (`app/public/os/`) does not match the sources
  (`shell/build-shell.sh --check` fails), so CI's shell job stops at
  "Committed bundle matches source". Regenerating it is a separate step.

## 8. Visual choices

None. This lane changes no pixels.

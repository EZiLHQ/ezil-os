# Puter provenance — what came from where

This is the **authoritative, file-by-file index** of the Puter-derived code in
EZiL-OS. `../ATTRIBUTIONS.md` §1 and `../NOTICE` summarise; this file is the
record. Where they disagree, this file is correct.

- **Upstream:** Puter — https://github.com/HeyPuter/puter
- **Upstream licence:** AGPL-3.0-only
- **This repository's licence:** AGPL-3.0-only (`../LICENSE`)

There is no licence conflict and no relicensing. EZiL-OS is already
AGPL-3.0-only, so the fork simply stays AGPL-3.0-only.

---

## What the obligation actually is

AGPL-3.0 §5(a) requires that modified files carry **prominent notices stating
that you changed them, and the date** of any change. That is the whole
obligation, and this file plus `../NOTICE` discharge it. The licence does not
ask us to avoid modifying Puter — **this is a fork, not a dependency, and
Puter's internals are modified freely.** What it asks is that we *say so*,
which is what the table below is for.

## The trademark position — a requirement, not a preference

Puter's `TRADEMARK.md` (v1.0, 2025-01-01) is explicit that the open-source
copyright licence **"does not include a licence to use our trademark."** The
copyright grant and the trademark grant are separate, and only the first one
was given.

For a modified distribution — which EZiL-OS is — that document requires the
distributor to:

- **remove all Puter logos** from the modified software;
- **clearly indicate that the software has been modified**;
- include the notice *"This software is a modified version of Puter software
  and is not endorsed by Puter Technologies Inc."*

It also forbids using the marks, or variations of them, as part of a product
name, company name or domain — `MyPuter` and `PuterFooBar` are given as
examples of what is too close.

**Consequently, removing the Puter name and marks from ported code is a legal
requirement of this fork, not a branding preference.** Every port must strip
Puter logos, favicons, wordmarks, `puter.com` URLs and product-name strings
from anything user-visible, and must not reintroduce them. The word mark may
appear in attribution and provenance prose — this file, `../ATTRIBUTIONS.md`,
`../NOTICE` — because accurately describing origin is a use the policy
permits. It may not appear in shipped UI, asset names, or branding.

Puter is a trademark of Puter Technologies Inc. EZiL-OS is not affiliated
with, sponsored by, or endorsed by Puter Technologies Inc.

## What is deliberately NOT ported

Puter's GUI is written against a cloud backend that does not exist here. The
EZiL shell runs in the browser and talks only to EZiL's own Worker and
container. So the following are removed rather than reimplemented, and any
port that still references them is unfinished:

| Upstream | Disposition |
|---|---|
| `puter.kv` (~40 call sites) | Replaced by browser `localStorage` — `ezil/session.js` |
| `puter.fs` (~71 call sites) | Removed |
| `puter.apps`, `puter.auth` | Removed |
| socket.io realtime | Removed |
| `src/gui/src/services/*` | Removed |
| `src/gui/src/IPC.js` | Removed |
| `src/backend/**` (~165k lines) | Removed |
| `src/gui/src/IPC.js` (2,016) | Removed — the app-to-shell postMessage bus |
| `src/gui/src/initgui.js` (2,322) | Removed — boots against auth + the cloud; `ezil/boot.js` replaces it |
| `src/gui/src/helpers/launch_app.js` (805) | Removed — `puter.apps` + IPC. Stubbed to a rejection |
| `src/gui/src/UI/UIItem.js` (1,911) | Removed — a filesystem entry icon |
| `src/gui/src/UI/Dashboard/Tab*` (7,000+) | Removed |
| `src/gui/src/UI/Dashboard/UIDashboard.js` (789) | Not ported verbatim — never copied into `src/`. Its tab-shell SHAPE (sidebar-of-tabs, the active-tab click handler, the one-`UIWindow`-many-tab-objects structure) was read from the reference clone and re-implemented fresh as `ezil/ui/Settings/index.js`. No upstream bytes exist in that file; see "Structurally adapted" below for what that means in practice. |
| `src/gui/src/globals.js` (285) | Replaced by `src/ezil-globals.js`, not ported |
| `src/gui/src/helpers.js` (3,623) | Not ported; only `uuidv4` (4 lines) cherry-picked |
| `src/gui/src/UI/UIWindow*.js` dialogs (~30 files) | Removed — login, signup, 2FA, publish, settings, task manager, feedback, QR, … all cloud-backed |
| `src/gui/src/i18n/translations/*` except `en.js` (~40 locales) | Removed |
| vendored libs: viselect, socket.io, qrcode, iro, fflate, FileSaver, timeago, jquery.dragster | Not ported. The first seven are unused; `dragster` **is** used by UIWindow, and is reimplemented in `src/lib/ezil-dragster.js` rather than vendored |
| Puter's webpack build | Not used — see `build-shell.sh` (esbuild + `cat`) |
| Puter logos, favicons, wordmarks, `puter.com` URLs | Removed — a trademark requirement, see above. 21 of upstream's 143 icons are ported; none is branding |

---

## Index

Layout: `src/` is the Puter-derived tree — **it is the only place in this
repository where Puter-derived code may live.** `ezil/` is EZiL-authored.

### Taken verbatim

Byte-identical to upstream. Still AGPL-3.0-only; still Puter's copyright.

All rows below were verified by `md5sum` or by a full `diff` against the
reference clone at the time of taking, not by eye.

| EZiL path | LOC | Upstream path | Upstream commit | Date taken |
|---|---|---|---|---|
| `src/UI/UIContextMenu.js` | 857 | `src/gui/src/UI/UIContextMenu.js` | `5a15719` | 2026-07-31 |
| `src/UI/UIPopover.js` | 134 | `src/gui/src/UI/UIPopover.js` | `5a15719` | 2026-07-31 |
| `src/helpers/update_mouse_position.js` | 101 | `src/gui/src/helpers/update_mouse_position.js` | `5a15719` | 2026-07-31 |
| `src/lib/path.js` | 508 | `src/gui/src/lib/path.js` | `5a15719` | 2026-07-31 |
| `src/lib/html-entities.js` | minified | `src/gui/src/lib/html-entities.js` | `5a15719` | 2026-07-31 |
| `src/lib/isMobile.min.js` | minified | `src/gui/src/lib/isMobile.min.js` | `5a15719` | 2026-07-31 |
| `src/lib/jquery-3.6.1/jquery-3.6.1.min.js` | minified | same path | `5a15719` | 2026-07-31 |
| `src/lib/jquery-ui-1.13.2/jquery-ui.min.js` | minified | same path | `5a15719` | 2026-07-31 |
| `src/lib/jquery-ui-1.13.2/jquery-ui.min.css` | minified | same path | `5a15719` | 2026-07-31 |
| `src/lib/jquery-ui-1.13.2/LICENSE.txt` | 43 | same path | `5a15719` | 2026-07-31 |
| `src/css/normalize.css` | 367 | `src/gui/src/css/normalize.css` | `5a15719` | 2026-07-31 |
| `src/icons/*.svg` (21 files) | — | `src/gui/src/icons/` | `5a15719` | 2026-07-31 |

`src/icons/` holds only the 21 icons the ported chrome actually references,
out of upstream's 143. None carries Puter branding — the logo and favicon
assets are deliberately absent, as the trademark position above requires.
`jquery-3.6.1` and `jquery-ui-1.13.2` are MIT-licensed third-party libraries
that Puter itself vendors; they are not Puter's code, and jQuery UI keeps its
`LICENSE.txt` alongside it. `lib/path.js` carries its own Joyent/Node MIT
notice in-file. `html-entities.js` and `isMobile.min.js` are pre-minified
third-party bundles, so a line count is not meaningful.

### Taken and modified

🔴 Modified by EZiL. Each row states what changed and when — this is the
AGPL §5(a) record.

| EZiL path | LOC | Upstream path | Upstream commit | Date | What changed |
|---|---|---|---|---|---|
| `src/UI/UIWindow.js` | 5281 | `src/gui/src/UI/UIWindow.js` (5265) | `5a15719` | 2026-07-31 (import block); 2026-08-02, 2026-08-03 (see below) | **Import block, plus three small, individually tagged body edits — no longer "nothing else touched", see the note below for why.** Nine imports (login/save-account/email-confirmation dialogs, publish-website, item-properties, `new_context_menu_item`, `refresh_item_container`, `launch_app`, `item_icon`) plus the `puter` SDK resolve to `src/ezil-stubs.js`. 2026-08-02: removed one `window.hide_toolbar()` call (see the `MODIFIED BY EZIL` comment in-file; not previously recorded here). 2026-08-03: added one import (`telemetry.js`) and two `telemetry.capture()` calls, each one line beside a pre-existing `console.error` it does not replace — see `ezil/telemetry.js`'s header and this file's own `MODIFIED BY EZIL` comments at each site. |
| `src/UI/UITaskbar.js` | 469 | `src/gui/src/UI/UITaskbar.js` (763) | `5a15719` | 2026-07-31 | Removed the `GET /get-launch-apps` XHR and the entire Start-button launcher popover it fed (~180 lines, backed by `puter.apps`, including an "Add to Desktop" that wrote through `puter.fs.upload`); removed the Explorer item, the `window.user.taskbar_items` loop, the Trash item, its `puter.fs.stat` probe and the socket.io `trash.is_empty` emit, and the two separators that bracketed Trash. `puter.kv` → `ezil/session.js`. `window.update_taskbar` reimplemented locally. Start now dispatches an `ezil:start-click` event. Geometry, sorting and resize logic are upstream's, unchanged. |
| `src/UI/UITaskbarItem.js` | 536 | `src/gui/src/UI/UITaskbarItem.js` (527) | `5a15719` | 2026-07-31 | **Import block only** — verified identical from `let tray_item_id` to EOF (504 lines). `launch_app` → stub. |
| `src/UI/UIAlert.js` | 179 | `src/gui/src/UI/UIAlert.js` (172) | `5a15719` | 2026-07-31 | **One added import** — verified identical from `function UIAlert` to EOF. It was expected to be verbatim but has a single `puter.ui.closeDialog()` call, which now resolves to the stub. |
| `src/UI/UIComponentWindow.js` | 61 | `src/gui/src/UI/UIComponentWindow.js` (47) | `5a15719` | 2026-07-31 | Dropped the `options.component` path. It imported `JustHTML`, which is `def(class extends Component)` and drags in `util/Component.js` plus the global `def()`/`use()` class registry from `init_sync.js` — the service-script/extension machinery this fork does not ship. `options.html` is passed straight to `body_content`; `options.component` now throws. |
| `src/UI/UIDesktopFullpage.js` | 99 | `src/gui/src/UI/UIDesktop.js` ~L2405-2450 (of 2479) | `5a15719` | 2026-07-31 | Extraction of exactly three functions: `enter_fullpage_mode`, `exit_fullpage_mode`, `reset_window_size_and_position`. UIWindow calls all three by name, so they are a required seam. Inside them, `refresh_item_container()` and `refresh_desktop_background()` are dropped rather than stubbed — both sit on the restore path, and a rejecting stub there would strand a window in fullpage mode. The other ~2,430 lines of UIDesktop.js are not ported. |
| `src/i18n/i18n.js` | 96 | `src/gui/src/i18n/i18n.js` (88) | `5a15719` | 2026-07-31 | Replaced the ~40-locale `translations.js` barrel with a single `en` import; repointed the `docs`/`terms`/`privacy` link variables off `puter.com`. Logic unchanged. |
| `src/i18n/translations/en.js` | 694 | `src/gui/src/i18n/translations/en.js` (688) | `5a15719` | 2026-07-31 | Every user-visible occurrence of the Puter word mark and `puter.com`/`support@puter.com` replaced with EZiL equivalents (17 strings). Dictionary **keys** are untouched — they are lookup identifiers, never rendered, and UIWindow's 73 `i18n()` call sites depend on them. |
| `src/css/style.css` | 2108 | `src/gui/src/css/style.css` (6535) | `5a15719` | 2026-07-31 | Rule-level subset. Kept the window / taskbar / context-menu / popover / tooltip / snap / desktop chrome; dropped Settings, session manager, usage tables, auth dialogs, publish dialogs, the launcher popover, the background picker, the toolbar buttons, and every dialog class whose JS is not ported. Rules copied whole and brace-balanced; a commented-out `--puter-window-background` reference removed. |
| `src/css/dashboard.css` | 275 | `src/gui/src/css/dashboard.css` (4809) | `5a15719` | 2026-07-31 | The `.dashboard-app-drawer*` rules only. UIWindow renders that chrome in dashboard mode. The rest is the Dashboard tabs, backed by `puter.fs`/`puter.apps`. |
| `src/helpers/uuidv4.js` | 46 | `src/gui/src/helpers.js` L220-223 (of 3623) | `5a15719` | 2026-07-31 | Extraction of `window.uuidv4` into its own file. Body unchanged. This is the **only** thing cherry-picked from helpers.js. |

#### UIWindow.js was taken whole — and that was verified, not assumed

`UI/UIWindow.js` is 5,265 lines with no upstream test. Its 25 `is_dir` branches
and 73 `i18n()` calls interleave through drag, resize, snap and z-order, and the
cut lines are **not contiguous**. A too-aggressive cut yields windows that drag
but do not snap, or minimise but never restore, and nothing upstream would
catch it.

So it was not pruned. The verification was mechanical and repeatable at the
2026-07-31 import-block-only snapshot:

```
a=$(grep -n '^const el_body' <upstream>/UI/UIWindow.js | cut -d: -f1)   # 35
b=$(grep -n '^const el_body' shell/src/UI/UIWindow.js  | cut -d: -f1)   # 51
diff <(tail -n +$a <upstream>/UI/UIWindow.js) <(tail -n +$b shell/src/UI/UIWindow.js)
```

That diff was empty at that snapshot: 5,231 lines byte-identical, the only
difference being the header comment and the import block above `const el_body`.

🔴 It is **no longer** empty, and that is expected, not a regression to chase:
two small body edits landed after 2026-07-31 (see the table row above), each
one individually tagged `MODIFIED BY EZIL` in-file and each one line — a
removed `hide_toolbar()` call, and two one-line `telemetry.capture()` additions
beside pre-existing `console.error` calls they do not replace. None of the
25 `is_dir` branches or 73 `i18n()` calls this section exists to protect were
touched. Re-running the diff above today will show exactly those three hunks
and nothing else — that is the bar this note now holds itself to, not a
byte-for-byte match.

Pruning the unreachable branches happens later, in an isolated commit, once
the shell demonstrably works. Bundle size is not the constraint today; a
subtly broken window manager is.

### Structurally adapted (no upstream bytes copied)

Distinct from both tables above: nothing in the file below is upstream text,
byte-identical or otherwise — it contains no Puter copyright header and
carries none of Puter's AGPL notices, because none of Puter's copyrighted
expression is IN it. What was taken is the STRUCTURE, from reading the
reference clone, not from copying it. Listed here anyway, in the interest of
over-disclosure rather than under-disclosure: a reviewer comparing this
shell's tab UI to Puter's Dashboard should be able to find out why they look
related without having to ask.

| EZiL path | LOC | Read from (not copied from) | Upstream commit | Date | What the shape is |
|---|---|---|---|---|---|
| `ezil/ui/Settings/index.js` | ~190 | `src/gui/src/UI/Dashboard/UIDashboard.js` (789) | `5a15719` | 2026-08-01 | The sidebar-of-tabs markup shape, the click handler that swaps the sidebar's `.active` item and the matching content pane while calling the tab's `onActivate`, and the "one `UIWindow`, N tab objects (`{id,label,icon,html(),init(),onActivate()}`)" structure. Everything else upstream's 789 lines do — all 6 built-in tabs, hash routing, the entire socket.io block, the user-options/logged-in-users menu, `is_fullpage`/headless chrome — is NOT reproduced; see the file's own header for the line-by-line accounting and `../ATTRIBUTIONS.md`. Read from a read-only reference clone kept outside this repository (see "Reference clone used while porting" below), never copied from it. |

`ezil/ui/Settings/tabs/*.js`, `trpc.js` and `settings.css` are pure "written
fresh" by the definition below (no upstream reading, no upstream shape) and
are not individually rowed here for the same reason `apps/registry.js`,
`apps/desktop-window.js` and `ui/app-drawer.js` are not: `ezil/` is understood
wholesale as EZiL-authored, and this table exists to resolve ambiguity, not
to catalogue every file under it.

### Written fresh

EZiL-authored. No Puter code. Listed here only because some of it sits inside
`src/` so that CSS cascade order works, and it would otherwise be mistaken for
upstream.

| Path | LOC | Purpose |
|---|---|---|
| `src/ezil-stubs.js` | 155 | **The seam that makes the whole-file UIWindow port safe.** Every removed backend call resolves here, and every stub REJECTS or THROWS naming the path it blocked — none returns a plausible empty value, because a stub that quietly returns `{}` produces a shell that half-works and looks fine. `puter` is a recursive `Proxy`, so any property path is legal and calling any of them rejects; no guess had to be made about the shape of an SDK being deleted. Also the standing inventory of what a later prune pass must cut. |
| `src/ezil-globals.js` | 173 | Replaces upstream `src/gui/src/globals.js` (285 lines), over half of which is Puter's session, cloud-derived filesystem paths and a telemetry `Transaction` class. Holds only what the ported code reads: layout, z-order, mouse/snap state. The filesystem path constants are **sentinels that can never match** — leaving them `undefined` would make upstream's `options.path === window.home_path` comparisons come out *true*. |
| `src/lib/ezil-dragster.js` | 82 | Reimplements `$.fn.dragster` (drag enter/leave depth counting) in EZiL code. `jquery.dragster.js` is on the do-not-take list, but `UIWindow.js` calls `$(el).dragster()` on **every** window it creates, so without it `UIWindow()` appended the window to the DOM and then threw. A no-op stub was not sufficient: one of the three call sites is real chrome (drag-hover 1.4s over a background window to raise it). |
| `src/lib/ezil-jquery.js` | 21 | Publishes `$`/`jQuery` as globals. Upstream loads jQuery as a classic `<script>`; esbuild takes its UMD `module.exports` branch, which puts jQuery in `noGlobal` mode. Separate from `ezil-vendor.js` because ES imports hoist above module bodies and jQuery UI reads the bare global at evaluation time. |
| `src/lib/ezil-vendor.js` | 28 | The bundled equivalent of upstream's `static-assets.js` `lib_paths`, in the same relative order. Load order is load-bearing. |
| `src/css/ezil-tokens.css` | 61 | Overrides the `:root` design-token block in upstream `src/gui/src/css/style.css` (~L86-116) from which the whole chrome derives. Lives under `src/` so the build concatenates it *after* upstream's sheets. |
| `ezil/boot.js` | 116 | Bundle entry point. Documents the load-bearing import order and the requirement that the bundle be loaded deferred (UIWindow.js reads `document.body` at module scope). |
| `ezil/session.js` | 55 | localStorage replacement for `puter.kv`. |
| `build-shell.sh` | — | Bundles `src/` + `ezil/` to `app/public/os/`. Its CSS cascade order is explicit, not sorted: upstream's `style.css` deliberately overrides jQuery UI's `.ui-resizable-*` rules, so alphabetical order inverts the cascade. |
| `load-test.mjs` | — | Headless jsdom load of the **built** bundle: boots the shell, constructs a real window, taskbar and context menu, and asserts every `puter.*` stub rejects. Found three defects a green build and `node --check` both passed. |
| `package.json` | — | Exists only so `load-test.mjs` has somewhere to declare jsdom. Not a dependency of `app/` or `worker/`. |
| `ezil/ui/Settings/drawer-action.js` | 155 | Puts a Settings button in the full-bleed window's control drawer. **Reproduces no upstream code** — it builds one `<button>` with the class names `ui/app-drawer.js` already uses (`dashboard-app-drawer-btn`), because `src/css/dashboard.css` is the ported extract that styles exactly those selectors. See the "one exception" note below. |
| `ezil/ui/Settings/settings-test.mjs` | — | End-to-end jsdom harness for the **built** bundle: opens the desktop window, drives Settings the way a person does, and asserts ORDERING (delete closes the container window before `computer.delete` goes out). Found that guarantee silently not firing; mutation-tested in both directions. Sibling of `load-test.mjs`, kept next to the feature it covers. |
| `ezil/ui/Settings/computers-drift.test.{tsx,vitest.config.ts}` | — | Renders the `/computers` page — the escape hatch when the shell fails to boot — with `react-dom/server`, so a later "the OS took over, delete this page" cleanup fails a test instead of stranding a user at the 2-computer cap. Runs against `app/`'s module graph from outside it; see the config's header. |
| `ezil/ui/Settings/{server-only,next-navigation}.stub.ts` | — | Two tiny module stubs the drift test aliases in. Not shipped: nothing under `ezil/ui/Settings/*.stub.ts` is reachable from `ezil/boot.js`, so esbuild never sees them. |

#### 🔴 The one place EZiL code styles a Puter-derived selector from outside `src/`

`ezil/ui/Settings/settings.css` ends with a rule on
`.dashboard-app-drawer.ezil-has-settings-action`. Every other rule in that file
is `ezil-settings-*`-prefixed, on purpose. This one is not, and the reason is
recorded here rather than only in the CSS: `src/css/dashboard.css:52`
(Puter-derived) derives the drawer's open width from a `calc()` written for
exactly two buttons, and the tray clips its overflow. EZiL adds a third button,
so the total has to be redefined. It is redefined **on a marker class**, so a
drawer without EZiL's button keeps upstream's geometry byte-for-byte, and the
TOTAL is redefined rather than any of its parts, so upstream's
`(pointer: coarse)` and `(max-width: 500px)` overrides of `--btn` / `--title-w`
/ `--t2b` still flow through unchanged. `dashboard.css` itself is untouched.

---

## Keeping this file honest

- A port is not finished until its row is in the table above.
- `build-shell.sh --check` guards the *build output* against drift. **Nothing
  automatically guards this table** — it is maintained by hand, and reviewing
  it is part of reviewing any change under `shell/src/`.
- Record the upstream commit, not just the path. "Taken from Puter" is not a
  provenance record; "taken from `<path>` at `<sha>`" is.
- `load-test.mjs` guards the *behaviour* of what was ported, including that no
  Puter mark reaches the rendered DOM and that no `puter.com` URL survives in
  the shipped bundle. It does not guard this table either.
- Reference clone used while porting: a read-only checkout of upstream kept
  outside this repository. It is never modified and never committed here. At
  the time this index was created it was at upstream commit
  `5a157197b6ea166d5c5c04cc1d2816bcf9cc05f9` ("fix: PUT-1398 (#3478)"), which
  is the baseline the first ported files should be recorded against unless
  they say otherwise.

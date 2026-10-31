# Code full view, its strip, and the stopped/reconnecting state

App-code lane A2, 2026-10-30; the strip reshaped by gate G3, 2026-10-31.
Source: `shell/ezil/apps/code.js`, `shell/ezil/ui/full-view.js`,
`shell/ezil/ui/ezil-shell.css`, `shell/ezil/ui/feedback/feedback.{js,css}`.

> **Every visual value in this document is PROVISIONAL.** G3 worked from the
> coordinator's description of the founder's reference screenshots ("a centred
> compact pill/grab notch in a dark full-view strip; a tiny circular outlined
> speech-bubble Feedback icon flush top-right; no oversized pill overlapping
> the editor"). The reference pixels themselves were not readable, so every
> dimension below is a choice, judged only from rendered screenshots, and is to
> be refined after a pixel review against the references.

## 1. Behaviour

| Trigger | Result |
|---|---|
| Launch with `ctx.view === 'full'` (the `/app/code` route, including a canonicalised `/os?app=code`) | Opens in full view. Not announced, not remembered. |
| Launch with `ctx.view === 'window'` | Opens windowed at 980×680. |
| Launch with no view (dock, Start menu, launcher) | Windowed at 980×680, unless the user's last explicit choice in this tab was full (`sessionStorage['ezil-os:view.code'] === 'full'`). |
| Green button, head double-click, head context menu "Maximize" (all reach `scale_window` → `el._ezil_maximise`) | Toggles full view ↔ window. Remembered. Announced. |
| Tray **Restore window**, double-click on the strip | Back to the window at the bounds it had before full view. Remembered. Announced. |
| Tray **Show desktop** | Minimises. The taskbar comes back first. Coming back from the taskbar re-enters full view if the window still wants it; otherwise it restores the windowed bounds. The head's minimise button and context menu are reachable only while windowed and keep upstream's `hideWindow()`. Code installs no `_ezil_minimise` hook (`seam-minimise-browser-test` pins a single provider). |
| Tray **Close** | Closes the window (the taskbar comes back). |
| `el._ezil_relaunch(ctx)` (the registry calls it on an existing single-instance window after `showWindow()`, contract item 4) | Reads only `ctx.view`, and only `'full'` / `'window'`; every other key and value is ignored. Not remembered. Announced when the view changes. |
| `el._ezil_set_title(text)` | Sets the title in the head and the tray as text (`textContent`). An empty value falls back to the app name. A later lane passes the project/repo name. |
| `el._ezil_view()` (read only; the router, `app-history.js`, calls it whenever it writes this window's history entry, docs/APP-ROUTES.md §5 "State") | Returns the view now: `'full'` while the window wants full view, minimised from it included (it re-enters full view when shown, though the `ezil-fullbleed` class is off while hidden); otherwise `'window'`, always `'window'` when full view is forbidden. Read from the full-view state, not from the last announced value. Changes nothing. |

- **Remembered** means that `sessionStorage['ezil-os:view.code']` is set to `'full'` or `'window'`. Only gestures write it. Route launches and relaunches never write it. Storage failures are ignored, and the choice still applies to the open window.
- **Announced** means that `window.dispatchEvent(new CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view } }))` fires. It fires only when the view actually changes. The open itself is never announced. The router launches the app and then pushes its own history entry, so an event fired during the launch would be recorded on the entry being left. The Code window never calls a history API.
- There is no automatic browser Fullscreen API call. Full view is a layout mode inside the page.
- If the control drawer fails to attach, full view is forbidden. The window stays windowed and keeps upstream's maximise (no hook is installed), because full view hides the taskbar and the head.

## 2. The shared mechanism (`shell/ezil/ui/full-view.js`)

`createFullView(el_window)` is the Browser's former `go_fullbleed` /
`minimise_to_taskbar`, made shareable:

- **`enter()`** first completes any jQuery animation still running on the window (`finish()`). It then adds `ezil-fullbleed`, calls `enter_fullpage_mode` (which hides the taskbar and the head, sizes the window at 100%, and stashes the previous bounds), writes `data-is_fullpage="1"`, calls `focusWindow()` and flashes the drawer.
- **`exit()`** clears the desire, gives the chrome back and restores the stashed bounds. This is new for Code. The Browser never calls it.
- **`minimise()`** gives the chrome back and then calls `hideWindow()`. It is chrome-only, and the geometry stays full while the window is hidden.
- **`settle()`** handles a window that was minimised from full view and is now restored without wanting full view. It goes back to its stashed bounds.
- **`watch_restore(fn)`** calls `fn` on every restore from the taskbar.
- **`forbid()`** means there is no exit, so there is no entry.
- **Two windows in full view.** Leaving full view gives the taskbar back only when no other visible window is still in full view. Otherwise only that window's head comes back.
- **`prepare_close()`** is called from both windows' `on_before_exit`, which `$.fn.close` awaits before its own full-page exit. It applies the same rule to closing. When another window is still in full view, it drops this window's `data-is_fullpage`, so `$.fn.close` does not put the taskbar over that window. When there is no other full window it does nothing.

**Full view fills the viewport, on every entry path (2026-10-30).** Until
this date, Code opened from `/app/code` got the class and the top bar (since
G3, the strip) but kept its windowed size:
`left: 0px; top: 0px; width: 980px; height: 680px`. This
was measured on real Next and in Chromium. Two writes put the windowed box
back:

- **UIWindow's opening animation.** UIWindow shows every new window with
  `$(el).show(0, cb)`. jQuery runs any numeric speed, 0 included, as a "show"
  animation. It captures the inline width and height the window was built
  with and writes them back when it completes. On a real load the dock's items
  are still in their 50ms jQuery entrance, so the completion lands on a later
  fx tick, about 7ms after `code.js` has entered full view (Chromium trace:
  `enter_fullpage_mode` 100% at t=244, `f.fx.tick` 980px/680px at t=251). This
  hit every new window that opens straight into full view: a first load, a
  reload, Back/Forward to a closed Code, and a dock launch with full
  remembered. `enter()`'s `finish()` completes that animation before the
  geometry is written.
- **`$.fn.showWindow` on a visible window** (`UIWindow.js`). The registry calls
  `showWindow()` on an already-open single-instance window (a dock click,
  Back/Forward onto an open app). It wrote the box that `hideWindow`, a drag or
  a resize had last left in `data-orig-*`, so a full Code shrank to where it
  was last minimised (230,135 980x680), or to an old viewport's pixels after a
  resize. It now restores that box only to a window that is minimised. This
  also fixes the Browser's full-bleed on the same path. Measured: a Browser
  that had been minimised and restored, then relaunched after a resize to
  1200x760, stayed 1440x900; it now fills 1200x760, and os-chrome checks this
  at both viewport sizes. A windowed window keeps
  its box: before, Back onto a windowed Code that had been minimised from full
  view put it at 0,0 with the old viewport's size.

The browser suites now assert geometry, not only the class:
`os-chrome-browser-test`, `window-chrome-browser-test` GROUP 6 and
`app-link-browser-test`, plus `full-view-test` in jsdom. Each check asserts
that:

- the window rect equals the viewport;
- the body runs from the strip to the bottom edge;
- the window is opaque;
- the window is the element at the centre and at both bottom corners;
- all of this still holds two frames later, after nothing is moving the window.

Each is paired with a windowed positive control: the 980x680 box, and a
Restore to the stash. The two portable suites (`app-link-browser-test` and
`os-chrome-browser-test`, which also run on macOS) compare to within 1px.
`window-chrome-browser-test` (Linux only) compares exactly.

`ezil-shell.css` keys the shared strip, drawer, body offset and resize-handle
rules on `.ezil-full-view-host`, which `createFullView` adds. The Browser's rules
were previously keyed on `.ezil-desktop-window`. Specificity and source
position are the same, and the Browser's computed full-bleed geometry was diffed
identical at 1440×900 and 390×844.

## 3. The strip (PROVISIONAL visuals, gate G3)

Until 2026-10-31 a 43px top bar carried the drawer's tongue at the left, a
centred title and its own Minimise / Restore window / Close buttons. Gate G3
replaced it with the Browser's pattern: one centred notch in a lower strip,
everything else in the notch's tray.

**What is on screen.** While the drawer is shut, the strip holds exactly two
things: the drawer's grab notch, centred, and the Feedback icon, flush right.
The title and the window actions live in the notch's expanded tray, which is a
transient menu and may cover the editor's top rows while it is open.

| Element | Value (PROVISIONAL) | Notes |
|---|---|---|
| Strip height | `--ezil-control-strip-height` on `.ezil-code-window.ezil-fullbleed`: **28px** fine, **44px** `pointer: coarse` | Lower than the Browser's 43px / 59px, which is unchanged. 28px fits the 16px notch and the icon's 20px disc with 4px to spare; 44px keeps 44px targets. The shared body offset reads the same property, so the editor starts at the strip's bottom. |
| Strip background | The window's own `#11151f` (shared full-view rule), bottom hairline `1px rgba(255,255,255,0.08)` | The same dark strip in both themes, matching the dark editor. |
| `.ezil-full-view-bar` | Empty, `aria-hidden="true"`, no role | The strip itself. It keeps the head's double-click (back to a window) and press-to-activate. Nothing in it is focusable. |
| Notch (shut) | dashboard.css's tongue, **56×16** fine, **68×20** coarse, its 1px border inside (Code's drawer states `box-sizing: border-box`). Centred horizontally (`left: 50%`, `translateX(-50%)`, as the Browser's) and vertically by the shared `top: (strip − shut-h) / 2` | The Next pages' global preflight already makes the drawer border-box. Measured on real Next, the first cut's content-box `− 1px` correction left the notch 1px high there (56×16 at y=5). Stating border-box makes a page without that preflight, such as the test fixtures, lay it out the same. The Browser's drawer is untouched: content-box (58×18) in the fixtures, border-box on Next. |
| Notch hit area | The toggle's `::after` runs from the strip's top edge to its bottom edge (28px fine, 44px coarse), 14px / 16px wider than the notch on each side | It never extends below the strip, so it never takes a click meant for the editor. Measured on real Next: 28 / 44 rows at the notch's centre, and the window body 1px below. |
| Tray (open) | dashboard.css's tray: icon, title (12px / 500), **Show desktop**, **Restore window**, **Close**; 288×42 at 1440 | Opens on hover (mouse), tap, or keyboard focus; covers the editor's top 14px while open. At ≤500px wide dashboard.css hides the title, as in the Browser. |
| Feedback icon | `feedback.css`: a 24px button (44px coarse), `right: 6px` (0 coarse), its `top` derived from the strip: `calc((strip − 24px) / 2)`, `calc((strip − 44px) / 2)` coarse | 2px / 0px in Code's strip; 9.5px / 7.5px in the Browser's, as before. |
| Feedback look in Code's strip | Outlined: the 20px disc becomes a 1px `currentColor` ring with no glass and no shadow; the same stroked speech-bubble glyph at 12px (4px padding); opacity 0.62 (1 on hover/focus); focus ring 2px, 1px out (inside the 28px strip) | Code's strip declares `--ezil-feedback-look: outline`. Everywhere else (a windowed app, the Browser's full-bleed) the icon keeps its glass disc. |
| Focus | Tray toggle and actions: dashboard.css's `2px solid rgba(255,255,255,0.9)` ring, 1px out. Feedback: the accent ring | Keyboard focus on the toggle opens the tray; its ring is drawn around the tray's dismiss strip. |
| Tab order | Editor → Send feedback → tray toggle → Show desktop → Restore window → Close | DOM order: the Feedback icon is a body child placed before the window's tray toggle, not the body's last button. Measured from a fresh 1440×900 fixture page: IFRAME, BODY, Send feedback, Window controls, Show desktop, Restore window, Close. |

**Show desktop is the one minimise.** The old bar's "Minimise" and the tray's
"Show desktop" both called `full_view.minimise()`. The tray keeps one button,
labelled "Show desktop" as it was. If the founder wants the label the Browser
uses ("Minimise"), that is a one-word change in `code.js`.

**How the icon follows the strip.** The icon is one fixed, body-level button
shared by every window. On every window mutation (and when the
`pointer: coarse` query changes) `mount_feedback_chip`'s sync takes the front
full view (the rendered `.ezil-fullbleed` window with the highest z-index, the
later one on a tie) and copies its computed `--ezil-control-strip-height` onto
the icon as `--ezil-feedback-strip-h`, and its `--ezil-feedback-look` onto
`data-look`. It writes only when a value changes, so a window mutation that
moves nothing costs the icon no style write. (A same-value write would not
loop: Chromium and jsdom queue no mutation record for an unchanged CSSOM
write, and `data-look` is not an observed attribute. Measured: a mutant that
re-wrote the strip property on every sync left `code-full-view-browser-test`
green, and `feedback-test` too until it counted the calls.) With no full view,
or nothing declared, the CSS
fallbacks are the Browser's strip and the glass disc. So Code full over a
full-bleed Browser puts the icon in Code's strip, and minimising Code puts it
back at the Browser's 9.5px, glass.

**Measured** (Chromium, the built bundle, a fake editor whose first row sits at
the frame's top-left; `x, y, width × height`):

| View | Strip | Notch (shut) | Feedback button / disc | Editor frame |
|---|---|---|---|---|
| 1440×900 fine | 0,0 1440×28 | 692,6 56×16 | 1410,2 24×24 / 1412,4 20×20 | 0,28 1440×872 |
| 900×700 fine | 0,0 900×28 | 422,6 56×16 | 870,2 24×24 / 872,4 20×20 | 0,28 900×672 |
| 390×844 coarse | 0,0 390×44 | 161,12 68×20 | 346,0 44×44 / 358,12 20×20 | 0,44 390×800 |
| 1024×768 coarse | 0,0 1024×44 | 478,12 68×20 | 980,0 44×44 / 992,12 20×20 | 0,44 1024×724 |
| Real local Next, 1440×900 / 390×844 coarse | 1440×28 / 390×44 | 692,6 56×16 / 161,12 68×20 | (no feedback endpoint locally) | 0,28 / 0,44 |
| Browser full-bleed, 1440×900 (unchanged) | 0,0 1440×43 | 691,13.5 58×18 | 1410,9.5 24×24 / 1412,11.5 20×20 | body 0,43 |

The Browser's full-bleed screenshot at 1440×900 is pixel-identical to 83078df5
(0 differing pixels), and so is a windowed Code.

**Tests.** `shell/ezil/apps/code-full-view-browser-test.mjs` (ci.yml's geometry
family, Linux only, because it measures pixels) checks the relationships at
1440×900 and 900×700 fine and 390×844 and 1024×768 coarse, plus 1440×900 again
with the Next pages' border-box preflight on the fixture page:

- the strip is empty;
- the notch is inside it, centred both ways, at most 72px wide;
- the notch's hit area spans the strip, and 1px below it the editor takes the click;
- exactly two buttons answer along the strip;
- the Feedback icon's right edge is within 8px, it is vertically centred, outlined, and clear of the notch and the open tray;
- the editor and its first row start at or below the strip;
- "Reconnecting…" stays below the strip;
- the keyboard path works (Tab to the toggle, Show desktop, Restore window, then Enter);
- the focused green button enters full view again;
- the icon follows the front full view.

It pins the two strip heights only as ranges: fine between 26px and 32px, coarse
at least 44px. `feedback-test` (jsdom) pins the mirroring rules. `os-chrome`
scenario 5, `window-chrome` GROUP 6, `code-test` §7, `app-link-test`,
`app-link-browser-test` and `feedback-browser-test` drive the tray where they
drove the bar.

## 4. "Reconnecting…" / "Computer stopped" (PROVISIONAL visuals and copy)

An OS-level cover (`.ezil-code-state`, `role="status"`, `aria-live="polite"`)
sits over the editor frame and the opening surface (z 5) for the moments when
the shell knows the computer is not there. It exists because code-server's own
"Attempting to reconnect" dialog lives inside the cross-origin iframe, where the
shell can neither see it nor replace it.

| State | When | Copy | Action |
|---|---|---|---|
| `reconnecting` | An `ezil:computer-transition` (restart computer or switch) for this computer, from the event until the server settles it | "Reconnecting…" / "Your computer is restarting or switching configuration. Code reopens here when it is back. Your files are safe." | None. On `done` or `failed`, `start_boot()` re-mints, which is the existing behaviour. If the watch gives up without settling (its ~16 min poll budget), the cover becomes `stopped`. It is never a dead end. |
| `stopped` | The return-from-away check (`runtime-recheck.js`: back after at least 5 minutes away, a live frame, and `desktopRunning === false`) | "Computer stopped" / "Your computer isn't running, so Code can't reach it. Your files are safe." | **Start computer** calls `start_boot()` on an explicit click. While the state is shown, the cheap status probe (`session.desktopRunning`, which never wakes a computer) asks every 10s while the tab is visible. When it answers running, the window re-mints by itself. |

The colours are charcoal `var(--color-charcoal, #161616)` with off-white text.
The title is 15px / 600 and the body is 13px at opacity 0.75. The Start button
uses the accent style of the existing "Try again" button.

- **Start is the existing safe wake.** `start_boot()` runs the window's own mint: `mintCodePreviewUrl` → `session.cancellableWake`, whose server-side `ensure()` starts a stopped computer. "Try again" already uses it, and Stop can cancel it through `session.cancelComputerOpens`. Every exit re-mints the same Code URL through that path and never navigates anywhere else.
- **Behaviour change (Code only; needs owner sign-off).** Before this lane, Code's return-from-away check called `start_boot()` directly. That started a stopped computer, including one its owner had stopped from another tab or device, just because the tab regained focus. Now the Code window re-mints only on an explicit Start, or once the computer is already running again. This is not a tab-wide rule. The Browser window's own return check (`desktop-window.js`, `reboot: () => { void start_boot(); }`) is unchanged, because this lane does not change Browser behaviour. In practice:
  - **Code alone:** "Computer stopped" stays up until the user presses Start.
  - **Code with the Browser open:** the Browser starts the computer on return, and Code's stopped-state probe then sees it running and re-mints by itself.
  - **Owner decision.** One option is to keep this and align the Browser in a later lane. The other is to revert Code to `reboot: () => { void start_boot(); }`, which turns red the code-test 7k checks that pin the current behaviour (mutant b gives 125/130, with 5 checks failing).
  - **Hand-off.** The header of `shell/ezil/runtime-recheck.js` (lines 21-22) still says that a live window "reboots, through its own `start_boot()`". It should say that each window's `reboot` callback decides what happens: the Browser calls `start_boot()`, and Code shows "Computer stopped".
- **Not reachable from Stop in this tab.** Settings → Computers → Stop closes every sandbox window, Code included, before it posts `/api/shell/stop` (`closeSandboxWindows`). The stopped state therefore covers stops this tab did not make: idle-stop, or another tab or device.

## 5. Not done here (deferred)

- Pixel review of every value above against the founder's reference
  screenshots, which G3 could not read (§3).
- The outlined Feedback look applies only in Code's strip. The Browser's
  full-bleed and windowed apps keep the glass disc, because the brief said to
  leave the Browser's look unchanged. To make the outline universal, declare
  `--ezil-feedback-look: outline` in the shared full-view rule, or drop the
  `[data-look]` gate in feedback.css.
- On the keyboard, Enter or Space on the tray toggle toggles the tray. Focus
  has already opened it, so the first Enter shuts it, and while the tray is
  shut its actions are hidden and Tab skips them. Tab straight past the toggle
  works. This is the Browser's behaviour as well.
- With `desktopState.ui.floatingControls === true`, the fenced Feedback sync hides the icon in every full-bleed window, so Code's full view would have no Feedback icon. Today that flag is always false.
- A Settings button in Code's drawer (Browser "Guarantee #1") needs `wants_settings_in_drawer: true` on the `code` registry entry (registry.js, not this lane's). Today the tray's Restore window and Show desktop bring the taskbar, and its Settings icon, back in one click.

## 6. Hand-offs outside this lane (from the removal of "Restart desktop")

These files are not this lane's to edit.

> **Status at integration (`feat/os-app-code-20261030`, 2026-10-30).** Done:
> the troubleshoot-test check 4 rewrite (4/4) and the three "Stale wording"
> items. The `e2e/billing-staging-journey.mjs` persistence step was done by
> gate G4b (2026-10-31, below). Still open: the
> `shell/ezil/runtime-recheck.js:21-22` header.

- **Merge blocker: `shell/ezil/ui/Settings/troubleshoot-test.mjs` check 4 (lines 48-61).** CI runs this file (ci.yml node-suite list). Check 4 still requires `RESTART_DESKTOP_TIME` and the Restart desktop copy, so it fails as soon as this lane lands. Rewrite it to test both sides:
  - Present: the Restart computer heading, copy and `data-action="restart-computer"`, and that copy passes `scanCopy`.
  - Absent: `RESTART_DESKTOP_TIME`, "Restarts the desktop and its apps", `<h3>Restart desktop</h3>`, `data-action="restart"` and `sheet: 'confirm-restart'`.
  - The integrator must apply this in the same merge.
- **Done (G4b): `e2e/billing-staging-journey.mjs` persistence step.** It drove `[data-action="restart"]`, so it would have timed out and FAILed. It now drives Restart computer (`persistence()`, `restartPane()`, `RESTART_COMPUTER_UI`):
  - path Settings → Troubleshoot → Restart computer. No open Browser is needed first, because the tab takes the page's current computer;
  - `[data-action="restart-computer"]`, then the button "Restart computer" inside `[role="dialog"][data-sheet="confirm-restart-computer"]` (the pane's own button has the same name);
  - `[data-role="restart-computer-status"]` until "Your computer restarted.", for up to 360 s (`RESTART_COMPUTER_WAIT_MS`). That status line with `.ezil-settings-error` is a FAIL;
  - only "Not available in this deployment yet." is a SKIP. "Open a desktop first, then come back here." stays a FAIL;
  - both markers must come back: `/workspace/.e2e-persist.txt` and `~/e2e-persist.txt`. This corrects the earlier note here, which said to drop `~`: `/root` sits in the root overlay's upper layer on the data disk, and boot clears only its `tmp` and `run` (`infra/host-agent/lib/ezil_host/desktop.py` `host_clean`). The tmux session and the kernel boot id are recorded, not asserted.
  - `e2e/billing-staging-journey.test.mjs` (now in ci.yml's cloud-release-contract node list) runs the real step against a fake Settings pane and a bash-backed fake computer, and pins every selector and line the step uses against `troubleshoot.js` and `sheet-frame.js`.
- **Stale wording:**
  - `docs/aws-computers/LEGACY-REBASE-OPERATOR-PRESERVATION.md:43` lists "restart desktop" as an acceptance step. It should be "restart computer".
  - `shell/ezil/apps/relay-renewal.js:4` names "Restart desktop" as a cause. Only Restart computer and a switch remain.
  - The header of `app/src/app/api/shell/restart/route.ts:12` names troubleshoot.js plus `session.restartDesktop()` as the caller. Troubleshoot now posts only `scope: 'computer'`.
- **`shell/ezil/runtime-recheck.js:21-22`**: see §4, "Behaviour change".

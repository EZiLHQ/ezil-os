# Code full view, its top bar, and the stopped/reconnecting state

App-code lane A2, 2026-10-30. Source: `shell/ezil/apps/code.js`,
`shell/ezil/ui/full-view.js`, `shell/ezil/ui/ezil-shell.css`.

> **Every visual value in this document is PROVISIONAL.** No reference
> screenshots were available when it was written. The numbers below are the
> ones the code uses today, chosen to fit the existing Browser control strip and
> the existing Feedback icon. They are to be refined after a pixel review.

## 1. Behaviour

| Trigger | Result |
|---|---|
| Launch with `ctx.view === 'full'` (the `/app/code` route, including a canonicalised `/os?app=code`) | Opens in full view. Not announced, not remembered. |
| Launch with `ctx.view === 'window'` | Opens windowed at 980×680. |
| Launch with no view (dock, Start menu, launcher) | Windowed at 980×680, unless the user's last explicit choice in this tab was full (`sessionStorage['ezil-os:view.code'] === 'full'`). |
| Green button, head double-click, head context menu "Maximize" (all reach `scale_window` → `el._ezil_maximise`) | Toggles full view ↔ window. Remembered. Announced. |
| Top bar **Restore window**, drawer **Restore window**, double-click on the top bar | Back to the window at the bounds it had before full view. Remembered. Announced. |
| Top bar **Minimise**, drawer **Show desktop** | Minimises. The taskbar comes back first. Coming back from the taskbar re-enters full view if the window still wants it; otherwise it restores the windowed bounds. The head's minimise button and context menu are reachable only while windowed and keep upstream's `hideWindow()`. Code installs no `_ezil_minimise` hook (`seam-minimise-browser-test` pins a single provider). |
| Top bar **Close**, drawer **Close** | Closes the window (the taskbar comes back). |
| `el._ezil_relaunch(ctx)` (the registry calls it on an existing single-instance window after `showWindow()`, contract item 4) | Reads only `ctx.view`, and only `'full'` / `'window'`; every other key and value is ignored. Not remembered. Announced when the view changes. |
| `el._ezil_set_title(text)` | Sets the title in the head, the top bar and the drawer as text (`textContent`). An empty value falls back to the app name. A later lane passes the project/repo name. |
| `el._ezil_view()` (read only; the router, `app-history.js`, calls it whenever it writes this window's history entry, docs/APP-ROUTES.md §5 "State") | Returns the view now: `'full'` while the window wants full view, minimised from it included (it re-enters full view when shown, though the `ezil-fullbleed` class is off while hidden); otherwise `'window'`, always `'window'` when full view is forbidden. Read from the full-view state, not from the last announced value. Changes nothing. |

- **Remembered** means that `sessionStorage['ezil-os:view.code']` is set to `'full'` or `'window'`. Only gestures write it. Route launches and relaunches never write it. Storage failures are ignored, and the choice still applies to the open window.
- **Announced** means that `window.dispatchEvent(new CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view } }))` fires. It fires only when the view actually changes. The open itself is never announced. The router launches the app and then pushes its own history entry, so an event fired during the launch would be recorded on the entry being left. The Code window never calls a history API.
- There is no automatic browser Fullscreen API call. Full view is a layout mode inside the page.
- If the control drawer fails to attach, full view is forbidden. The window stays windowed and keeps upstream's maximise (no hook is installed), because full view hides the taskbar and the head.

## 2. The shared mechanism (`shell/ezil/ui/full-view.js`)

`createFullView(el_window)` is the Browser's former `go_fullbleed` /
`minimise_to_taskbar`, made shareable:

- **`enter()`** adds `ezil-fullbleed`, calls `enter_fullpage_mode` (which hides the taskbar and the head, sizes the window at 100%, and stashes the previous bounds), writes `data-is_fullpage="1"`, calls `focusWindow()` and flashes the drawer.
- **`exit()`** clears the desire, gives the chrome back and restores the stashed bounds. This is new for Code. The Browser never calls it.
- **`minimise()`** gives the chrome back and then calls `hideWindow()`. It is chrome-only, and the geometry stays full while the window is hidden.
- **`settle()`** handles a window that was minimised from full view and is now restored without wanting full view. It goes back to its stashed bounds.
- **`watch_restore(fn)`** calls `fn` on every restore from the taskbar.
- **`forbid()`** means there is no exit, so there is no entry.
- **Two windows in full view.** Leaving full view gives the taskbar back only when no other visible window is still in full view. Otherwise only that window's head comes back.
- **`prepare_close()`** is called from both windows' `on_before_exit`, which `$.fn.close` awaits before its own full-page exit. It applies the same rule to closing. When another window is still in full view, it drops this window's `data-is_fullpage`, so `$.fn.close` does not put the taskbar over that window. When there is no other full window it does nothing.

`ezil-shell.css` keys the shared strip, drawer, body offset and resize-handle
rules on `.ezil-full-view-host`, which `createFullView` adds. The Browser's rules
were previously keyed on `.ezil-desktop-window`. Specificity and source
position are the same, and the Browser's computed full-bleed geometry was diffed
identical at 1440×900 and 390×844.

## 3. The top bar (PROVISIONAL visuals)

| Element | Value | Notes |
|---|---|---|
| Bar height | `--ezil-control-strip-height`: 43px fine, 59px `pointer: coarse` | Same strip as the Browser, so the Feedback icon's fixed full-bleed position (feedback.css `top: 9.5px` / `7.5px`) is centred in it with no Code-specific rule. |
| Bar background | Window background `#11151f` (shared full-view rule); bottom hairline `1px rgba(255,255,255,0.08)` | |
| Text colour | `var(--color-offwhite, #f5f5f4)` | |
| Left | Control drawer at `left: 8px` (collapsed tongue 56×16 + 1px border, vertically centred as in the Browser) | The Browser's drawer is centred. Expanded, it shows icon, title, **Show desktop**, **Restore window** and **Close**, and covers the title (drawer z 600 > bar z 550). |
| Left padding | 78px | Clears the collapsed drawer. |
| Title | Centred, 13px / 600, opacity 0.86, one line with an ellipsis; `max-width: calc(100% - 2 × --ezil-fv-side)`, where `--ezil-fv-side` is 150px fine and 200px coarse | At 390px coarse the title has no room and ellipsises to nothing. |
| Controls (right) | Minimise, Restore window, Close: `--ezil-fv-btn` 28px fine / 44px coarse square, 4px gap, radius 6px, 16px glyph, opacity 0.8 (1 on hover/focus), hover `rgba(255,255,255,0.12)` | Real `<button>`s with `aria-label` and `title`. |
| Right padding (Feedback reserve) | `--ezil-fv-chip-reserve` 40px fine / 50px coarse | The icon is 24px at `right: 6px` (fine) or 44px at `right: 0` (coarse). |
| Focus | `:focus-visible` outline `2px solid var(--ezil-accent, #00adb5)`, offset 2px | |
| Tab order | Drawer toggle → bar buttons → editor | DOM order: drawer, bar, body. |

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

- Pixel review of every value above.
- With `desktopState.ui.floatingControls === true`, the fenced Feedback sync hides the icon in every full-bleed window, so Code's full view would have no Feedback icon. Today that flag is always false.
- A Settings button in Code's drawer (Browser "Guarantee #1") needs `wants_settings_in_drawer: true` on the `code` registry entry (registry.js, not this lane's). Today the top bar's Restore and Minimise bring the taskbar, and its Settings icon, back in one click.

## 6. Hand-offs outside this lane (from the removal of "Restart desktop")

These files are not this lane's to edit.

> **Status at integration (`feat/os-app-code-20261030`, 2026-10-30).** Done:
> the troubleshoot-test check 4 rewrite (4/4) and the three "Stale wording"
> items. Still open: the `e2e/billing-staging-journey.mjs` persistence step
> and the `shell/ezil/runtime-recheck.js:21-22` header.

- **Merge blocker: `shell/ezil/ui/Settings/troubleshoot-test.mjs` check 4 (lines 48-61).** CI runs this file (ci.yml node-suite list). Check 4 still requires `RESTART_DESKTOP_TIME` and the Restart desktop copy, so it fails as soon as this lane lands. Rewrite it to test both sides:
  - Present: the Restart computer heading, copy and `data-action="restart-computer"`, and that copy passes `scanCopy`.
  - Absent: `RESTART_DESKTOP_TIME`, "Restarts the desktop and its apps", `<h3>Restart desktop</h3>`, `data-action="restart"` and `sheet: 'confirm-restart'`.
  - The integrator must apply this in the same merge.
- **`e2e/billing-staging-journey.mjs` persistence step (lines 576, 614-630, 643; fixture `billing-staging-journey.test.mjs:226`).** The step drives `[data-action="restart"]`, so it would time out and FAIL. It is not a SKIP, because `restartUnavailableReason('')` is null.
  - **Minimal fix:** pass the skip reason `'restart_desktop_removed'` to `record('persistence', …)` at line 783.
  - **Full fix:** rewrite the step for Restart computer, which needs all of these:
    - selector `[data-action="restart-computer"]`;
    - confirm through `[role="dialog"][data-sheet="confirm-restart-computer"]`, using the button "Restart computer" scoped to that sheet, because the pane's own button has the same name;
    - success copy "Your computer restarted.";
    - a wait of at least 300 s;
    - assert the `/workspace/.e2e-persist.txt` marker, not `~/e2e-persist.txt`, because a computer restart stops the machine.
- **Stale wording:**
  - `docs/aws-computers/LEGACY-REBASE-OPERATOR-PRESERVATION.md:43` lists "restart desktop" as an acceptance step. It should be "restart computer".
  - `shell/ezil/apps/relay-renewal.js:4` names "Restart desktop" as a cause. Only Restart computer and a switch remain.
  - The header of `app/src/app/api/shell/restart/route.ts:12` names troubleshoot.js plus `session.restartDesktop()` as the caller. Troubleshoot now posts only `scope: 'computer'`.
- **`shell/ezil/runtime-recheck.js:21-22`**: see §4, "Behaviour change".

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
- **Behaviour change.** Before this lane, the return-from-away check called `start_boot()` directly. That started a stopped computer, including one its owner had stopped from another tab or device, just because the tab regained focus. Now only an explicit Start, or the computer already running again, re-mints. This is the same rule as hotfix r5's hover-warm hold.
- **Not reachable from Stop in this tab.** Settings → Computers → Stop closes every sandbox window, Code included, before it posts `/api/shell/stop` (`closeSandboxWindows`). The stopped state therefore covers stops this tab did not make: idle-stop, or another tab or device.

## 5. Not done here (deferred)

- Pixel review of every value above.
- With `desktopState.ui.floatingControls === true`, the fenced Feedback sync hides the icon in every full-bleed window, so Code's full view would have no Feedback icon. Today that flag is always false.
- A Settings button in Code's drawer (Browser "Guarantee #1") needs `wants_settings_in_drawer: true` on the `code` registry entry (registry.js, not this lane's). Today the top bar's Restore and Minimise bring the taskbar, and its Settings icon, back in one click.

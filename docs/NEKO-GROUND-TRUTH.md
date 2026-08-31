# NEKO-GROUND-TRUTH

Ground truth established by running the real worker image in a real container,
before any fix was attempted. **Observation only: nothing was fixed and no source
file was changed.** The screenshots it cites are committed alongside it in
`docs/assets/`, so every claim here can be checked against the pixels it was drawn
from.

## Provenance

| Item | Value |
| --- | --- |
| Image built | `ezil-ground-truth:local` (left in place for later phases) |
| Built from | `worker/Dockerfile`, build context `worker/` |
| Build command | `cd worker && docker build -t ezil-ground-truth:local .` |
| Build result | **exit 0** (all layers `CACHED` — the layer cache was already warm from a prior identical build on this host) |
| `NEKO_IMAGE` build arg | default `ezil-neko-vscode:d74052bb-049931d7-ezil-brand1` (present in local daemon, id `3916c91c101a`) |
| Container name | `ezil-gt` (**removed at end of this phase**) |
| Run command | `docker run -d --name ezil-gt --cpus=2 -p 18181:8181 -e DESKTOP_MODE=neko -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=gtadmin -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=gtuser -e NEKO_PASSWORD_ADMIN=gtadmin -e NEKO_PASSWORD=gtuser --entrypoint /bin/bash ezil-ground-truth:local -c 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh'` |
| Boot outcome | Desktop reached `phase=ready status=ok` at **+11310ms**; `neko is serving on 8181` |
| Chrome window id | `0x400003` (decimal `4194307`) |
| Date | 2026-08-19 |

Boot log tail (verbatim, elided for the Chrome dbus noise):

```
[ezil-boot][start-neko] +8771ms browser ready
[ezil-boot][start-neko] +8773ms codeserver ready
[ezil-boot][start-neko] +8775ms window-ready gate passed: all mandatory apps present (browser codeserver)
[ezil-boot] +8779ms phase=window_ready_gate event=end status=ok phase_ms=4061 cumulative_ms=8777
[ezil-boot] +8786ms phase=neko_serve_bind event=start
[ezil-boot][start-neko] +8788ms starting neko on 0.0.0.0:8181 (pinned build, static=/var/www)
[ezil-boot][start-neko] +8791ms ICE: no TURN relay configured — relay-less/STUN-only (media gated)
...
INF setting initial screen size  module=desktop screen_size=1920x1080@60
INF http listening on 0.0.0.0:8181  module=http
INF neko ready  service=neko
[ezil-boot][start-neko] +11304ms neko is serving on 8181
[ezil-boot] +11308ms phase=neko_serve_bind event=end status=ok phase_ms=2521 cumulative_ms=11306
[ezil-boot] +11312ms phase=ready event=end status=ok phase_ms=11310 cumulative_ms=11310
```

---

## ANSWERS (one line each)

- **(a) WM_CLASS** — VERIFIED. Instance = `google-chrome (/tmp/chromium-app-data)`, class = **`Google-chrome`**. The openbox rule `class="Google-chrome"` **DOES match**, exactly and literally.
- **(b) Decorated?** — VERIFIED **NO**. Openbox reparents Chrome into a frame, but that frame is **undecorated**: `_NET_FRAME_EXTENTS = 0, 0, 0, 0` and `_NET_WM_STATE` contains `_OB_WM_STATE_UNDECORATED`. Openbox draws **no titlebar**.
- **(c) Screenshot** — VERIFIED, captured. `docs/assets/neko-screenshot.jpg` (JPEG 1920x1080). It shows **no openbox titlebar**; the bar the user reports is **Chrome's own tabstrip-integrated frame**, carrying Chrome's own minimize / restore / close caption buttons at the top right.
- **(d) Openbox config parse** — VERIFIED **clean**. No parse error, warning, or any openbox diagnostic anywhere in `/tmp/neko.log`; phase ended `status=ok`. The rule provably took effect (see `_OB_WM_STATE_UNDECORATED` in (b)).
- **(e) Screen API under Xvfb** — VERIFIED, and **the expected result is WRONG**. `configurations` lists exactly one entry (`1920x1080@0`), but `POST /api/room/screen` with `1280x720` **SUCCEEDED** (HTTP 200) and **really resized the X display**. Sizes **larger** than the Xvfb framebuffer are refused (`2560x1440` → HTTP 422 `cannot set screen size`). Resize down works; resize beyond 1920x1080 does not.
- **(f) XTEST input** — VERIFIED **YES**, definitively, for both pointer and keyboard, using true XTEST (no `--window`/XSendEvent fallback). A synthetic click opened a new tab; synthetic typing navigated the browser to example.com. `start-neko.sh:1618`'s UNVERIFIED note is now resolved in the affirmative.
- **(g) Chrome frame preference** — VERIFIED. `custom_chrome_frame` is **ABSENT** from `/tmp/chromium-app-data/Default/Preferences` (and from `Local State`). Chrome version **151.0.7922.71**.
- **(h) Xvfb substitution** — VERIFIED. In the running worker container: `/usr/lib/xorg/Xorg` **ABSENT**, `dummy_drv.so` **ABSENT** (the whole `/usr/lib/xorg/modules/drivers/` directory does not exist), `xrandr` **ABSENT**, `/etc/neko/xorg.conf` **PRESENT** (carried in by the `COPY --from=neko /etc/neko` and unused).

---

## (a) WM_CLASS ground truth — VERIFIED

`wmctrl -x -l`:

```
0x00400003  0 google-chrome (/tmp/chromium-app-data).Google-chrome  b86c2ca03326 EZiL OS Browser - Google Chrome
```

`wmctrl -l -p -G -x`:

```
0x00400003  0 173    0    0    1920 1080 google-chrome (/tmp/chromium-app-data).Google-chrome  b86c2ca03326 EZiL OS Browser - Google Chrome
```

`xprop -id 0x400003 WM_CLASS`:

```
WM_CLASS(STRING) = "google-chrome (/tmp/chromium-app-data)", "Google-chrome"
```

`obxprop --id 0x400003` (filtered):

```
_OB_APP_TYPE(UTF8_STRING) = "normal"
_OB_APP_TITLE(UTF8_STRING) = "Untitled - Google Chrome"
_OB_APP_GROUP_CLASS(UTF8_STRING) =
_OB_APP_GROUP_NAME(UTF8_STRING) =
_OB_APP_CLASS(UTF8_STRING) = "Google-chrome"
_OB_APP_NAME(UTF8_STRING) = "google-chrome (/tmp/chromium-app-data)"
_OB_APP_ROLE(UTF8_STRING) = "browser"
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_NET_WM_PID(CARDINAL) = 173
```

`obxprop` is present at `/usr/bin/obxprop` (from the neko base). `xprop`, `xwininfo`,
`xdpyinfo`, `wmctrl`, `xdotool` are all present. **No tool was missing** except `xrandr`
and `strings` (see (h)).

**LITERAL strings:** instance `google-chrome (/tmp/chromium-app-data)`, class `Google-chrome`.

The instance string carries the `--user-data-dir` suffix (Chrome appends the profile
path to WM_CLASS *instance* when a non-default user-data-dir is used) — but the **class**
is untouched and is exactly `Google-chrome`. The rule in
`worker/assets/ebuilder-openbox.xml:44` matches on class:

```xml
  <application type="normal" class="Google-chrome">
    <decor>no</decor>
    <maximized>true</maximized>
    <focus>yes</focus>
    <layer>normal</layer>
  </application>
```

so it matches. Note `_OB_APP_CLASS` is openbox's own record of what it matched against —
openbox itself saw `Google-chrome`.

There is a *second*, unmanaged Chrome window with a different class:

```
0x600001 "google-chrome-stable": ("google-chrome-stable" "Google-chrome-stable")  10x10+10+10
```

This is Chrome's 10x10 hidden helper/messaging window, not in `_NET_CLIENT_LIST`, not
managed by openbox, and not visible.

---

## (b) Is the window decorated? — VERIFIED NO

`xwininfo -root -tree` (head; the Chrome client is the first child of frame `0x200062`):

```
xwininfo: Window id: 0x50d (the root window) (has no name)

  Root window id: 0x50d (the root window) (has no name)
  Parent window id: 0x0 (none)
     15 children:
     0x400006 (has no name): ()  1x1+0+0  +0+0
     0x600001 "google-chrome-stable": ("google-chrome-stable" "Google-chrome-stable")  10x10+10+10  +10+10
     0x400000 "Chromium clipboard": ()  10x10+-100+-100  +-100+-100
     0x20000e "Openbox": ("" (none))  1x1+-100+-100  +-100+-100
     0x200060 (has no name): ()  1x1+0+0  +0+0
        1 child:
        0x200061 (has no name): ()  1x1+0+0  +1+1
     0x20005e (has no name): ()  1x1+0+0  +0+0
        1 child:
        0x20005f (has no name): ()  1x1+0+0  +1+1
     0x20005b (has no name): ()  1x1+0+0  +0+0
        1 child:
        0x20005c (has no name): ()  1x1+0+0  +1+1
     0x200057 (has no name): ("OPENBOX_FOCUS_CYCLE_POPUP" "OPENBOX_FOCUS_CYCLE_POPUP")  1x1+0+0  +0+0
        3 children:
        0x20005a (has no name): ()  1x1+0+0  +1+1
        0x200059 (has no name): ()  1x1+0+0  +1+1
        0x200058 (has no name): ()  1x1+0+0  +1+1
     0x200054 (has no name): ()  1x1+0+0  +0+0
        2 children:
        0x200056 (has no name): ()  1x1+0+0  +1+1
        0x200055 (has no name): ()  1x1+0+0  +1+1
     0x200053 (has no name): ()  1x1+0+0  +0+0
     0x200052 (has no name): ()  1x1+0+0  +0+0
     0x200051 (has no name): ()  1x1+0+0  +0+0
     0x200050 (has no name): ()  1x1+0+0  +0+0
     0x20005d (has no name): ()  1x1+0+0  +0+0
     0x200062 (has no name): ()  1920x1080+0+0  +0+0
        56 children:
        0x400003 "EZiL OS Browser - Google Chrome": ("google-chrome (/tmp/chromium-app-data)" "Google-chrome")  1920x1080+0+0  +0+0
        0x2000ae (has no name): ()  1x1+0+0  +0+0
        0x2000ad (has no name): ()  1x1+0+0  +0+0
        0x2000ac (has no name): ()  1x1+0+0  +0+0
        0x2000ab (has no name): ()  1x1+0+0  +0+0
```

**Reading of the tree:** openbox HAS reparented — the Chrome client `0x400003` is not a
direct child of root; its parent is openbox's frame window `0x200062` (openbox window ids
are in the `0x2000xx` range, matching `0x20000e "Openbox"`). But:

- The frame `0x200062` is **`1920x1080+0+0`** and the client `0x400003` is **also
  `1920x1080+0+0` at relative `+0+0`**. A decorating frame would be *taller* than its
  client and would offset the client downward by the titlebar height. Here the frame and
  client are **pixel-identical**, so the frame contributes **zero** decoration.
- The frame's other 55 children are all `1x1+0+0` — openbox's decoration widgets
  (titlebar, buttons, handle, grips) exist as objects but are all collapsed to 1x1 and
  positioned at the origin, i.e. **not drawn**. There is no titlebar child of any real size.

`xwininfo -id 0x400003`:

```
xwininfo: Window id: 0x400003 "EZiL OS Browser - Google Chrome"

  Absolute upper-left X:  0
  Absolute upper-left Y:  0
  Relative upper-left X:  0
  Relative upper-left Y:  0
  Width: 1920
  Height: 1080
  Depth: 24
  Visual: 0x21
  Visual Class: TrueColor
  Border width: 0
  Class: InputOutput
  Colormap: 0x20 (installed)
  Bit Gravity State: NorthWestGravity
  Window Gravity State: NorthWestGravity
  Backing Store State: NotUseful
  Save Under State: no
  Map State: IsViewable
  Override Redirect State: no
  Corners:  +0+0  -0+0  -0-0  +0-0
  -geometry 1920x1080+0+0
```

Absolute upper-left is `+0+0` — the client occupies the display from the very top pixel.
A decorated window would start below the titlebar.

`xprop -id 0x400003 _MOTIF_WM_HINTS _NET_WM_WINDOW_TYPE _OB_APP_CLASS _OB_APP_NAME _OB_APP_TYPE _NET_FRAME_EXTENTS _NET_WM_STATE`:

```
_MOTIF_WM_HINTS(_MOTIF_WM_HINTS) = 0x2, 0x0, 0x0, 0x0, 0x0
_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL
_OB_APP_CLASS(UTF8_STRING) = "Google-chrome"
_OB_APP_NAME(UTF8_STRING) = "google-chrome (/tmp/chromium-app-data)"
_OB_APP_TYPE(UTF8_STRING) = "normal"
_NET_FRAME_EXTENTS(CARDINAL) = 0, 0, 0, 0
_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ, _OB_WM_STATE_UNDECORATED
```

Three independent confirmations that openbox is **not** decorating:

1. `_NET_FRAME_EXTENTS = 0, 0, 0, 0` — openbox publishes zero left/right/top/bottom frame
   thickness. A titlebar would put a non-zero value in the third slot.
2. `_OB_WM_STATE_UNDECORATED` present in `_NET_WM_STATE` — openbox's own flag saying this
   window is undecorated. This is openbox reporting that its `<decor>no</decor>` rule was
   applied.
3. `_MOTIF_WM_HINTS = 0x2, 0x0, 0x0, 0x0, 0x0` — flags `0x2` = `MWM_HINTS_DECORATIONS`,
   decorations field `0x0` = none. **Chrome itself is asking for no WM decorations**, which
   it does whenever it draws its own frame.

`_NET_WM_STATE` also carries `_NET_WM_STATE_MAXIMIZED_VERT/HORZ`, confirming the rule's
`<maximized>true</maximized>` was applied too.

---

## (c) Screenshot of the X display — VERIFIED, captured

The neko binary's screenshot route is **`GET /api/room/screen/shot.jpg`**, not
`/api/room/screen/shot`. Route probe (all with a valid admin bearer token):

```
/api/room/screen/shot.jpg -> HTTP=200 type=image/jpeg size=77533
/api/room/screen/cast.jpg -> HTTP=400 type=application/json size=60
/api/room/screen/shot     -> HTTP=404 type=text/plain; charset=utf-8 size=19
/api/screen/shot.jpg      -> HTTP=404 type=text/plain; charset=utf-8 size=19
```

### Artifacts (absolute paths)

| File | What it shows |
| --- | --- |
| `docs/assets/neko-screenshot.jpg` | **The primary artifact.** The desktop as booted, untouched. |
| `docs/assets/xtest-after-typing.jpg` | Omnibox mid-type (XSendEvent path) — evidence for (f). |
| `docs/assets/xtest-true-xtest.jpg` | Second tab opened by a true-XTEST mouse click — evidence for (f). |
| `docs/assets/xtest-keyboard-nav.jpg` | After true-XTEST keyboard navigation — evidence for (f). |

All are `JPEG image data, baseline, precision 8, 1920x1080, components 3`.

### What the primary screenshot shows (description of observed pixels)

Top-to-bottom, at 1920x1080:

- **Row 0–40px: Chrome's own tab strip.** At far left a small chevron (tab-search) button;
  then one tab, labelled with a globe favicon and the text `EZiL OS Browser`, with an `x`
  close button; then a `+` new-tab button. At the **far right of this same row**, three
  window caption buttons: **minimize (—), restore/maximize (▣), close (✕)** at roughly
  x=1837, x=1868, x=1898.
- **Row ~45–80px: Chrome's toolbar** — back/forward/reload, an `ⓘ File` chip, the omnibox
  reading `/usr/local/share/ezil/browser-home.html`, a bookmark star, profile avatar, and
  the three-dot menu.
- **Row ~95–135px: a Chrome infobar** — `You are using an unsupported command-line flag:
  --no-sandbox. Stability and security will suffer.` with a dismiss `✕` on the right.
- **Row ~140–1080px: the page** — the dark EZiL landing card reading `EZiL OS Browser` /
  `Native browser is running on the EZiL OS desktop.` / `VS Code and this browser are both
  mandatory desktop applications.` / a blue `DESKTOP READY` pill.

**There is no openbox titlebar.** There is no separate bar above the tab strip, no window
title text rendered by the WM, no openbox border, and no openbox corner grips. The tab
strip begins at pixel row 0. The caption buttons that appear at the top-right are drawn
**inside the tab strip row**, which is the signature of Chrome's own integrated frame — an
openbox titlebar would be a distinct band *above* the tabs with its own separate buttons.

---

## (d) Does openbox parse the config without error? — VERIFIED, clean

Every line in `/tmp/neko.log` mentioning openbox:

```
11:[ezil-boot] +2608ms phase=openbox event=start
12:[ezil-boot][start-neko] +2610ms starting openbox (config /etc/neko/ebuilder-openbox.xml)
13:[ezil-boot] +3615ms phase=openbox event=end status=ok phase_ms=1006 cumulative_ms=3613
```

That is the complete set — three lines, no fourth. Openbox emitted **no output at all** to
the log: no parse error, no "syntax error in", no "unable to find", no XML warning.
Openbox writes such diagnostics to stderr, and `start-neko.sh:876` redirects both
stdout and stderr into `$LOG` (`openbox --config-file "$OPENBOX_CONFIG" >>"$LOG" 2>&1`),
so a parse error would have landed in this file. It did not.

A grep for parse/syntax/invalid/xml patterns across the whole log returns only the
`starting openbox` line above plus Chrome's unrelated D-Bus noise (`Failed to connect to
the bus: Could not parse server address` — that is Chrome failing to reach a session bus,
nothing to do with openbox or its XML):

```
12:[ezil-boot][start-neko] +2610ms starting openbox (config /etc/neko/ebuilder-openbox.xml)
28:[173:256:0819/063132.059788:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")
   ... (30+ further identical dbus/bus.cc:405 lines, all Chrome) ...
```

Openbox is confirmed running with the intended config:

```
root          91  0.0  0.0 213692 18020 ?        S    06:31   0:00 openbox --config-file /etc/neko/ebuilder-openbox.xml
```

**Stronger than the absence of errors:** the config demonstrably took effect. The Chrome
window carries `_OB_WM_STATE_UNDECORATED` and `_NET_WM_STATE_MAXIMIZED_VERT/HORZ`, which
are exactly the `<decor>no</decor>` and `<maximized>true</maximized>` directives from the
`class="Google-chrome"` rule. The config parsed AND matched AND applied.

---

## (e) The screen API under Xvfb — VERIFIED; the expected result was WRONG

Login (`POST /api/login`) with the injected admin password succeeded, confirming
`NEKO_PASSWORD_ADMIN` / `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD` from process env are what
the server used:

```json
{"id":"admin-af5dP","token":"<64 chars>","profile":{"name":"admin","is_admin":true,"can_login":true,"can_connect":true,"can_watch":true,"can_host":true,"can_share_media":true,"can_access_clipboard":true,"sends_inactive_cursor":true,"can_see_inactive_cursors":true,"plugins":null},"state":{"is_connected":false,"is_watching":false}}
```

neko logged that it accepted the v2-style vars and warned they are deprecated:

```
WRN you are using v2 configuration 'NEKO_PASSWORD' and 'NEKO_PASSWORD_ADMIN' which are deprecated, please use 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD' and 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD' with 'NEKO_MEMBER_PROVIDER=multiuser' instead
WRN legacy configuration is enabled because at least one V2 configuration was used, please migrate to V3 configuration
```

### `GET /api/room/screen`

```json
{"width":1920,"height":1080,"rate":60}
```
```
HTTP=200
```

### `GET /api/room/screen/configurations`

```json
[{"width":1920,"height":1080,"rate":0}]
```
```
HTTP=200
```

Exactly one entry, as expected — and note `"rate":0`, not 60, in the configurations list
(Xvfb reports no refresh rate for its single synthesised mode).

### `POST /api/room/screen` with `{"width":1280,"height":720,"rate":60}`

```json
{"width":1280,"height":720,"rate":60}
```
```
HTTP=200
```

**The set was NOT refused.** It returned 200 with the new size echoed back.

### Confirmation the resize was real, not merely reported

`GET /api/room/screen` immediately after:

```json
{"width":1280,"height":720,"rate":60}
```
```
HTTP=200
```

`xdpyinfo` on the actual X display:

```
  dimensions:    1280x720 pixels (488x274 millimeters)
  resolution:    67x67 dots per inch
```

`wmctrl -l -G -x` — the Chrome window followed the resize:

```
0x00400003  0 0    0    1280 720  google-chrome (/tmp/chromium-app-data).Google-chrome  b86c2ca03326 EZiL OS Browser - Google Chrome
```

The X root really changed size and the maximized client really re-laid-out. This is a
genuine RANDR resize, not a cosmetic API response.

### Upper bound: `POST /api/room/screen` with `{"width":2560,"height":1440,"rate":60}`

```json
{"code":422,"message":"cannot set screen size"}
```
```
HTTP=422
```

`xdpyinfo` after the failed attempt (unchanged, still the previous size):

```
  dimensions:    1280x720 pixels (488x274 millimeters)
```

### Restore

`POST /api/room/screen` with `{"width":1920,"height":1080,"rate":60}`:

```json
{"width":1920,"height":1080,"rate":60}
```
```
HTTP=200
```
```
  dimensions:    1920x1080 pixels (488x274 millimeters)
0x00400003  0 0    0    1920 1080 google-chrome (/tmp/chromium-app-data).Google-chrome  b86c2ca03326 EZiL OS Browser - Google Chrome
```

The display was returned to 1920x1080 before the remaining checks.

### Supporting facts

`Xvfb` is running with `+extension RANDR`:

```
root          67  0.1  0.2 224008 78872 ?        S    06:31   0:00 Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp
```

RANDR is advertised on the display (23 extensions, RANDR among them):

```
number of extensions:    23
    BIG-REQUESTS
    Composite
--
    RANDR
    RECORD
    RENDER
```

**Summary of the screen-API contract as actually observed:** the configurations list
advertises only `1920x1080`, but `POST /api/room/screen` accepts and really applies **any**
size that fits **within** the Xvfb framebuffer allocated by `-screen 0 1920x1080x24`, and
rejects with **422 `cannot set screen size`** anything larger. Shrinking works; growing
beyond the boot-time framebuffer does not.

---

## (f) XTEST input — VERIFIED **YES** (pointer AND keyboard)

This resolves the `UNVERIFIED` claim at `worker/scripts/start-neko.sh:1618`.

XTEST is advertised on the display:

```
    XTEST
```

neko is running with the custom input driver disabled, i.e. on the standard-X/XTEST path:

```
root         423  0.2  0.2 1808688 87748 ?       Sl   06:31   0:00 /usr/bin/neko serve --server.static /var/www --desktop.input.enabled=false --desktop.display :99 --capture.video.display :99
```

### Pointer — YES

Pointer warping lands where asked:

```
### pointer move test
pointer now: x:640 y:400 screen:0 window:2097250
pointer now: x:1500 y:900 screen:0 window:2097250
```

Then a **true XTEST click** (`xdotool click`, which uses `XTestFakeButtonEvent` — no
`--window`, so no XSendEvent fallback) aimed at Chrome's `+` new-tab button at `(291, 20)`:

```
### TRUE XTEST mouse click test: click the + new tab button at 291,20
### wmctrl / title after new-tab click
0x00400003  0 google-chrome (/tmp/chromium-app-data).Google-chrome  b86c2ca03326 New Tab - Google Chrome
New Tab - Google Chrome
```

The window title changed from `EZiL OS Browser - Google Chrome` to
**`New Tab - Google Chrome`**. Chrome opened a new tab in response to the synthetic click.
The screenshot `xtest-true-xtest.jpg` confirms visually: **two tabs** are now present
(`EZiL OS Browser` and an active `New Tab`), the Google new-tab page is rendered with the
search box and `Web Store` / `Add shortcut` tiles, and Chrome's own hover tooltip
(`New Tab` / `Memory usage: 73.8 MB`) is displayed — a tooltip only appears because the
pointer is genuinely hovering there.

### Keyboard — YES

A clean, isolated **true XTEST** keyboard sequence (`xdotool key` / `xdotool type` with
**no** `--window` flag, so `XTestFakeKeyEvent` is used):

```
### pure XTEST keyboard: ctrl+l, type example.com, Return
### window title after XTEST-typed navigation:
Example Domain - Google Chrome
0x00400003  0 google-chrome (/tmp/chromium-app-data).Google-chrome  b86c2ca03326 Example Domain - Google Chrome
```

`Ctrl+L` focused the omnibox, the typed characters were received, and `Return` committed
the navigation — the window title became **`Example Domain - Google Chrome`**, the real
`<title>` of `example.com`. Nothing but genuine key delivery to the focused Chrome window
produces that.

An earlier corroborating run (using `--window`, i.e. the XSendEvent path) is captured in
`xtest-after-typing.jpg`, showing the omnibox containing `example.org/xtest-probe` with
Chrome's autocomplete dropdown open. That path also worked, but the **true XTEST** results
above are the load-bearing ones.

**Conclusion: pointer and keyboard events DO reach applications over XTEST on this Xvfb
base. Input is not broken at the X layer.**

---

## (g) Chrome's frame preference — VERIFIED

Chrome version:

```
Google Chrome 151.0.7922.71
```

`custom_chrome_frame` in the profile Preferences:

```
### grep custom_chrome_frame in Preferences
KEY custom_chrome_frame ABSENT
```

The `Preferences` file exists and is populated (the profile directory has 35 entries:
`Cookies`, `Cache`, `Web Data`, etc.), so this is a genuine absence, not a missing file.
The `browser` section of `Preferences` in full:

```json
{
  "window_placement": {
    "bottom": 1080,
    "left": 0,
    "maximized": true,
    "right": 1920,
    "top": 0,
    "work_area_bottom": 1080,
    "work_area_left": 0,
    "work_area_right": 1920,
    "work_area_top": 0
  }
}
```

`browser.custom_chrome_frame` is where Chrome persists the "Use system title bar and
borders" toggle. The key is **not present**, so no explicit choice has ever been recorded
for this profile and Chrome is on its **default**.

Also checked, and also absent:

```
### top-level Local State check
not in Local State
```

Note `window_placement.maximized: true` — consistent with the openbox `<maximized>true</maximized>`
rule and the `--window-size=1920,1080` launch flag.

---

## (h) Confirm the Xvfb substitution — VERIFIED

All checks run **inside the running `ezil-gt` worker container**, not the base image.

```
### Xorg present?
ls: cannot access '/usr/lib/xorg/Xorg': No such file or directory
Xorg NOT on PATH

### dummy_drv.so present?
ls: cannot access '/usr/lib/xorg/modules/drivers/dummy_drv.so': No such file or directory
ls: cannot access '/usr/lib/xorg/modules/drivers/': No such file or directory

### xrandr present?
xrandr NOT FOUND

### /etc/neko/xorg.conf present?
total 68
drwxr-xr-x 1 root root  4096 Aug  5 09:51 .
drwxr-xr-x 1 root root  4096 Aug 19 06:31 ..
-rw-r--r-- 1 root root  1315 Aug  1 09:41 ebuilder-menu.xml
-rw-r--r-- 1 root root  4063 Aug  1 09:41 ebuilder-openbox.xml
-rw-r--r-- 1 root root   344 Apr 10 09:02 neko.yaml
-rw-r--r-- 1 root root 24539 Jul 13 08:24 openbox.xml
drwxr-xr-x 2 root root  4096 Apr 10 09:05 plugins
drwxr-xr-x 2 root root  4096 Jul 13 08:26 supervisord
-rw-r--r-- 1 root root  1472 Apr 10 09:02 supervisord.conf
-rw-r--r-- 1 root root   229 Apr 10 09:02 supervisord.dbus.conf
-rw-r--r-- 1 root root  5203 Apr 10 09:02 xorg.conf

### Xvfb?
/usr/bin/Xvfb
root          67  0.1  0.2 224008 78872 ?        S    06:31   0:00 Xvfb :99 -screen 0 1920x1080x24 -ac +extension RANDR -nolisten tcp
root          91  0.0  0.0 213692 18020 ?        S    06:31   0:00 openbox --config-file /etc/neko/ebuilder-openbox.xml
root         423  0.2  0.2 1808688 87748 ?       Sl   06:31   0:00 /usr/bin/neko serve --server.static /var/www --desktop.input.enabled=false --desktop.display :99 --capture.video.display :99
```

### What W1 must install vs. what is already there

| Thing | State in the worker container | Note |
| --- | --- | --- |
| `/usr/lib/xorg/Xorg` | **ABSENT** — must be installed (`xserver-xorg-core`) | The whole `/usr/lib/xorg` tree is missing |
| `dummy_drv.so` | **ABSENT** — must be installed (`xserver-xorg-video-dummy`) | Parent dir `/usr/lib/xorg/modules/drivers/` does not exist either |
| `xrandr` | **ABSENT** — must be installed (`x11-xserver-utils`) | `libxrandr2` *is* installed (the Dockerfile installs it for neko), but the **CLI** is not |
| `/etc/neko/xorg.conf` | **PRESENT** (5203 bytes) — nothing to do | Carried in by `COPY --from=neko /etc/neko`; currently inert, nothing reads it |
| `Xvfb` | **PRESENT** at `/usr/bin/Xvfb`, and is what actually runs | From the Dockerfile's `xvfb` apt package |
| `xdpyinfo`, `xprop`, `xwininfo` | **PRESENT** | From `x11-utils` |
| `obxprop` | **PRESENT** at `/usr/bin/obxprop` | From the neko base via openbox |
| `wmctrl`, `xdotool` | **PRESENT** | Installed explicitly by the Dockerfile |
| `strings` | **ABSENT** | `binutils` not installed; noted only because it blocked one diagnostic |

The Xvfb substitution is confirmed: the worker image took `/usr/bin/neko`, `/var/www`, and
`/etc/neko` from the pinned base but **none** of its X server, so `xorg.conf` came along as
dead weight and the display is driven entirely by Xvfb.

---

## COULD-NOT-DETERMINE

Nothing in (a)–(h) was left undetermined. Two incidental limitations, neither affecting an
answer:

- `strings` is not installed in the container, so the neko binary's route table could not
  be enumerated directly. The screenshot route was found by probing candidate paths
  instead (recorded in (c)), which established it positively.
- WebRTC media and input **over the datachannel** were not exercised — no TURN relay is
  configured in this run (`ICE: no TURN relay configured — relay-less/STUN-only`). (f)
  tests XTEST at the X layer, which is the layer `start-neko.sh:1618` flagged as unverified
  and the layer any input fix must rely on; it does not test the WebRTC transport that
  carries events *to* neko.

---

## Interpretation

*Everything below is inference, not measurement. The answer lines and evidence above stand
on their own.*

- **The titlebar the user reports is Chrome's, not openbox's.** All four independent
  signals agree: `_NET_FRAME_EXTENTS=0,0,0,0`, `_OB_WM_STATE_UNDECORATED`, an openbox frame
  pixel-identical to its client with all decoration widgets collapsed to 1x1, and a
  screenshot whose caption buttons sit *inside* the tab strip row rather than in a band
  above it. Openbox's `class="Google-chrome"` rule matched and did exactly what it was
  written to do. **Any fix aimed at the openbox config is aimed at the wrong component**
  — the config is already working, and there is no WM decoration left to remove.
- **Why Chrome draws its own frame.** `_MOTIF_WM_HINTS = 2, 0, 0, 0, 0` is Chrome telling
  the WM "no decorations, I'll draw my own", and `custom_chrome_frame` being absent from
  Preferences means Chrome is on its default, which on Linux is its own custom frame. The
  plausible levers are therefore Chrome-side, not WM-side: seeding
  `browser.custom_chrome_frame` in the profile, or launching in a mode that has no frame
  at all (`--app=`, kiosk, or fullscreen). Which of those is appropriate is a design
  question this phase does not answer.
- **The screen API is more capable than assumed, and this is the most consequential
  correction here.** The working assumption was that `screen/set` is refused under Xvfb.
  It is not: shrinking works and really resizes the display, with the client following.
  The real constraint is the boot-time framebuffer — `Xvfb -screen 0 1920x1080x24` fixes
  the ceiling, and 422 is returned above it. So dynamic resize to any viewport at or below
  1920x1080 appears available **without** installing Xorg+dummy; installing Xorg+dummy
  would be needed only to exceed 1920x1080 or to offer a discrete mode list. That
  materially changes what W1 has to do, and the assumption is worth re-checking against
  whatever W1's brief currently states.
- **Input is not the problem.** XTEST delivers both pointer and keyboard to Chrome on this
  Xvfb base — proven by a synthetic click opening a tab and synthetic typing completing a
  real navigation. The `UNVERIFIED` caveat at `start-neko.sh:1618` can be retired for the X
  layer. If input appears broken to a user, the fault lies above X — in the WebRTC
  datachannel, TURN, or the client — not in XTEST. Note this run had no TURN configured,
  so the transport itself remains untested.
- **Incidental observation, not in scope.** The desktop boots with a Chrome infobar reading
  *"You are using an unsupported command-line flag: --no-sandbox. Stability and security
  will suffer."* occupying roughly 40px across the full width. It is visible in the primary
  screenshot and is part of what a user sees on a fresh desktop. Flagged only because it
  was in frame; no change was made.

---

## Cleanup

- Container `ezil-gt` was stopped and removed.
- Image **`ezil-ground-truth:local`** was left in place for later phases.
- The X display was restored to 1920x1080 before teardown.
- No source file was modified. This document is the only write.

---

## ADDENDUM — Chrome exit codes (added 2026-08-19 by the orchestrator)

Resolves W4's COULD-NOT-DETERMINE #2: *"What status does real Chrome exit with when a
user closes its last window?"* W4's clean-vs-crash rule in `supervise_app` depends
entirely on the answer, and a stub browser cannot supply it. Measured against real
`google-chrome-stable` **151.0.7922.71** inside the running worker image.

**(i) User closes the last window — VERIFIED `rc=0`.**

Launched with its own `--user-data-dir=/tmp/exitcode-probe` so it could not hand off
to the production instance, then closed via a real WM close request (`wmctrl -i -c`),
which is what a user clicking the caption ✕ sends:

```
probe window: 0x01000003  pid=800
--- closing its last window the way a user would (WM close request) ---
EXIT_CODE=0
```

⇒ W4's rule (`rc == 0 && uptime >= 5s` ⇒ clean, not charged to
`NEKO_APP_MAX_RESTARTS`) **does fire** on a genuine user quit. Without it, six closes
trip the fatal sentinel and `terminate_stack` kills the whole session.

**(ii) Hand-off to an already-running instance — VERIFIED `rc=0` after 116 ms.**

Second Chrome against the *same* profile as the running production browser:

```
handoff EXIT_CODE=0  uptime_ms=116
```

⇒ This is why the uptime half of the rule is load-bearing, and it is not a theoretical
concern. "Any `rc=0` is free" would have been an **unbounded hot restart loop** at
roughly 8 restarts/second. W4 predicted this failure mode and guarded it before it was
measured; the 5 000 ms threshold clears the observed 116 ms by a factor of ~43.

**Still open from W4's list:** whether the container actually *stops* after a release
(gated on `/proc/loadavg` and a successful final workspace flush, neither reproducible
outside a real Worker), and the ≤60 s window in which a second viewer's heartbeat has
not yet restored presence.

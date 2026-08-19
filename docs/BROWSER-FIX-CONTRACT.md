# The Browser-fix contract

**Status: PINNED. Single-authored. Do not edit if you are a Phase 1 agent** — if you
believe something here is wrong, say so in your final report and stop; do not work
around it. A contract described in two briefs is two contracts.

This document exists because twelve agents are changing one browser at the same time,
and six of them touch the same wire. Every name below — env var, route path, JSON
field, telemetry site, CSS class, file path — is fixed text. Use it exactly. Do not
invent a name that this document assigns to another task.

Companion document: `docs/NEKO-GROUND-TRUTH.md` (Phase 0a) records what a real
container actually does. Where this contract says "per ground truth", read that file
before you write code.

---

## 1. What we are building, in one paragraph

The streamed desktop must fit the shape of the window it is shown in — including a
portrait phone — instead of being pinned to 1920x1080 and letterboxed down to a
strip. It must present exactly one set of window controls (the shell's), not two.
Closing it must actually release the container. And a phone user must be able to
type into it.

---

## 2. Environment variables

| Name | Owner | Values | Default | Meaning |
|---|---|---|---|---|
| `NEKO_SCREEN` | W1 reads, W2 writes | `WxHxD`, e.g. `1170x2532x24` | `1920x1080x24` | The X screen the desktop boots at. Already exists at `start-neko.sh:138` and is already `${NEKO_SCREEN:-…}`-overridable. W2 injects it per-session; W1 must keep honouring it under the new X server. |
| `EZIL_X_FRAMEBUFFER` | W1 | `WxHxD` | `1920x1920x24` | The Xvfb framebuffer — the **ceiling**, not the visible size. Every mode in §3 must fit inside it in both dimensions. Clamped **up** to contain `NEKO_SCREEN` in both axes, with a warning. Stays a literal `Xvfb -screen` argument so validators can read it from argv. **PINNED** — W1 built and proved this name. |
| `EZIL_BROWSER_DECOR` | W3 | `on` \| `off` | `off` | `off` = no window decorations on the in-stream browser. The kill switch if undecorating misbehaves. |
| `EZIL_NEKO_LOGS` | W10 | `on` \| `off` | `on` | Kill switch for the container log-tail route, matching the existing `SANDBOX_CPU_DIAG` / `SANDBOX_WORKSPACE_DIAG` pattern. |

No other new environment variables. If you think you need one, report it; do not add it.

---

## 3. The requestable screen modes

W2 may request **only** sizes from this list. Anything else is a contract violation
and W2 must snap to the nearest entry by aspect ratio, then by area.

> **CORRECTED 2026-08-19 after Phase 0a.** This list was originally to be compiled
> into an Xorg `dummy`-driver modeline list. **That migration is cancelled** — see
> `docs/NEKO-GROUND-TRUTH.md` §e. Xvfb's RandR is not a stub: `XRRSetScreenConfig`
> works against it, and the framebuffer allocated at startup is a *ceiling*, not a
> fixed size. Verified on a real container: with `NEKO_SCREEN=1920x1920x24`,
> `POST /api/room/screen {"width":1080,"height":1920}` returned 200 and the X
> display, the Chrome window and neko's own capture all became 1080x1920. So the
> modes below are simply "every size that fits inside the framebuffer", and the
> whole X-server change is one larger framebuffer.

| Mode | Shape | For |
|---|---|---|
| `1920x1080` | 16:9 landscape | default; desktop |
| `1600x900` | 16:9 landscape | smaller desktop window |
| `1280x720` | 16:9 landscape | low-bandwidth / small window |
| `1440x900` | 16:10 landscape | laptop |
| `1280x800` | 16:10 landscape | laptop |
| `1024x768` | 4:3 landscape | tablet landscape |
| `1280x1024` | 5:4 landscape | legacy monitor |
| `1200x1600` | 3:4 portrait | tablet portrait |
| `1080x1920` | 9:16 portrait | phone portrait |
| `896x1600` | ~9:16 portrait | phone portrait, cheaper |
| `720x1280` | 9:16 portrait | phone portrait, cheapest |
| `768x1024` | 3:4 portrait | tablet portrait, cheaper |

Rules that bind every task:

- **Width must be a multiple of 8; height need only be even.** Not a style rule —
  **Xvfb's RANDR floors screen width to an 8-pixel cell.** Measured by W1:
  `900x1600` → applied **`896x1600`**, `902x902` → `896x902`, while `1080x1918`
  applies exactly (height is not quantised). This is why the table entry above reads
  `896x1600` and not `900x1600`. Enforce 8-alignment in the server-side clamp so a
  caller can never request a width the platform silently changes underneath it.
- **`1920x1080` stays the default and the fallback.** If a mode request fails for any
  reason, the desktop must end up at 1920x1080, never at nothing.
- **Every mode must fit inside `EZIL_X_FRAMEBUFFER` in both dimensions.** A mode
  larger than the framebuffer is refused at runtime with HTTP 422 `cannot set screen
  size` — observed, not theorised. The default `1920x1920x24` contains all twelve.
- **The pixel ceiling is 1920x1080 = 2,073,600 px.** No mode above it. `PLATFORM-NOTES`
  §23 measures an idle attached session at 0.237 cores on a 2-vCPU container; a larger
  framebuffer spends that budget with no one asking for it.
- `24` is the only colour depth. `NEKO_SCREEN`'s third field is always `x24`.

---

## 4. The sizing wire (W2 owns all of it)

### 4.1 Boot-time sizing — Tier 1

The shell measures its window body **before** requesting the desktop, and passes it
through the existing desktop-open call. No new route.

`POST /api/shell/desktop` request body gains one **optional** field:

```json
{ "computerId": "…", "screen": { "width": 1080, "height": 1920 } }
```

- `screen` absent, malformed, or out of range → server behaves exactly as today.
  **This must remain true**: an old cached bundle must keep working against a new
  server, and a new bundle must keep working against an old server.
- The app layer snaps `{width,height}` to the §3 table and forwards the snapped value
  to the Worker, which sets `NEKO_SCREEN=<W>x<H>x24` in the container's boot env
  alongside the existing neko credential env.
- The response gains one **optional** field so the shell can tell what it actually
  got, rather than assuming its request was honoured:

```json
{ "…existing fields…": "…", "screen": { "width": 1080, "height": 1920, "source": "requested" } }
```

`source` is one of `"requested"` (the shell's ask was honoured), `"snapped"` (a
different §3 mode was chosen), `"default"` (no ask, or the ask was rejected).

### 4.2 Live resize — Tier 2

New route, feature-detected exactly the way `focus` is
(`shell/ezil/apps/desktop-window.js` reads `desktopState.endpoints.focus` and draws
nothing when the key is absent — copy that, do not invent a new detection style).

- App route path: **`/api/shell/screen`**
- `SHELL_API_ROUTES` key and `session.js` `ENDPOINTS` key: **`screen`**
- Worker route: **`POST /sandbox/:name/screen`**, HMAC-gated with the same envelope
  as `POST /sandbox/:name/focus`.

```
POST /api/shell/screen
  { "computerId": "…", "width": 1080, "height": 1920 }
->
  { "ok": true,  "width": 1080, "height": 1920, "source": "requested"|"snapped", "correlationId": "…" }
  { "ok": false, "error": { "code": "…", "message": "…" }, "correlationId": "…" }
```

Error codes, closed set: `BAD_REQUEST`, `NOT_FOUND`, `UNSUPPORTED` (the running X
server cannot change mode), `UPSTREAM` (neko refused), `TIMEOUT`.

Implementation notes that are part of the contract, not suggestions:

- Reach neko via the **existing** admin path — `deriveNekoAdminValue` + `POST
  /api/login` + the cached bearer token in `cloudflare-guacamole-provider.ts`. Do not
  mint a second credential path.
- `POST /api/room/screen` on the neko side, request shape `{width, height, rate}`,
  `rate: 60`. **This is confirmed working against the real pinned build** — 200 on
  success, 422 `cannot set screen size` when the mode exceeds the framebuffer, and
  the X display, the Chrome window and neko's capture all follow. Admin bearer token
  from `POST /api/login`. See `docs/NEKO-GROUND-TRUTH.md` §e and the correction note
  in §3 above.
- Neko sets an initial screen size at startup from the baked `/etc/neko/neko.yaml`
  (`desktop.screen: "1920x1080@60"`), which is why a larger framebuffer alone does
  not change what the user first sees. W1 owns making `NEKO_SCREEN` drive that.
- 🔴 **Always read back with `GET /api/room/screen`. The POST response is not
  evidence.** Measured by W1: requesting `900x1600` returns HTTP 200 with
  `{"width":900,"height":1600}` while the display is really **896x1600** — the POST
  echoes what was *asked*, not what was *applied*. Deriving `source` from the POST
  response would report `"requested"` for a size that never existed and would never
  once fire the `contract_violation` case that field exists to catch.
- 🔴 **`GET /api/room/screen/configurations` is a ceiling, not a mode list.** It
  returns exactly one entry — the framebuffer, `rate: 0`. Any size fitting inside it
  in both axes is settable. Snap from the §3 table; never treat absence from
  `configurations` as "unsupported".
- Debounce client-side at **500 ms** trailing, and never send a request identical to
  the last-applied size.
- Resizing does **not** restart the apps: after 20+ live resizes W1 measured
  `chromium restarts: 0`, `codeserver restarts: 0`. Note this does not confirm the
  "5-10s interruption plus full software-vp8 re-init" claim at `desktop-window.js:290`
  — that figure has no measurement behind it anywhere in the repo, and the encoder
  path needs a subscribed WebRTC client (TURN-gated) to exercise.
- A resize is a **capture-pipeline restart**. It must never fire from a `ResizeObserver`
  tick alone during an active drag — only when the size has settled.

### 4.3 `fit_stream` — one owner

`fit_stream` in `shell/ezil/apps/desktop-window.js` letterboxes to a hardcoded 16:9.
**W2 is its only owner.** It must become a function of the *actual current* stream
size, not the `STREAM_W`/`STREAM_H` constants. W7 must not touch it; if W7 needs the
box to behave differently on a phone, that requirement goes to W2.

---

## 5. The in-stream window (W3 owns all of it)

Target, as approved: **no title bar, no minimize/maximize/close inside the stream;
the tab strip and address bar stay.** The shell's own controls become the only ones.

> **CORRECTED 2026-08-19 after Phase 0a.** The original text here assumed openbox
> might be failing to match `class="Google-chrome"`. **It is not.** Ground truth §a-§d:
> the class is literally `Google-chrome`, the rule matches, openbox parses its config
> cleanly, `_NET_FRAME_EXTENTS = 0,0,0,0`, `_OB_WM_STATE_UNDECORATED` is set, and the
> screenshot shows no openbox titlebar at all. **The window manager is already doing
> exactly what it was told.**
>
> The bar the user sees is **Chrome's own frame** — its tabstrip with Chrome's
> minimize / restore / close caption buttons drawn inside the tab row.
> `custom_chrome_frame` is *absent* from the profile's `Preferences`, so Chrome is on
> its Linux default, which is to draw its own frame; `_MOTIF_WM_HINTS = 2,0,0,0,0` is
> Chrome telling the WM not to decorate it. Every layer of the fix therefore targets
> **Chrome**, and none of it targets openbox.

1. **Make Chrome use the system frame instead of its own.** Seed
   `browser.custom_chrome_frame: false` into the profile's `Default/Preferences`
   **after** the `rm -rf "$CHROME_PROFILE_DIR"` at `start-neko.sh:~1320` and **before**
   the `supervise_app chromium` launch at `~1348`. The profile is wiped every boot, so
   this must be re-seeded every boot; there is nowhere persistent for it to live.
   Openbox's existing `<decor>no</decor>` then removes the system frame it asks for,
   and the result is the approved design: tab strip and address bar at the very top,
   no title bar, no caption buttons.
2. **Do not touch `worker/assets/ebuilder-openbox.xml` except to leave it working** —
   and understand that this is a load-bearing constraint, not a formality.

   > **Measured by W9, 2026-08-19.** Today that rule is *redundant*: pointing a running
   > openbox at a config targeting a bogus class leaves the browser undecorated anyway,
   > because Chrome's own `MWM_DECOR_NONE` already suppresses WM decoration. **The
   > moment layer 1 lands, that flips.** Repeating the same experiment with
   > `custom_chrome_frame=false` brings the window back **fully decorated** —
   > `_NET_FRAME_EXTENTS = 1,1,20,5`, frame `802x625+9+0` vs client `800x600+10+20`.
   > After this change the openbox rule is the **only** thing removing the titlebar, so
   > weakening it makes the product worse than it is today.

3. **Verify with `_MOTIF_WM_HINTS[2]`, which is the proven signal.** Read back after the
   window-ready gate, log the literal WM_CLASS every boot, and emit
   `container:neko#decor` / `decor_still_present` (§8) if the window is still drawing
   its own frame.

   > **Measured by W9 against pixels, not inferred.** Running a second Chrome with the
   > pref set in a live container:
   > ```
   > pref absent  ->  _MOTIF_WM_HINTS = 0x2, 0x0, 0x0, 0x0, 0x0
   > pref false   ->  _MOTIF_WM_HINTS = 0x2, 0x0, 0x1, 0x0, 0x0
   > ```
   > and a screenshot confirmed the minimize/restore/close buttons are gone from the tab
   > row in the second case. **`_MOTIF_WM_HINTS[2] != 0` is a positive machine-checkable
   > assertion that Chrome is not drawing its own frame.** `worker/scripts/validate-neko-browser-window.sh`
   > already asserts exactly this as `browser.chrome_frame.no_caption_buttons`. Use the
   > same property — two checks agreeing on one property is the goal; two checks
   > measuring almost-the-same property is how drift starts.
   >
   > This also settles the risk that Chrome might reject a hand-seeded `Preferences`:
   > W9 got the pref to take effect in a live Chrome at this version, so the mechanism
   > is sound. Evidence is still owed that it takes effect *from `start-neko.sh`*.

   `xprop`, `obxprop`, `wmctrl` and `xdotool` are all available in the built image.
4. **Also suppress the `--no-sandbox` infobar.** The screenshot shows Chrome's yellow
   *"You are using an unsupported command-line flag: --no-sandbox. Stability and
   security will suffer."* banner eating a strip across the top of every session. It
   is cosmetic but it is on screen for every user, so it belongs in this task.

**Do not use `--kiosk` and do not use `--app=`.** Both remove the tab strip and
address bar, which the approved design keeps.

---

## 6. Close and minimize (W4 owns all of it)

Two distinct defects sharing one user report.

**6.1 The shell close does not release.** `dispose()` stops timers and the activity
heartbeat and calls nothing server-side; the container then idles ~10 minutes before
stopping. Add an explicit release on close. Constraints:

- The release is **best-effort and must never block or fail the close.** A user
  closing a window must always get a closed window. Fire it, do not await it in a way
  that can hang, and treat every failure as non-fatal.
- Reuse the existing activity transport shape. A release is "report that presence
  ended", not a new lifecycle verb — do not add a `destroy`/`terminate` verb to the
  shell. The shell has never had the power to destroy a container and this change
  must not give it one.
- Minimize is **not** a release. A minimized window's desktop stays up.

**6.2 A browser quit inside the stream can kill the session.** `supervise_app`
restarts Chrome on any exit and does not look at the exit code; the 6th exit exhausts
`NEKO_APP_MAX_RESTARTS=5`, trips the fatal sentinel, and `terminate_stack` kills
Xvfb, openbox, neko and all. Once W3 removes the close button this is much harder to
reach, but it must still not be reachable by ordinary use. Distinguish a **clean
user-initiated exit** from a **crash**, and do not let the former walk the budget
toward a session kill. Report the design you chose; do not silently make the budget
infinite, because a genuine crash-loop must still terminate.

---

## 7. Touch and keyboard

**7.1 Focus activation (W5).** Every click-to-focus binding in the shell is
`mousedown`-only, and `.window-app-iframe` is `pointer-events: none` until
`.window-active`. On touch the first tap is therefore always swallowed. Add
`pointerdown` alongside each existing `mousedown` binding. Rules:

- **Add, do not replace.** Removing `mousedown` risks regressing desktop behaviour
  that ~45 CSS rules and several suites depend on.
- Guard against double-firing: a touch produces `pointerdown` *and* a synthesized
  `mousedown`. Focusing twice must be a no-op, not two focus events.

**7.2 The keyboard (W6).** The neko client is cross-origin; the shell cannot reach
into it. The one lever is `worker/assets/neko-branding/www/index.html`, which is a
whole-file replacement we own and which is copied to `/var/www/index.html`. Add an
EZiL script there.

- The script is a **new separate file** copied alongside, not a giant inline blob:
  `worker/assets/neko-branding/www/ezil-mobile.js`, referenced from `index.html`.
- It must be a **no-op on non-touch devices.** Gate on touch capability, not on width.
- `worker/scripts/neko-branding.test.ts` asserts the branding overlay never
  reintroduces the upstream strings. Read that test before writing, and keep it green.
- Every `<script>`/`<link>` tag and hashed filename that is already in `index.html`
  must stay byte-identical. You are adding one tag, not rewriting the file.
- **XTEST input is CONFIRMED WORKING** (ground truth §f) — pointer and keyboard both,
  via true XTEST, verified with real synthetic events: a synthetic click opened a tab
  and synthetic typing navigated the browser. `start-neko.sh:1618`'s long-standing
  "UNVERIFIED" comment is resolved in the affirmative. So a keyboard affordance can
  genuinely work, and there is no excuse for one that does nothing.

**7.3 Mobile layout (W7).** Device detection is currently pure UA sniffing
(`isMobile.phone` in `boot.js` `set_device_class`), so a narrow desktop window is
never `device-phone` and no test has ever executed the `.device-phone` path. Widen the
signal to include coarse pointer and viewport width. Add a `visualViewport` listener
so a raised keyboard resizes the desktop rather than covering it. **W7 does not touch
`fit_stream`** — see §4.3.

---

## 8. Telemetry and logging (W10 owns the plumbing; everyone uses the names)

**Do not add a new `eventClass`.** The nine-member set is duplicated in three files
(`app/src/server/telemetry/types.ts`, `shell/ezil/telemetry.js`,
`worker/src/telemetry.ts`) plus a per-class `attrs` allow-list, and twelve agents each
adding one is exactly how those three copies drift apart.

Use the **existing** classes with these **new `site` values**:

| site | class | when |
|---|---|---|
| `ezil-os:apps/desktop#screen` | `api_failure` | a screen-size request failed |
| `ezil-os:apps/desktop#screen` | `contract_violation` | the server applied a size the client did not ask for and did not offer as a snap |
| `ezil-os:apps/desktop#close` | `window_error` | a release-on-close attempt failed |
| `ezil-os:apps/desktop#keyboard` | `window_error` | the keyboard affordance could not arm |
| `container:neko#decor` | `contract_violation` | the browser window was still decorated after enforcement |

`code` values are short, lowercase, **underscore-separated**, and stable — e.g.
`screen_unsupported`, `screen_upstream`, `decor_still_present`, `xtest_dead`. Max 64 chars.

> **CORRECTED 2026-08-19.** This originally said *hyphenated*. That was wrong and
> unbuildable: `normalizeCode` (`shell/ezil/telemetry.js:191-194`) rewrites every
> non-`[a-z0-9_]` run to `_`, and the server's zod schema
> (`app/src/server/telemetry/schema.ts:39`) rejects anything not matching
> `/^[a-z0-9_]+$/`. Both sides already agreed; only this document was out of step.
> A hyphenated code would have silently become an underscored one on the wire, so
> the *observed* names would not have matched the *documented* ones — the contract
> bends to the code here, not the other way round. Caught by W4.

> **CORRECTED 2026-08-19 by W11 — this section had it exactly backwards.**
> `0001_telemetry.sql` **was already applied**, on or before 2026-08-04. All three
> tables exist on project `btgqfmnzycdecmeyqubx` with RLS on, 3 policies, 7 indexes,
> 3 CHECKs, 2 FKs — an exact match for the file. `ezil_error_events` holds **199
> inserts / 109 deletes / 84 live rows**, autovacuumed today, oldest surviving row
> exactly 14 days back, so the retention cron is running too. `docs/RUNBOOK.md:27-78`
> and `docs/telemetry.md:38-42` are both stale on this point and integration should
> correct them. Telemetry you add **is** readable.

🔴 **But the container/worker producer has never once worked in production.** All 193
recorded occurrences are `source='shell'`. **Zero** rows have ever arrived with
`source='worker'` or `source='container'`. So before anything relies on a
`container:neko#*` site — W3's `decor_still_present`, W4's `app_exit`, or any new one —
treat that producer as **unproven in production**, not merely unused. The NDJSON
sidecar is drained by `drainContainerBootTelemetry` at *boot*, so a row written during
a live session only ships on the *next* boot; whether that path has ever completed
end-to-end is an open question and worth one deliberate check.

🔴 **`computer_id` is NULL on all 84 shell rows**, contradicting `docs/telemetry.md`.
Error events cannot currently be joined to a computer. If you touch the ingest path,
this is worth fixing — it is the difference between "something failed" and "this
user's computer failed".

**Container logs.** W10 adds `POST /sandbox/:name/logs`, modelled line-for-line on the
existing `handleCpuDiag`: hardcoded path (`/tmp/neko.log`), byte cap, the same HMAC
envelope, the same kill-switch shape. The path must **not** be caller-supplied.

---

## 9. File ownership

Two agents editing one file is the failure mode this table exists to prevent. If your
task needs a change in a file you do not own, **request it in your final report** —
do not make it.

| Path | Owner | Region |
|---|---|---|
| `worker/Dockerfile` | W1 | whole file |
| `worker/assets/ebuilder-xorg.conf` (new) | W1 | whole file |
| `worker/scripts/start-neko.sh` | **shared — by region** | see below |
| `worker/assets/ebuilder-openbox.xml` | W3 | whole file |
| `worker/assets/neko-branding/**` | W6 | whole subtree |
| `worker/scripts/validate-*.sh` | W9 | whole files |
| `worker/src/index.ts` | **shared** — W2 (boot env injection only), W10 (logs route only) | |
| `worker/src/sandbox-control.ts` | W4 | whole file |
| `worker/src/telemetry.ts` | W10 | whole file |
| `app/src/server/lib/cloudflare-guacamole-provider.ts` | W2 | whole file |
| `app/src/server/api/routers/cloudflare-guacamole.ts` | W2 | whole file |
| `app/src/app/api/shell/screen/route.ts` (new) | W2 | whole file |
| `app/src/server/shell/boot-payload.ts` | W2 | whole file |
| `app/src/server/telemetry/types.ts` | W10 | whole file |
| `shell/ezil/apps/desktop-screen.js` (new) | W2 | whole file |
| `shell/ezil/apps/desktop-window.js` | **shared** — W2 (sizing + stream fit), W4 (`dispose` and the close path) | |
| `shell/ezil/session.js` | **shared** — W2 (`screen` endpoint), W4 (release verb) | |
| `shell/src/UI/UIWindow.js` | W5 | whole file |
| `shell/ezil/ui/app-drawer.js` | W5 | whole file |
| `shell/ezil/boot.js` | W7 | `set_device_class` only |
| `shell/src/css/style.css` | W7 | `.device-*` rules only |
| `shell/ezil/ui/ezil-shell.css` | W7 | whole file |
| `shell/src/css/dashboard.css` | W7 | the `(pointer: coarse)` and `(max-width: 500px)` blocks only — **added 2026-08-19, was unassigned** |
| `shell/ezil/telemetry.js` | W10 | whole file |
| `shell/ezil/ui/Settings/tabs/troubleshoot.js` | W10 | whole file |
| `shell/ezil/apps/mobile-browser-test.mjs` (new) | W8 | whole file |
| `shell/run-tests.sh` (new) | W8 | whole file |
| `shell/ezil/apps/resize-test.mjs` | W8 | whole file |
| `docs/NEKO-GROUND-TRUTH.md` | Phase 0a | read-only to everyone else |
| `docs/BROWSER-FIX-CONTRACT.md` | Phase 0b | read-only to everyone |
| `docs/PLATFORM-NOTES.md`, `docs/RUNBOOK.md` | integration only | append findings via your report, do not edit |

### `start-neko.sh` regions

The file is 1694 lines and three tasks need different parts of it. Stay inside your
region; disjoint hunks merge cleanly, overlapping ones do not.

| Region | Lines (approx, verify before editing) | Owner |
|---|---|---|
| X server startup | ~830–890 | W1 |
| `supervise_app` / `monitor_apps` / `terminate_stack` | ~950–1140 | W4 |
| Chrome profile + launch + switch helper | ~1180–1420 | W3 |
| neko env + `neko serve` | ~1520–1660 | W1 (screen-related only) |

---

## 10. Rules that bind every Phase 1 agent

1. **You do not certify your own work.** A different agent verifies every change
   against a real container in Phase 2. Write your report so that verification is
   possible: state exactly what you claim, and exactly what command proves it.
2. **A test that mocks the thing it tests proves nothing.** This repo already shipped
   an openbox `decor=no` rule that may never have matched, guarded by a test that
   greps the XML for a substring, and a `wmctrl` stub that *supplies* the WM_CLASS the
   gate looks for. Do not add another. If your change is only provable in a container,
   say so and write a container check — do not write a unit test that asserts the
   string you just typed.
3. **Say what you could not verify.** "COULD-NOT-DETERMINE, because X" is a good
   result. A confident claim that turns out to rest on an assumption is not.
4. **Keep the existing suites green.** Baseline: worker `790 pass / 1 skip`, app
   `586 pass`, 11 shell node suites, 8 shell browser suites,
   `shell/build-shell.sh --check` clean, both typechecks clean. The one known-red
   test is `shell/ezil/apps/resize-test.mjs` (16/18), which is W8's.
5. **Rebuild the bundle if you touched `shell/`.** `shell/build-shell.sh` writes
   `app/public/os/bundle.min.js`, and `--check` fails if it drifts.
6. **Do not deploy.** Not `wrangler deploy`, not a Vercel push, not a docker push.
   Integration deploys, once, at the end.
7. **Do not change the default behaviour of a kill switch** without saying so loudly
   in your report. `EZIL_X_SERVER` in particular ships as `xvfb` until a container run
   proves `xorg`.

# Build an app for the EZiL-OS desktop

This is a guide for adding a window to the EZiL-OS shell — the browser desktop
that boots at `/os`. It assumes you have already read
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) (licensing, DCO, the bundle build)
and [`./LOCAL-MODE.md`](./LOCAL-MODE.md) if you plan to run the desktop
locally while you work.

Every fact below is cited to the line in the source that backs it. Where a
claim could not be verified by reading the code, it says so rather than
guessing.

## What an app is here

There is no app store and no remote manifest. The set of things the shell can
open is a static array, `APPS`, built into the bundle at build time
(`shell/ezil/apps/registry.js:286-409`). The file's own header explains why:
"EZiL's shell has no app store to query and no remote manifest to fetch: the
set of things it can open is fixed at build time, and pretending otherwise
would mean a network round trip whose answer never changes"
(`registry.js:15-18`).

An "app" is therefore one entry in that array — an **`AppDescriptor`** — plus
an `open(ctx)` function that builds a real DOM window and returns it.

## The `AppDescriptor` fields

The full shape is documented as a JSDoc `@typedef` at `registry.js:260-282`:

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | Matches `data-app` on the window and the taskbar item. |
| `name` | `string` | User-facing. Shown in the taskbar tooltip and the drawer. |
| `icon` | `string` | An `<img src>`-ready value (a data URI — see below). |
| `pinned` | `boolean` | Sits in the taskbar whether or not it is open. |
| `single_instance` | `boolean` | A second launch focuses the first window instead of opening a duplicate. |
| `shell_local` | `boolean?` | Runs entirely in this bundle; the server does not need to agree it exists. See "Shell-local vs. hosted" below. |
| `wants_settings_in_drawer` | `boolean?` | This app's window carries a full-bleed control tray, so the tray must also carry a Settings button. |
| `owns_boot_trace` | `boolean?` | `open()` returning does *not* mean the boot is over — this app finishes its own trace later, at its real terminal state. See "The boot-trace contract" below. |
| `open` | `(ctx: object) => Promise<HTMLElement\|null>` | Builds the window and returns it, or `null` if nothing opened. |

The four real entries — `desktop`, `settings`, `preview`, `code`
(`registry.js:287-408`) — are the worked examples for every field above; read
one alongside this table if a field's purpose isn't clear from the table
alone.

### Icons

Icons are inline SVG turned into data URIs by a shared helper,
`appIcon(id, from, to, glyph)` (`registry.js:180-193`) — **not** exported, and
not looked up from `window.icons`. The file's own comment gives the reason
twice over (`registry.js:118-125`): nothing in the ported Puter icon set means
any of these apps, and the ported icon tree
(`shell/src/icons/`) is the Puter-derived attribution record — dropping new,
EZiL-authored artwork into it would misattribute it, and widening
`build-shell.sh`'s icon glob to a second directory is a bigger change than the
icons are worth. A new app's icon is therefore a new `appIcon(...)` call
living beside `DESKTOP_ICON`/`SETTINGS_ICON`/`PREVIEW_ICON`/`CODE_ICON`
(`registry.js:203-259`) inside `registry.js` itself, in the same PR that adds
the `AppDescriptor`.

These are functional glyphs, not a brand mark — the file says so directly:
"These are FUNCTIONAL app glyphs — a globe, a cog, `</>`, an eye. None of them
is, and none of them may become, an EZiL brand mark" (`registry.js:151-153`).

## Shell-local vs. hosted — the two-sided handshake

This is the one rule with one exception, and both are spelled out at the top
of `registry.js`:

> "A HOSTED entry exists only if BOTH sides agree it can be launched today:
> this array (the client knows how to draw it) AND `payload.apps` (the server
> confirms it can actually serve it...). `resolve()` below intersects the
> two. An icon that opens nothing is worse than a missing icon, because the
> user spends their attention finding out." (`registry.js:20-26`)

Concretely, `resolve(payload)` (`registry.js:491-515`) reads
`payload.apps` — the boot payload's app list — and keeps an entry only if its
`id` is in that list, **unless** the entry declares `shell_local: true`, in
which case it is kept unconditionally (`registry.js:502-503`). The server side
of that list is `SHELL_APPS` in
[`app/src/server/shell/boot-payload.ts`](../app/src/server/shell/boot-payload.ts):

```ts
export const SHELL_APPS: readonly ShellBootApp[] = [
    { id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' },
];
```

(`app/src/server/shell/boot-payload.ts:185-193`, current content as of this
writing.) `resolve()` warns to the console, in both directions, on a mismatch
between the two lists (`registry.js:502-513`) — a client-only app is a button
that fails, a server-only app is a capability nobody can reach.

**This makes a *hosted* app a two-file change**: an entry in `registry.js`'s
`APPS` array (this repo, shell side) *and* an entry in `SHELL_APPS`
(`app/src/server/shell/boot-payload.ts`, the Next.js app side) confirming the
server can actually provision it. If you cannot make both edits in one PR —
for instance the server-side capability doesn't exist yet — your app almost
certainly wants `shell_local: true` instead (see below), or your PR needs to
say explicitly which follow-up PR will add the `SHELL_APPS` entry.

**The exception, `shell_local: true`,** is for an app that runs entirely in
this bundle: "there is nothing the host could fail to provision, so gating it
on a server list cannot prevent a broken icon, it can only produce a missing
one" (`registry.js:28-32`). `settings` and `preview` are both `shell_local`
today, each for a reason recorded on its own entry
(`registry.js:319-329` for `settings`, `registry.js:355-365` for `preview`) —
worth reading if you're unsure which category your app falls into.

**A document viewer that only ever reads a file the user handed it (see "How
an app gets content" below) is shell-local**: it has no server-side capability
to provision, in the same sense `settings` does not. It should set
`shell_local: true` and needs no `SHELL_APPS` entry.

⚠️ A subtlety worth knowing before you write a test: `resolve(payload)` treats
a payload with **no** app list (`payload?.apps` not an array) as "show every
known app" and returns `[...APPS]` unfiltered, logging a warning
(`registry.js:492-496`). A jsdom test that calls `ezil.boot()` without setting
`window.__EZIL_BOOT__` first will therefore see *every* app resolved,
`shell_local` or not — that proves nothing about what a real boot serves. To
actually exercise the two-sided handshake, pass a `payload.apps` list that
does or doesn't include your app's `id`, the way
`registry-trace-test.mjs` does (see "Tests to add" below).

## The boot-trace contract

Every `launch(id, ctx)` call opens one trace (`beginTrace(id)`,
`registry.js:632-633`) and is responsible for closing it with **exactly one**
`boot_summary` telemetry event. The three legal outcomes are a closed
enum — `'ok' | 'error' | 'skipped'`
(`shell/ezil/trace.js`'s own JSDoc on `.end()`) — and passing anything else is
not an error, it is *silently coerced to `'error'`*:

```js
const safeOutcome = (outcome === 'ok' || outcome === 'skipped' || outcome === 'error') ? outcome : 'error';
```

(this line is inside `beginTrace()`'s returned `end()` method in
`shell/ezil/trace.js`). Calling `trace.end('ready')`, or any other string
outside the three, reports a **successful** open as a **boot failure** —
exactly the "false ready" this project's boot-honesty rule exists to prevent,
just inverted. Always pass one of the three literal strings.

**Who ends the trace, and when**, depends on `owns_boot_trace`:

- **Unset (the default)** — `settings` is the example. `open()` resolving
  *is* the whole story: the window exists, fully built, the instant the
  promise resolves. `launch()` itself ends the trace right after `await
  app.open(...)` returns, as `'ok'` if a window came back or `'skipped'` if it
  did not (`registry.js:735-750`). An app in this category **must not** call
  `ctx.trace.end` itself — `settings` never does.
- **`owns_boot_trace: true`** — `desktop`, `preview`, `code`. `open()`
  returns the instant the `UIWindow` exists, but real content (a container
  mint, a frame confirmation) is still in flight, fired off with `void
  start_boot()` and deliberately not awaited. Ending the trace the moment
  `open()` resolves would time a boot that had not actually finished — this
  was a real, measured bug: "real desktop opens of 11150ms and 3631ms each
  produced `durationMs=22`/`12` and an `ok` outcome for an open that... went
  on to fail" (`registry.js:222-227`). So for these apps, `launch()` hands the
  app `ctx.trace = { step, end }` and the app itself calls `ctx.trace.end(...)`
  once it reaches its **own** terminal state — see `preview.js`'s
  `trace.end('ok')` the moment its frame is confirmed, or `trace.end('error')`
  on a failed mint, as worked examples.

**The 240 s fallback.** If an `owns_boot_trace` app's window opens but the app
never calls `ctx.trace.end` (a bug, an uncaught path), `launch()` arms a
fallback timer the moment it hands off the trace
(`registry.js:683`, guarded by `TRACE_FALLBACK_TIMEOUT_MS`, `registry.js:108`):

```js
export const TRACE_FALLBACK_TIMEOUT_MS = 240_000;
```

At 240 seconds it force-closes the trace as `'error'` — never a fourth value,
because the wire enum only has three outcomes (`registry.js:80-89`). `.end()`
is idempotent (a second call is a no-op, `trace.js`'s own doc on `.end()`), so
this racing your app's real, on-time `.end()` call is harmless — whichever
runs first wins.

**What the summary carries.** `.end(outcome)` returns
`{ correlationId, name, outcome, totalMs, phases }`
(`trace.js`'s JSDoc on `.end()`), where `phases` is an ordered, capped list of
whatever `.step(code)` breadcrumbs your `open()` (or `launch()` itself)
recorded, e.g. `"launch_start:0,open_resolved:14,drawer_ready:16"`. This is
what lands in the `boot_summary` telemetry event
`registry.js`'s `launch()` builds from it.

**Boot honesty.** Never call `.end('ok')` (or let `launch()` call it on your
behalf, by not declaring `owns_boot_trace`) before the window actually has
content a user can see. If your `open()` returns before your content exists —
a file still loading, a container still minting — set `owns_boot_trace: true`
and end the trace yourself, later, at the real moment you know the outcome.
Reporting "ready" before you have something to show is the exact defect class
this contract exists to catch.

## Focus and stacking

Z-order in this shell is decided by **focus**, not by any per-window counter.
`style.css` gives every `.window` a flat `z-index: 9999999 !important`
(`shell/src/css/style.css:796-798`, for `.device-phone`/`.device-tablet`, part
of a two-tier band — see below), which overrides `UIWindow`'s own inline
value; the rule that actually orders windows is "focused = highest,
unfocused = one below" (`registry.js`'s `ensureOnTop()` doc block,
`registry.js:527-529`). Whichever window is focused *last* wins.

**Why `ensureOnTop()` exists** (`registry.js:553-576`): a window's own
focus is not always applied synchronously — `$.fn.showWindow` focuses on an
80ms `setTimeout`. If your window's `open()` resolves, `launch()` returns it,
and *then* something with a delayed focus lands (a desktop window being
restored, say), your freshly opened window can end up buried underneath it —
measured, on a phone, as a window that is on screen but untappable
(`registry.js:539-552`). `ensureOnTop()` re-asserts focus once, 120ms later
(comfortably after the 80ms delay can have landed), and only if something is
genuinely now above the window — never an unconditional steal-back.
`launch()` calls it on every window it returns, new or restored
(`registry.js:748` and `registry.js:618`). You do not need to call it
yourself; it is part of `launch()`, not part of your `open()`.

**The phone/tablet band.** On a phone or tablet, every `.window` still gets
the flat `9999999 !important`, but it is split into two tiers along
`.window-active` — the class `focusWindow` puts on exactly one window
(`shell/src/css/style.css:727-795`, the "PHONE/TABLET WINDOW BAND" comment
block, and the rule immediately below it):

```css
.device-phone .window, .device-tablet .window {
    z-index: 9999999 !important;
}
.device-phone .window:not(.window-active),
.device-tablet .window:not(.window-active) {
    z-index: 9999998 !important;
}
```

(`shell/src/css/style.css:796-800`.) This exists because on a phone, app
windows are full-bleed and exactly co-extensive — with one flat z-index for
every window, "a user could not raise one window above another at all"
(`style.css:730-747`, describing the pre-fix bug, MEASURED with
`document.elementFromPoint` returning the buried window's own body). Your app
does not need to do anything for this to apply; it is automatic for every
`.window`. `stay_on_top` windows (a class of window this guide does not
cover) sit above both tiers via an inline `!important` in the 99999999+ range
and are untouched by either rule (`style.css`'s own note beside the band).

## How an app gets content today

🔴 **There is no shell-callable file API.** The Worker does have a
`/project-files/*` HMAC-gated proxy (`worker/src/project-files.ts:1-45`) that
performs `put`/`get`/`head`/`delete`/`list` against an R2 bucket — but it is
wired only to `worker/src/workspace-persist.ts`, `workspace-seed.ts`, and
`sandbox-control.ts` inside the Worker itself, and to
`apps/web/client/src/server/lib/worker-proxy-transport.ts` in the separate
EZiL Works app. **Nothing in `app/src/app/api/shell/` or
`app/src/server/api/routers/` exposes it to this shell.** Verified by
listing `app/src/app/api/shell/` — it has `activity`, `code-preview-url`,
`desktop`, `focus`, `preview-url`, `restart`, `screen`, `session`,
`telemetry` and nothing that touches project files — and by grepping
`app/src/server/api/routers/` for any reference to it (none). One comment in
this app even says so directly, about a *different* project-files endpoint:
"`/project-files/delete` endpoint, which this app never calls"
(`app/src/app/computers/_lib/delete-copy.ts:25`).

This means a document-viewer-style app cannot ask the shell "give me the
user's file" today. Two things follow:

1. **Meanwhile**, accept a file the user hands you directly: a
   `<input type="file">` element in your window, or a drop target wired to
   `dragenter`/`dragover`/`drop` inside your `body_content`. Either is
   acceptable — nothing else is, because nothing else exists yet.
2. **Track the real fix as community issue `SFA-01`** ("shell file API"). As
   of this writing **no such issue is filed** on this repository's tracker —
   if you need this capability, please open one under that name (checking
   first that nobody else has) rather than building a second, private way to
   reach `/project-files/*` from the shell. `SFA-01` is where a real
   shell-callable read (and, if scoped, write) path against the same
   HMAC-gated Worker proxy belongs, once someone designs the auth story for
   handing a browser-side shell a token scoped to one user's own files.

## Hydration honesty

`/os` is a React (Next.js App Router) document, and React owns the DOM nodes
it rendered. `shell/ezil/boot.js`'s own header is direct about the failure
mode: "If anything mutates a node React rendered... **before** React
hydrates, React reports a mismatch... and regenerates the whole tree from its
own copy" (`boot.js:90-97`, cf.
[`./PLATFORM-NOTES.md` §14](./PLATFORM-NOTES.md)), deleting whatever the
shell already built. `suppressHydrationWarning` suppresses the warning, not
the regeneration.

The shell's rule: **do not touch a React-owned node until React says it has
hydrated.** The host page marks its mount point
`data-awaits-hydration="react"` and dispatches an `ezil:hydrated` event from a
client effect (`boot.js:103-108`); `boot.js` waits for that event before doing
anything to the DOM. The wait is capped
(`HYDRATION_CAP_MS = 3_000`, `boot.js:124`) so a page whose React never loads
still gets an OS — accepting a possible wipe past that point, which a
separate rebuild guard (`ensure_intact`, referenced at `boot.js:110-113`)
then repairs. If your app's `open()` runs during this window (it normally
will not — `launch()` is only reachable after the shell has already mounted),
the same rule applies: do not reach outside your own window's DOM subtree
into anything React still owns.

## Tests to add

Add a jsdom test, `shell/ezil/apps/<id>-test.mjs`, that loads the **committed
bundle** — never the source in isolation — the same way
`registry-trace-test.mjs` does: check `app/public/os/{bundle.min.js,
bundle.min.css, icons.js}` exist (exit 2 if not, with a message to run
`shell/build-shell.sh` first), build a `JSDOM`, `window.eval()` the bundle,
set `window.__EZIL_BOOT__` to a payload whose `apps` list includes your app's
`id` (or omit it deliberately to test the shell-local exception — see the
`resolve()` caveat above), then `await window.ezil.registry.launch('<id>',
ctx)` and assert **exactly one** `boot_summary` telemetry event was produced
for that open (`registry-trace-test.mjs:175-192` is the worked pattern;
`code-test.mjs` is a second, independently-written example of the same
shape). Follow the project-wide rule this guide itself points at: prove a
window is actually *reachable* (resolved by `registry.resolve()` against a
real-shaped payload, and present in the Start menu list), not just that
`open()` doesn't throw — `preview-focus-test.mjs`'s own header names the
class of bug ("a registry entry pointing at a placeholder... invisible to
unit tests, visible only by actually clicking the icon") this pattern exists
to catch.

Add a `shell/ezil/apps/<id>-browser-test.mjs` **only if your window has
geometry to prove** — a real Chromium layout claim (a size, a position, a hit
target) that jsdom cannot make since it does no layout. These load
`playwright` from `$PLAYWRIGHT_REQUIRE_DIR` (or a local install) and exit
**2** — not a false pass — if neither resolves (see any existing
`*-browser-test.mjs` header, e.g. `mobile-browser-test.mjs:9-12`, for the
exact convention). CI's Playwright suites are split into two families
(`.github/workflows/ci.yml:379-406`): **portable** ones (behavior — focus,
stacking, paint order) run on every OS; **geometry** ones (pixel deltas,
settle times) run on the Linux leg only, via a step-level
`if: runner.os == 'Linux'`, because the same shell measurably settles a
handful of pixels differently on macOS Chromium. Put a genuinely
Chromium/Linux-pixel-sensitive test in the geometry list; put anything else
in the portable one.

🔴 **A new test file is not run anywhere by default.** Every suite in this
repo is enumerated by name — there is no directory glob. Adding
`shell/ezil/apps/hello-test.mjs` and stopping there means it never runs in
CI or locally, and a contributor watching green checks would not notice.
Add it to *all* of the following that apply:

- `.github/workflows/ci.yml`'s `for t in ...` list — the node-jsdom-suite
  loop for a plain `*-test.mjs` (`.github/workflows/ci.yml:361-368`), or one
  of the two Playwright loops for a `*-browser-test.mjs`
  (`.github/workflows/ci.yml:384-406` — pick portable or geometry, per the
  rule above).
- `shell/run-tests.sh`'s own `run_suite "<path>" <timeout-budget-seconds>
  node "$HERE/<path>"` list — this is the single local entry point this repo
  built specifically because "the commands for the other nineteen suites
  existed only as prose in each file's own header comment... nothing ran any
  of them automatically" (`shell/run-tests.sh`'s own header). Give your
  suite a timeout budget generous enough for what it does — see that file's
  existing entries for the range in use (120s for a small jsdom suite up to
  600s for a 578-check stacking sweep).

A skipped or never-registered test reported as a pass is exactly the failure
mode this project keeps closing; do not let a new app ship a test file that
nothing ever executes.

## The bundle rule

`shell/` builds into three files under `app/public/os/` —
`bundle.min.js` (esbuild, IIFE, entry `shell/ezil/boot.js`), `bundle.min.css`
(concatenation in a fixed order, then `clean-css`), and `icons.js` (generated
data-URI map) — via `shell/build-shell.sh`. These artifacts are **committed**,
not built by the app at deploy time, "so the app needs no shell build step,
and so `--check` has something to diff" (`shell/build-shell.sh:18-19`).

After any change under `shell/`, run:

```bash
shell/build-shell.sh          # rebuilds and overwrites app/public/os/*
shell/build-shell.sh --check  # CI's drift guard — fails if committed != rebuilt, writes nothing
```

and commit the resulting `app/public/os/bundle.min.js`,
`app/public/os/bundle.min.css`, and `app/public/os/icons.js` alongside your
`shell/` change, in the same PR. `--check` runs in CI
(`.github/workflows/ci.yml:340`, `run: bash shell/build-shell.sh --check`) and
fails the build on any drift.

**CSS order is load-bearing, not incidental.** `build-shell.sh`'s
`css_inputs()` (`shell/build-shell.sh:62-79`) lists the first four sheets
*explicitly*, not alphabetically, because the cascade depends on the order:
"Upstream Puter loads them in this order... A plain `find | sort` puts
`lib/jquery-ui` last (l > c), which lets the vendor theme win over the window
chrome and leaves resize handles mispositioned" (`shell/build-shell.sh:48-59`).
If your app ships its own stylesheet under `shell/ezil/`, it is picked up by
the trailing, sorted `find "$here/ezil" -name '*.css'` clause
(`shell/build-shell.sh:78`) and loads after every Puter-derived sheet and
every EZiL override — you do not need to touch `css_inputs()` unless your
sheet is not under `shell/ezil/` or `shell/src/`.

## Vendoring third-party code

If your app needs a third-party library (a PDF renderer, a syntax
highlighter), it goes under `shell/src/lib/` as a plain **UMD** build,
alongside the existing vendored libraries there
(`jquery-3.6.1/`, `jquery-ui-1.13.2/`, `isMobile.min.js`, `html-entities.js`,
`path.js`). This repo's `shell/package.json` deliberately does **not** set
`"type": "module"` — its own comment explains why: "Setting it makes esbuild
treat every vendored UMD lib under `src/lib` as ESM, so jQuery and `isMobile`
stop exporting a default and `build-shell.sh` FAILS"
(`shell/package.json`'s `_comment_type` field). An ESM-only library will not
build under this pipeline; find (or ask the upstream project for) a UMD or
CommonJS build, or wrap it.

**Licence, before anything else.** This repo is AGPL-3.0-only
(`../CONTRIBUTING.md`'s "License of contributions"). A vendored library must
carry a licence *compatible* with that — permissive licences (MIT, BSD,
**Apache-2.0** — pdf.js, for example, is Apache-2.0 and would be acceptable
on licence grounds) or another copyleft licence AGPL-3.0 is compatible with
are fine. **GPL-2.0-only is not** (it lacks the "or later" clause AGPL-3.0
compatibility with GPL relies on), and anything marked "non-commercial use
only" is never acceptable in this repository, full stop — see
`../CONTRIBUTING.md`: "GPL/AGPL/SSPL or 'non-commercial only' licenses need
explicit review."

Whatever you add, credit it in **[`../ATTRIBUTIONS.md`](../ATTRIBUTIONS.md)**
(the top-level attribution record — see its §3 for the existing
`worker/`-dependency table as a formatting example) **and, if the code is
Puter-derived or you are modifying an existing Puter file to make room for
your app, in [`../shell/PUTER-PROVENANCE.md`](../shell/PUTER-PROVENANCE.md)**
(the authoritative file-by-file index — "Where they disagree, this file is
correct," `shell/PUTER-PROVENANCE.md:5`) — **in the same PR** as the code.
Under-crediting an upstream project is treated as a bug in this repository,
not a nitpick (`../CONTRIBUTING.md`'s "Pull requests" section).

## How to send the PR

Once your `AppDescriptor`, its icon, its `open()`, its test(s), the rebuilt
bundle, and (if you vendored anything) `ATTRIBUTIONS.md` /
`PUTER-PROVENANCE.md` are all in one commit set, follow
[`../CONTRIBUTING.md#how-to-send-a-pr`](../CONTRIBUTING.md#how-to-send-a-pr).

> As of this writing, that heading does not yet exist on `main` — it is being
> added by a separate, concurrent change to `CONTRIBUTING.md`. If the link
> above 404s for you, check `../CONTRIBUTING.md`'s "Pull requests" section
> for the current guidance in the meantime.

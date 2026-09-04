# Local mode — running EZiL OS on your own machine

Local mode is the same desktop container the hosted product runs, driven by a
native Bun host over the `docker` CLI instead of a Cloudflare Worker. There is
no Cloudflare account, no Vercel project, no Supabase project and no sign-in:
the native host serves `/os` itself, starts and stops the container itself,
and publishes every port straight onto `127.0.0.1`. Nothing in this mode talks
to `*.ezil.work`, `*.workers.dev` or `*.vercel.app` — enforced, not just
intended: `local/src/server/no-hostname.test.ts` fails the build on a literal
hostname anywhere under `local/src`.

If you want the hosted product instead — invite-only, `os.ezil.work`, your own
account — see the main [README](../README.md#getting-started).

## Prerequisites

- [Docker](https://www.docker.com/), running.
- [Bun](https://bun.sh/).
- The desktop image is **amd64 only**. On Apple Silicon or Windows-on-ARM it
  runs under emulation — slower, software-decoded — and `bun run --cwd local
  doctor` prints a `WARN` naming that rather than failing.
- Once the pinned image is publicly pullable (see "What connects where"
  below), pulling it is about **1.4 GB to transfer, about 4.6 GB on disk**
  once extracted (`deploy/launcher/README.md`).

🔴 **Today, that pull does not work for anyone outside the project.**
`deploy/images.env` still ships `EZIL_DESKTOP_TAG=<to be pinned by CI>` — a
placeholder that `local/src/container/run-spec.ts`'s `isDockerTag` refuses to
compose into a reference, so `resolveDesktopImage` falls back to
`LOCAL_DESKTOP_IMAGE_FALLBACK`, the image a `worker/Dockerfile` build produces
on the machine that built it — and even once a real tag lands there, GHCR
packages default to **private**, and `ghcr.io/ezilhq/ezil-neko-vscode` /
`ezil-os-desktop` stay that way until a maintainer flips them to Public. Until
both of those land, build the image yourself instead of pulling it:

```bash
cd worker && docker build -t ezil-os-worker-sandbox:ff199202 .
```

(that tag is the current fallback constant; building it under that exact name
means `deploy/images.env`'s placeholder resolves to an image that is actually
on your machine). Once a real GHCR tag is public, none of this is needed —
`bun run --cwd local doctor` reports which one it resolved and why.

## Starting it

### From a release download

The fastest path once a `v*` release exists: download the tarball, and run the
launcher pair `deploy/launcher/ezil-os.sh` (macOS/Linux, bash 3.2-compatible)
or `deploy/launcher/ezil-os.ps1` (Windows, PowerShell 5.1+). It checks for
Docker and Bun, pulls the pinned image, runs the doctor and stops on a
problem, starts the host, and opens `http://127.0.0.1:7080/os` once it
answers. Ctrl-C stops the host and removes the container it started. Full
detail, including `EZIL_LAUNCHER_IMAGE` (skip `deploy/images.env` and run an
image you already have) and exactly what the launcher connects to, is in
[`deploy/launcher/README.md`](../deploy/launcher/README.md).

### From a clone

```bash
bun install --cwd local
bun run --cwd local doctor
bun run --cwd local start
```

Then open `http://127.0.0.1:7080/os`. `doctor` is not optional the first time
— it is the thing that turns "the container did not start" into a named
reason before you ever run `start`. `start` builds a real `DockerHost` and
fails outright if the Docker daemon is unreachable; there is no silent
fallback to a fake desktop (`local/src/server/main.ts`'s own header calls this
out: a host that quietly served a fake desktop when Docker was missing would
be exactly the "asserting health it has not confirmed" failure this project
keeps closing).

## Environment variables

Seven, all optional, all read in exactly one place
(`local/src/config.ts`'s `ENV_KEYS`):

| Variable | Default | What it does |
|---|---|---|
| `EZIL_LOCAL_PORT` | `7080` | The port this host's own `/os` server listens on. `0` picks a free one (what the tests use). |
| `EZIL_LOCAL_PORT_OFFSET` | `0` | Shifts every **published container** port by this much — see below. Not the same variable as `EZIL_LOCAL_PORT`. |
| `EZIL_LOCAL_WORKSPACE` | `~/.ezil-os/workspace` | Host directory bind-mounted into the container as the project tree. |
| `EZIL_LOCAL_STATE_DIR` | `~/.ezil-os` | Where this host keeps its own files (telemetry). Deliberately **not** inside the workspace — a file written there would be visible inside the desktop and liable to be `git add .`-ed into a user's own project. |
| `EZIL_LOCAL_SHELL_DIR` | auto-detected | Where `bundle.min.js` / `bundle.min.css` / `icons.js` live, for a layout the auto-detection does not cover. |
| `EZIL_MCP_ENDPOINT` | unset | An MCP endpoint you choose to point this host at. Configuration only — nothing in `local/` dials it. |
| `EZIL_APP_URL` | unset | A hosted EZiL app this host may link out to. Configuration only — nothing in `local/` dials it. |

**`EZIL_LOCAL_PORT` moves this host's own HTTP listener. `EZIL_LOCAL_PORT_OFFSET`
moves the container's six published ports, and it moves the WebRTC mux on
BOTH sides of the container boundary.** They are not interchangeable and one
cannot substitute for the other. The offset exists because a default port can
already be taken on your machine — measured on the machine this round was
built on, `supabase-kong` permanently holds `0.0.0.0:8443`, so `docker run`
with the unoffset map dies with `Bind for 0.0.0.0:8443 failed` before the image
is ever started. Set `EZIL_LOCAL_PORT_OFFSET=10000` and every port below moves
by 10000 — except the mux, which moves the **same number on both sides**: neko
advertises `127.0.0.1:<its own mux port>` as the ICE candidate it hands the
browser, so publishing the host side at an offset while the container still
listens on the base port produces a candidate that points at nothing — every
HTTP check stays green and the picture never arrives
(`local/src/container/run-spec.ts`'s `offsetPortMap`).

## Port map

Every port local mode publishes on `127.0.0.1`, and nothing else — `run-spec.ts`
asserts Chrome's remote-debugging port (9222) never appears in a built `docker
run` argv, because CDP is unauthenticated and total access to any origin the
browser can reach.

| Name | Container port | Protocol | What it is |
|---|---|---|---|
| desktop | 8181 | tcp | neko's HTTP UI and WebSocket signalling — the desktop itself |
| appPreview | 3002 | tcp | your own dev server (`next dev --port 3002`) |
| code | 8443 | tcp | code-server (VS Code in the browser) |
| sidecar | 9223 | tcp | the browser sidecar's fixed verb set — never CDP passthrough |
| webrtcUdp | 52100 | udp | WebRTC media, direct — no TURN needed on loopback |
| webrtcTcp | 52100 | tcp | WebRTC media fallback when UDP is blocked locally |

Plus the host's own listener, **not** a container port: `7080` (`EZIL_LOCAL_PORT`),
where `/os` and the `/api/shell/*` routes are served. At offset `N`, every
container-port number above (including the two mux entries, on both sides of
the boundary) shifts by `N`; the host listener does not.

## The doctor

`bun run --cwd local doctor` asks the machine, never the configuration — a
port check is a real bind, not a parse of `ss` output, because a wildcard
listener elsewhere on the machine is exactly the conflict that matters.
**`WARN` never fails the exit code; `FAIL` always does, and names the fix.**
An arm64 host running the amd64 image under emulation is a `WARN`; a Docker
daemon that does not answer, a missing image, a busy port or an unwritable
workspace are `FAIL`.

It checks, in order: the Docker daemon is reachable; host architecture
(`WARN` on non-amd64); the resolved desktop image is present locally; every
published port is free at the configured offset (and if not, it tries a list
of candidate offsets and names the first one where every port is free); this
host's own `/os` port is free; the container environment it would build
carries `NEKO_WEBRTC_NAT1TO1` (so neko never makes an outbound call to
`checkip.amazonaws.com` on boot) and the implicit-hosting fallback variable
(see below); the two optional endpoints, reported as set-or-unset only; the
workspace directory is actually writable (a real write-and-remove, not an
`access()` check); the shell bundle is present; and the WebRTC caveats below,
always as `WARN`.

Measured on the machine this round was built on, at `EZIL_LOCAL_PORT_OFFSET=10000`
(0 fails there — port 8443 is busy): **12 pass, 2 warn, 0 fail** — the two
warnings are the ICE caveats in the next section.

## What connects where

Three kinds of address, and `local/src/server/no-hostname.test.ts` holds the
line by refusing any literal hostname anywhere under `local/src`:

- the container **registry** (`ghcr.io`), when a real pull is possible — see
  "Prerequisites" above for why that is not the case yet;
- its own **loopback host**, `127.0.0.1` — every port in the map above and
  nothing else; `local/src/server/server.ts`'s `assertLoopbackBind` refuses a
  wide bind outright (mutation-proved reachable on a LAN address and rejected);
- `EZIL_MCP_ENDPOINT` and `EZIL_APP_URL`, **unset by default and dialled by
  nothing in this package** — they are configuration a user supplies for their
  own later use, not a capability local mode exercises today.

There is no telemetry call anywhere in this. The NDJSON file the doctor and
the startup block mention (`config.telemetryPath`, under `EZIL_LOCAL_STATE_DIR`)
is written to your own disk and read by nothing this project runs.

## Caveats measured this round

Two things that are true, are not failures, and are exactly what you should
know before staring at a black rectangle — both come from `local/src/ice.ts`'s
`describe()`, which is also what the doctor prints them from, so there is one
definition rather than a second copy that could drift:

- **neko still advertises its own compiled-in default STUN server**
  (`stun:stun.l.google.com:19302`) to the browser. This is not something this
  repository configures — it is neko's own default — and it was measured that
  the obvious env fix does nothing: booting with
  `NEKO_WEBRTC_ICESERVERS_FRONTEND=[]` and `_BACKEND=[]` against the pinned
  image left the logged value unchanged. Loopback media does not need it, but
  a browser on an offline machine will still see the page try to reach Google.
  Clearing it needs a neko flag that actually accepts an empty list, or a
  config-file change baked into the image — neither shipped this round.
- **The WebRTC mux is published on `127.0.0.1` only.** A browser on another
  machine on your LAN can reach the desktop's HTTP surface but will never get
  media — this is by design (an unauthenticated automation surface must not be
  reachable from the LAN), not a bug to work around.

Two more, not from `ice.ts` but measured the same way this round:

- **Audio was not exercised.** Nothing in this round's smoke or doctor drives
  or asserts on the container's audio path.
- **One browser, one viewport.** The real-browser smoke that proves pixels and
  input (see below) ran once, in one Chromium instance at one window size.

## What is proven, and how — and what is not

The real-browser smoke (`local/tests/local-smoke.container.test.ts`, 6 tests,
a real container plus real Chromium) measured, at `EZIL_LOCAL_PORT_OFFSET=10000`:

- **Cold boot** through `POST /api/shell/desktop`: **5.7–9.1 s**.
- **Time to non-uniform pixels** after the window opened: **2.2–4.4 s**.
- A pixel statistic over a 160×100 downsample of the decoded `<video>` inside
  the desktop iframe was well past the threshold that separates "a real
  picture" from "a flat colour" (`stdDev 58.8` against a `>= 8` threshold,
  `29/32` non-uniform buckets against a `>= 3` threshold — roughly 7× and 10×
  margin).
- **Host control was granted**: `GET /api/room/control` reported
  `has_host: false -> true` with a host id after a click.
- **The pointer moved**: `xdotool getmouselocation` inside the container
  landed within 2 device pixels of the click's expected coordinate.

Three separate input oracles, each with its own named blind spot: control
being granted (blind to whether the application inside X reacted, not just
neko); the X pointer moving (blind to whether the application reacted, not
just X); and neko's own log line showing a session host change (blind to the
same). **None of this proves an application inside the desktop reacted to a
keystroke** — that is the honest gap this round leaves open, stated so it is
not mistaken for something narrower having been proven.

The doctor's "implicit-hosting fallback" line is a related but different
claim, and worth not conflating with the smoke above:
`NEKO_SESSION_IMPLICIT_HOSTING=true` is always set in the container
environment, and on the pinned image it is inert — measured three ways
(unset, `false`, `true`, reading `GET /api/room/settings` back after each
boot) all report `implicit_hosting: true`, because the image's own launcher
already passes `--session.implicit_hosting=true` as an explicit flag, and an
explicit flag outranks the environment. The variable is a **fallback** for an
image whose launcher does not do that — belt, not the actual fix, and never
evidence on its own. What actually shows clicks reach the desktop is
`DockerHost.readControlMode` reading `GET /api/room/settings` back, plus the
smoke additionally flipping the setting off on a live container and watching
that read-back report `manual`, then restoring it — see
`grep -n "NEKO_SESSION_IMPLICIT_HOSTING" local/src/container/run-spec.ts` for
the full measurement.

## Running the smoke yourself

```bash
EZIL_LOCAL_PORT_OFFSET=10000 bun run --cwd local doctor \
  && PLAYWRIGHT_REQUIRE_DIR=/path/to/a/node_modules/containing/playwright \
     bun test local/tests/local-smoke.container.test.ts
```

`PLAYWRIGHT_REQUIRE_DIR` is deliberate friction, not an oversight: Playwright
is never a dependency of any `package.json` in this repository (no `bun
install` in a worktree pulls it in), so the smoke resolves it dynamically from
a `node_modules` you point it at. **Without that variable set, the smoke
does not run — it reports `0 pass / 7 skip / 0 fail` and exits `0`.** That is
a skip, not a pass; `./tools/test.sh local` names it loudly as
`[CONTAINER — green-by-absence]` for exactly this reason. Use whichever offset
is actually free on your machine — the doctor's `published ports` check names
one if the default is busy.

## Troubleshooting

- **A published port is already in use.** The doctor's `published ports`
  check fails and names a working offset — set `EZIL_LOCAL_PORT_OFFSET` to it.
  Remember it moves the mux on both sides; do not set only a host-side value
  by hand.
- **`desktop_frame_foreign_origin` in the boot failure.** This means the
  origin the browser handed back does not match the one this host expects for
  its own desktop — the exact defect an offset mismatch produced before it was
  fixed (`local/src/server/routes.ts`'s `isOwnDesktopOrigin` now reads the same
  `hostPortOffset` the container was actually started with, from one config
  field, rather than assuming offset 0). Seeing this today means something is
  passing a different offset to the two halves — check for a stray override.
- **You just want to run shell code with no container at all.** `bun run
  --cwd local start -- --fake-host` starts the host against a fixed, in-memory
  `SandboxHost` instead of a real `DockerHost` — no Docker daemon is touched
  and no container is started. It is loud about this in its own startup block
  so a fake boot can never be mistaken for a real one; it is what CI's
  three-OS matrix and the contract test suite use.

## Verifying what you downloaded

If you started from a release tarball rather than a clone, verify it before
you run it — checksums, build provenance, and the container image's own
signature. All three commands are in
[`deploy/launcher/README.md`](../deploy/launcher/README.md#verifying-what-you-downloaded).

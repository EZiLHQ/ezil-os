# EBuilder — Cloudflare Sandbox Browser Desktop (Apache Guacamole)

A real [`@cloudflare/sandbox`](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-sandbox/)
Worker that provisions a **live browser desktop** (Xvfb + fluxbox + x11vnc +
guacd + Chrome) inside a Cloudflare Sandbox container and exposes it to the
EBuilder canvas through the **genuine Apache Guacamole HTML5 client** — not
noVNC.

> The HTTP API surface consumed by
> `apps/web/client/src/server/lib/cloudflare-guacamole-provider.ts` is unchanged
> (`{ ok, guacamoleUrl, expiresAt, provider, mode, sandboxId }`), so no
> web-client change is required. Only what `guacamoleUrl` points at changed:
> Apache Guacamole on port **8080** instead of noVNC on 6080.

## Architecture

```
EBuilder canvas (iframe)
        │  https://<port>-<id>-desktop.<host>/          Guacamole auto-connect landing (ROOT/index.html)
        │    → /guacamole/#/client/<id>?token=…         genuine Apache Guacamole HTML5 client
        │    → /guacamole/websocket-tunnel              Guacamole protocol over WebSocket
        ▼
Worker  src/index.ts
        ├─ proxyToSandbox()   forwards preview traffic + the Guacamole WS tunnel into the container
        └─ POST /sandbox/preview → openSandbox() → ensureDesktop() → exposePort(8080)
        ▼
Sandbox container (Dockerfile, base cloudflare/sandbox:0.12.1)
        └─ scripts/start-desktop.sh
             Xvfb :99 (1280x800) → fluxbox → x11vnc :5901 → Chrome
                                                   │  (RFB/VNC, loopback)
             guacd :4822  ─────────────────────────┘   native proxy daemon
                  ▲  (Guacamole protocol, loopback)
             Tomcat :8080 → Apache Guacamole client at /guacamole/
             ROOT/index.html auto-authenticates the "preview" user via the
             Guacamole REST API and deep-links into the single "desktop" VNC
             connection (so the canvas shows the live browser with no login).
```

Only port **8080** (Tomcat / Apache Guacamole) is exposed. **guacd (4822)** and
**x11vnc (5901)** stay on container loopback and are never reachable from the
browser — the browser only ever speaks the Guacamole protocol to the web app.

## Guacamole configuration (baked into the image)

`GUACAMOLE_HOME=/etc/guacamole`. These files are `COPY`d by the `Dockerfile`:

| File | Role |
| --- | --- |
| `guacamole/guacamole.properties` | Points the web app at guacd (`127.0.0.1:4822`) and the file-auth map |
| `guacamole/user-mapping.xml` | Defines the `preview` user + its single VNC `desktop` connection (`127.0.0.1:5901`) |
| `guacamole/root-index.html` | Tomcat `ROOT` page — REST-auth as `preview` then deep-link into the Guacamole client; falls back to the `/guacamole/` login on any error |

## HTTP API

| Method + Path | Response |
| --- | --- |
| `GET /health` | `{ ok, service, mode }` |
| `POST /sandbox/preview` | `{ ok, guacamoleUrl, expiresAt, provider, mode, sandboxId }` |
| `GET /sandbox/:name/status` | `{ ok, sandboxName, guacamoleRunning, mode, desktopRunning, runningModes, modeSource }` |
| `DELETE /sandbox/:name` | `{ ok, sandboxName, terminated, stopped, outcome, wasRunning, runningAfter, mode }` |

`guacamoleUrl` is the exposed container root (`https://<port>-<id>-desktop.<host>/`),
which serves the auto-connect landing page that redirects into
`/guacamole/#/client/<id>?token=…`.

### Authentication

One HMAC envelope gates every mutating route: `t=<unix_ms>,v1=<hex_hmac_sha256>`
over `${ts}.POST./sandbox/preview.`, verified against `SANDBOX_HMAC_SECRET` /
`CLOUDFLARE_GUACAMOLE_HMAC_SECRET` (plus the optional mission alias below).
When no secret is configured the Worker runs in local-dev mode and skips
verification.

| Route | Credential |
| --- | --- |
| `GET /health` | none (read-only) |
| `GET /sandbox/:name/status` | none — see the note below |
| `POST /sandbox/preview` | HMAC token in the JSON body (`token`) |
| `POST /sandbox/:name/{workspace-diag,cpu-diag,twen}` | HMAC token in the JSON body |
| `POST /project-files/*` | HMAC token in the JSON body |
| `DELETE /sandbox/:name` | **HMAC token** — `Authorization: Bearer <token>` (preferred), `?token=`, or a JSON body `{token}` |
| `GET /preview-bootstrap` (preview host) | sandboxId-bound bootstrap token in `?token=` |
| `GET /preview-status` (preview host) | `ezil_preview` cookie **or** the sandboxId-bound bootstrap token |
| `GET /preview`, `/preview-ws`, `/preview-inspector.js` (preview host) | `ezil_preview` cookie |

`GET /sandbox/:name/status` is deliberately left open: it is read-only, reads
only Durable Object storage (it can never wake or bill a container), and
discloses nothing beyond whether a desktop is currently serving under a name
the caller must already know. Gating it would require the app to sign its
poll; do both together if you want it closed.

> **Callers must sign `DELETE`.** This route previously had *no* authorization
> at all — an unsigned `DELETE` returned `ok:true`, and the sandbox name is
> plainly visible in the desktop iframe's `src`, so anyone who saw a URL could
> destroy that session. `app/src/server/lib/cloudflare-guacamole-provider.ts`'s
> `requestGuacamoleSandboxTerminate()` currently sends no token and will now
> get a 401; add
> `headers: { authorization: \`Bearer ${mintSandboxPreviewToken(hmacSecret)}\` }`
> to that `fetch` (it already imports the minting helper it uses for
> `/sandbox/preview`). Terminate is best-effort in the app and sandboxes
> auto-sleep after 30m regardless, so an unsigned destructive endpoint is by
> far the worse of the two states to be in while that lands.

### Reading a `DELETE` response

`terminated` is `true` **only** when a container was observed running before
the call and observed gone after it. `outcome` says which happened:

| `outcome` | meaning |
| --- | --- |
| `destroyed` | a running container was torn down by this call |
| `not_running` | nothing was running under this name — **nothing was destroyed** |
| `still_running` | `destroy()` returned but the container is still up (HTTP 500) |
| `destroy_failed` | `destroy()` threw (HTTP 500) |

`not_running` is what a mistyped or mis-derived sandbox name reports. The name
is `guac-<userId16>-<scopeId16>` (`deriveSandboxId`) — **not** the preview
hostname label, which additionally carries the port token
(`…-desktop` / `…-nekodesktop` / `…-app`). Sending the hostname label used to
return `terminated: true` while the real container kept running.

### Reading a `/status` response

`mode` is **detected** from the live exposed-port list when the caller omits
`?desktopMode=` (`modeSource: "detected"`), so a neko desktop reports
`mode: "neko"` rather than defaulting to `guacamole`. `guacamoleRunning` means
"the desktop port for the reported `mode` is exposed" — always read it together
with `mode`. An explicit `?desktopMode=` is still answered literally
(`modeSource: "requested"`). `desktopRunning` / `runningModes` are additive and
report every desktop that is actually up regardless of which one was asked
about.

## Quick start (local dev)

This package uses **bun** (see `bun.lock`).

```bash
cd worker
bun install            # ONLY if node_modules is absent (it is normally hydrated)
bun run typecheck      # tsc --noEmit
bun run dev            # wrangler dev --port 8787 (builds the container image on first run)
```

Then in `apps/web/client/.env`:
```
CLOUDFLARE_GUACAMOLE_WORKER_URL=http://localhost:8787
```

`GET http://localhost:8787/health` → `{ "ok": true, "mode": "production" }`.

### ⚠️ Known local limitation (OrbStack)

The full `POST /sandbox/preview` → container round-trip does **not** complete
under **OrbStack**: the `@cloudflare/sandbox` proxy sidecar
(`cloudflare/proxy-everything`) crashes on start with
`Fatal error: setsockoptint: protocol not available`, so the SDK never reaches
the container (`createSession` fails after ~8 attempts / ~162s and
`/sandbox/preview` returns HTTP 500). This is an OrbStack networking limitation,
**not** a defect in this Worker.

To exercise the end-to-end preview locally, either:
- **Deploy to Cloudflare** (recommended — see below), or
- Use **Docker Desktop** instead of OrbStack as the container runtime, or
- Validate the desktop image directly (see [Validation](#validation)).

## Production deploy

```bash
cd worker
bun run deploy                           # builds + pushes the container image
wrangler secret put SANDBOX_HMAC_SECRET  # must match the control-plane secret
```

### Optional, temporary mission-signing alias (`SANDBOX_MISSION_HMAC_SECRET`)

`SANDBOX_MISSION_HMAC_SECRET` is an **optional, additive** HMAC alias for the
signed preview/diag verification path. When present, a request signature is
accepted if it matches **either** the primary/compatibility secret
(`SANDBOX_HMAC_SECRET` / `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`) **or** this mission
secret. All other behavior — token freshness, canonicalization, timing-safe
comparison, and every negative/failure case — is unchanged.

It exists only to let an operator sign a one-off A/B/C isolation mission with a
throwaway key without touching the production `SANDBOX_HMAC_SECRET`. It is:

- **never required** — its absence changes nothing and primary auth is unaffected;
- **never a replacement** — the primary secret remains authoritative;
- **temporary/operational** — it must **normally be ABSENT** in production and
  should be removed (`wrangler secret delete SANDBOX_MISSION_HMAC_SECRET`) once
  the mission completes.

```bash
# Bind a throwaway mission key (value generated in-process, never printed):
# printf '%s' "$MISSION_VALUE" | wrangler secret put SANDBOX_MISSION_HMAC_SECRET
# ...run the mission, then remove it again:
# wrangler secret delete SANDBOX_MISSION_HMAC_SECRET
```


Then point the app at the deployed Worker. This value **must be a host on the
preview zone** — a `*.workers.dev` URL here cannot work (see below):
```
CLOUDFLARE_GUACAMOLE_WORKER_URL=https://api-desktop.ezil.org
```

**2026-07-31 — preview routing is live on `ezil.org` (narrow suffix routes):**
this used to point briefly at `https://os.ezil.work`, the company's main
production website, routed there by mistake; that routing was fully removed
(routes, custom domain, DNS records). After that, preview routing sat
disabled for a while because the obvious replacement, `ezil.org`, looked
off-limits (`*.ezil.org/*` is bound to the live production Worker
`cf-guacamole-sandbox`, serving `sandbox.ezil.org` / `neko.ezil.org`) and
`zlsocial.ai` turned out to have its own live bare wildcard tunnel catch-all.

The owner then approved adding three **narrow, token-scoped suffix routes**
on `ezil.org` alongside the existing bare `*.ezil.org/*` production route:
`*-app.ezil.org/*`, `*-desktop.ezil.org/*`, `*-nekodesktop.ezil.org/*` — see
`wrangler.toml`'s route-block comment for the most-specific-wins rationale
and `src/index.ts`'s `PREVIEW_ZONE_ROOT` doc comment for the composition
details. Each route was added ONE at a time with a live byte-level
before/after diff of `sandbox.ezil.org`/`neko.ezil.org` (unchanged throughout)
before adding the next. `PREVIEW_ZONE_ROOT` is `'ezil.org'` again.

### The app entrypoint must be on the preview zone — `workers.dev` cannot work

An earlier revision of this file claimed the `*.workers.dev` URL "remains the
app's primary entrypoint" and that only the minted per-sandbox preview
hostnames use the zone. **That was false, and it cost a full end-to-end run.**

`normalizeSandboxHostname()` (`src/index.ts`) derives the preview hostname from
the **inbound request's own `Host`** — so whichever host the app calls the
Worker on is the host every preview URL gets minted under. Call it on
`https://ezil-os-worker.ezil-builder.workers.dev` and `POST /sandbox/preview`
boots the container and then dies, verbatim:

```
Port exposure requires a custom domain. .workers.dev domains do not support
wildcard subdomains required for port proxying.
```

`@cloudflare/sandbox` refuses any preview host ending in `.workers.dev`
(`CustomDomainRequiredError`). The container has already started by the time
`exposePort` runs, so this surfaces late — as a ~26s boot failure
(`cf-guacamole-failed-unknown`), not as a config error at startup.

`https://api-desktop.ezil.org` is therefore the committed value (it is in
`app/.env.example`). It works because it ends in `-desktop.ezil.org`, so the
`*-desktop.ezil.org/*` route above sends it to this Worker, and
`normalizeSandboxHostname` collapses any host under `PREVIEW_ZONE_ROOT` to the
bare zone root before `exposePort` composes
`<port>-<sandboxId>-<token>.ezil.org` — a single label under the zone, which
Universal SSL covers. Any other host matching one of the three routes would do
equally well; **a host that matches none of them will 404 or hit the wrong
Worker.**

Verified live (2026-07-31):
`GET https://api-desktop.ezil.org/health` → `{"ok":true,…,"build":"ezil-os"}`
(this Worker), while `GET https://sandbox.ezil.org/health` still returns the
old production Worker's payload with **no** `build` field — the narrow routes
did not capture production.

`workers_dev = true` stays set explicitly in `wrangler.toml` (it would
otherwise default to disabled once `[[routes]]` entries exist), and the
`*.workers.dev` URL remains useful as a **diagnostic** entrypoint: `GET /health`
answers there. It is not an app entrypoint — every request that ends in
`exposePort` fails on it. Do not put it in `CLOUDFLARE_GUACAMOLE_WORKER_URL`.

(The local-dev `http://localhost:8787` above is a separate, still-valid case:
`localhost` is not under `PREVIEW_ZONE_ROOT`, so it passes through unchanged
and preview hosts are minted as `<port>-<id>-desktop.localhost:8787`.)

Notes:
- `wrangler.toml` uses `instance_type = "standard"` (Chrome + Tomcat + a JVM need
  the memory; `lite` is too small). Newer Wrangler may emit a deprecation notice
  suggesting the renamed tier (e.g. `standard-1`) — update only after confirming
  the valid value with `wrangler containers` for your account.
- Sandboxes auto-sleep after 30m idle; `DELETE /sandbox/:name` calls `destroy()`
  for explicit teardown, then re-reads `ctx.container.running` and reports what
  actually happened (see "Reading a `DELETE` response" above).
- The periodic workspace flush loop **must** be cancelled on teardown.
  `@cloudflare/containers`' `alarm()` runs every due schedule *before* it checks
  `container.running`, and the flush walks the workspace over container RPCs —
  which auto-start a stopped container. An un-cancelled loop therefore
  resurrects whatever `destroy()` just killed, within one flush interval.
  `EzilSandboxDO.destroy()` tombstones the sandbox (`ezil:workspaceTerminated`)
  and calls `deleteSchedules()`; the next successful hydrate clears the
  tombstone and the loop restarts.

## Validation

The image bundles a real Apache Guacamole stack, so validate it by building and
running the container directly (this bypasses the OrbStack proxy limitation
above), then confirming the Guacamole client is served:

- **Clean-image build**: `docker build -t ebuilder-desktop:guac .`, then run it.
  `start-desktop.sh` boots Xvfb → fluxbox → x11vnc → Chrome → guacd → Tomcat
  with **zero manual intervention** (its progress is logged to `/tmp/desktop.log`
  inside the container).
- **Guacamole client is up**: `curl -sI http://localhost:8080/guacamole/` returns
  **HTTP 200** (the Apache Guacamole HTML5 app), and `GET /` serves the
  auto-connect landing page that redirects to `/guacamole/#/client/…`.
- **Internal wiring** (inside the container): `ss -ltn` shows `8080` (Tomcat),
  `4822` (guacd) and `5901` (x11vnc) listening; only `8080` is `EXPOSE`d.
- **Vision acceptance**: because a Guacamole/VNC surface renders into an opaque
  `<canvas>` (pixels, not DOM/accessibility nodes), a *vision-capable* tester
  model must confirm the desktop visually (e.g. "Chrome open to Wikipedia").
  DOM-only testers false-negative on this canvas-based UI.

> This supersedes the previous noVNC/websockify build. There is no noVNC,
> `/vnc.html`, `websockify`, or port 6080 anywhere in this image.

## `neko` mode: two native X11 apps on one display

`start-neko.sh` runs both VS Code and an isolated Chromium-family app
(reusing the Google Chrome binary already installed for the Guacamole stage —
no second browser package is added) on the same `Xvfb`/`openbox` display.
Each app is launched via an independent `supervise_app` restart loop, so a
crash in one app is logged and retried without affecting the other app,
`neko serve`, or triggering any Guacamole fallback (Neko is the sole product
path; failures fail closed, never silently degrade to Guacamole).

- **Isolation**: Chromium runs with a fresh, container-local
  `--user-data-dir` (`/tmp/chromium-app-data`, recreated on every start) and
  `--no-first-run --no-default-browser-check --disable-sync`; it never
  attaches any host/human profile, cookies, or saved logins.
- **Health observability**: a sanitized JSON health file
  (`/tmp/neko-app-health.json`, default) is refreshed every 5s with only
  `{state, pid, restarts}` per app — never command lines, window titles, or
  URLs. `/tmp/neko.log` logs only app name + exit code on crash.
- **Focus/app switching**: deterministic switching is available two ways —
  the pinned `openbox.xml`'s built-in `Alt+Tab` keybinding, and
  `/usr/local/bin/neko-switch-app.sh <vscode|chromium>` (installed at
  runtime), which raises/focuses the named app's window via `wmctrl -x -a`
  for machine-checkable automation.

Validated locally (`docker build` + `docker run` with the pinned
`ezil-neko-vscode` image already present): both windows appear in
`wmctrl -l`, the health file reports `state: running` for both apps, and
`neko-switch-app.sh` successfully activates each window by name.

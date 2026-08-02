# EBuilder — Cloudflare Sandbox browser-desktop image (Apache Guacamole)
#
# Extends the Cloudflare Sandbox base image (Ubuntu 22.04) with a real,
# headless-but-viewable browser desktop served through **genuine Apache
# Guacamole** (NOT noVNC):
#
#   Xvfb        — virtual X display (:99)
#   fluxbox     — lightweight window manager
#   x11vnc      — VNC server bound to the Xvfb display (port 5901); this is the
#                 backend that guacd connects to (never exposed to the browser)
#   guacd       — Apache Guacamole native proxy daemon (port 4822): speaks the
#                 Guacamole protocol to the web app and RFB/VNC to x11vnc
#   Tomcat 9    — servlet container hosting the Apache Guacamole HTML5 client
#                 web application at /guacamole/ (port 8080) — this is what the
#                 Worker fronts via proxyToSandbox()
#   Google Chrome — the actual browser shown in the EBuilder canvas
#
# The browser talks HTML5 (Guacamole.js + WebSocket tunnel) to the Guacamole web
# app on 8080; there is no noVNC/websockify anywhere in this image.
#
# NOTE: the base image keeps its own entrypoint (internal Bun server on port
# 3000). We do NOT override CMD/ENTRYPOINT — the Worker launches the desktop
# via sandbox.startProcess('/usr/local/bin/start-desktop.sh').
#
# The SDK version in package.json (@cloudflare/sandbox@0.12.1) MUST match this
# base image tag.
#
# ── Pinned Neko + VS Code source stage (alternate `neko` desktop mode) ────────
# The pinned Neko/neko-apps runtime is provided by the project-owned, immutable
# ezil-neko-vscode image (built by infra/neko-standalone/scripts/build.sh at the
# pinned SHAs neko=d74052bb / neko-apps=049931d7). We reference it as a build
# stage and COPY only the runtime artifacts we need into the Ubuntu 22.04
# Sandbox base below. Never pushed to any registry; resolved from the local
# build host's image store (wrangler builds the container image locally before
# pushing to registry.cloudflare.com).
ARG NEKO_IMAGE=ezil-neko-vscode:d74052bb-049931d7
FROM ${NEKO_IMAGE} AS neko

FROM docker.io/cloudflare/sandbox:0.12.1

ENV DEBIAN_FRONTEND=noninteractive
# GUACAMOLE_HOME is where the Guacamole web app reads guacamole.properties and
# user-mapping.xml. Tomcat layout follows the Debian tomcat9 package.
ENV GUACAMOLE_HOME=/etc/guacamole
ENV CATALINA_HOME=/usr/share/tomcat9
ENV CATALINA_BASE=/var/lib/tomcat9

# Apache Guacamole client version. MUST match the apt guacd version (1.3.0 in
# Ubuntu 22.04) so the guacd <-> web-app Guacamole protocol is compatible.
ARG GUAC_VERSION=1.3.0

# Desktop backend (Xvfb + Chrome + x11vnc) and the real Apache Guacamole stack.
# Ubuntu's `chromium-browser` apt package is a snap transitional stub that does
# NOT work inside a container, so we install Google Chrome from the official
# .deb instead. guacd + libguac-client-vnc0 provide the native Guacamole proxy
# with VNC support; tomcat9 + a JRE host the HTML5 client web app.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      fluxbox \
      guacd \
      libguac-client-vnc0 \
      tomcat9 \
      default-jre-headless \
      python3 \
      wget \
      curl \
      unzip \
      ca-certificates \
      dbus-x11 \
      x11-utils \
      xdotool \
      fonts-liberation \
      xterm \
  && wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb \
  && apt-get install -y --no-install-recommends /tmp/chrome.deb \
  && rm -f /tmp/chrome.deb \
  && test -x /usr/sbin/guacd \
  && rm -rf /var/lib/apt/lists/*

# Apache Guacamole HTML5 client web application (version-matched to guacd).
# Exploded at build time into webapps/guacamole/ so Tomcat serves /guacamole/
# quickly on boot (no first-request .war unpack). The Debian ROOT app is removed
# and replaced with a Guacamole-branded auto-connect landing page (see below).
RUN wget -q "https://archive.apache.org/dist/guacamole/${GUAC_VERSION}/binary/guacamole-${GUAC_VERSION}.war" \
        -O /tmp/guacamole.war \
  && rm -rf /var/lib/tomcat9/webapps/ROOT /var/lib/tomcat9/webapps/guacamole \
  && mkdir -p /var/lib/tomcat9/webapps/guacamole \
  && unzip -q /tmp/guacamole.war -d /var/lib/tomcat9/webapps/guacamole \
  && rm -f /tmp/guacamole.war \
  && test -f /var/lib/tomcat9/webapps/guacamole/guacamole.css

# Guacamole configuration (GUACAMOLE_HOME): point the web app at the local guacd
# and define a single VNC connection to the x11vnc-backed desktop, plus a preview
# user for the auto-connect landing page.
COPY guacamole/guacamole.properties /etc/guacamole/guacamole.properties
COPY guacamole/user-mapping.xml     /etc/guacamole/user-mapping.xml

# Root landing page (context "/"): a Guacamole-branded page that authenticates
# with the preview user via the Guacamole REST API and deep-links straight into
# the single desktop connection, so the EBuilder canvas shows the live desktop
# with no manual login. On any failure it falls back to the genuine Guacamole
# login UI at /guacamole/. This page loads ONLY Apache Guacamole resources — no
# noVNC assets are ever referenced.
COPY guacamole/root-index.html /var/lib/tomcat9/webapps/ROOT/index.html

COPY scripts/start-desktop.sh /usr/local/bin/start-desktop.sh
COPY scripts/start-neko.sh /usr/local/bin/start-neko.sh
# The Option D app-preview dev-server launcher (ported from the Azure
# reference `Sandboxes/infra/sandbox-desktop/start-devserver.sh`). Invoked by
# start-neko.sh right after workspace hydration resolves; see that script's
# "Dev server (Option D app preview)" section for why it's placed there and
# why it never blocks boot.
COPY scripts/start-devserver.sh /usr/local/bin/start-devserver.sh
# Idempotent code-server launcher (pid-file + port probe), ported from the
# Sandboxes reference — see that file's own doc comment. Not on start-neko.sh's
# own mandatory boot path (which supervises code-server directly for restart-
# budget/health-file parity with the native browser — see start-neko.sh's
# "code-server" launch section), but shipped here as a standalone, idempotent
# utility for on-demand/manual relaunch.
COPY scripts/start-codeserver.sh /usr/local/bin/start-codeserver.sh
RUN chmod +x /usr/local/bin/start-desktop.sh /usr/local/bin/start-neko.sh /usr/local/bin/start-devserver.sh /usr/local/bin/start-codeserver.sh
# ── Alternate `neko` desktop mode (Phase 1, opt-in via desktopMode) ──────────
# Guacamole above remains the default/rollback path — nothing above this
# comment is changed by Neko's presence. The pinned Neko + VS Code runtime
# (neko=d74052bb / neko-apps=049931d7) is baked in here by COPYing the runtime
# artifacts from the `neko` build stage (the project-owned ezil-neko-vscode
# image) into this Ubuntu 22.04 Sandbox base. start-neko.sh launches the stack
# (Xvfb + openbox + VS Code + `neko serve`) on port 8181; it still fails closed
# with a clear error if the neko binary is somehow absent, rather than silently
# degrading to Guacamole.
#
# Runtime dependency packages for the Neko Go server (gstreamer / gtk3 / X11
# capture libs), its window manager (openbox), audio (pulseaudio), and the
# pinned VS Code Electron build (nss / asound / gbm / xshmfence). Verified with
# a compatibility experiment: the Debian-13-built `neko` binary and its shared
# libraries resolve cleanly and execute on this Ubuntu 22.04 base.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgstreamer1.0-0 \
      libgstreamer-plugins-base1.0-0 \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      libgtk-3-0 \
      libxtst6 \
      libxfixes3 \
      libxrandr2 \
      liborc-0.4-0 \
      libffi8 \
      libxcvt0 \
      openbox \
      pulseaudio \
      libnss3 \
      libasound2 \
      libgbm1 \
      libxshmfence1 \
      libsecret-1-0 \
      wmctrl \
  && rm -rf /var/lib/apt/lists/*
# `wmctrl` (above) gives start-neko.sh a deterministic, machine-checkable way to
# list/activate windows by class (`wmctrl -l`, `wmctrl -x -a`) for focus/app
# switching between VS Code and the isolated Chromium instance, on top of the
# pinned openbox config's built-in Alt+Tab keybinding. `xdotool` (already
# installed above for the Guacamole stage) is reused for the same purpose —
# both binaries land in this single shared final image regardless of which
# desktop mode is started at runtime.
#
# Chromium-family binary: intentionally NOT reinstalled here. Google Chrome
# (google-chrome-stable, providing /usr/bin/google-chrome{,-stable}) is already
# installed above for the Guacamole desktop stage and is part of this same
# final image layer, so start-neko.sh reuses that existing binary for the
# isolated Chromium application rather than adding a second browser package.

# Neko runtime artifacts from the pinned build stage:
#   /usr/bin/neko    — the Neko Go application server
#   /var/www         — the Neko HTML5 client bundle (served on 8181)
#   /etc/neko        — neko.yaml, xorg.conf, openbox.xml, plugins
#
# NOTE: the pinned image's /usr/share/code (Electron VS Code) is deliberately
# NOT copied — see the code-server install below, which replaces it in this
# SAME commit. The two must never coexist: Electron VS Code was a second
# Chromium-family renderer compositing into this same Xvfb display, captured
# by the same software vp8enc encoder as the native browser, plus its own
# extension host — on a machine this container no longer runs (see the
# instance_type history in wrangler.toml). code-server serves the IDE over
# plain HTTP and renders nothing into Xvfb.
COPY --from=neko /usr/bin/neko   /usr/bin/neko
COPY --from=neko /var/www        /var/www
COPY --from=neko /etc/neko       /etc/neko
RUN chmod +x /usr/bin/neko \
  && if ldd /usr/bin/neko | grep -qi "not found"; then echo "ERROR: neko has unresolved shared libraries:" >&2; ldd /usr/bin/neko | grep -i "not found" >&2; exit 1; fi \
  && test -x /usr/bin/neko \
  && test -d /var/www \
  && test -f /etc/neko/neko.yaml

# ── code-server (replaces the pinned Electron VS Code build above) ───────────
# Installed via the official installer, which on Debian/Ubuntu fetches and
# installs the .deb release from GitHub (detected automatically; see
# https://code-server.dev/install.sh). Binds **0.0.0.0**:8443 with `--auth
# none`; start-neko.sh/start-codeserver.sh launch it. It bound 127.0.0.1 until
# a live test showed Cloudflare's proxy reaches containers on their routable
# address (10.0.0.1), never loopback — see the note in start-codeserver.sh.
# Safe because the container network is not publicly routable and the sole
# ingress is the HMAC/cookie-gated `*-code.ezil.org` bridge.
# This RUN step must stay in the SAME commit as the /usr/share/code
# COPY removal above so the two IDEs are never both present in one image.
RUN curl -fsSL https://code-server.dev/install.sh | sh \
  && test -x /usr/bin/code-server

# ── EZiL OS desktop assets + deterministic validators ────────────────────────
# Explicit Openbox config (app-switch keybindings + root menu), the mandatory
# native-browser landing page (deterministic, non-blank content/title), and the
# machine-checkable validation scripts. These are installed into the FINAL image
# so start-neko.sh and any in-container validation pass can use them directly.
COPY assets/ebuilder-openbox.xml /etc/neko/ebuilder-openbox.xml
COPY assets/ebuilder-menu.xml    /etc/neko/ebuilder-menu.xml
COPY assets/browser-home.html    /usr/local/share/ezil/browser-home.html
COPY scripts/validate-neko-focus.sh   /usr/local/bin/validate-neko-focus.sh
COPY scripts/validate-neko-desktop.sh /usr/local/bin/validate-neko-desktop.sh
RUN chmod +x /usr/local/bin/validate-neko-focus.sh /usr/local/bin/validate-neko-desktop.sh \
  && test -f /etc/neko/ebuilder-openbox.xml \
  && test -f /etc/neko/ebuilder-menu.xml \
  && test -f /usr/local/share/ezil/browser-home.html

# ── Wave 4B2A: in-container workspace bootstrap bundle ───────────────────────
# Self-contained ESM bundle (built by bootstrap/build-bootstrap.sh; pulls in the
# pure workspace-bridge startup path + @ezil/workspace-engine, and NOTHING from
# the Next.js app / db / tRPC layer). start-neko.sh runs it with the base image's
# `bun` (/usr/local/bin/bun) BEFORE launching VS Code — ONLY when a sealed
# startup delivery is present in the container startup env — to hydrate
# /home/neko/project from the durable branch BEFORE readiness. Fails closed.
COPY bootstrap/dist/workspace-bootstrap.mjs /usr/local/lib/ezil/workspace-bootstrap.mjs
RUN test -f /usr/local/lib/ezil/workspace-bootstrap.mjs

# ── Wave A2: starter workspace template ──────────────────────────────────────
# Baked-in starter project, copied into every genuinely-new (empty) workspace
# by `seedWorkspaceIfAbsent`/`ensureWorkspaceHydratedFromR2`'s `copyTemplate`
# (`src/index.ts`, `src/workspace-seed.ts`) — the ONLY thing standing between
# a new user and a completely empty desktop on first boot. This directory was
# previously referenced by that copy step (`cp -a
# /opt/ezil-sandbox-template/.`) but never actually shipped in the image, so
# the guarded `[ -d ... ] || true` check silently no-op'd on every boot; see
# `src/workspace-seed.ts`'s `buildTemplateCopyCommand`/`templateWasMissing`
# for the loud-failure signal that now catches this if it ever regresses.
# Deliberately tiny — source only, no `node_modules` (`bun install`
# regenerates it on first dev-server launch; see `docs/PLATFORM-NOTES.md` §2
# on why object storage must never see `node_modules`). The `dev` script MUST
# stay `next dev --port 3002` — this is the exact command `desktop-mode.ts`'s
# `APP_PREVIEW_PORT` doc comment and this file's own EXPOSE 3002 comment below
# both reference by name.
COPY sandbox-template /opt/ezil-sandbox-template
RUN test -f /opt/ezil-sandbox-template/package.json \
  && test -f /opt/ezil-sandbox-template/README.md \
  && test -f /opt/ezil-sandbox-template/pages/index.js

# Required so `wrangler dev` can proxy the exposed port locally. 8080 serves the
# Apache Guacamole HTML5 client (Tomcat); guacd (4822) and x11vnc (5901) stay
# internal to the container. 8181 serves the alternate `neko` mode's HTTP UI +
# WebSocket signaling (see NEKO_PORT in src/index.ts). 3002 is the Option D
# app-preview port (`APP_PREVIEW_PORT` in src/desktop-mode.ts) — the user's own
# dev server, reverse-proxied (token/cookie-gated) via src/preview-bridge.ts.
# Deliberately NOT 3000: the base image's own control-plane Bun server (see
# the base-image doc comment at the top of this file) reserves port 3000 —
# the @cloudflare/sandbox SDK's validatePort()/exposePort() throw
# SandboxSecurityError for it — so the dev server MUST listen elsewhere
# (ezil-sandbox-template runs `next dev --port 3002` for exactly this reason).
# start-neko.sh launches scripts/start-devserver.sh (ported from the Azure
# reference) after workspace hydration, which is what actually listens on
# this port — see that script's doc comment for package-manager detection,
# phase reporting, and why it never blocks boot.
EXPOSE 8080
EXPOSE 8181
EXPOSE 3002

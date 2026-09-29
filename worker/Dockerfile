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
#
# `-ezil-brand2` is a SECOND local, project-owned, never-pushed tag: it is
# `ezil-neko-vscode:d74052bb-049931d7` with EZiL's branding overlay applied
# (worker/assets/neko-branding/Dockerfile) — the upstream n.eko wordmark
# (img/logo.800bec71.svg — a cat-silhouette mark, confirmed by inspecting its
# path data), favicons/tile icons, PWA manifest, mask icon, and the
# `chat.mp3` notification chime (the literal "n.eko sound", played via
# `new Audio("chat.mp3").play()` on the built-in chat plugin's newMessage
# event) are replaced. No EZiL logo graphic exists anywhere in this
# repository as of this commit, so the replacements are neutral/blank
# placeholders in EZiL's real palette (--color-charcoal #161616 /
# --color-teal #00adb5), not an invented mark — see that Dockerfile's header
# comment. Rebuild it with:
#   docker build -t ezil-neko-vscode:d74052bb-049931d7-ezil-brand3 \
#     -f worker/assets/neko-branding/Dockerfile worker/assets/neko-branding
# before building this Dockerfile, exactly like the upstream tag it overlays.
#
# 🔴 THE `brandN` SUFFIX IS LOAD-BEARING AND ITS TEST CANNOT SEE IT.
#    `scripts/neko-branding.test.ts` asserts only that this tag CONTAINS
#    `ezil-brand` and `d74052bb-049931d7`. Every `brandN` satisfies both, so a
#    stale suffix here is invisible to the suite: the worker image would build
#    from the OLD overlay, ship none of the newer overlay's files, and nothing
#    would go red. That is exactly how a feature ends up green-tested and
#    absent from the artifact.
#
#    brand1 -> brand2 adds the mobile on-screen-keyboard client script
#    (`/var/www/ezil-mobile.js`, ~18 KB, plus its <script> tag in
#    `/var/www/index.html`). Verified present in brand2 and absent from brand1.
#
#    brand2 -> brand3 adds the BLACK-PICTURE DETECTOR to that same script
#    (~36 KB now). It is the only code in the product that can read the decoded
#    picture, because the `<video>` is in the container's origin and the shell's
#    is not. Verified by grep INSIDE both images: `picture_black` appears 4x in
#    brand3's `/var/www/ezil-mobile.js` and 0x in brand2's. Ship brand2 and the
#    product goes back to being unable to see its own worst failure.
#    The overlay Dockerfile has its own build-time gate (`test -s
#    /var/www/ezil-mobile.js`), but that gate only runs when the new tag is
#    ACTUALLY BEING BUILT — it cannot catch this line never being bumped.
#
#    So: whenever `worker/assets/neko-branding/**` changes, rebuild the overlay
#    under a NEW `brandN` tag and bump this line in the same commit.
#
# GHCR, not a local-only tag: `docker/neko/build.sh` + `.github/workflows/
# image.yml` (row T3) publish the bare base and this overlay to
# ghcr.io/ezilhq/ezil-neko-vscode so a clean machine can build this
# Dockerfile without first building the base by hand. The `-ezil-brand8`
# suffix is not yet a key in `deploy/images.env` (that file only carries the
# BARE base tag) — see the workflow's own hand-off comment before bumping
# either place on its own.
ARG NEKO_IMAGE=ghcr.io/ezilhq/ezil-neko-vscode:d74052bb-049931d7-ezil-brand8
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
# start-neko.sh's `launch_devserver` at the very END of boot — after the
# window-ready gate and after `neko serve` binds — so nothing the dev server
# does can stop the desktop coming up. See that script's "Dev server (Option D
# app preview)" section; it used to be invoked before the gate, and that is
# what broke the desktop in production on 2026-08-02.
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
# Pinned .deb release from GitHub, checksummed, same shape as
# macos/runtime/Dockerfile. This used to be `curl code-server.dev/install.sh |
# sh`, i.e. "whatever is latest today": a rebuild of an unchanged Dockerfile
# could ship a different IDE, and did — 4.139.x (Code 1.139) started bundling
# the open-source GitHub Copilot Chat as a BUILT-IN extension
# (`lib/vscode/extensions/copilot`, MIT, 170 MB). That built-in is now THE chat
# panel EZiL ships (fed by the ezil-models provider below), so the pin is also
# what guarantees the exact Copilot Chat build (0.67.0) the e2e was run
# against. Bump the two ARGs together; the sha256 is of the amd64 .deb asset on
# the release page (`sha256sum code-server_<version>_amd64.deb`).
# `engines.vscode` of the baked ezil-chat / ezil-models extensions is ^1.106 —
# any 4.10x+ satisfies it; 4.139.1 is the release that was current (and already
# in the last unpinned build) when the pin was introduced.
#
# Binds **0.0.0.0**:8443 with `--auth none`; start-neko.sh/start-codeserver.sh
# launch it. It bound 127.0.0.1 until a live test showed Cloudflare's proxy
# reaches containers on their routable address (10.0.0.1), never loopback —
# see the note in start-codeserver.sh. Safe because the container network is
# not publicly routable and the sole ingress is the HMAC/cookie-gated
# `*-code.ezil.org` bridge.
# This RUN step must stay in the SAME commit as the /usr/share/code
# COPY removal above so the two IDEs are never both present in one image.
ARG CODE_SERVER_VERSION=4.139.1
ARG CODE_SERVER_SHA256=9f841557bfb5926eadce253a6c899b064cc9919f91cafb7b676245919d1a68a3
RUN curl --fail --location --silent --show-error \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
      --output /tmp/code-server.deb \
  && echo "${CODE_SERVER_SHA256}  /tmp/code-server.deb" | sha256sum --check --strict \
  && dpkg -i /tmp/code-server.deb \
  && rm -f /tmp/code-server.deb \
  && test -x /usr/bin/code-server \
  && code-server --version | grep -q "^${CODE_SERVER_VERSION} "

# ── Copilot Chat built-in: KEPT, and it must be there ────────────────────────
# Revision 1 of this image deleted `lib/vscode/extensions/copilot` and stripped
# `product.json#defaultChatAgent`. Revision 2 reverses that: the open-source
# Copilot Chat UI (MIT — microsoft/vscode `extensions/copilot`, GitHub.copilot-
# chat 0.67.0 in this code-server) IS the chat panel, running on EZiL-
# configured models through the `ezil-models` LanguageModelChatProvider baked
# in below, with no GitHub account: `chat.allowAnonymousAccess` plus a seeded
# `User/chatLanguageModels.json` vendor group, both written by start-neko.sh
# on every boot (measured in /workspace/copilot-byok-test/REPORT.md — the
# setting is what activates copilot-chat on a cold browser, the file is what
# flips `github.copilot.hasByokModels` and hides the sign-in affordances).
# product.json is left exactly as code-server ships it — `defaultChatAgent`
# included, because the core ChatEntitlementService returns early without it
# and the setup/BYOK plumbing the model picker relies on goes with it. The
# gate fails the BUILD if a future code-server stops bundling the extension,
# renames the directory or drops the provider contribution, instead of
# shipping an image whose right panel is empty.
RUN test -f /usr/lib/code-server/lib/vscode/extensions/copilot/package.json \
  && node -e "const j=require('/usr/lib/code-server/lib/vscode/extensions/copilot/package.json');if(j.publisher!=='GitHub'||j.name!=='copilot-chat')throw new Error('unexpected built-in '+j.publisher+'.'+j.name);if(!(j.contributes&&j.contributes.languageModelChatProviders))throw new Error('built-in copilot-chat has no languageModelChatProviders contribution');console.log('built-in',j.publisher+'.'+j.name,j.version)" \
  && node -e "const j=JSON.parse(require('fs').readFileSync('/usr/lib/code-server/lib/vscode/product.json','utf8'));if(!j.defaultChatAgent)throw new Error('product.json has no defaultChatAgent — the chat setup plumbing the model picker needs is gone');console.log('product.json defaultChatAgent present')"

# ── EZiL Chat: baked in as a BUILT-IN (system) extension ─────────────────────
# `worker/ezil-chat/dist/ezil-chat-<version>.vsix` is built from
# `extensions/ezil-chat/` by `worker/ezil-chat/build-vsix.sh` and committed
# (the extension source is outside this build context — same arrangement as
# `bootstrap/dist/workspace-bootstrap.mjs`). It is unpacked into code-server's
# system extensions directory, next to the other 98 built-ins, NOT installed
# with `--install-extension` into the per-user `--extensions-dir`: a built-in
# cannot be uninstalled from the Extensions view, needs no install step on
# boot, does not depend on `/tmp/code-server-extensions` surviving, and is
# invisible to start-neko.sh's `.ezil/extensions.txt` capture/restore (which
# only walks the user directory), so an existing user's manifest can neither
# lose it nor try to fetch it from a marketplace where it does not exist.
# code-server 4.139 has no `--extra-builtin-extensions-dir`-style flag
# (verified: "Unknown option"), so the directory is the only way in.
#
# Since revision 2 the panel is INSTALLED BUT DORMANT by default: the Chat
# view (Copilot Chat on EZiL models) is the active view of the secondary
# sidebar, and start-neko.sh's Machine settings set `ezilChat.autoStart:
# false` and `ezilChat.revealOnStartup: false`, so no `opencode serve` is
# spawned and the EZiL container is not focused until a user clicks its icon
# or runs "EZiL Chat: Open". Its `configurationDefaults`
# (`chat.disableAIFeatures: true`) are overridden by the same Machine layer
# (`chat.disableAIFeatures: false`), which is why that key is no longer
# asserted here — the two settings the Machine layer relies on are.
COPY ezil-chat/dist/ezil-chat-0.1.0.vsix /tmp/ezil-chat.vsix
RUN mkdir -p /tmp/ezil-chat \
  && unzip -q /tmp/ezil-chat.vsix 'extension/*' -d /tmp/ezil-chat \
  && mv /tmp/ezil-chat/extension /usr/lib/code-server/lib/vscode/extensions/ezil-chat \
  && rm -rf /tmp/ezil-chat /tmp/ezil-chat.vsix \
  && node -e "const j=require('/usr/lib/code-server/lib/vscode/extensions/ezil-chat/package.json');if(j.publisher!=='ezil'||j.name!=='ezil-chat')throw new Error('unexpected extension '+j.publisher+'.'+j.name);for(const k of ['ezilChat.autoStart','ezilChat.revealOnStartup'])if(!j.contributes.configuration.properties[k])throw new Error('ezil-chat lost the setting '+k+' that start-neko.sh uses to keep the panel dormant by default');console.log('built-in ezil-chat',j.version)" \
  && test -f /usr/lib/code-server/lib/vscode/extensions/ezil-chat/dist/extension.js \
  && test -f /usr/lib/code-server/lib/vscode/extensions/ezil-chat/dist/webview.js

# ── EZiL Models: the LanguageModelChatProvider behind the Copilot Chat UI ────
# `worker/ezil-models/dist/ezil-models-<version>.vsix` is built from
# `extensions/ezil-models/` by `worker/ezil-models/build-vsix.sh` and committed
# (same arrangement as ezil-chat above; `build-vsix.sh --check` fails when it
# is stale). Unpacked next to the other built-ins, it contributes vendor
# `ezil` to `languageModelChatProviders`: Copilot Chat lists its models under
# "EZiL" in Manage Models and routes Agent-mode requests (system prompt, 39
# tools, tool results, images) to them. Zero runtime dependencies.
#
# Models come from ONE file, `/etc/ezil/models.json` (`EZIL_MODELS_CONFIG`,
# which the extension reads before its `ezilModels.configPath` setting),
# shipped from `worker/ezil-models/models.json`: Anthropic direct
# (`{env:ANTHROPIC_API_KEY}`), Claude and OpenAI deployments on one Microsoft
# Foundry resource (`{env:AZURE_RESOURCE_NAME}` + `{env:AZURE_API_KEY}`) and
# OpenAI (`{env:OPENAI_API_KEY}`). No secret is in the image; "just put the
# key" = set the variable on the container. The gate rejects a literal key.
# Note (extensions/ezil-models/src/config.ts): a provider whose variable is
# UNSET is skipped — its models are not served and one warning naming the
# variable (never a value) goes to the output channel — while every other
# provider keeps serving, so set only the keys you have. Override the path
# with EZIL_MODELS_CONFIG to ship a smaller file (the e2e does exactly that).
COPY ezil-models/dist/ezil-models-0.1.0.vsix /tmp/ezil-models.vsix
RUN mkdir -p /tmp/ezil-models \
  && unzip -q /tmp/ezil-models.vsix 'extension/*' -d /tmp/ezil-models \
  && mv /tmp/ezil-models/extension /usr/lib/code-server/lib/vscode/extensions/ezil-models \
  && rm -rf /tmp/ezil-models /tmp/ezil-models.vsix \
  && node -e "const j=require('/usr/lib/code-server/lib/vscode/extensions/ezil-models/package.json');if(j.publisher!=='ezil'||j.name!=='ezil-models')throw new Error('unexpected extension '+j.publisher+'.'+j.name);const p=(j.contributes.languageModelChatProviders||[]);if(!p.some(x=>x.vendor==='ezil'))throw new Error('ezil-models does not contribute languageModelChatProviders vendor ezil');console.log('built-in ezil-models',j.version)" \
  && test -f /usr/lib/code-server/lib/vscode/extensions/ezil-models/dist/extension.js
COPY ezil-models/models.json /etc/ezil/models.json
ENV EZIL_MODELS_CONFIG=/etc/ezil/models.json
RUN node -e "const j=JSON.parse(require('fs').readFileSync('/etc/ezil/models.json','utf8'));if(!j.providers||!Object.keys(j.providers).length||!Array.isArray(j.models)||!j.models.length)throw new Error('models.json needs providers and models');for(const [n,p] of Object.entries(j.providers)){for(const k of ['apiKey','resource']){if(p[k]!==undefined&&!/^[{](env|file):[^}]+[}]$/.test(p[k]))throw new Error('providers.'+n+'.'+k+' must be an {env:NAME} or {file:/path} reference, not a literal');}}if(JSON.stringify(j).match(/sk-[A-Za-z0-9]{8}|[0-9a-f]{32}/))throw new Error('models.json looks like it carries a literal secret');if(j.models.filter(m=>m.default===true).length!==1)throw new Error('models.json must mark exactly one default model');console.log('models.json ok:',Object.keys(j.providers).join(','),'/',j.models.map(m=>m.id).join(','))"

# ── OpenCode CLI (the agent runtime EZiL Chat drives) ────────────────────────
# Pinned to the `@opencode/client` version the extension is compiled against
# (extensions/ezil-chat/src/opencode/version.ts — bump both together). OpenCode
# 2.x has no GitHub release assets (github.com/anomalyco/opencode releases stop
# at 1.18.x); the v2 line is published on npm only, and `@opencode/cli` is a
# stub that pulls a per-platform package. That package's `bin/opencode` is a
# standalone bun-compiled ELF (libc/libm/libpthread/libdl only, ~200 MB, no
# node at runtime), so it is fetched straight from the registry, checksummed
# and dropped on PATH — no `npm install -g`, nothing under node_modules. The
# sha256 is of the registry tarball; it corresponds to npm's `dist.integrity`
# (sha512) for the same file.
# The managed config below is the ONLY config the image ships. OpenCode reads
# `/etc/opencode/opencode.json` on Linux as its highest-precedence layer
# (https://opencode.ai/docs/config/ "Managed settings"), so every `opencode
# serve` the extension spawns — whatever OPENCODE_CONFIG or per-project files
# say — gets autoupdate off, sharing off and the Azure provider wiring. It
# holds no secrets; credentials are `{env:...}` references.
ARG OPENCODE_VERSION=2.0.19
ARG OPENCODE_LINUX_X64_SHA256=1041e5a6acb4b258174064d995ea375d3bfaa82152aed3c0960894e658d627ef
RUN curl --fail --location --silent --show-error \
      "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz" \
      --output /tmp/opencode.tgz \
  && echo "${OPENCODE_LINUX_X64_SHA256}  /tmp/opencode.tgz" | sha256sum --check --strict \
  && tar -xzf /tmp/opencode.tgz -C /tmp package/bin/opencode \
  && install -m 0755 /tmp/package/bin/opencode /usr/local/bin/opencode \
  && rm -rf /tmp/opencode.tgz /tmp/package \
  && if ldd /usr/local/bin/opencode | grep -qi "not found"; then echo "ERROR: opencode has unresolved shared libraries:" >&2; ldd /usr/local/bin/opencode | grep -i "not found" >&2; exit 1; fi \
  && test "$(HOME=/tmp/opencode-version-probe /usr/local/bin/opencode --version)" = "opencode v${OPENCODE_VERSION}" \
  && rm -rf /tmp/opencode-version-probe
COPY opencode/opencode.json /etc/opencode/opencode.json
RUN node -e "const j=JSON.parse(require('fs').readFileSync('/etc/opencode/opencode.json','utf8'));if(j.autoupdate!==false||j.share!=='disabled')throw new Error('managed opencode.json must keep autoupdate=false and share=disabled');if(JSON.stringify(j).match(/sk-[A-Za-z0-9]{8}|[0-9a-f]{32}/))throw new Error('managed opencode.json looks like it carries a literal secret');console.log('managed opencode.json ok')"

# ── EZiL OS desktop assets + deterministic validators ────────────────────────
# Explicit Openbox config (app-switch keybindings + root menu), the mandatory
# native-browser landing page (deterministic, non-blank content/title), and the
# machine-checkable validation scripts. These are installed into the FINAL image
# so start-neko.sh and any in-container validation pass can use them directly.
COPY assets/ebuilder-openbox.xml /etc/neko/ebuilder-openbox.xml
COPY assets/ebuilder-menu.xml    /etc/neko/ebuilder-menu.xml
COPY assets/browser-home.html    /usr/local/share/ezil/browser-home.html
COPY scripts/validate-neko-focus.sh          /usr/local/bin/validate-neko-focus.sh
COPY scripts/validate-neko-desktop.sh        /usr/local/bin/validate-neko-desktop.sh
COPY scripts/validate-neko-browser-window.sh /usr/local/bin/validate-neko-browser-window.sh
RUN chmod +x /usr/local/bin/validate-neko-focus.sh \
             /usr/local/bin/validate-neko-desktop.sh \
             /usr/local/bin/validate-neko-browser-window.sh \
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
# both reference by name. `next.config.js`'s `turbopack.root: '/'` is likewise
# required, not optional: start-neko.sh symlinks node_modules to local disk
# OUTSIDE this workspace root, and Next 16's Turbopack dev server fatals on
# any node_modules symlink escaping its detected project root without it
# (`Symlink [project]/node_modules is invalid, it points out of the
# filesystem root`) — see that file's own doc comment for the full trace.
COPY sandbox-template /opt/ezil-sandbox-template
RUN test -f /opt/ezil-sandbox-template/package.json \
  && test -f /opt/ezil-sandbox-template/README.md \
  && test -f /opt/ezil-sandbox-template/pages/index.js \
  && test -f /opt/ezil-sandbox-template/next.config.js

# ── Browser sidecar: the desktop browser's narrow automation surface ─────────
# `worker/sidecar/` — a small Node service that connects to Chrome's CDP port
# on container loopback (`--remote-debugging-port=9222`, added to the Chrome
# launch in start-neko.sh) with `playwright-core`'s `connectOverCDP`, and
# serves a FIXED verb set on 0.0.0.0:9223. Launched by start-neko.sh's
# `launch_browser_sidecar`, after the boot readiness verdict, so it can never
# affect whether the desktop comes up.
#
# 🔴 THE TWO PORTS ARE NOT THE SAME KIND OF THING.
#    9222 is CDP: unauthenticated and TOTAL — whatever reaches it reads every
#    page, exfiltrates the profile's cookies and runs arbitrary JS in any
#    origin. It stays on 127.0.0.1 (Chromium M113+ forces that anyway) and is
#    deliberately NOT `EXPOSE`d below, not `exposePort()`d by the Worker, and
#    not proxied by anything.
#    9223 is the sidecar: navigate / snapshot / click / type / get_text /
#    screenshot / console / network / wait_for, with NO CDP passthrough verb —
#    see `sidecar/README.md` and the pinned wire contract it names. It is
#    reached by `sandbox.containerFetch` from an HMAC-gated Worker route, NOT
#    through `src/preview-bridge.ts` (which accepts 3002 and 8443 by design).
#
# `playwright-core` — not `playwright` — on purpose: we connect to a browser
# that is already running, so none of the browser DOWNLOADS the full package
# pulls in are wanted. `--omit=dev` keeps it to that one dependency. The
# version is pinned in `sidecar/package.json`; `npm ci` is not used because
# there is no lockfile to keep in step with a single pinned dependency.
#
# The final `node -e` runs verbs.mjs's LOAD-TIME route/contract conformance
# check inside the image (it throws when the served routes and
# `sidecar/contract.mjs` have drifted) and asserts the verb COUNT, so a server
# whose wire has drifted from its own declaration fails the BUILD rather than
# failing to be noticed. It imports the module without binding any port.
COPY sidecar /opt/ezil-sidecar
RUN cd /opt/ezil-sidecar \
  && npm install --omit=dev --no-audit --no-fund \
  && test -f /opt/ezil-sidecar/server.mjs \
  && test -d /opt/ezil-sidecar/node_modules/playwright-core \
  && node --check /opt/ezil-sidecar/server.mjs \
  && node --check /opt/ezil-sidecar/verbs.mjs \
  && node --check /opt/ezil-sidecar/browser.mjs \
  && node --check /opt/ezil-sidecar/redact.mjs \
  && node --check /opt/ezil-sidecar/page-scripts.mjs \
  && node -e "import('/opt/ezil-sidecar/verbs.mjs').then(m=>{const n=Object.keys(m.VERBS).length;if(n!==10)throw new Error('expected 10 verbs, got '+n);console.log('sidecar verbs ok:',n)})"

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
# reference) once neko is already serving, which is what actually listens on
# this port — see that script's doc comment for package-manager detection,
# phase reporting, and why its call site is last in the boot sequence.
EXPOSE 8080
EXPOSE 8181
EXPOSE 3002
# code-server (see the install step above); 0.0.0.0:8443, reached via src/preview-bridge.ts.
EXPOSE 8443

# The browser sidecar's narrow automation surface (`sidecar/`, see the COPY
# above). Reached by `sandbox.containerFetch` from the Worker's HMAC-gated
# `POST /sandbox/:name/browser/:verb` route — NOT by `exposePort()` (which
# would mint an unauthenticated public preview hostname for a surface that can
# drive the user's logged-in browser) and NOT through `src/preview-bridge.ts`,
# which accepts 3002 and 8443 by design.
#
# 🔴 9222 — Chrome's CDP port — is DELIBERATELY ABSENT from this file, and must
#    stay absent. CDP is unauthenticated and total. It lives on 127.0.0.1 only
#    (Chromium M113+ pins it there regardless of flags) and the sidecar is the
#    only thing that talks to it.
EXPOSE 9223

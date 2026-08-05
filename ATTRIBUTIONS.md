# Attributions

EZiL-OS is licensed under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)). This document credits every upstream project
whose code, binary, or container-image component is actually present in
this repository, states the license each one carries, and flags anything
that constrains redistribution.

**Third-party application source code is confined to one directory.**
EZiL-OS incorporates a **modified fork of the Puter web desktop**, and every
file derived from it lives under [`shell/src/`](./shell/src). Nothing outside
that directory derives from another project's application source; the rest of
this repository is EZiL-authored code plus ordinary, unmodified runtime
dependencies and container-image components, listed below.

[`shell/PUTER-PROVENANCE.md`](./shell/PUTER-PROVENANCE.md) is the
file-by-file index of what was taken verbatim, what was taken and modified,
and what was written fresh. **It is authoritative over any summary in this
file** — the `shell/` tree is now populated (both `shell/src/` — the
Puter-derived tree — and `shell/ezil/`, EZiL-authored code that sits
alongside it and talks to Puter's UI layer without deriving from it), so the
index, not this paragraph, is where to check what is actually present at any
given commit.

If you believe an attribution is missing or inaccurate, please open an issue
— under-crediting an upstream project is treated as a bug in this repository.

---

## 1. Forked application source (`shell/`)

### Puter (`HeyPuter/puter`)
- **URL:** https://github.com/HeyPuter/puter
- **License:** **AGPL-3.0-only** (verified via GitHub Licenses API).
- **Used for:** The browser desktop shell — window manager, taskbar, desktop
  surface, and their CSS. EZiL-OS is licensed AGPL-3.0-only itself, so there
  is no licence conflict and no relicensing: the fork stays AGPL-3.0-only and
  this repository's own terms already satisfy it.
- **🔴 MODIFIED.** This is a fork, not a dependency. Puter's GUI talks to a
  cloud backend for identity, files, key-value preferences, app metadata and
  realtime; **none of that backend exists in EZiL-OS.** The shell runs in the
  browser and talks only to EZiL's own Worker and container. Removed or
  replaced wholesale: `puter.kv` (→ browser `localStorage`, see
  `shell/ezil/session.js`), `puter.fs`, `puter.apps`, `puter.auth`, socket.io
  realtime, `services/*`, `IPC.js`, and the entire `src/backend` tree. The
  `:root` design tokens the chrome derives from are overridden by
  `shell/src/css/ezil-tokens.css`. Puter's webpack build is not used; see
  `shell/build-shell.sh`.
- **Modification notice (AGPL-3.0 §5(a)):** this software is a modified
  version of Puter software and is **not endorsed by Puter Technologies
  Inc.** Per-file records of what changed, and when, are in
  [`shell/PUTER-PROVENANCE.md`](./shell/PUTER-PROVENANCE.md).
- **Trademarks:** Puter's `TRADEMARK.md` grants **no trademark rights**, and
  explicitly requires a modified distribution to remove Puter's logos.
  Accordingly EZiL-OS carries no Puter logos, names or marks in its shipped
  UI or branding; the Puter word mark appears in this repository only in
  attribution and provenance prose, which is the use that policy permits.
  Puter is a trademark of Puter Technologies Inc. EZiL-OS is not affiliated
  with, sponsored by, or endorsed by Puter Technologies Inc.

---

## 2. Desktop / sandbox container image (`worker/Dockerfile`)

### Apache Guacamole (`apache/guacamole-client`, `apache/guacamole-server`)
- **URL:** https://guacamole.apache.org/
- **License:** Apache-2.0 (verified: official release artifacts, standard
  Apache-2.0 project).
- **Used for:** The default remote-desktop path. The image installs the
  official `guacamole-1.3.0.war` release from `archive.apache.org` and the
  Ubuntu `apt` packages `guacd` / `libguac-client-vnc0`. **No Guacamole
  source is vendored or modified** — only EZiL-authored configuration
  (`worker/guacamole/guacamole.properties`, `user-mapping.xml`) and a
  custom landing page (`root-index.html`) that talks to the unmodified
  Guacamole web app.

### Neko (`m1k1o/neko`)
- **URL:** https://github.com/m1k1o/neko
- **License:** Apache-2.0 (verified via GitHub Licenses API).
- **Used for:** The alternate `neko` desktop mode — WebRTC-based browser
  desktop streaming. Pinned at commit `d74052bb844c43a0cc3c2386d083f7505dc483a2`,
  consumed as a pre-built binary/asset copied from a project-owned build
  stage (`ezil-neko-vscode`) into the final image. The `/usr/bin/neko`
  binary and `/etc/neko` config are unmodified. Its compiled HTML5 client
  bundle's **static branding assets** (favicons, PWA manifest, mask icon,
  the `img/logo.800bec71.svg` wordmark — a cat-silhouette mark — and the
  `chat.mp3` notification sound) and a handful of strings/colors in
  `index.html` **are** replaced by a second, local-only build stage
  (`worker/assets/neko-branding/Dockerfile`, tag
  `ezil-neko-vscode:d74052bb-049931d7-ezil-brand1`) layered on top of the
  unmodified upstream image before `worker/Dockerfile` consumes it — no
  upstream JS/CSS, and no copyright/license notice, is altered. Apache-2.0
  imposes no on-screen-attribution obligation, so this is permitted; full
  attribution stays here rather than in the product UI.

### neko-apps (`m1k1o/neko-apps`)
- **URL:** https://github.com/m1k1o/neko-apps
- **License: UNVERIFIED.** No upstream `LICENSE` file was found for this
  repository at last check. It is maintained by the same author/org as
  Neko (Apache-2.0), but that is not a substitute for a confirmed grant —
  do not assume Apache-2.0 without checking again before relying on it.
  Pinned at commit `049931d7638f9db8598f29c369d2fb7cd2c6e4b4`.
- **Used for:** its `vscode` recipe produces a pinned Electron VS Code build
  in an intermediate build stage of `worker/Dockerfile`. **That build stage's
  output is deliberately NOT copied into the final image** — see
  `code-server` below, which replaced it in the same commit that removed the
  `COPY --from=neko /usr/share/code` step. neko-apps is therefore a
  build-time-only input with nothing from it, or from the Electron VS Code
  build it produces, present in the shipped container image today.

### code-server (`coder/code-server`)
- **URL:** https://github.com/coder/code-server
- **License:** **MIT** (verified via the GitHub Licenses API against the
  `LICENSE` file on `coder/code-server`'s `main` branch: "The MIT License,
  Copyright (c) 2019 Coder Technologies Inc.").
- **Used for:** the in-browser code editor (VS Code in the browser) served
  to users, replacing the Electron VS Code build described above.
  `worker/Dockerfile` installs it via the official installer
  (`curl -fsSL https://code-server.dev/install.sh | sh`), which fetches a
  prebuilt `.deb` release directly from `coder/code-server`'s own GitHub
  releases — no code-server source is vendored or modified in this
  repository, and no separate Electron/Chromium renderer is composited into
  the container's display for it (code-server serves the IDE over plain
  HTTP; the note in `worker/Dockerfile` explains why the two approaches
  cannot coexist in one container). Because code-server ships the
  open-source ("Code - OSS", MIT) VS Code build with Microsoft's proprietary
  product branding, telemetry and marketplace access already stripped out
  and pointed at Open VSX by default, using it — rather than Microsoft's own
  official binary (which the superseded Electron build above downloaded
  under the proprietary Microsoft Software License Terms) — avoids that
  proprietary-terms question entirely.

### Google Chrome
- Installed via the official `google-chrome-stable` `.deb` from
  `dl.google.com`, not the open-source Chromium project. Google Chrome is
  Google's proprietary binary distribution (built on the BSD-3-Clause
  Chromium source plus Google-proprietary components), used here strictly
  as an unmodified, separately-downloaded runtime dependency under Google's
  Chrome Terms of Service. No Chromium/Google source is vendored here.

---

## 3. `worker/` npm dependencies (`worker/package.json`, `worker/bun.lock`)

| Package | License | Used for |
|---|---|---|
| `@cloudflare/sandbox` 0.12.1 | Apache-2.0 | Runs and drives the sandbox container (Cloudflare Sandbox SDK) from the Worker |
| `@cloudflare/containers` (transitive) | MIT OR Apache-2.0 | Container-lifecycle primitives underlying `@cloudflare/sandbox` |
| `aws4fetch` (transitive) | MIT | AWS SigV4 request signing (R2 access) |
| `capnweb` (transitive) | MIT | Cap'n Web RPC transport used by the sandbox SDK |
| `hono` (transitive) | MIT | HTTP routing used internally by the sandbox SDK |
| `wrangler` (dev) | MIT OR Apache-2.0 | Build/deploy CLI — not shipped in the deployed Worker |
| `typescript` (dev) | Apache-2.0 | Type-checking — not shipped |
| `@cloudflare/workers-types` (dev) | MIT OR Apache-2.0 | Type declarations — not shipped |

All licenses above were read directly from each installed package's own
`package.json` in `worker/node_modules` (not assumed from memory or from
the registry page). Every one is a permissive license (MIT and/or
Apache-2.0) — none imposes copyleft or redistribution obligations beyond
retaining their own license/copyright notices.

No GPL, LGPL, AGPL, SSPL, or "non-commercial only" dependency was found in
`worker/`'s dependency tree.

---

## 4. Voluntary acknowledgements (no code carried, no license obligation)

Nothing in this section is required by any license. It is here because the
lineage is real and we'd rather over-credit than under-credit.

### Onlook (`onlook-dev/onlook`)
- **URL:** https://github.com/onlook-dev/onlook
- **License:** Apache-2.0 (verified against upstream's `LICENSE.md`).
- **Relationship:** EZiL-OS's predecessor prototype was architecturally
  built on top of Onlook, an open-source AI-first visual React editor.
  **This repository (EZiL-OS) carries no Onlook code** — it was started
  clean, and none of `app/`, `worker/`, `shell/` or `docs/` derives from
  or contains any Onlook source. Because no code is carried, Onlook's
  Apache-2.0 license imposes **no obligation** on this repository.
  **We credit Onlook anyway, voluntarily**, because the architectural
  lineage — the idea of a persistent, streamed, real desktop/editor
  environment reachable from a browser tab — traces back through it, and
  erasing that history would be dishonest even though it isn't legally
  required.

> **Puter used to be listed here.** It no longer belongs in a "no code
> carried" section: EZiL-OS now forks it, so the credit is a licence
> obligation rather than a courtesy. See **§1** above.

---

## 5. UNVERIFIED items carried forward

These could not be independently confirmed as of this writing. They are
marked UNVERIFIED rather than guessed at, and should be re-checked before
anyone relies on an assumed license:

- **`neko-apps` (`m1k1o/neko-apps`)** — no upstream `LICENSE` file found.
  See §2 above.
- **`onlook-dev/admin`** — not publicly accessible; license could not be
  checked. Not relevant to this repository's own license posture since no
  code from it is present here, but carried forward from prior research in
  case it is ever referenced again.

---

## 6. Method

- Licenses for container-image components (Guacamole, Neko, neko-apps, VS
  Code, Chrome) were verified against upstream project pages/release
  artifacts and prior audits of the same pinned commits/versions used by
  `worker/Dockerfile`. code-server's MIT license was re-verified directly
  against the GitHub Licenses API for `coder/code-server`'s `main` branch
  (not assumed from memory) when it replaced the Electron VS Code build in
  the shipped image; its Open VSX-by-default behaviour was confirmed
  against Coder's own published FAQ.
- Licenses for `worker/`'s npm dependencies were read directly from each
  package's installed `package.json` under `worker/node_modules` (i.e.
  from the actual artifact this repository builds with), not assumed from
  the npm registry page or from memory.
- `worker/src/`, `worker/scripts/`, and `worker/bootstrap/` were searched
  for literal `onlook`/`puter` references; no real hits were found (only
  incidental substring matches inside the word "computer"). That search
  predates `shell/` and says nothing about it — `shell/` is Puter-derived
  by design, and its provenance is tracked per file in
  `shell/PUTER-PROVENANCE.md` rather than by grep.
- Puter's own `TRADEMARK.md` was read in full to establish that the
  copyright grant carries **no trademark licence**, and that a modified
  distribution must remove Puter's logos and state that it is modified and
  unendorsed. Both requirements are discharged in §1 and in `NOTICE`.
- Anything that could not be independently confirmed is marked
  **UNVERIFIED** above, with what was checked, rather than guessed at.

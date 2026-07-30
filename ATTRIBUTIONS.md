# Attributions

EZiL-OS is licensed under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)). This document credits every upstream project
whose code, binary, or container-image component is actually present in
this repository, states the license each one carries, and flags anything
that constrains redistribution.

**This is a clean-start repository.** Unlike an earlier, unpublished
prototype this project grew out of, EZiL-OS carries **no third-party
application source code** — only ordinary, unmodified runtime dependencies
and container-image components, listed below. If you believe an
attribution is missing or inaccurate, please open an issue — under-crediting
an upstream project is treated as a bug in this repository.

---

## 1. Desktop / sandbox container image (`worker/Dockerfile`)

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
  stage (`ezil-neko-vscode`) into the final image. Not modified in this
  repository.

### neko-apps (`m1k1o/neko-apps`)
- **URL:** https://github.com/m1k1o/neko-apps
- **License: UNVERIFIED.** No upstream `LICENSE` file was found for this
  repository at last check. It is maintained by the same author/org as
  Neko (Apache-2.0), but that is not a substitute for a confirmed grant —
  do not assume Apache-2.0 without checking again before relying on it.
  Pinned at commit `049931d7638f9db8598f29c369d2fb7cd2c6e4b4`.
- **Used for:** Supplies the `vscode` app recipe used to produce the pinned
  VS Code build baked into the sandbox image's build stage. Nothing from
  neko-apps ships as code in this repository; it is a build-time input to
  the container image only.

### Visual Studio Code (Microsoft's official build)
- Installed via the `neko-apps` `vscode` recipe, which downloads Microsoft's
  official `.deb` (`go.microsoft.com/fwlink/?LinkID=760868`). The underlying
  source, `microsoft/vscode` ("Code - OSS"), is MIT-licensed, but the
  **released Microsoft binary is distributed under the proprietary
  Microsoft Software License Terms** (product name/icon, telemetry,
  marketplace access — not covered by the MIT grant). No VS Code source is
  modified or redistributed by this repository; the container image
  downloads Microsoft's official binary at build time, under Microsoft's
  own terms.

### Google Chrome
- Installed via the official `google-chrome-stable` `.deb` from
  `dl.google.com`, not the open-source Chromium project. Google Chrome is
  Google's proprietary binary distribution (built on the BSD-3-Clause
  Chromium source plus Google-proprietary components), used here strictly
  as an unmodified, separately-downloaded runtime dependency under Google's
  Chrome Terms of Service. No Chromium/Google source is vendored here.

---

## 2. `worker/` npm dependencies (`worker/package.json`, `worker/bun.lock`)

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

## 3. Voluntary acknowledgements (no code carried, no license obligation)

Nothing in this section is required by any license. It is here because the
lineage is real and we'd rather over-credit than under-credit.

### Onlook (`onlook-dev/onlook`)
- **URL:** https://github.com/onlook-dev/onlook
- **License:** Apache-2.0 (verified against upstream's `LICENSE.md`).
- **Relationship:** EZiL-OS's predecessor prototype was architecturally
  built on top of Onlook, an open-source AI-first visual React editor.
  **This repository (EZiL-OS) carries no Onlook code** — it is a
  clean-start repository containing only `worker/` (a Cloudflare Worker
  and container image) and `docs/`, neither of which derives from or
  contains any Onlook source. Because no code is carried, Onlook's
  Apache-2.0 license imposes **no obligation** on this repository.
  **We credit Onlook anyway, voluntarily**, because the architectural
  lineage — the idea of a persistent, streamed, real desktop/editor
  environment reachable from a browser tab — traces back through it, and
  erasing that history would be dishonest even though it isn't legally
  required.

### Puter (`HeyPuter/puter`)
- **URL:** https://github.com/HeyPuter/puter
- **License:** AGPL-3.0 (verified via GitHub Licenses API).
- **Relationship:** Puter was studied as a **design and product reference**
  for "a real computer in your browser" UX patterns during EZiL-OS's
  design phase. **No code from Puter has been copied into this
  repository.** As with Onlook, this credit is **entirely voluntary** —
  no license obligation is triggered by studying a product's UX. If code
  is ever incorporated from Puter, this file must be updated at that time
  to say so explicitly and to carry forward Puter's AGPL-3.0 terms for
  that code (conveniently compatible with EZiL-OS's own AGPL-3.0 license).

---

## 4. UNVERIFIED items carried forward

These could not be independently confirmed as of this writing. They are
marked UNVERIFIED rather than guessed at, and should be re-checked before
anyone relies on an assumed license:

- **`neko-apps` (`m1k1o/neko-apps`)** — no upstream `LICENSE` file found.
  See §1 above.
- **`onlook-dev/admin`** — not publicly accessible; license could not be
  checked. Not relevant to this repository's own license posture since no
  code from it is present here, but carried forward from prior research in
  case it is ever referenced again.

---

## 5. Method

- Licenses for container-image components (Guacamole, Neko, neko-apps, VS
  Code, Chrome) were verified against upstream project pages/release
  artifacts and prior audits of the same pinned commits/versions used by
  `worker/Dockerfile`.
- Licenses for `worker/`'s npm dependencies were read directly from each
  package's installed `package.json` under `worker/node_modules` (i.e.
  from the actual artifact this repository builds with), not assumed from
  the npm registry page or from memory.
- `worker/src/`, `worker/scripts/`, and `worker/bootstrap/` were searched
  for literal `onlook`/`puter` references; no real hits were found (only
  incidental substring matches inside the word "computer").
- Anything that could not be independently confirmed is marked
  **UNVERIFIED** above, with what was checked, rather than guessed at.

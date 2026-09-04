# EZiL OS — local mode launcher

This directory ships inside every release tarball (`ezil-os-<tag>.tar.gz`,
built by
[`.github/workflows/release.yml`](../../.github/workflows/release.yml) from a
pushed `v*` tag). It is the fastest way to run a real EZiL OS desktop on your
own machine with no Cloudflare account, no Vercel project and no Supabase
project — see the main [README](../../README.md) for what those buy you
instead.

## What the download contains

```
ezil-os-<tag>/
  local/                  the native Bun host (source, no node_modules)
  worker/src/              two pure files local/ imports for its port map
  app/public/os/           the built desktop shell (bundle.min.js/.css, icons.js)
  deploy/images.env        the pinned desktop image reference
  deploy/launcher/         this launcher (ezil-os.sh, ezil-os.ps1)
  LICENSE, NOTICE, ATTRIBUTIONS.md
  RELEASE-MANIFEST.txt     git sha, tag, and the image reference this build pins
  SHA256SUMS               checksums for the tarball and both launcher scripts
```

## Running it

You need [Docker](https://www.docker.com/) and [Bun](https://bun.sh/)
installed already — the launcher checks for both and tells you exactly what
to install if either is missing; it never installs anything itself.

**macOS / Linux:**

```bash
tar xzf ezil-os-<tag>.tar.gz
cd ezil-os-<tag>
./deploy/launcher/ezil-os.sh
```

**Windows (PowerShell 5.1+):**

```powershell
tar xzf ezil-os-<tag>.tar.gz
cd ezil-os-<tag>
.\deploy\launcher\ezil-os.ps1
```

The launcher pulls the pinned desktop image (about 1.4 GB to transfer, about
4.6 GB on disk once extracted; amd64 only — an Apple Silicon or Windows-on-ARM
machine runs it under emulation and the launcher warns about that), runs
`bun run --cwd local doctor` and stops if it finds a problem, then starts the
local host and opens your desktop at `http://127.0.0.1:7080/os` once it
answers. Press Ctrl-C to stop — it shuts down the host and removes the
container it started.

Every `EZIL_*` variable `local/src/config.ts` reads (`EZIL_LOCAL_PORT`,
`EZIL_LOCAL_PORT_OFFSET`, `EZIL_LOCAL_WORKSPACE`, `EZIL_LOCAL_STATE_DIR`,
`EZIL_LOCAL_SHELL_DIR`, `EZIL_MCP_ENDPOINT`, `EZIL_APP_URL`) works the same way
here: export it before running the launcher and it reaches the doctor and the
host unchanged. `EZIL_LAUNCHER_IMAGE=<image:tag>` is launcher-only — set it to
skip `deploy/images.env` and use an image you already have (useful if you
built the desktop image yourself from `worker/Dockerfile`).

## What it connects to

Exactly three kinds of address, and nothing else — `release.yml` runs a static
check on both scripts to hold this line:

- the container **registry** (`ghcr.io`), to `docker pull` the pinned image;
- two install pages it only ever **prints**, never fetches
  (`docs.docker.com`, `bun.sh`) — you copy the command yourself;
- its own **loopback host**, `127.0.0.1` — the local `/os` server and the
  container's published ports. Nothing binds any other address; see
  `local/src/server/server.ts`'s `assertLoopbackBind`.

Nothing here talks to `*.ezil.work`, `*.workers.dev`, `*.vercel.app`, or any
EZiL-operated service. There is no telemetry call — the NDJSON file the doctor
and the host mention is written to your own disk and read by nothing.

## Verifying what you downloaded

```bash
# The tarball and both launcher scripts against the published checksums:
sha256sum -c SHA256SUMS

# That this release was actually built by EZiL-OS's own CI, not hand-uploaded:
gh attestation verify ezil-os-<tag>.tar.gz --owner EZiLHQ

# That the container image itself was signed by the same workflow (keyless
# cosign, so there is no key to leak or rotate — the identity is the workflow
# that built it):
cosign verify \
  --certificate-identity-regexp '^https://github\.com/EZiLHQ/ezil-os/\.github/workflows/image\.yml@refs/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/ezilhq/ezil-os-desktop:<tag>
```

## One founder step this depends on

GHCR packages default to **private**. Until `ghcr.io/ezilhq/ezil-os-desktop`
and `ghcr.io/ezilhq/ezil-neko-vscode` are switched to **Public** (repository
→ Packages → package settings), `docker pull` above returns `unauthorized` for
everyone who is not logged in to a GHCR account with read access — the
launcher cannot do this itself; it has no registry credential of its own and
is not supposed to.

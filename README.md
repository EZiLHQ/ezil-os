[![CI](https://github.com/EZiLHQ/ezil-os/actions/workflows/ci.yml/badge.svg)](https://github.com/EZiLHQ/ezil-os/actions/workflows/ci.yml) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

# EZiL-OS

**A real Linux computer, running in your browser.**

<!-- SCREENSHOT: docs/assets/desktop.png -->

EZiL-OS gives every user a persistent, full Linux desktop and dev environment —
not a mockup, not a browser-based simulation, but an actual sandboxed computer
(real filesystem, real processes, a real code editor and a real browser inside
it) that boots on demand, streams to any device, and picks up exactly where
you left it. It's built for freelancers and independent professionals doing
real work: a computer you sign into from any tab, rather than a box tied to
one desk.

## Status

EZiL-OS is deployed and live, but should be treated as alpha software. A
stranger can read and study all of it; running the full stack requires your own
Cloudflare, Vercel, and [Supabase](https://supabase.com/) accounts.

## What's actually here

Three things, wired together:

- **A streamed Linux desktop.** A Cloudflare Container managed through the
  [Cloudflare Sandbox SDK](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-sandbox/) running
  a real browser ([Google Chrome](./ATTRIBUTIONS.md)) and
  [code-server](https://github.com/coder/code-server) (VS Code in the browser)
  against your own persistent workspace. It streams through either the
  [Apache Guacamole](https://guacamole.apache.org/) HTML5 tunnel or
  [Neko](https://github.com/m1k1o/neko) over WebRTC; Neko is the configured
  default.
- **An app preview bridge.** The Worker also exposes whatever a dev server
  inside the container is listening on as its own signed, expiring preview
  URL — so a web app you're building inside the desktop is reachable directly,
  not just through the streamed screen.
- **A boot-honesty contract.** Booting a real container takes real time
  (measured, not assumed — see `docs/PLATFORM-NOTES.md`). Rather than a spinner
  that either resolves or hangs forever with no explanation, the shell surfaces
  named boot phases as they happen and says plainly when it genuinely doesn't
  know whether the desktop came up — never a false "ready."

## Prerequisites

- Bun
- Node.js 22
- Docker
- A Cloudflare account with Containers access
- A Vercel project
- A Supabase project

Without these, you can build and test the pieces, but you cannot run a real
desktop.

## Repository layout

```text
.
├── worker/  # Cloudflare Worker (Durable Objects + R2) and the container image:
│           #   Guacamole/Neko streaming, code-server, the app preview bridge
├── app/     # Next.js web app: auth, the "your computers" list, the /os host
│           #   page, Supabase Postgres (via Drizzle) as the one datastore
├── shell/   # The in-browser desktop UI — a modified fork of Puter's GUI, plus
│           #   EZiL-authored code; built into app/public/os/bundle.min.js
├── sdk/     # @ezil-os/sdk — a typed client for the computer API
├── mcp/     # @ezil-os/mcp — an optional MCP connector over that SDK
├── docs/    # Platform notes, the runbook, telemetry, and design records
└── e2e/     # Production suites: real sign-in, real container, live deployment
```

`app/` is a [Next.js](https://nextjs.org/) application. It renders one real
page (`/os`) whose entire job is to paint the `shell/`-built bundle fast and
hand it a boot payload; everything a user sees after that first paint is drawn
by that bundle talking to the Worker. `sdk/` is a typed client for third parties.
`mcp/` is an optional Model Context Protocol connector, explicitly not a
dependency of EZiL-OS itself.

## Architecture

A desktop request starts in the browser, on the Next.js app deployed to Vercel.
The app owns the signed-in product surface and keeps application data in
Supabase; it hands the desktop request to the Cloudflare Worker. The Worker
dispatches to the sandbox's Durable Object, which — through the Sandbox SDK —
starts or reconnects to that sandbox's Container. The Worker then returns a
signed, short-lived route for the browser to open.

**The workspace is not an R2 mount.** `/workspace` is plain container disk, and
R2 is reached only through the Worker's own bucket binding: the container
hydrates from R2 on boot and flushes changed files back on a timer and at
shutdown (`worker/src/workspace-persist.ts`). This is deliberate and was
expensive to learn — mounting R2 with `sandbox.mountBucket()`/s3fs silently
drops **every second write**, 0 bytes, with no error a shell redirection would
ever see. `docs/PLATFORM-NOTES.md` §1 has the measurement.

The running desktop reaches the browser by one of two streaming paths: the
Apache Guacamole HTML5 tunnel, or Neko over WebRTC. Neko is the configured default
(`SANDBOX_DEFAULT_DESKTOP_MODE = "neko"` in `worker/wrangler.toml`). The Worker
also brokers signed, expiring routes to application and code-server ports
inside the same container.

## Running it

Three independent pieces, each with its own dependencies:

**The Worker** (Bun-managed Cloudflare Worker + container image):

```bash
cd worker
bun install
bun run dev          # wrangler dev, local Worker + container
bun run typecheck    # tsc --noEmit
bun run test         # bun test
```

See [`worker/README.md`](./worker/README.md) for the container image's
architecture (Guacamole/Neko/code-server) and how the Worker drives it.

**The app** (Next.js, needs a Supabase Postgres instance):

```bash
cd app
bun install
bun run dev          # next dev
bun run typecheck    # tsc --noEmit
bun run lint         # eslint
bun run test         # vitest run
bun run build        # next build — run this before a PR that touches app/
bun run db:generate  # drizzle-kit generate, after a schema change
```

Requires `SUPABASE_DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` at minimum (`app/src/env.ts` validates the
full set eagerly at boot and fails loudly if one is missing); the Cloudflare
Guacamole variables are optional for local app-only work.

**The shell** (the desktop UI bundle):

```bash
shell/build-shell.sh          # builds app/public/os/bundle.min.js
shell/build-shell.sh --check  # verify the build is up to date, no write
```

**The SDK and the MCP connector** (neither is required to run EZiL-OS):

```bash
cd sdk && bun install && bun run typecheck && bun run test
cd mcp && bun install && bun run typecheck && bun run test
```

See [`sdk/README.md`](./sdk/README.md) and [`mcp/README.md`](./mcp/README.md).
`mcp/` is a **connector**: nothing in `worker/`, `app/` or `shell/` imports it,
and EZiL-OS runs identically whether or not you ever install it.

## Telemetry

EZiL-OS collects crash/error telemetry from signed-in sessions — never
identities, file contents, secrets, or full URLs. **[`docs/telemetry.md`](./docs/telemetry.md)**
is the exact, code-linked account of what is collected, what deliberately is
not, how long it's kept, and how to stop it from reaching this repo's servers
at all. The design it was built from, down to the fingerprinting rule and the
closed event taxonomy, is [`docs/telemetry-design.md`](./docs/telemetry-design.md).

## Security

Report security vulnerabilities privately; see [`SECURITY.md`](./SECURITY.md)
for the reporting process. Never report a vulnerability in a public issue.

## Further reading

- **[`docs/PLATFORM-NOTES.md`](./docs/PLATFORM-NOTES.md)** — everything learned
  the hard way about Cloudflare Containers/Workers, Vercel, and this stack's
  own sharp edges. Read it before assuming a primitive behaves the way its
  docs imply.
- **[`docs/RUNBOOK.md`](./docs/RUNBOOK.md)** — the operational runbook: what's
  live, known constraints, and open items.
- **[`docs/NEKO-GROUND-TRUTH.md`](./docs/NEKO-GROUND-TRUTH.md)** — what a real
  container actually does, established by running one and photographing it. The
  screenshots it cites are committed in `docs/assets/`, so every claim can be
  checked against the pixels it was drawn from.
- **[`docs/PERFORMANCE-BASELINE.md`](./docs/PERFORMANCE-BASELINE.md)** — where
  the time goes, measured against live production, with its own limits stated
  up front.
- **[`docs/BROWSER-FIX-CONTRACT.md`](./docs/BROWSER-FIX-CONTRACT.md)** — how one
  interface was frozen while twelve parallel workstreams changed the same
  browser.

## License

EZiL-OS is licensed under the **[GNU Affero General Public License
v3.0](./LICENSE) (AGPL-3.0)**.

In practice, that means:

- **You can** use, study, modify, and redistribute this code, for free,
  including for commercial purposes.
- **If you run a modified version of EZiL-OS as a network service** (for
  example, hosting it for others to use over the web), the AGPL-3.0
  requires you to make the corresponding source code of your modified
  version available to the users of that service. This is the key
  difference from a plain GPL or permissive license — it applies even if
  you never distribute a binary, only a hosted service.
- **Contributions** to this repository are accepted under the same
  AGPL-3.0 terms (see [`CONTRIBUTING.md`](./CONTRIBUTING.md)). Who has
  contributed is recorded in [`CONTRIBUTORS.md`](./CONTRIBUTORS.md); the
  third-party code this builds on is in
  [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md).

This is not legal advice; read the [full license text](./LICENSE) or talk
to a lawyer if you have a specific redistribution or hosting scenario in
mind.

## Built on the work of

EZiL-OS did not start from a blank slate. The streamed-desktop backend builds
on Apache Guacamole, Neko, code-server/VS Code, Google Chrome, and the
Cloudflare Sandbox SDK; the in-browser desktop UI (`shell/`) is a **modified
fork of [Puter](https://github.com/HeyPuter/puter)** (AGPL-3.0) — genuinely
forked code, not just an influence, tracked file-by-file in
[`shell/PUTER-PROVENANCE.md`](./shell/PUTER-PROVENANCE.md). The project's
architectural lineage also traces back through an earlier prototype built on
**[Onlook](https://github.com/onlook-dev/onlook)** (Apache-2.0); no Onlook code
is present in this repository, and it is credited voluntarily.

Some source comments cite **EBuilder** as the origin of a file. EBuilder is
EZiL's separate, unreleased visual-builder project, where a few of these
modules were written before EZiL-OS was split out into its own repository.
Those citations are provenance, kept deliberately so that every carried file
says where it came from — they are not references to anything you need.

**Every upstream project this repository actually uses, its license, and
exactly what it's used for is documented in
[`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md).** That file also flags any
dependency that carries copyleft or otherwise restricted terms. If you're
evaluating this project for redistribution or compliance purposes, start
there.

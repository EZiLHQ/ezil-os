# EZiL-OS

**A real Linux computer, running in your browser.**

EZiL-OS gives every user a persistent, full Linux desktop and dev
environment — not a mockup, not a browser-based simulation, but an actual
sandboxed computer (real filesystem, real processes, a real browser and
editor inside it) that boots on demand, streams to any device, and picks
up exactly where you left it. It's built for freelancers and independent
professionals doing real work: a computer you sign into from any tab,
rather than a box tied to one desk.

This repository is the Cloudflare Worker and container image that make
that possible — the sandbox/desktop backend (Cloudflare Sandbox + Apache
Guacamole, with an alternate Neko-based streaming mode) — plus the web
application that will sit in front of it.

## Who it's for

Freelancers, contractors, and small teams who need a real, persistent work
computer reachable from anywhere — without buying, provisioning, or
maintaining physical hardware, and without trusting their files to a
browser-only simulation that disappears on refresh.

## Quick start

The Worker is a Bun-managed Cloudflare Worker project.

```bash
cd worker
bun install
bun run dev          # wrangler dev, local Worker + container
bun run typecheck    # tsc --noEmit
bun run test         # bun test
```

See [`worker/README.md`](./worker/README.md) for details on the
Cloudflare Sandbox / Guacamole / Neko container image and how the Worker
drives it.

## Repository layout

```
worker/   # Cloudflare Worker + container image (Guacamole/Neko sandbox desktop)
app/      # Web client (in progress)
docs/     # Platform notes and design documentation
```

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
  AGPL-3.0 terms (see [`CONTRIBUTING.md`](./CONTRIBUTING.md)).

This is not legal advice; read the [full license text](./LICENSE) or talk
to a lawyer if you have a specific redistribution or hosting scenario in
mind.

## Built on the work of

EZiL-OS did not start from a blank slate. Its sandboxed-desktop streaming
stack builds on several open-source projects — **Apache Guacamole**,
**Neko**, **VS Code**, **Google Chrome**, and the **Cloudflare Sandbox
SDK** — and its architectural lineage traces back through an earlier
prototype built on **[Onlook](https://github.com/onlook-dev/onlook)**
(Apache-2.0), with design inspiration studied from
**[Puter](https://github.com/HeyPuter/puter)** (AGPL-3.0). No code from
Onlook or Puter is present in this repository; both are credited
voluntarily because the lineage is real, not because either license
requires it.

**Every upstream project this repository actually uses, its license, and
exactly what it's used for is documented in
[`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md).** That file also flags any
dependency that carries copyleft or otherwise restricted terms — currently
none in this repository's own dependency tree. If you're evaluating this
project for redistribution or compliance purposes, start there.

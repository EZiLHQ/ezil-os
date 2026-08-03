# EZiL-OS

**A real Linux computer, running in your browser.**

EZiL-OS gives every user a persistent, full Linux desktop and dev environment —
not a mockup, not a browser-based simulation, but an actual sandboxed computer
(real filesystem, real processes, a real code editor and a real browser inside
it) that boots on demand, streams to any device, and picks up exactly where
you left it. It's built for freelancers and independent professionals doing
real work: a computer you sign into from any tab, rather than a box tied to
one desk.

## What's actually here

Three things, wired together:

- **A streamed Linux desktop.** A Cloudflare Sandbox container running Apache
  Guacamole (or an alternate Neko/WebRTC streaming mode), a real browser
  ([Google Chrome](./ATTRIBUTIONS.md)), and **[code-server](https://github.com/coder/code-server)**
  (VS Code in the browser) against your own persistent workspace.
- **An app preview bridge.** The Worker also exposes whatever a dev server
  inside the container is listening on as its own signed, expiring preview
  URL — so a web app you're building inside the desktop is reachable directly,
  not just through the streamed screen.
- **A boot-honesty contract.** Booting a real container takes real time
  (measured, not assumed — see `docs/PLATFORM-NOTES.md`). Rather than a spinner
  that either resolves or hangs forever with no explanation, the shell surfaces
  named boot phases as they happen and says plainly when it genuinely doesn't
  know whether the desktop came up — never a false "ready."

## Repository layout

```
worker/   # Cloudflare Worker (Durable Objects + R2) + the container image:
          #   Guacamole/Neko streaming, code-server, the app preview bridge
app/      # Next.js web app: auth, the "your computers" list, the /os host
          #   page, Supabase Postgres (via Drizzle) as the one datastore
shell/    # The in-browser desktop UI itself — a modified fork of Puter's
          #   GUI (see ATTRIBUTIONS.md) plus EZiL-authored code alongside it;
          #   built by shell/build-shell.sh into app/public/os/bundle.min.js
docs/     # Platform notes, the operational runbook, and telemetry.md
```

`app/` renders one real page (`/os`) whose entire job is to paint the
`shell/`-built bundle fast and hand it a boot payload; everything a user sees
after that first paint is drawn by that bundle talking to the Worker.

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

## Telemetry

EZiL-OS collects crash/error telemetry from signed-in sessions — never
identities, file contents, secrets, or full URLs. **[`docs/telemetry.md`](./docs/telemetry.md)**
is the exact, code-linked account of what is collected, what deliberately is
not, how long it's kept, and how to stop it from reaching this repo's servers
at all.

## Further reading

- **[`docs/PLATFORM-NOTES.md`](./docs/PLATFORM-NOTES.md)** — everything learned
  the hard way about Cloudflare Containers/Workers, Vercel, and this stack's
  own sharp edges. Read it before assuming a primitive behaves the way its
  docs imply.
- **[`docs/RUNBOOK.md`](./docs/RUNBOOK.md)** — the operational runbook: what's
  live, known constraints, and open items.

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

EZiL-OS did not start from a blank slate. The streamed-desktop backend builds
on **Apache Guacamole**, **Neko**, **code-server**/**VS Code**, **Google
Chrome**, and the **Cloudflare Sandbox SDK**; the in-browser desktop UI
(`shell/`) is a **modified fork of [Puter](https://github.com/HeyPuter/puter)**
(AGPL-3.0) — genuinely forked code, not just an influence, tracked file-by-file
in [`shell/PUTER-PROVENANCE.md`](./shell/PUTER-PROVENANCE.md). The project's
architectural lineage also traces back through an earlier prototype built on
**[Onlook](https://github.com/onlook-dev/onlook)** (Apache-2.0); no Onlook code
is present in this repository, and it is credited voluntarily.

**Every upstream project this repository actually uses, its license, and
exactly what it's used for is documented in
[`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md).** That file also flags any
dependency that carries copyleft or otherwise restricted terms. If you're
evaluating this project for redistribution or compliance purposes, start
there.

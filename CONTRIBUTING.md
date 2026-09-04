# Contributing to EZiL-OS

Thanks for your interest in EZiL-OS. This document covers how to build the
project, what we expect from contributions, and the licensing terms your
contributions are accepted under.

## License of contributions

EZiL-OS is licensed under the **[GNU Affero General Public License v3.0
(AGPL-3.0)](./LICENSE)**. By submitting a pull request or patch, you agree
that your contribution is provided under the same AGPL-3.0 license as the
rest of the project. Please don't submit code you don't have the right to
license this way (e.g. code copied from an incompatible-license project).

If your change brings in a new third-party dependency or container-image
component, please check its license before adding it — GPL/AGPL/SSPL or
"non-commercial only" licenses need explicit review — and credit any new
upstream project a change is derived from in
[`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md) in the same PR.

## Sign-off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) instead of a separate CLA. Every commit must include a
`Signed-off-by` line certifying you wrote the patch or otherwise have the
right to submit it under the project's license:

```
Signed-off-by: Your Name <your.email@example.com>
```

Add it automatically with:

```bash
git commit -s -m "your commit message"
```

## Building and testing

The Worker lives in `worker/` and is a Bun-managed Cloudflare Worker
project:

```bash
cd worker
bun install                # install dependencies
bun run dev                # wrangler dev, local Worker + container
bun run typecheck          # tsc --noEmit
bun run test                # bun test
```

`app/` is a Next.js project (needs a Supabase Postgres instance — see
`app/src/env.ts` for the required environment variables):

```bash
cd app
bun install
bun run dev                # next dev
bun run typecheck          # tsc --noEmit
bun run lint                # eslint
bun run test                # vitest run
bun run build               # next build — run this before opening a PR that touches app/
```

`shell/` (the in-browser desktop UI, a modified fork of Puter — see
`ATTRIBUTIONS.md`) builds into `app/public/os/bundle.min.js`:

```bash
shell/build-shell.sh           # build the bundle
shell/build-shell.sh --check   # verify it's up to date without writing
```

🔴 **Never commit `app/public/os/bundle.min.js` by hand** if you're working
alongside an automated build/integration step for this repository — check
whether one exists before adding it to a commit; a stale bundle silently
serving old code is worse than a missing one.

Every `.sh` file in this repository must pass `bash -n` (see
`worker/src/shell-scripts-parse.test.ts`), and no `.sh` file may contain an
apostrophe inside a single-quoted `bash -c` block — that exact mistake has
taken the desktop down before.

## Pull requests

- Keep PRs focused; unrelated refactors make review slower.
- Add or update tests for behavior changes — `worker/` has an existing
  test suite (`bun test`); don't reduce its coverage.
- Do not touch `docker.io/cloudflare/sandbox` or pinned Neko/neko-apps
  commit SHAs in `worker/Dockerfile` without updating
  `ATTRIBUTIONS.md` accordingly — they're pinned for compatibility and
  license-tracking reasons documented there.
- If you touch licensing-sensitive areas (new dependencies, vendored code,
  container images that pull in third-party binaries), update
  `ATTRIBUTIONS.md` in the same PR — under-crediting an upstream project
  is treated as a bug here, not a nitpick.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens two different kinds of PR, and
they're handled differently:

- **Minor/patch groups** (the `patch-and-minor` group PR in each project)
  merge once CI is green and one maintainer has actually read the diff —
  no auto-merge, this repo is solo-maintained and `main` requires a human
  in the loop.
- **Major version bumps are never opened by Dependabot** — every npm/bun
  entry in `dependabot.yml` ignores `version-update:semver-major`. This
  only suppresses routine version-update PRs; it does not affect security
  updates, so a major that's also a security fix still gets its own PR and
  still raises a Security tab alert. A routine major is opened by hand
  instead, as its own PR linked to a tracked issue that carries a
  migration note: what changed upstream, what in this repo depends on the
  old behavior, and what was checked before merging. This isn't extra
  ceremony for its own sake — the maintainer is solo, the deploy pipeline
  is tag-triggered straight off `main`, and a bad major landed unattended
  has no safety net.

As of this writing there are six deferred majors. Each was open as an
(unreviewed) Dependabot PR before the `ignore` rule above was added; adding
that rule may itself cause Dependabot to auto-close those PRs on its next
run, so the tracked issue — not PR number — is the durable record. Anyone
picking one up should check:

- **eslint 9 → 10** (`/app`) — flat-config changes; confirm
  `app/eslint.config.*` still loads and `bun run lint` is clean, not just
  non-erroring.
- **motion 11 → 13** (`/app`) — API changes in the `motion` package
  (formerly Framer Motion); grep call sites and check the changelog for
  renamed/removed exports before bumping.
- **zod 3 → 4** (`/app`) — `app/package.json` pins `zod ^3`, `mcp/package.json`
  is already on `zod ^4`; taking this bump in `app` is what actually aligns
  them, but `drizzle-zod` (`^0.6.0` in `app`) must support the zod 4 you land
  on first. `sdk/src/surface.test.ts` parses `app/src/server/api/routers/*.ts`
  directly as a drift guard — re-run it after the bump, it's the cheapest
  check that the routers still parse the way the SDK expects.
- **sonner 1 → 2** (`/app`) — check the toast API surface used in `app/`
  against sonner's v2 migration notes before bumping.
- **typescript 5.9 → 7.0** (`/worker`) — TypeScript 7 is the Go-based
  compiler rewrite (tsgo), not an incremental release; `worker/tsconfig.json`
  has never been checked against it. Run `bun run typecheck` in `worker/`
  and expect to find compiler-option or diagnostic differences, not just a
  clean pass/fail.
- **@cloudflare/workers-types 4 → 5** (`/worker`) — check compatibility
  against the pinned `@cloudflare/sandbox` version (`0.12.1`, see
  `dependabot.yml` and `ATTRIBUTIONS.md`) before bumping; a types major can
  break a dependency that itself isn't moving.

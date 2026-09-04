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

## Picking something up

Issues are labeled so you can find something that matches what you want to
work on:

- `good first issue`, `help wanted` — starting points for someone new to the
  codebase.
- `size/XS` … `size/XL` — a rough estimate of how many lines the fix touches.
- One label per area of the repository: `app`, `worker`, `shell`, `sdk`,
  `mcp`, `e2e`, `docs`, `ci`, `local`, `tools`.
- `blocked` / `prereq-missing` — this can't be started yet; the issue itself
  names what has to land first. Don't start one of these — read what it's
  waiting on instead.
- `needs-triage` — opened, not yet sorted by a maintainer.

To claim an issue, comment on it; a maintainer assigns it to you. If nobody
responds within 72 hours — the same lazy-consensus window
[`GOVERNANCE.md`](GOVERNANCE.md) uses for everything else — take it and say so
on the issue rather than waiting indefinitely.

## Branch naming

`feat/…`, `fix/…`, `docs/…`, `test/…`, `chore/…` — the prefix says what kind
of change the branch carries.

## PR size

**Prefer under ~400 changed lines** — past that, a PR gets harder to review
well even when every line is warranted. That's a preference, not a hard
line: the automated size labeling only actually asks for a split at
`size/XL`, over **1000** lines added + deleted (`tools/triage.ts`). If
you're between the two, err on splitting anyway rather than waiting to be
asked. When you split one, cut along a real seam rather than an arbitrary
line count — one package per pull request, or a schema change landed
separately from the code that reads it. That second rule isn't invented for
this list: it's this repository's own rule, stated in
[`docs/RELEASE.md`](docs/RELEASE.md)'s release checklist as "schema before
code" — a migration has to be applied before the code that depends on the
table it creates can ship, so the two changes are reviewed, and land,
separately.

## How to send a PR

1. Fork the repository and branch off `main` (see "Branch naming" above).
2. Make your change. Sign off **every** commit: `git commit -s`.
3. Run [`./tools/test.sh <package>`](tools/test.sh) for each package you
   touched — `app`, `worker`, `shell`, `sdk`, `mcp`, `tools`, or `local` (or
   `all` to run everything present in your tree).
4. If you touched `shell/`, rebuild the committed bundle —
   `shell/build-shell.sh` — and confirm `shell/build-shell.sh --check` is
   clean before you commit it.
5. Fill in the pull request template; open the PR against `main`.

**`main` is protected.** A pull request is the only way onto it, and it needs
every required status check green (see "Reading CI" below) before it can
merge — including a maintainer's own PR, which nobody can approve either (see
[`GOVERNANCE.md`](GOVERNANCE.md)'s "Merging into `main`" for why the required
approval count is zero rather than bypassed).

## Reading CI

Every pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Fifteen of its checks are **required contexts** — the branch ruleset on `main`
will not offer the merge button until every one of these exact names is green:

- `worker (typecheck + unit) (ubuntu-latest)`
- `worker (typecheck + unit) (windows-latest)`
- `worker (typecheck + unit) (macos-latest)`
- `app (typecheck + unit) (ubuntu-latest)`
- `app (typecheck + unit) (windows-latest)`
- `app (typecheck + unit) (macos-latest)`
- `sdk + mcp (typecheck + unit) (ubuntu-latest)`
- `sdk + mcp (typecheck + unit) (windows-latest)`
- `sdk + mcp (typecheck + unit) (macos-latest)`
- `shell (bundle check + browser suites) (ubuntu-latest)`
- `shell (bundle check + browser suites) (windows-latest)`
- `shell (bundle check + browser suites) (macos-latest)`
- `tools (typecheck + unit)`
- `DCO`
- `CodeQL (javascript-typescript)`

The same workflow also runs two more jobs, **`container (real image)`** and
**`local (typecheck + unit + smoke)`**, and neither is a required context.
Both pull the desktop image from GHCR, and `ci.yml` explains exactly why that
can't be required yet (`.github/workflows/ci.yml:64-72`):

> FORK PRs CANNOT PULL THE PRIVATE PACKAGE. `pull_request` runs this
> workflow with a read-only, fork-scoped `GITHUB_TOKEN` for a fork's PR —
> that token cannot pull a private `ezilhq/ezil-os-desktop`, so both
> `container` and `local` fail at the "Pull the desktop image" step on
> every external contribution, regardless of anything the contributor
> wrote. Row G4's required-status list must NOT add "container (real
> image)" or "local (typecheck + unit + smoke)" until the package is made
> Public (already tracked as a founder step, docs/ORCHESTRATION-LOG.md
> 2026-09-04 14:50Z) — otherwise no fork PR could ever merge.

**A red or missing `container` or `local` check on your pull request does not
block your merge.** If you see one, it is almost certainly this, not
something you did.

A few other checks can appear that also aren't among the fifteen: `label`
(the existing labeler workflow), a plain `CodeQL` alongside the required
`CodeQL (javascript-typescript)`, and `Vercel Preview Comments` — Vercel's
GitHub integration deploys a preview of `app/` for every branch
(`.github/workflows/deploy.yml`'s own header explains why that's safe: only
`main`'s deploy is disabled at the integration level). None of these gate
the merge; only the fifteen named above do.

## "A skip is not a pass"

[`tools/test.sh`](tools/test.sh) is the only sanctioned way to run this
repository's suites, and its own header names three rules it fails closed on:

1. **An absent summary is a failure.** If the run dies mid-way there is no
   final "N pass / N fail" line, and "nothing was reported" is not the same
   as "nothing failed".
2. **An unreadable failure count is a failure.** A summary that doesn't parse
   to a number counts as a failure, never as zero.
3. **Any exit code other than 0 is passed through untouched.** The wrapper
   knows about no "benign" non-zero exit and refuses to invent one — it adds
   no interpretation on top of whatever the test runner itself reported.

On top of those three, every skipped container or browser suite is printed by
name, individually: `worker`'s container suites (`*.container.test.ts`) skip
when no desktop image is present on the machine; `shell`'s real-browser
suites skip when Playwright is unresolvable. Both are listed one by one in
the output — never folded into a bare count.

Two environment variables exist to let a run continue past a skip you have
deliberately accepted — never to make one look like a pass, and both print a
line every time they're used, saying exactly that:

- `EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1`
- `EZIL_ALLOW_SKIPPED_BROWSER_SUITES=1`

**A `0 fail` that ran nothing is not a green suite.** If your change touches
`worker/`'s container behaviour or `shell/`'s browser-facing code, run it
against a real image or a real Playwright install before claiming it's
covered — don't reach for either variable to make the run finish faster.

## Running it locally

To see your change running in a real desktop, not just passing its tests, see
[`docs/LOCAL-MODE.md`](docs/LOCAL-MODE.md). Start with:

```bash
bun run --cwd local doctor
```

before you try to boot anything — it checks the Docker daemon, the resolved
desktop image, every port at the configured offset and the workspace
directory, and names the fix for whatever it finds wrong rather than just
failing. One thing worth knowing before you run it: the pinned desktop image
is a **private** GHCR package today, so a plain `docker pull` of it fails for
anyone outside the project. The doctor's own output names the fix; if you're
using the release launcher rather than a clone, its `EZIL_LAUNCHER_IMAGE`
environment variable is how you point local mode at an image you already have
instead of the one it can't pull (see
[`deploy/launcher/README.md`](deploy/launcher/README.md)).

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

`/app`, `/worker`, `/sdk` and `/mcp` are on Dependabot's `bun` ecosystem, not
`npm` — each carries a `bun.lock`, and CI installs every one of them with
`bun install --frozen-lockfile`, so a bumped `package.json` has to bring its
`bun.lock` along in the same PR or the install (and the PR) fails closed.
`/worker/sidecar` is the one exception and stays on `npm`: it has no lockfile
of any kind, so there's nothing for a `bun` entry to keep in step with.

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

## Discussions

For an open-ended question or a proposal — as opposed to a concrete bug or a
scoped task — use [Discussions](https://github.com/EZiLHQ/ezil-os/discussions)
instead of an issue: **Announcements**, **Q&A**, **Ideas**, **Show and tell**,
and **Apps** (for talking through a desktop-app idea before or alongside an
[app proposal issue](https://github.com/EZiLHQ/ezil-os/issues/new?labels=needs-triage&template=app_proposal.yml)).

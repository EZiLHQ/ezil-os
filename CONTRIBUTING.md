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

`app/` (the web client) has its own build instructions once it lands —
see its README when it does.

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

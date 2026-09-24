# Releases

How a frontend-only deployment or a `v*` tag turns into a verified product.
A tag also produces a downloadable tarball and native macOS DMG. This document
covers the secrets, checks, rollout order, and recovery for both paths.

A tagged release is a maintainer-cut `v*` tag; nothing else creates one — see
[`GOVERNANCE.md`](../GOVERNANCE.md) § Releases. Tagging pushes three workflows
into motion at once: [`.github/workflows/image.yml`](../.github/workflows/image.yml)
(container images to GHCR), [`.github/workflows/release.yml`](../.github/workflows/release.yml)
(the downloadable tarball and signed DMG, as a **draft** GitHub Release), and
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) (the hosted
product — and the only one of the three that publishes the draft the second
one created after the signed DMG is attached). This document is about the
operator side of that; the workflow files themselves carry the mechanical
detail in their own header comments.

## Frontend-only production deployment

Use [`.github/workflows/deploy-app.yml`](../.github/workflows/deploy-app.yml)
from **Actions → Deploy App → Run workflow** on `main` for a Next.js or shell
change that requires no desktop Worker or image update. Keep
`app/vercel.json`'s automatic main deployment disabled. The workflow checks
that it is deploying the current main commit, verifies the committed shell
bundle, typechecks the app, and confirms the Vercel project and existing
`ezil-os.vercel.app` production alias before changing it. It then deploys that
commit, waits for the live bundle digest, and signs in to the real `/os` page
with the existing e2e account to test the App Store at desktop and phone sizes.
The run retains screenshots as a 14-day artifact. If a check fails after the
deployment, it restores and verifies the previous production deployment.

This path uses the existing Vercel and e2e repository secrets listed below.
It does not update the Cloudflare Worker, desktop image, GitHub Release, or any
database. The App Store preview's Reticle card still says **Planned**: a
successful frontend deployment does not establish an installation service or
a running Reticle application. A desktop-image change uses the tagged release
path and its separate fresh-container verification.

## Secrets

Set with `gh secret set <NAME> -R EZiLHQ/ezil-os` (it prompts for the value —
never pass a secret as a command-line argument, which would land in shell
history). The deployment secrets and the Apple distribution credentials live
in **repository** secrets (Settings → Secrets and variables → Actions).

| Secret | Used by | Required token scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `worker` (deploy), `release` (best-effort deployment note) | For this existing Worker: Workers `Editor` (or legacy `Workers Scripts:Edit`), `Containers:Edit`, `Workers R2 Storage:Edit`, `Account Settings:Read`, and zone `Workers Routes:Edit` limited to `ezil.org`. Use Workers product `Admin` only if CI must create the Worker. |
| `CLOUDFLARE_ACCOUNT_ID` | `worker`, `release` | — (not a token; the account id) |
| `VERCEL_TOKEN` | `app` | a Vercel Access Token scoped to the `ezil-os` project |
| `VERCEL_ORG_ID` | `app` | — (from `app/.vercel/project.json`'s `orgId` after `vercel link`) |
| `VERCEL_PROJECT_ID` | `app` | — (from the same file's `projectId`) |
| `EZIL_E2E_EMAIL` | `verify`, `verify-container` | an EZiL OS account the production suites can sign in as |
| `EZIL_E2E_PASSWORD` | `verify`, `verify-container` | the same account's password |
| `APPLE_CERTIFICATE` | `release.yml` macOS job | base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `release.yml` macOS job | password used when the `.p12` was exported |
| `APPLE_SIGNING_IDENTITY` | `release.yml` macOS job | full `Developer ID Application: …` identity |
| `APPLE_ID` | `release.yml` macOS job | Apple ID used by `notarytool` |
| `APPLE_PASSWORD` | `release.yml` macOS job | app-specific Apple ID password, not the account password |
| `APPLE_TEAM_ID` | `release.yml` macOS job | ten-character Apple Developer team ID |

```bash
gh secret set CLOUDFLARE_API_TOKEN -R EZiLHQ/ezil-os
gh secret set CLOUDFLARE_ACCOUNT_ID -R EZiLHQ/ezil-os
gh secret set VERCEL_TOKEN -R EZiLHQ/ezil-os
gh secret set VERCEL_ORG_ID -R EZiLHQ/ezil-os
gh secret set VERCEL_PROJECT_ID -R EZiLHQ/ezil-os
gh secret set EZIL_E2E_EMAIL -R EZiLHQ/ezil-os
gh secret set EZIL_E2E_PASSWORD -R EZiLHQ/ezil-os
gh secret set APPLE_CERTIFICATE -R EZiLHQ/ezil-os
gh secret set APPLE_CERTIFICATE_PASSWORD -R EZiLHQ/ezil-os
gh secret set APPLE_SIGNING_IDENTITY -R EZiLHQ/ezil-os
gh secret set APPLE_ID -R EZiLHQ/ezil-os
gh secret set APPLE_PASSWORD -R EZiLHQ/ezil-os
gh secret set APPLE_TEAM_ID -R EZiLHQ/ezil-os
```

No new secret is needed for the `image`, `worker`, or `release` jobs in
`deploy.yml`: `image` and `worker` authenticate to GHCR with the run's own
`GITHUB_TOKEN` (job-level `packages: read` — each job runs on a fresh runner
and logs in separately), and
`release` publishes with the run's own `GITHUB_TOKEN` (job-level
`contents: write`) plus the Cloudflare pair already above. Anything not in
this table is public by design — the app-runtime secrets
(`SANDBOX_HMAC_SECRET` and its pair, `SUPABASE_DATABASE_URL`, the TURN
credential) are a separate inventory in
[`docs/RUNBOOK.md`](RUNBOOK.md) § Secret rotation and are not read by any
workflow in this repository.

## First-run checklist

Everything here is a one-time check before the *first* tag; after that, only
"the e2e account is still allow-listed" and "0002 is applied" are ongoing
concerns (a schema change ships a new migration, not a rewrite of 0002).

- [x] **Vercel Root Directory is `app`.** This is a monorepo and the Next.js
  package lives there. Git deployments and the CLI both apply the remote Root
  Directory; `deploy.yml` therefore runs `vercel deploy` from the repository
  root. Vercel builds the uploaded source in its protected environment because
  Sensitive variables deliberately cannot be downloaded for a GitHub-side
  prebuild. This was set and read back from the live Vercel project on
  2026-09-16. `app/vercel.json` deliberately keeps Git production deployments
  from `main` disabled: branches still get automatic previews, while production
  remains the Worker-first, verified tag workflow instead of two racing deploy
  systems. Keep the repository-root `.vercelignore`: the CLI uploads from the
  monorepo root, and nested ignore files alone did not exclude `app/.env`.
- [ ] **The e2e account is allow-listed.** `EZIL_E2E_EMAIL` must have a row in
  `ezil_os_access` (migration `0002_os_access.sql`) — `assertOsAccess` gates
  every protected route, so a not-allow-listed e2e account fails `verify`
  the same way a real uninvited user would, for the same reason.
- [ ] **`EZIL_OS_ACCESS_MODE` on Vercel is `invite`, not `open`.**
  `app/src/env.ts` defaults this to `invite` when the variable is unset, so
  the *absence* of a Production environment variable is already correct —
  this check is for an explicit `open` value left over from testing, which
  would silently disable the allow-list in production.
- [ ] **Migration `0002_os_access.sql` is applied to the hosted database
  before the first tag — schema before code.** `app/drizzle/0002_os_access.sql`
  creates `ezil_os_access`; the app's access gate (`osAccessFor`) queries a
  table that does not exist until this runs. `drizzle-kit migrate` does NOT
  work against this database (see `docs/RUNBOOK.md` § "Database migrations —
  read this before running `drizzle-kit migrate`" — there is no migrations
  journal, so it replays from `0000` and dies on an "already exists" error).
  `0001_telemetry.sql` shipped its own safe-apply script
  (`npm run db:apply-0001`, idempotent, transactional, additive-only
  verified); **`0002` has no equivalent script yet** — apply
  `app/drizzle/0002_os_access.sql` by hand (Supabase SQL editor, or `psql`
  against `SUPABASE_DATABASE_URL`) inside a transaction, and confirm
  `ezil_os_access` exists and RLS is enabled before tagging. Writing that
  script is a hand-off, not something this row did.
- [ ] **GHCR packages are Public.** `ghcr.io/ezilhq/ezil-os-desktop` and
  `ghcr.io/ezilhq/ezil-neko-vscode` default to **private** (GHCR's default for
  a new package) — until each is switched to Public (that package's own page →
  Package settings → Danger Zone → Change visibility; this is not scriptable
  with `gh` today), an anonymous `docker pull` — which is what every release
  tarball's launcher does — fails with `unauthorized`, even though the CI
  jobs that build and deploy these images authenticate with their own
  `GITHUB_TOKEN` and keep working regardless. See
  `deploy/launcher/README.md` § "One founder step this depends on".
- [ ] **The six Apple distribution secrets are installed before a public
  signed release.** `release.yml` is
  deliberately fail-closed: a missing certificate, identity, or notarization
  credential fails the macOS job, and `deploy.yml` refuses to publish the
  draft until the expected signed DMG asset exists. An ordinary Apple ID and
  account password do not satisfy this: Developer ID distribution requires a
  paid Apple Developer membership, and `APPLE_PASSWORD` must be an app-specific
  password. Do not store the normal Apple account password in GitHub.

## Internal macOS test DMG (no Apple subscription)

The manual [`macOS Internal DMG`](../.github/workflows/macos-internal.yml)
workflow builds the pinned ARM Linux runtime on `ubuntu-24.04-arm`, compiles an
Apple Silicon app on `macos-14`, ad-hoc signs it, verifies the disk image,
writes a SHA-256 file, and uploads both as a 14-day Actions artifact. It does
not read any Apple or repository secret.

From GitHub, open **Actions → macOS Internal DMG → Run workflow**, select
the branch containing the macOS files, and download the
`EZiL-OS-AppleSilicon-internal-*` artifact after the job turns green. This artifact is
for trusted internal testers only. Because it is not Developer ID signed or
notarized, macOS will require the tester to Control-click the app and choose
**Open**, or approve it in **System Settings → Privacy & Security**. The
public/tagged release workflow remains intentionally unavailable until the six
real Apple distribution credentials exist.

## Order of events on a tag

```
git tag v0.2.0-rc.1 && git push origin v0.2.0-rc.1
        │
        ├─▶ image.yml starts   ─── builds/pushes ghcr.io/ezilhq/ezil-os-desktop
        │                          under <sha8>, `latest` (main only) and the
        │                          semver (tag only) — see that file's header
        │                          for the ONE unresolved risk: its `paths:`
        │                          filter may AND with the `tags: [v*]`
        │                          trigger, so a tag cut at a commit touching
        │                          none of worker/**, docker/neko/**,
        │                          deploy/images.env may never fire it at all.
        │
        ├─▶ release.yml starts ─── builds the local-mode tarball, opens a
        │                          GitHub Release for v0.2.0-rc.1 as a DRAFT,
        │                          then on macOS builds/signs/notarizes the
        │                          Apple Silicon DMG and attaches it; both artifacts
        │                          receive provenance attestations and enter
        │                          SHA256SUMS.
        │
        └─▶ deploy.yml starts  ─── image      : waits (up to 30 min) for
                                                 image.yml's ghcr.io/…:<sha8>
                                                 to exist; reads its digest.
                                    worker     : needs image — deploys the
                                                 Worker.
                                    app        : needs worker — deploys the
                                                 Next.js app to Vercel.
                                    verify     : needs app — runs the
                                                 production suites against
                                                 the live URL.
                                    release    : needs [verify, image], then
                                                 waits for the signed DMG;
                                                 ONLY if both are ready:
                                                 `gh release edit v0.2.0-rc.1
                                                 --draft=false`, then appends
                                                 a note with the worker
                                                 deployment list and the
                                                 verified image ref@digest.
```

image.yml and deploy.yml both start from the same tag push and run
**concurrently** — `needs:` cannot cross workflow files, so `deploy.yml`'s
`image` job is the synchronization point: it polls GHCR rather than assuming
the two workflows finish in a convenient order. If `image.yml` never ran for
the tagged commit at all (the `paths:`/`tags:` risk above), the `image` job
fails within seconds, naming that as the cause, rather than spending the full
30-minute poll finding out the same way — check `image.yml`'s own runs for
the tagged commit's SHA if that happens.

If `verify` fails, the `release` job never runs — the draft `release.yml`
created stays a **draft**, visibly unreleased, and nothing more claims it
was verified than the truth supports.

🔴 **The one link in this chain that had to be checked empirically, not
assumed: can a later `gh release edit <tag> --draft=false` actually find a
draft that `gh release create <tag> --verify-tag --draft` made?** A draft
release's own web URL is an internal `releases/tag/untagged-<random>` slug,
not the tag name — so it is genuinely unobvious that addressing it *by tag*
later would work. Verified against a real, disposable GitHub repo (created
and deleted for this check, not `EZiLHQ/ezil-os`): `gh release create
v0.0.1-test --verify-tag --draft --notes "…"` creates the draft (`isDraft:
true`, `tagName: "v0.0.1-test"`, URL `.../untagged-…`); `gh release edit
v0.0.1-test --draft=false` resolves it by tag and publishes it (exit 0, URL
becomes `.../v0.0.1-test`, `isDraft: false`) — `gh`'s own tag-name fallback
handles the mismatch. The same sequence with `--prerelease` added (the
`-rc.N` path) behaves identically. `gh version 2.95.0`, checked 2026-09-04;
if a future `gh` release changes this fallback, re-run the same check before
trusting the `release` job's first edit call again.

## Confirming the rollout

`deploy.yml`'s own header names two different things a "successful deploy"
can mean, and they are verified separately:

1. **The script and the Worker routes** — what a plain `vercel deploy` and
   `wrangler deploy` change. This is what the `verify` job's production
   suites (`prod`, `prod-responsiveness`, `prod-window-stacking`,
   `prod-reconcile`) check, on every tag, against the live URL. A deploy that
   reports success but never actually flips the alias is caught by
   `e2e/await-deployed-bundle.mjs` waiting on the served bundle being
   byte-for-byte what this run built, not a fixed sleep.
2. **The container image** — what `image.yml` and `worker/Dockerfile` change.
   A running container keeps its image until it stops (see `deploy.yml`'s own
   header, point 2), so this can only be checked by forcing a fresh one:
   `gh workflow run deploy.yml -f verify_container=true` on an existing tag
   (or `workflow_dispatch` from the Actions tab) runs `verify-container`,
   which releases the current desktop, waits for a genuinely new container,
   and runs the container-facing suites (`prod-mobile-keyboard`,
   `prod-system-tab`) against it. This is **not** part of a normal tag push —
   it is a separate, manually-triggered confirmation, and a tag can be fully
   released (script side verified, Release published) without it ever having
   run.

To confirm which Worker version is actually live outside of a CI run:

```bash
cd worker && npx wrangler deployments list --name ezil-os-worker
```

The published (non-draft) Release's body also carries this, captured by the
`release` job at publish time — see "Order of events" above.

## Rollback

Two independently-deployed halves, and un-publishing the claim that either was
verified:

```bash
# Worker — rolls back to the previous Worker version. Cloudflare secrets are
# VERSIONED and roll back with the code: if this follows a secret rotation,
# re-check the HMAC pair per docs/RUNBOOK.md § Secret rotation immediately
# after, or the two halves silently disagree again.
cd worker && npx wrangler rollback

# App — rolls back the Vercel deployment alias to a previous one.
cd app && npx vercel rollback --token="$VERCEL_TOKEN"

# Release — un-publish a Release that turned out to be wrong. This does not
# touch the deployed Worker or app; it only removes the public claim that the
# tag was verified. Re-publish with `--draft=false` once the real problem is
# fixed (a fresh tag is usually simpler than re-editing an old one).
gh release edit v0.2.0-rc.1 --draft=true
```

Rolling back the Worker or the app does **not** roll back the container
image (see "Confirming the rollout" above, point 2) — a running container
keeps whatever image it booted with until it stops. If a rollback needs the
previous image behaviour too, the desktop has to be restarted (Settings →
Troubleshoot, or wait for the idle reaper) after the code-side rollback, not
instead of it.

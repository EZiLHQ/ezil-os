# Releases

How a `v*` tag turns into a deployed, verified product and a downloadable
tarball — the secrets it needs, what to check before the first one, the order
things happen in, how to confirm a rollout actually took effect, and how to
undo one.

A release is a maintainer-cut `v*` tag; nothing else creates one — see
[`GOVERNANCE.md`](../GOVERNANCE.md) § Releases. Tagging pushes three workflows
into motion at once: [`.github/workflows/image.yml`](../.github/workflows/image.yml)
(container images to GHCR), [`.github/workflows/release.yml`](../.github/workflows/release.yml)
(the downloadable tarball, as a **draft** GitHub Release), and
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) (the hosted
product — and the only one of the three that publishes the draft the second
one created). This document is about the operator side of that; the workflow
files themselves carry the mechanical detail in their own header comments.

## Secrets

Set with `gh secret set <NAME> -R EZiLHQ/ezil-os` (it prompts for the value —
never pass a secret as a command-line argument, which would land in shell
history). All seven live in **repository** secrets (Settings → Secrets and
variables → Actions), read only by `deploy.yml`.

| Secret | Used by | Required token scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `worker` (deploy), `release` (best-effort deployment note) | `Workers Scripts:Edit`, `Workers Containers:Edit`, `Account Settings:Read` |
| `CLOUDFLARE_ACCOUNT_ID` | `worker`, `release` | — (not a token; the account id) |
| `VERCEL_TOKEN` | `app` | a Vercel Access Token scoped to the `ezil-os` project |
| `VERCEL_ORG_ID` | `app` | — (from `app/.vercel/project.json`'s `orgId` after `vercel link`) |
| `VERCEL_PROJECT_ID` | `app` | — (from the same file's `projectId`) |
| `EZIL_E2E_EMAIL` | `verify`, `verify-container` | an EZiL OS account the production suites can sign in as |
| `EZIL_E2E_PASSWORD` | `verify`, `verify-container` | the same account's password |

```bash
gh secret set CLOUDFLARE_API_TOKEN -R EZiLHQ/ezil-os
gh secret set CLOUDFLARE_ACCOUNT_ID -R EZiLHQ/ezil-os
gh secret set VERCEL_TOKEN -R EZiLHQ/ezil-os
gh secret set VERCEL_ORG_ID -R EZiLHQ/ezil-os
gh secret set VERCEL_PROJECT_ID -R EZiLHQ/ezil-os
gh secret set EZIL_E2E_EMAIL -R EZiLHQ/ezil-os
gh secret set EZIL_E2E_PASSWORD -R EZiLHQ/ezil-os
```

No new secret is needed for the `image` or `release` jobs `deploy.yml` gained
in this round: `image` authenticates to GHCR with the run's own `GITHUB_TOKEN`
(job-level `packages: read` — see that job's `permissions:` block), and
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

- [ ] **Vercel Root Directory is the repository root (`.`), not `app`.**
  `app`/`deploy.yml`'s `app` job runs `vercel pull` / `vercel build` /
  `vercel deploy` from *inside* `app/`, which is Vercel's documented shape
  only when the project's own Root Directory setting is the repo root — if it
  is set to `app` instead, `vercel build` looks for `app/app` and fails (see
  that job's own comment in `deploy.yml`). **Not independently verified by
  this row**: a stale, gitignored `app/.vercel/project.json` left on this
  machine from an earlier `vercel link` has no `rootDirectory` key, and
  Vercel omits that key exactly when it equals the default (the repo root) —
  consistent with the setting already being correct, but that file is local
  and may not reflect the live dashboard. Confirm on the Vercel dashboard
  (Project Settings → General → Root Directory) or via `vercel pull` with
  real credentials before the first tag, not after a failed deploy.
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
  jobs that build and verify against these images (which authenticate with
  their own `GITHUB_TOKEN`) keep working regardless. See
  `deploy/launcher/README.md` § "One founder step this depends on".

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
        │                          GitHub Release for v0.2.0-rc.1 as a DRAFT
        │                          (--verify-tag --draft), with SHA256SUMS
        │                          and a provenance attestation.
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
                                    release    : needs [verify, image] —
                                                 ONLY if verify passed:
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

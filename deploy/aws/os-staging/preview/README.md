# OS PR preview slots

Parallel PRs get their own URL instead of taking turns overwriting os-staging.
os-staging stays the integration baseline. The workflow is
`.github/workflows/os-pr-preview.yml`. It does nothing until the release owner
completes Activation.

## Trust boundary (read first)

A preview runs the PR's unreviewed app code on the staging host, with host
networking. That code can reach the instance metadata service and use the host
role, which can read the staging app secret. A `pull_request` run also executes
the PR's own copy of the workflow. Two consequences follow:

- **The boundary is the `os-pr-preview` GitHub environment's required reviewers.**
  - Every job that holds a cloud identity or QA secret runs in that environment:
    deploy, browser and teardown.
  - The OIDC role must trust only
    `sub = repo:EZiLHQ/ezil-os:environment:os-pr-preview`.
  - Approving a preview means "I trust this PR's code with staging-host access",
    and the approval covers a specific run.
  - `activation.json` and the base-branch tooling are an on/off switch and a
    convenience. They are not a security boundary.
- The env overlay (below) removes side-effect authority from **honest** code. It
  does not contain code that reads the host role directly. Real containment needs a
  separate preview host whose role cannot read staging secrets, or a network
  namespace that blocks the metadata service (this host has no iptables). That is
  the follow-up if previews must be fully automatic for untrusted authors.
- The slot callbacks are registered with the same Auth0 tenant (`id.ezil.work`). A
  visitor who opens a slot URL while signed in can be silently signed in to that
  PR's code (`prompt=none`). Open only previews you approved, with the QA identity.

## Shape

- **Two fixed slots** on the existing staging host: `https://os-pv1.ezil.work` and
  `https://os-pv2.ezil.work`. Each slot is one more `ezil-os-staging:pr<N>-<sha12>`
  web container (Compose project `ezil-os-preview-pv<N>`, loopback port 3101/3102)
  behind the host's Caddy. The hosts are fixed because Caddy runs with `admin off`
  (no hot reload), and because then Auth0 needs exact URLs, not a wildcard. A PR keeps
  its slot across pushes. A third concurrent PR is refused with the busy slots
  named; it never takes another PR's slot.
- **One immutable artifact per head.** A labelled PR head is built on a GitHub
  runner by the same `deploy.sh build` as os-staging, with no AWS identity. The
  deploy job verifies the receipt and image ID (`install_receipt.py`), then runs
  `preview.sh publish`:
  - The first complete publish of `pr<N>-<sha12>` wins. A complete tag is one
    whose checksum marker exists; the marker is written last.
  - A rerun or relabel deploys that published receipt, and its own rebuild (never
    byte-identical) is discarded.
  - An interrupted upload is completed only if the objects already in S3 match by
    MD5 ETag.

  The host verifies the archive against the receipt hash, which alone determines
  the image ID. It verifies the loaded image too, and checks the CI image ID when
  the build was this run's. No artifact is ever taken from another workflow run.
- **Exact mapping.** The PR gets one sticky comment and a job summary that pins the
  PR head, image tag, image ID, receipt SHA-256, URL and expiry. `/api/health` on the
  slot must return that head, checked from the host and from the public URL.
  `inventory.py` prints the URL → served commit → branch table for every environment.
- **Lifecycle.** Previews are opt-in with the `preview:os` label, for open PRs only.
  - Removing the label, or closing a labelled PR, queues a teardown. Like a deploy,
    it needs a reviewer.
  - A TTL of 48 hours (at most 72) is the backstop, enforced by the hourly
    `ezil-os-preview-reap.timer` on the host. An expired slot is also reclaimed by
    the next deploy.
  - A slot is claimed with a 30-minute `starting` receipt before its container
    starts. If the SSM command dies mid-deploy, the reaper still removes it.
  - A failed redeploy keeps the old head serving if it failed before the slot was
    touched. Otherwise the slot is removed. No failed image is left on the shared
    disk, and os-staging's image is never removed.
- **Concurrency.** Build, deploy and browser share one job group per PR
  (`os-pr-preview-deploy-<N>`), so a new head cancels that PR's older jobs.
  - Teardown has its own group, which is never cancelled.
  - Other-label events end in the plan job without entering either group.
  - Different PRs serialize on the host lock in `preview_host.py`.
  - The shared staging lease and the `deploy-staging` group are never used, so
    previews neither block nor overwrite a staging release.

## Isolation, per tier

| Tier | Isolated? | How |
|---|---|---|
| URL / process | Yes | Own container, port, Caddy site block, compose project, env file |
| Session / cookies | Yes | Auth cookies are `__Host-` (host-only, no `Domain`), so slots, os-staging and desktop hosts cannot read or plant each other's sessions |
| Auth callback / origin | Yes | `EZIL_DEPLOY_ENV=pr-preview` + exact `EZIL_PR_PREVIEW_ORIGIN` make the container own only its slot origin. Auth0 `redirect_uri`, sign-out and Stripe returns stay on the slot, and unknown hosts fall back to the slot, never to production (`app/src/utils/forwarded.ts`) |
| Side effects | For honest code (see Trust boundary) | No cron timers, no `CRON_SECRET` (cron routes answer 404), no Stripe webhook secret, checkout off. With `computers: off` there are also no AWS computers, the kill switch is on, and the computer HMAC, lifecycle authority secret and app-caller roles are absent |
| Redis | N/A | There is no Redis client anywhere in this repository (checked 2026-11-08), so there is no namespace to cross |
| **Data** | **No** | Slots use the same PREVIEW Supabase as os-staging, never production. PRs that touch `app/drizzle/` or migration scripts are refused, so a preview cannot change the shared schema |

`computers: shared` (activation-wide) keeps staging's computer settings, so a QA
identity can start a staging computer and run chat on the shared fleet under the
app's per-user caps. It still runs no timers. Chat execution is paid inference and
needs a ledger row first.

**Not covered:** editor/computer-image changes (VSIX, extension, model picker inside
the editor, AMI). An app preview's computer runs the staging AMI. PRs that only
change `worker/` are skipped with that reason. Those go through the image bake and
staging release.

## Browser acceptance

`e2e/os-preview-smoke.mjs` checks:
- health SHA;
- signed-out `/login` at desktop and phone viewports;
- that Auth0's `redirect_uri` is the slot's own callback.

With the `OS_PREVIEW_QA_EMAIL` / `OS_PREVIEW_QA_PASSWORD` secrets on the
`os-pr-preview` environment (referenced by name only), it also checks signed-in
desktop and phone. Without them the result is PARTIAL, reported as a warning and
never as a pass. It starts no computer and sends no chat: after sign-in, every
non-GET request is aborted.

The QA password is typed into a sign-in page served by the PR's code. Use a
dedicated low-privilege QA account, and rotate it if an approved preview turns out
to be hostile (see Trust boundary).

## Cost

There is no new infrastructure: the slots share the staging host (container limits
of 768 MB and 1 CPU each, two slots). Incremental spend is:
- runner minutes, only for labelled app-tier PRs, once per head;
- one S3 artifact set per head (about 200–300 MB), until the lifecycle rule below
  expires it;
- one Let's Encrypt certificate per slot host, issued once.

## Promotion

The preview artifact is an ordinary staging artifact (`os-staging/images/<tag>.*`,
staging receipt). The release owner can install it into os-staging with
`deploy.sh install-verified <tag> <PR head SHA> <receipt sha256>`. That deploys
exactly the tested image, but the running SHA is then the PR head, not the merge
commit. Promote only if `git diff --quiet <PR head> <merge commit>` (same tree).
Otherwise build the merge commit.

## Activation (release owner, once)

Merging this source changes nothing live. The release owner (the sole AWS/Cloudflare
writer) activates it in this order, recording each step privately:

1. **DNS:** create DNS-only (grey-cloud) A records `os-pv1.ezil.work` and
   `os-pv2.ezil.work` pointing to the staging host's existing address, the same way
   as `os-staging`. These explicit records override the proxied `*.ezil.work`
   wildcard. Do this before the next staging install that ships this Caddyfile, or
   Caddy will retry ACME for hosts that do not resolve yet.
2. **Auth0:** add exact entries for each slot: callback
   `https://os-pvN.ezil.work/auth/auth0/callback`, logout `https://os-pvN.ezil.work/login`
   and web origin `https://os-pvN.ezil.work`. Use no wildcard, and keep the existing
   entries.
3. **Caddy:** ship this `Caddyfile` with a normal staging install. It is part of the
   existing runtime bundle, so no allowlist change is needed. Then install the reaper
   once with `preview.sh install-reaper` (one SSM command).
4. **GitHub environment first:** create `os-pr-preview` with **required reviewers**
   (prevent self-review). This is the security boundary.
5. **IAM:** create a GitHub OIDC role whose trust requires exactly
   `token.actions.githubusercontent.com:sub = repo:EZiLHQ/ezil-os:environment:os-pr-preview`
   and `aud = sts.amazonaws.com`. Grant only:
   - S3 `PutObject` / `GetObject` on `os-staging/images/pr*` in the staging artifact
     bucket (`GetObject` also covers HEAD);
   - `ec2:DescribeInstances`;
   - `ssm:SendCommand` (`AWS-RunShellScript`, the staging host only) and
     `ssm:GetCommandInvocation`.
   The host role already reads `os-staging/images/*`.
6. **S3 lifecycle:** expire the prefix `os-staging/images/pr` after 14 days. Copy a
   tag you intend to promote before then.
7. **GitHub:**
   - optional QA secrets on `os-pr-preview`, as above;
   - repository variables `OS_STAGING_PUBLIC_SUPABASE_URL`,
     `OS_STAGING_PUBLIC_SUPABASE_ANON_KEY` and `OS_STAGING_STRIPE_PUBLISHABLE_KEY`
     (the public values os-staging is built with);
   - the `preview:os` label.
8. **Enable:** in a reviewed PR to the base branch, set `enabled: true` and `role_arn`
   in `activation.json`.
9. **Verify:** label one small app PR, then check the PR comment, `curl` the slot's
   `/api/health` for the head SHA, run `preview.sh status`, sign in through the slot,
   and close the PR to prove teardown.

Rollback: set `enabled: false` (the workflow goes inert), then run `preview.sh teardown <PR>`
for each live slot (`preview.sh status` lists them).
Remove the Caddy blocks with the next staging install, and the DNS and Auth0 entries
when no longer needed.

## Files

- `preview_host.py`: host-side slot manager (deploy, teardown, reap, status,
  install-reaper). It runs as root through SSM and imports `../install_receipt.py`.
- `preview.sh`: S3 publish and SSM wrapper. Every command pins the artifact bucket.
  Host commands also pin the staging host and VPC. It prints only the host's
  one-line result.
- `plan.py`: decides deploy, teardown or skip from the event's exact base...head file
  list (renames included; fails closed past the API's 300-file limit). It reads its
  activation from the PR's base commit.
- `inventory.py`: read-only environment table.
- `test_preview_host.py`, `test_plan.py`: offline tests, run in `source-provenance.yml`.

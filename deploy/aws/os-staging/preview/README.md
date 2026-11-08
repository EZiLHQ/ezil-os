# OS PR preview slots

Parallel PRs get their own URL instead of taking turns overwriting os-staging.
os-staging stays the integration baseline. The workflow is
`.github/workflows/os-pr-preview.yml`; it is **inert** until `activation.json` is
enabled on the base branch (see Activation).

## Shape

- **Two fixed slots** on the existing staging host: `https://os-pv1.ezil.work` and
  `https://os-pv2.ezil.work`. Each slot is one more `ezil-os-staging:pr<N>-<sha12>`
  web container (Compose project `ezil-os-preview-pv<N>`, loopback port 3101/3102)
  behind the host's Caddy. The hosts are fixed because Caddy runs with `admin off`
  (no hot reload), and because then Auth0 needs exact URLs, not a wildcard. A PR keeps
  its slot across pushes. A third concurrent PR is refused with the busy slots
  named; it never takes another PR's slot.
- **Build once.** A labelled PR head is built once on a GitHub runner by the same
  `deploy.sh build` as os-staging, with no AWS identity. The artifact is keyed by
  head SHA, so reruns and relabels reuse it. The deploy job verifies the receipt and
  image ID (`install_receipt.py`), publishes the tag once (an existing tag must have
  the identical receipt), and the host verifies the archive and the loaded image
  against the CI image ID before it starts anything.
- **Exact mapping.** The PR gets one sticky comment and a job summary that pins the
  PR head, image tag, image ID, receipt SHA-256, URL and expiry. `/api/health` on the
  slot must return that head, checked from the host and from the public URL.
  `inventory.py` prints the URL → served commit → branch table for every environment.
- **Lifecycle.** Previews are opt-in with the `preview:os` label. Removing the label
  or closing the PR tears the slot down. A TTL of 48 hours (at most 72) is enforced by
  the hourly `ezil-os-preview-reap.timer` on the host. An expired slot is also
  reclaimed by the next deploy. Teardown removes the container, env file, receipt
  and the slot's image (never os-staging's).
- **Concurrency.** One lane per PR (`os-pr-preview-<N>`): a new head cancels that PR's
  older run, and a teardown waits for it. Different PRs serialize on the host lock
  in `preview_host.py`. The shared staging lease and the `deploy-staging` group are
  never used, so previews neither block nor overwrite a staging release.

## Isolation, per tier

| Tier | Isolated? | How |
|---|---|---|
| URL / process | Yes | Own container, port, Caddy site block, compose project, env file |
| Session / cookies | Yes | Auth cookies are `__Host-` (host-only, no `Domain`), so slots, os-staging and desktop hosts cannot read or plant each other's sessions |
| Auth callback / origin | Yes | `EZIL_DEPLOY_ENV=pr-preview` + exact `EZIL_PR_PREVIEW_ORIGIN` make the container own only its slot origin. Auth0 `redirect_uri`, sign-out and Stripe returns stay on the slot, and unknown hosts fall back to the slot, never to production (`app/src/utils/forwarded.ts`) |
| Side effects | Yes, by default | No cron timers, no `CRON_SECRET` (cron routes answer 404), no Stripe webhook secret, checkout off. With `computers: off` there are also no AWS computers, the kill switch is on, and the computer HMAC is absent |
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
never as a pass. It starts no computer and sends no chat.

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
4. **IAM:** create a GitHub OIDC role restricted to this repository's `pull_request`
   workflow (`os-pr-preview` environment). Grant only:
   - S3 `PutObject` / `GetObject` on `os-staging/images/pr*` in the staging artifact
     bucket (`GetObject` also covers HEAD);
   - `ec2:DescribeInstances`;
   - `ssm:SendCommand` (`AWS-RunShellScript`, the staging host only) and
     `ssm:GetCommandInvocation`.
   The host role already reads `os-staging/images/*`.
5. **S3 lifecycle:** expire the prefix `os-staging/images/pr` after 14 days. Copy a
   tag you intend to promote before then.
6. **GitHub:**
   - environment `os-pr-preview`, with optional QA secrets as above;
   - repository variables `OS_STAGING_PUBLIC_SUPABASE_URL`,
     `OS_STAGING_PUBLIC_SUPABASE_ANON_KEY` and `OS_STAGING_STRIPE_PUBLISHABLE_KEY`
     (the public values os-staging is built with);
   - the `preview:os` label.
7. **Enable:** in a reviewed PR to the base branch, set `enabled: true` and `role_arn`
   in `activation.json`.
8. **Verify:** label one small app PR, then check the PR comment, `curl` the slot's
   `/api/health` for the head SHA, run `preview.sh status`, sign in through the slot,
   and close the PR to prove teardown.

Rollback: set `enabled: false` (the workflow goes inert), then run `preview.sh teardown <PR>`
for each live slot (`preview.sh status` lists them).
Remove the Caddy blocks with the next staging install, and the DNS and Auth0 entries
when no longer needed.

## Files

- `preview_host.py`: host-side slot manager (deploy, teardown, reap, status,
  install-reaper). It runs as root through SSM and imports `../install_receipt.py`.
- `preview.sh`: SSM wrapper. It pins the staging host, VPC and artifact bucket, and
  prints only the host's one-line result.
- `plan.py`: decides deploy, teardown or skip. It reads its activation from the PR's
  base commit.
- `inventory.py`: read-only environment table.
- `test_preview_host.py`, `test_plan.py`: offline tests, run in `source-provenance.yml`.

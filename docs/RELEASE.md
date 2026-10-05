# OS production releases

Successful push CI for the current `main` commit starts
[Cloud preview and main deploy](../.github/workflows/preview.yml).
Manual **Deploy**, **Deploy App**, and `v*` tags call that same workflow and
require successful push CI for exactly the current main SHA. Deploy App is
now a full gated release; its former frontend-only and verify-only bypasses
are retired. Vercel Git previews remain enabled; automatic main Git deployment
must remain disabled in `app/vercel.json`.

All OS jobs use GitHub-hosted runners, including exact-artifact Mac E2E on
`macos-15`. Native/macOS rollout is outside the automatic main cloud release. On version tags, the independent
release workflow still builds signed native artifacts as drafts. Deploy waits
for successful cloud verification and the signed macOS installer, attaches
the version image alias to the tested digest, then publishes that draft.

## Ordering and image identity

1. Admit trusted CI and report the admission reason. An unadmitted run fails
   its summary instead of reporting a successful deployment with two skipped jobs.
2. Deploy and test the staging Worker and returned Vercel preview with existing
   staging lease/isolation semantics. **PRs never apply SQL to the shared DB.**
3. The reusable Image workflow builds/reuses pinned Neko continuity, base, branding and desktop images
   for the admitted full source SHA, then runs all three existing real-container
   suites against the exact desktop digest; any skip fails the job.
4. Production requires both staging and images to succeed. Under the common
   production lock, capture previous identities and reject unvalidated schema
   changes, then deploy Worker and Vercel from that source.
5. Test both the returned Vercel URL and `https://os.ezil.org` (and check that the
   legacy alias `https://ezil-os.vercel.app` resolves the same deployment), and verify
   the active Worker at `https://api-desktop.ezil.org`. Provider readbacks require
   the full SHA, project, ready state and exact canonical deployment ID. Main is
   rechecked before each mutation and after verification; superseded releases fail.

There is no independent image push/path/tag trigger or registry polling race.
Base tags hash all base build inputs; overlay tags also hash the pinned Neko
continuity patch, branding inputs and the base key. Desktop tags use `sha-<full SHA>`. The global image publisher
lock and manifest existence checks prevent overwrites, including reruns and
partial previous builds. Only missing manifests permit builds; authorization
and network errors fail. `latest` advances only after desktop tests pass and a
current-main check. Version tags acquire a semantic alias only after production verification.

Production Wrangler builds a small Dockerfile FROM the tested GHCR desktop
**digest**, preserving its layers. Wrangler publishes its own Cloudflare image;
that registry digest is recorded separately and its local layers/source label
are compared against the GHCR image. A missing/stale Cloudflare image fails.
Warm customer containers can still retain their old image until Cloudflare's
rollout replaces them; successful control-plane identity is not a guarantee
that every existing session has already been replaced.

`deploy/images.env` remains a fixed, manually maintained local launcher pin.
CI never commits or rewrites it. `os-images-<SHA>` includes tested digests and
`published-images.env` for a deliberate later pin update. `os-production-<SHA>-<attempt>`
contains source, GHCR base/overlay/desktop digests, separate Cloudflare container
image/digest, Worker version, Vercel deployment, returned/canonical URLs and
previous/recovery identities. No raw provider configuration is uploaded.

## Shared SQL migration seam

The shared `.github/scripts/production-migrations.mjs` helper validates the SQL
source inventory and the observed hosted catalog. It serializes reviewed,
additive migrations with a PostgreSQL advisory lock and records checksums in
the private `ezil_ci` journal. Historical schema files are inventory snapshots;
they are never replayed or claimed to have been applied by this pipeline.

Only tested current-main production can apply the manifest. A missing baseline,
changed checksum, or unexpected catalog drift fails before deployment. PRs never
call apply, and deployment rollback never reverses SQL. See
[production migrations](production-migrations.md) for the manifest protocol.

## Configuration and recovery

Staging and production GitHub environments need environment-scoped Cloudflare
account/token, Vercel token/org/project and E2E email/password secrets. Staging
also needs `OS_WORKER_URL`, its existing AWS staging lease role and matching
Worker HMAC configuration. Vercel rootDirectory must be `app`; source is built
remotely because Sensitive Vercel variables cannot be used by local prebuilds.
The optional Vercel automation bypass remains scoped to app requests. GHCR
Actions access must permit this repository to read and publish its images.
Cloudflare needs Workers deployment/version reads and Containers application/
rollout read/write permissions. No Supabase credential is used by preview.

Failed production checks retain the failure while attempting recovery: first
verify that these deployments still belong to this release, restore the previous
Vercel deployment and Worker version, then PATCH only the previous container
image and start/poll a rolling container recovery. Current non-image container
configuration is retained in memory, not exported. Final readbacks check all
three identities. Platform refusals, missing immutable previous image digests,
changed ownership or incomplete rollouts fail explicitly and preserve the
previous image/version IDs for operator recovery. Job cancellation or runner
loss can prevent recovery steps; the captured artifact is the recovery handoff.

Tools: Bun 1.3.14, Node 22.16.0, Vercel CLI 57.0.0, Buildx 0.25.0,
Playwright 1.62.1 and lockfile-resolved Wrangler 4.128.0. Provider behavior and
large image builds still require the first hosted run; offline contract tests
cannot establish live credentials, quotas, registry access or rollout behavior.

Relevant PRs run the short hosted continuity suite with five-minute TURN
credentials. Main requires the full suite before production: active video for
36 minutes with the production 30-minute TURN lifetime, real checkpoint/stop/reopen,
and editor returns after 10 and 30 minutes. The suite has a 90-minute limit and holds the existing staging lease;
its AWS role coordinates that lease only. Execution uses GitHub-hosted runners.
Missing prerequisites and skipped acceptance are failures.

The continuity suite first confirms the isolated computer is stopped, then opens
Browser before Code so cold-start frame delivery is tested. Failed checkpoint
tests compare the committed R2 manifest before and after the rejected stop;
unavailable TURN must produce a visible Retry state and recover after clearing
the staging fault. Each editor reopen also verifies the restored keybinding:
with automatic save disabled, it inserts a fresh proof, presses the custom save
shortcut and reloads the file from disk. Restored JSON alone cannot pass that
check; the saved proof must remain after the reload and a second, unsaved probe
must disappear. A failed reload cannot pass by leaving editor text unchanged.
Stop forwarding allows up to 270 seconds for editor capture,
workspace/system checkpoints and confirmed shutdown within the 300-second route.
The browser's Vercel bypass allows 290 seconds for that stop response, while
ordinary app requests retain their 240-second budget. Cleanup uses the signed-in
request context even if the page fails, and requires confirmed shutdown or an
already-stopped computer. The deployed browser suites also verify the explicit
computer before launch; reconcile rechecks it immediately before restarting.
Both cloud jobs run final authenticated cleanup under `always()` before releasing
their lease, including when an earlier suite fails or later canonical checks reopen
compute. Cleanup signs in to the computer-management page, verifies the selected
isolated computer through the read-only session endpoint, and never loads `/os`.
Its redacted result is uploaded with acceptance evidence; unconfirmed cleanup fails
the job.

Configure each GitHub environment with an explicitly approved isolated
`EZIL_E2E_COMPUTER_ID` secret, an absolute `EZIL_E2E_WORKSPACE_PATH` variable,
`EZIL_E2E_R2_BUCKET` variable and exact `EZIL_E2E_R2_PREFIX` secret. The suite
refuses to start or stop a different selected computer. It reads the durable
R2 manifest with the repository's pinned Wrangler executable. Evidence retains
only deployment identities, hashes, timings and whitelisted media counters.
Staging also needs `EZIL_ACCEPTANCE_SANDBOX` for that same isolated computer
and `EZIL_ACCEPTANCE_HMAC_SECRET` matching its existing signed Worker boundary.
Fault controls are disabled without both staging scope and the exact sandbox;
injected failures expire within 60 seconds. Production has no fault scope.
Production verifies persistence through `https://os.ezil.org`, and validates
its isolated-computer prerequisites before changing a deployment. Branch
protection must require `Hosted continuity PR gate` alongside public CI, DCO
and CodeQL; a skipped or failed hosted gate cannot authorize a merge.

## Internal macOS test DMG (no Apple subscription)

The [`macOS Native Internal DMG`](../.github/workflows/macos-internal.yml)
workflow packages the native Electron Apple Silicon app on `macos-15`, runs
native helper, connector and GUI checks, ad-hoc signs the app, verifies the
disk image, and launches the packaged app in the offline guest smoke suite.
It uploads the DMG, SHA-256, inventory, SBOM and smoke evidence as 14-day Actions
artifacts. It runs manually and on relevant pull requests, without Apple or
repository secrets. The native host CI matrix uses the same macOS runner and
also builds and tests the legacy Swift migration package.

From GitHub, open **Actions → macOS Native Internal DMG → Run workflow**, select
the branch containing the macOS files, and download the
`ezil-native-<commit>-<run>` artifact after the job turns green. This artifact is
for trusted internal testers only. Because it is not Developer ID signed or
notarized, macOS will require the tester to Control-click the app and choose
**Open**, or approve it in **System Settings → Privacy & Security**. The
public/tagged release workflow remains intentionally unavailable until the six
real Apple distribution credentials exist.

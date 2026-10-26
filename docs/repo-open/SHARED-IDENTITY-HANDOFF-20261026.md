# Shared-identity repository launch — review handoff

Additive to reviewed OS `0dc2649a` and CLI `ee2e552`. This new exchange is not covered by those approvals. Works v1.1 is authoritative: POST JSON `{userIdToken,code}` to `/internal/project-repositories/redeem`, no M2M token or Authorization header. Account dual-proof linking, staffing and Universe project association remain owned by those lanes. This implementation never infers a Works account from email or OS Supabase identity.

## Browser and session contract

Universe sends exactly one 43-character code field in an application/x-www-form-urlencoded POST to `/api/project-repositories/launch`. The handoff HTML must use `Referrer-Policy: origin`; real Chromium proves `no-referrer` sends `Origin: null`, which is rejected. Receiver accepts only configured exact HTTPS caller origins. It does not authorize repo work on this cross-site POST. It stores the code in a bounded server vault and returns an opaque HttpOnly Secure SameSite=Lax handle cookie plus a same-origin redirect. No launch code, Auth0 token or Git grant enters a URL, HTML, local storage, analytics or browser API response.

`/continue` verifies retained OS identity or uses existing Auth0 login (same SSO, no Git login), then navigates to `/os?app=code&projectLaunch=1`. That marker is nonsecret and makes missing/expired state fail closed on refresh rather than opening workspace root. Existing OS computer selection supplies the computer; the preview handler verifies ownership before redemption. The shell requests redemption before cold-start waiting, respecting the 60-second launch lifetime. Existing provider ownership, billing, readiness and exact-folder handling remain in effect.

The normal nonce-verified Auth0 callback retains the independently verified ID token server-side. A separate strict exchange verifier enforces issuer, RS256/JWKS signature, configured OS client audience, proper azp rules, exp/iat without leeway, and human subject. Retention is bound to the cryptographically verified OS Supabase `session_id` and user, not an email or metadata identity assertion. A Supabase token is never sent to Works. Signout deletes retained state.

The vault is bounded process-local memory (10,000 entries per kind), with lazy expiration. Tokens/grants are never persisted. Current single-process staging app can use it; restart or another replica misses safely and requires relaunch/SSO. It is not a multi-replica durable session design. Confirm single-process routing before live acceptance. Redeemed grants expire within five minutes and the ID token expiry, bind one OS session/computer, and can authorize repeat opens only while valid. Expiry requires a fresh launch, not another Git login. Unknown mapping requires the Works platform dual-proof link, never an invented proof UUID.

## Protected runtime and CLI

The app forwards the validated grant inside the existing body-bound v2 computer control operation; AWS signs its body hash. Private service ingress limit is 16KiB. Runtime validates before any directory changes. Fixed FD 3 carries `{version:1,...WorksRedemption}` through the Python subreaper to the CLI. No token in argv/environment/files; FD accepts pipe/socket only, bounded size/input time. Group TERM/three-second grace/KILL/reaping is unchanged. Private-mode CLI output uses verified issuer/subject, not a fabricated Works account ID; legacy clone output is unchanged.

CLI source commit `554c561ac62fe1ec4328c2827538a9763b87ef04`, version `0.2.1-repo-url-open.20261026.5`.
Bundle SHA256 `021924592c8d061bae6a47bd3ca093fc0355ede3cc6c5ca4f84a21f52c4369c4`.
Private tarball SHA256 `e0d7c90a9c2e87695cf7fe0aa3454223577f4d2c80281ebf99050039d9e27366`.
Private artifact directory is `EZiL-CLI-private-artifacts/project-repo-grant-20261026-v5`, outside this repository. Built from clean CLI source with Bun 1.3.14, Node 24.15.0; Node >=22 required. Default images still exclude CLI; existing BuildKit secret opt-in verifies the pinned bundle. No public CLI publication or private source copy.

## Completed focused verification

- CLI: 239 tests, all four workspace typechecks. Private input validation and existing cancellation/contention/transport-isolation regressions included.
- App: 116 focused tests, including actual RS256 identity verification, session-switch refusal, one-use redemption, expiry/identity/ref/scope/URL denial, ownership-before-redemption and no root fallback. App typecheck passed.
- Real Chromium: HTTPS cross-site form Origin and SameSite=Lax cookie test passed against the actual receiver with isolated origin resolution.
- Runtime: 14 packaged/supervisor tests, zero skips. Both legacy and new private FD modes; actual credential helper retrieval, no CLI auth/API calls, exact fixture/folder, dirty reuse, normal timeout/retry, both forced recovery paths, no surviving recorded PIDs and preserved unrelated/uncertain state. Private timeout measured 1279ms; CLI escalation 1770ms; OS forced 4272ms with 1200ms test deadline and unchanged 3000ms grace.
- Worker: 223 selected tests and typecheck. Host edge: 32 tests. Staging env renderer: 9 tests. Shell rebuilt; app-link/repo-link checks passed, CSS/icons unchanged.
- Full source build is being checked separately with inert database/public build-only values. Such a build is not a release-configured image or live acceptance.

## Concrete staging gates

No lease mutation or deployment. Another billing release owns staging; coordinate source/current deployment reconciliation and ordinary conditional lease acquisition later.

Local Docker has only the default builder; `/data` has zero available space. No cleanup/prune or remote builder was created. Existing `preview.yml` invokes `image.yml` on preview, hosted ubuntu-24.04; that image path publishes GHCR and does not inject a private CLI bundle. It must not be treated as a ready private artifact distribution path. The preview app deployment targets Vercel, not the current AWS/Caddy host. `deploy/aws/os-staging/deploy.sh build|upload|install TAG` is the existing actual AWS app path, explicitly workstation-only, region ap-south-1. It requires verified public staging build settings, OS_STAGING_INSTANCE_ID and OS_STAGING_ARTIFACT_BUCKET; do not guess them or use main.

New optional runtime settings: `PROJECT_REPO_WORKS_ORIGIN` and `PROJECT_REPO_CALLER_ORIGINS`. Missing configuration refuses launch without breaking other OS functionality. No live settings were read or changed. Works needs the independently verified effective OS Auth0 client ID in its v1.1 policy and reviewed identity-link/staffing/ready-repository prerequisites. Universe project7 remains untouched/unmapped in this lane. Final exact-source/artifact review, safe private image build capacity/configuration, coordinated staging rollout, and real authenticated clone/open acceptance remain outstanding.

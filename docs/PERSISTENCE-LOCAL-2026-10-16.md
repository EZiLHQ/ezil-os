# Local OS persistence implementation — 2026-10-16

Implementation branch: `feat/os-persistence-local-20261016`.
Integration worktree: `/data/openclaw/projects/ezil/EZiL-OS.worktrees/persistence-local-20261016`.
Implementation commit (before this evidence document): `c3c8af4798087a0b352c8799170da0f2955547f9`.
Comparison baseline: cached `origin/main` at `74f5a88cf795858b934f4f0f9ffc4ea6e77e8057`; no remote fetch or publication was performed.

## Implemented behavior

- Founder `1ae9b1fd-880b-42ac-aebe-433b3c0ba11f` is always AWS-required for new computers. Existing provider pins remain authoritative; no migration is performed.
- New builders prefer AWS when the explicit enable/cutoff/cap gates pass. An unset cohort list means all builders; an explicit cohort remains a rollout restriction. Only allowed capacity/usage/kill-switch admission refusals permit a recorded Cloudflare fallback. Configuration, ownership, database and integrity failures refuse startup.
- Settings obtains actual placement from authenticated `computer.computePlacement({id})`. Its projection contains status, provider, region, lifecycle state, fallback flag and AWS requirement, with no resource identifiers, credentials or raw provider error. It never starts, admits or pins compute. Unknown observations never become a Cloudflare label.
- Retention eligibility is held until explicit deletion evidence and a separately approved post-deletion policy exist. Inactivity, cancellation and retirement never authorize purging undeleted computers. Existing backup rotation and spending limits are unchanged.
- The existing EBS-backed writable root preserves home, global package installations, executable symlinks and dependencies. New tests exercise saved files, tool layout, a new isolated tmux session and concurrent-shell history. Original process survival is not required.
- Fresh formatting now requires valid device evidence, independent signature checks, no mounted source and a complete bounded zero-byte scan. Failed probes, unknown nonzero content and incomplete scans refuse before formatting. Already formatted stop/start/replacement does not scan or format the disk.
- Lifecycle classification rejects missing observations, unexpected provider changes and detected history loss. Explicit provider context must come from separately recorded authenticated placement evidence; the probe does not query AWS.

## Commit reconciliation and ownership

The dedicated worktree started from `cf548bdebba575a354078eed7316eea8721dc198`, which already contained `8d50be06969e174d0c0f16af699240f58e2276ec`. The budget branch through `b0c3997940dafceea13d9205cd740ed634e96170` was merged locally in `1340998280d148004d1df1bc4276ad17e56658cd`. Repairs were preserved in history rather than reapplied as duplicate patches.

Implementation commits:

| Commit | Change |
|---|---|
| `30d2483f394621640869f9fb2b49ba247aac0824` | Retained-data purge hold; test-runner argument forwarding; retention docs |
| `579b4d53feadc86b4de825387e577e996e883757` | Host disk/history/tool safety and lifecycle evidence checks |
| `2f97219d99dfbf86f45ddc10ed1f89034958ed97` | AWS requirement and allowed fallback routing |
| `db3f10be038750897ee16a3675e834ceb064e69a` | Actual-provider Settings API/display and acceptance documentation |
| `e07442ecdda28c0b0d29c78432e1453f5b294623` | Existing-pin transport coverage and unsafe-start refusal fixtures |
| `e72d67c3459e387fe1b60bd7b99b1852302dc7e7` | Correct URL-host assertions in shell tests |
| `c3c8af4798087a0b352c8799170da0f2955547f9` | Independent-review fixes: recursive package diagnostics and plus-tier scan timing |

The original checkout remains on `fix/stale-preview-editor-state-release` at `9d692a2654dad298e9cadb880b76b543ef24dbf5`, with untracked `landing/` preserved. No existing worktree was reset or deleted. Native local agents used separate worktrees; Azure workers and the idle Claude lead were not launched. No push, PR change, main merge, DCO signoff, deployment, database/account mutation, cloud workload or credential/global-permission change occurred.

## Verification evidence

| Check | Result and limit |
|---|---|
| App suite through `tools/test.sh app` | 2,092 passed, 3 skipped; two files and two cases excluded to respect denied source access (below) |
| App typecheck and lint | Passed; temporary typecheck configuration excludes the one test that transitively imports the denied source |
| Retention regression | 23 passed, including every placement state and cancellation/age cases |
| Provider metadata API | 10 passed, including ownership, authentication, unavailable evidence, no provider calls and no resource/error disclosure |
| Tools full suite/typecheck | 272 passed; syntax checks passed |
| Host offline Python suite | 181 passed, 0 failures/errors/skips among selected modules; `test_edge.py` and privileged shell/mount harnesses not run |
| Infrastructure | 239 passed, no skips; typecheck and all six offline CDK synth targets passed; no deployment |
| Shell strict suite coverage | All 43 suites passed across the initial full run and corrective targeted reruns: 28 node suites, 8 portable browser suites, 7 geometry browser suites |
| Settings built-bundle fixture | 124/124 passed, including all provider labels and HTML escaping |
| Hosted lifecycle | UNEXECUTED; local fixtures do not satisfy the retained 20-cycle gate |

The initial integrated app run failed 15 old startup assumptions; fixture repairs now seed existing Cloudflare pins and assert precise refusal/no Cloudflare calls for unsafe unplaced starts. The initial shell run failed a URL assertion and 15 browser launches: the RPC path `computer.computePlacement` incorrectly matched a `puter.com` substring, and the first cached Playwright package expected a missing browser. URL checks now inspect hosts; reruns used the already cached CI-pinned Playwright 1.62.1 and matching Chromium. No browser download, global installation or weakened skip gate was needed. The long boot suite passed 169/169 checks in 294 seconds.

Logs retained on this machine:

- `/tmp/ezil-persistence-local-app-verified.log`
- `/tmp/ezil-persistence-local-types-verified.log`
- `/tmp/ezil-persistence-local-tools.log`
- `/tmp/ezil-persistence-local-infra.log`
- `/tmp/ezil-persistence-local-shell.log` (initial full run, includes corrected failures described above)
- `/tmp/ezil-persistence-local-shell-portable.log`
- `/tmp/ezil-persistence-local-shell-geometry.log`
- `/tmp/ezil-persistence-local-settings-verified.log`
- `/tmp/ezil-persistence-local-load-verified.log`
- `/tmp/ezil-os-host-review-1878d4299cb8116f93caef8fdeb382a30a6798d7.log` (host source identical to integrated `c3c8af4`)

### Deliberately withheld app checks

No copy of `worker/src/aws-origin.ts` was read by the coordinator, agents or test execution. The app run excluded:

- `aws-enroll-endpoint.test.ts`: imports `aws-tunnels.ts`, which imports the denied source. This file was also excluded from the temporary typecheck config.
- `placement-writer.test.ts`: scans all source files, including the denied source.
- `placement.test.ts` case `only admission.ts mints tickets`: repository-wide source scan.
- `aws-preview.test.ts` case `pins the route token to the Worker source`: direct denied read.

The third recorded skip is the opt-in live Postgres usage test; no test database URL was supplied. Tests ran with a clean environment, AWS credential-chain files pointed to `/dev/null`, metadata lookup disabled and offline package execution. These exclusions are not permanent repository skip rules. `tools/test.sh` now forwards caller arguments, making exclusions explicit at invocation.

## Review and release holds

Independent read-only review examined the allowed diff from `74f5a88` through exact implementation commit `c3c8af4798087a0b352c8799170da0f2955547f9`, including the fixture corrections. No open local findings remained; the reviewer independently reran the in-memory recursive-JSON reproducer against that commit and confirmed it returns an unavailable version without escaping. Two findings were repaired:

1. Deeply nested guest-controlled package JSON could raise `RecursionError` during canary boot/shutdown diagnostics. Diagnostics now report an unavailable version and continue; a regression covers the input.
2. A 300-second scan could not accommodate the configured 50 GiB plus disk at 125 MiB/s. The bound is now 500 seconds, with simulated 20/50 GiB timing coverage. Throughput and spending limits were not increased.

Hosted timing remains unconfirmed: a 50 GiB scan needs about 410 seconds at ideal 125 MiB/s, leaving roughly 190 seconds of the existing 600-second enrollment nonce lifetime for all other provisioning work. The 500-second scan cap does not extend that nonce or any other startup deadline. Slow or late startup refuses and needs operator recovery; it never guesses that a disk is blank.

An inherited ext4 caveat remains: a nominal read-only mount can replay its journal before marker checks. Mocked mount tests prove control-flow refusal and fixture-byte preservation, not physical byte immutability on a dirty block device. Real dirty-volume recovery and marker/epoch behavior remain part of later authorized device/hosted acceptance; no untested `noload`/remount recovery design is introduced here.

Port-bound bootstrap security remains unresolved; its denied source and production placement SELECT remain on hold. Full app verification involving those reads is therefore incomplete. Vercel identity 403, draft/security/DCO holds, exact approved budget/alert delivery evidence and hosted deployment acceptance remain unresolved. Staging shares production authentication/database and is not isolated. Existing Cloudflare migration and post-deletion retention policy remain deferred.

Next authorization: the exact held security/source and verification access, then separately scoped hosted test computers, lifecycle operations and spending within documented approved limits. Inspect CI/CD side effects before any later publication request. Deployment is not authorized by this local implementation.

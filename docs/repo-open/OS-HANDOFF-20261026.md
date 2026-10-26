# OS repository-open review handoff

Task: 3f77021e-76d7-81ed-8a71-f87c5d2f7f93. Request: os-repo-open-codex-os-20261026-v1.
Implementation session: 01a1788a-b457-7f23-ac00-19ce85cf0e6f.
Base: af90256b6ae6f033e64fcbc30834f647e5508c90, verified remote staging/os-core-20261026.
Owned isolated worktree: /dev/shm/repo-url-open-os-20261026.
The initial /data worktree remains untouched after creation; /data reported zero free space.
No other worktree was edited. No new agents, publication, push, deployment, lease mutation, or UI appearance changes.

## Behavior

The existing Code URL intent survives app-link parsing, boot, Code retries and the authenticated POST.
Existing Code windows re-mint on an explicit repository launch instead of silently retaining another folder.
The protected router checks OS session and computer ownership before compute/repository work. It accepts only
canonical lowercase gateway URLs, never a folder supplied by a client. Existing provider ensure/billing gates remain.
After readiness, a dedicated repo-open operation uses body-bound v2 auth, validates the claimed account/computer,
and routes only to that computer. AWS forwards a digest-bound signed control path through the existing host edge;
Cloudflare calls a private container port. Neither exposes a generic command API or a browser route for that port.
The local operation derives the persisted destination from SHA256(OS user ID) and SHA256(full canonical URL),
checks real directory ancestry, runs the exact CLI using argv/no shell, validates output and preserves files on reuse.
The caller validates the returned identity/URL-derived suffix before encoding the exact folder in Code's bootstrap URL.
Errors never produce a root-folder handoff. Works account identity is not assumed equal to OS identity.

## Local verification

- Worker selected suites: 363 passed (route auth, repo wire, AWS origin, preview bridge).
- App selected suites: 130 passed (repo-open and existing AWS preview).
- Runtime filesystem/argv/error tests: 4 passed.
- Host edge: 32 existing plus 2 repo digest/framing/forwarding tests passed.
- App and Worker TypeScript checks passed; start-neko bash syntax passed.
- Shell build and existing app-link browser regression passed; repo-link parsing regression passed.
- Actual private CLI v2 bundle with isolated empty test auth storage returned the expected bounded auth-required
  error through the OS adapter. This is a negative integration check, not positive live acceptance.
- Generated bundle updated; CSS and icons unchanged. Existing generated bundle whitespace warnings are not source edits.

## CLI packaging gate

Candidate v2 metadata is in worker/repo-open/cli-pin.json. Independent CLI rereview is pending at handoff.
Source 1cfa7fb727d08bedfdad3379105ff4cfb8aeab2d, version 0.2.1-repo-url-open.20261026.2.
Private artifact directory: /data/openclaw/projects/ezil/EZiL-CLI-private-artifacts/repo-url-open-20261026-v2.
The OS tree contains metadata/adapter code only, no CLI bundle or private sources.
The Docker build defaults to excluding the private CLI. Approved private staging builds opt in with
EZIL_PRIVATE_CLI=1 and a BuildKit secret named ezil_cli_bundle containing package/dist/ezil.js.
The installer requires Node >=22 and Git, verifies the exact bundle checksum, and installs a fixed executable
plus runtime pin under /opt/ezil-cli. No npm install or live installer is used at runtime.
Full staging image build, immutable digest and integration with the actual image-release command remain pending.
Host-edge change must be included in the staged AWS host-agent artifact, not just the desktop image.

## Runtime/auth blockers and next gates

ntn minimal START/Working receipt was read back. Detailed evidence remains in this verified session and local tree.
Default AWS login expired. Explicitly authorized ezil-admin identity read verified account 452630323510;
its lease read succeeded. Lease owner unified-credits-lead-20261026, expiry 1793024333
(2026-10-26T14:18:53Z); row provides no native-session binding. No lease was acquired/released.
A subsequent ec2 inventory call using ezil-admin failed: Error when retrieving token from sso: Token has expired
and refresh failed. Founder refresh requested by coordinator; do not switch profiles or bypass the lease.
Once access is restored, re-read current owner and use only normal conditional lease protocol after review.

GET https://api.ezil.work/cli/config was rechecked: 404. This alone is not an auth blocker.
No OS startup CLI session provisioning was found in the inspected startup/compute code. Existing CLI auth is
per-runtime-user ~/.ezil or its existing keychain; no new token exchange, SSO mapping or permission expansion added.
Required positive check: authorized safe test runtime has an existing Works CLI session; verify whoami and grant
for a verified entitled fixture, then clone/open through OS and inspect pwd, Git origin and fixture in Code.
No credential files were read or copied. No authenticated fixture/OS browser context has been verified in this lane.
If no existing grant is available, the concrete boundary is provisioning an existing Works CLI login securely
inside the owned test computer. Reusing OS login would require a separately reviewed OS-to-Works exchange contract;
OS tokens must not be submitted as Works grants. Public repo policy must be determined from the actual API.

Still required: independent OS review of exact commit; CLI rereview; positive integration; full app/image build;
current deployed app SHA, Worker/version, desktop/host image digests and rollback artifacts; staging lease;
isolation/fixture verification; staging deployment through existing preview/wrangler staging path; real browser
clone/open/reopen/refresh/dirty-state and cross-user/injection negatives. No main/production deployment.
Do not mark the task Done on this handoff.

## Timeout review correction

Independent OS review of 5211678a found parent-only execFile timeout could orphan Git and strand a lock.
The OS runner now invokes a small Linux Python subreaper (Python already exists in the desktop image).
It starts exactly one CLI in a new session/process group, sends TERM at the deadline, allows three seconds
for cooperative CLI cleanup, then sends KILL to that operation group only if still present. It reaps the
CLI and adopted descendants before returning; no supervisor filesystem deletion exists.
An ordinary CLI exit following cancellation returns repo_timeout. Signal death or forced termination
returns repo_recovery_required, leaving uncertain locks/temp state untouched for verified recovery.

The CLI owner agreed to abort owned API/lock waits/Git on TERM/INT, await Git and run its existing finally
cleanup before an ordinary nonzero exit. This requires a new independently reviewed cancellation artifact;
currently pinned v3 is the approved transport-isolation baseline, NOT sufficient release acceptance for this
cooperative cleanup dependency. No deployment until that follow-up artifact is reviewed and pinned.

V3 approved baseline: source 78eab80c79518132e6a4af0bc66e30fa0ef25fbf,
version 0.2.1-repo-url-open.20261026.3. Pin metadata supersedes the earlier v2 candidate above.
Reviewer did not independently reproduce the full bundle because its Bun version differed from the recorded
1.3.14 author build; artifact/source metadata and bounded source were reviewed. Private bundle remains outside OS.

Targeted tests: eight Node runtime/supervisor cases, including real stalled Git, group death/reaping, retry,
actual Git checkout dirty-file preservation, unrelated process survival, and preservation of unknown lock state;
two Worker wire cases and five app handoff cases. Both TypeScript checks pass. No shell appearance changes.
The real-Git supervisor fixture models cooperative CLI cleanup; exact rebuilt CLI integration remains a separate gate.
Full Next build compiled and passed TypeScript but page collection failed for missing server environment variables.
No AWS, lease, deployment, or credential actions were taken for this correction.

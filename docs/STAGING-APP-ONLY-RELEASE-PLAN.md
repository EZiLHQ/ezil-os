# Staging app-only folder release: executable plan

**Status:** the operator code and fake-host tests are implemented on this branch. Nothing here has run against AWS, SSM, Docker or the staging host. The release scheduler is the only party that executes it, under its existing lease and gates. It needs independent exact-head review first. It changes only staging and never production.

## What exists, and what does not

| Item | State |
| --- | --- |
| `rebase-release.sh app-swap`, `app-swap-reconcile` and `app-archive-check` (`deploy/aws/mum/rebase_app_swap.py`) | Implemented. Tested with fakes only. |
| `app-swap` and `app-restore` ledger rows. Each pending row records the before and expected app SHA and **web image ID**, and changes nothing else. A restore must undo the latest completed swap. | Implemented. Tested with fakes only. The live 109-entry ledger was validated in memory with this code, and nothing was written to it. |
| One-shot SSM transport. A failed or ended install journal is never re-armed or resent. | Implemented. Tested with fakes only. |
| Read-only host probe. It reports app SHA, kill switch, deployment, web image ID, the candidate tag's image, the `compose.env` tag, the six timers and their services, and whether `deploy.lock` is free. | Implemented. Fake-executed only. It has never run on the host. |
| Archive preflight. It checks the marker-pinned bytes and requires exactly one image, tagged only `ezil-os-staging:<tag>` (manifest, `repositories` and `index.json`), whose config digest equals the planned image ID. It applies `install_receipt.py`'s rules: revision label, `EZIL_GIT_SHA`, amd64 and linux. It records the public-configuration label as evidence. | Implemented. Tested on synthetic archives, not on a real `docker save` archive. |
| `deploy.sh install` and `install-verified` refuse when the ledger's latest row is pending. | Implemented. **This is cooperative only.** It applies only where the ledger file exists, which is the scheduler host. On any other workstation, and for raw `AWS-RunShellScript`, older checkouts or direct host access, it does nothing. |
| Real IAM or SSM-document enforcement against other app-mutating paths | **Not implemented.** The protections are scheduler custody, the operator's in-flight SSM check and the host deploy-lock check. These are evidence, not enforcement. |
| Runtime archive check. `app-archive-check` requires the marker-pinned `<tag>.runtime.tar.gz` to contain exactly the installer's 15 members, byte-equal to `deploy/aws/os-staging/` at both `agentCommit` and the target commit. | Implemented. Tested with fakes only. |
| `app_only_offline.py` kernel | A superseded design model. It is not used by the operator. |

## Deviation from the contract: why the reviewed installer is used

The contract proposed a new web-only installer. This plan instead reuses `install-host.sh` through the same `rebase_app.body` wrapper that release32 `apply-app` used. The reviewer must explicitly accept or reject this.

The installer bytes differ from release-132:
- release-132 pinned installer SHA-256 `c0eacf8f…`, which is the 7fcc version.
- This head's installer is `51857b9e…`.
- The difference is 35 added lines, all gated on a third and fourth argument (`approved_source`) that `rebase_app.body` never passes.
- `test_generated_legacy_install_keeps_two_arguments_and_no_receipt` and `test_legacy_checksum_failure_stops_before_load_or_timer_changes` exercise that two-argument path.

Reasons:
- `git diff 7fcc76d4 320f938d -- deploy/ docker/ app/Dockerfile app/.dockerignore infra/ worker/` is empty. The runtime archive members (`compose.yaml`, `Caddyfile`, `render-env.py`, `cron/*`) are byte-identical, so the installer rewrites them with the same bytes.
- The operator also refuses any plan whose two apps differ from the baked agent commit outside `shell/**` and `app/public/os/bundle.min.js`.

The installer's remaining effects, and how each is checked:
- **Environment re-render.** It re-renders `app.env` and `cron.env` from the current secret. The operator pins the secret version across the operation.
- **Service restart.** It force-recreates `web` and `caddy`. Expect brief unavailability and dropped browser sessions. No user computer is restarted.
- **Timers.** It stops all six timer/service pairs and later runs `enable --now` on them. The probe requires all six timers to be `enabled` and `active` both before and after, and no timer service to be running when the operation is admitted.

## Consequences the scheduler must accept before running it

1. **Older tooling stops working on this ledger.** Once an `app-swap` row exists, any checkout of `rebase_release.py` older than this change refuses the whole ledger, and that is tested. It refuses on the row's shape (`invalid ledger entry` or `invalid pending snapshots`) before it even reaches the operation name. Every later ledger operation must run from this tooling version or newer: `ledger-reconcile`, `registry-gc`, `ledger-adopt-app` and any release32 phase.
2. **The release32 `rollback` path closes.** After any app row is written, `rebase-release.sh rollback` for plan `446cafac…` refuses, because the latest entry belongs to another plan. Run the swap only after release32's recovery observation (r9) is final. Otherwise, accept that a tuple rollback would need a new plan.
3. **Fresh recovery evidence is needed.** A new app identity means the current fixed-window observation does not carry over. KS1 stays closed until the scheduler's own gates reopen it.

## Live prerequisites (none done by this lane)

| # | Prerequisite | Evidence required |
| --- | --- | --- |
| P1 | The tooling checkout on the scheduler host is this reviewed head. | `git rev-parse HEAD`; `sha256sum deploy/aws/os-staging/install-host.sh` equals the plan's `installerSha256`. |
| P2 | Candidate image `320f938d2c96`, built from `320f938d2c964f20a4e3a45847760b025c3d056f` with the three staging public values (currently absent here) and uploaded with `--if-none-match`. | All four object version IDs and the image ID (config digest). Docker root and `TMPDIR` on `/data`, because `/` has about 600 MB free. Immutable remote source custody for 320f938d (it is local-only today). |
| P3 | The 7fcc rollback archive at an exact S3 version, marker `20236fc8…`. | Its config-digest image ID, derived exactly as `install_receipt.py` does. It must equal the live web image ID read by the before-probe. If the before-probe reports a different `from` image ID, treat it as "this derivation does not hold on this host (for example a containerd image store)": stop, and do not edit the plan to match. |
| P3b | The live `compose.env` tag, which is the plan's `from.tag`. Expected `7fcc76d4efdb`, written by release32 `apply-app`. | The before-probe requires `OS_STAGING_TAG=<from.tag>` exactly. A mismatch refuses as `live app differs from the plan before-state` before anything changes. Confirm the value from the release32 apply-app receipt or tag; never edit the plan merely to make the probe pass. |
| P4 | Ledger tail. At 01:55Z it was generation 109, a completed `promote-canary` with registry pin, app `7fcc76d4`. | Re-read under the lock; `ledgerGeneration` in the plan = latest generation. |
| P5 | The single staging lease, held by the scheduler, with at least 30 minutes left (15-minute install timeout plus probes). | The scheduler's lease readback. |
| P6 | r9/recovery for release32 is final: 03:18:34Z (08:48:34 IST), or 20:18:34Z if 24h15 applies. | The scheduler's gate record. |
| P7 | All six timers are enabled and active, no timer service is running, the host deploy lock is free, and no other SSM command is in flight. | Enforced by the operator. A refusal before the pending row is written changes nothing; retry later. |
| P8 | Worker identity. Wrangler is unauthenticated, so the live OS staging Worker version and bridge digest are unverified. | An authenticated read-only deployment listing, or an already running signed-in workbench. This blocks product acceptance claims, not technical ledger completion. The expected folder bridge script SHA-256 is `2e8cd726…ebee78`. |
| P9 | Residual risk: no IAM fence. `ezil-admin` can still send arbitrary `AWS-RunShellScript`. | Keep the operation inside scheduler custody. A fixed-document IAM restriction (`delivery_permissions.py` proposal) is a separate change. |
| P10 | Public configuration of the candidate. `pipeline.json` has no approved `public_config`, and the 7fcc build predates the label. | Compare the receipt's `publicConfigSha256` with the fingerprint of the approved staging values (`public_config.py`) before applying. |
| P11 | Ledger readers. Only `rebase_release.py` and `registry_gc.py` (via `rebase_release`) read the ledger, plus the new `deploy.sh` check. The app's TypeScript does not. | Retire ledger operations from older checkouts, including the `rel132-7fcc76d4` worktree, before the first app row. |

## Ordered procedure (scheduler)

Use a new absolute release directory, for example `/root/ezil-aws-mum/release/app-swap-320f938d-20261107/`. `REPO` is a checkout containing both `7fcc76d4` and `320f938d`.

1. **Plan inputs.** Download the exact-version candidate `.tar.gz` and `.sha256` into the release directory. Read the image ID from the archive:
   ```
   python3 -I -c 'import sys,json,hashlib;sys.path.insert(0,sys.argv[1]);import rebase_app_swap as o;_,m,_=o.scan_archive(sys.argv[2]);e=json.loads(m["manifest.json"]);print(e[0]["RepoTags"],"sha256:"+hashlib.sha256(m[e[0]["Config"]]).hexdigest())' "$PWD/deploy/aws/mum" /abs/320f938d2c96.tar.gz
   ```
   Do the same for the 7fcc archive.
2. **Write `app-plan.json`:**
   ```json
   {"schemaVersion":1,"operation":"app-swap","ledgerGeneration":<N>,"agentCommit":"7fcc76d4efdbf0c400039640cdee13974b727b4d",
    "from":{"tag":"7fcc76d4efdb","gitSha":"7fcc76d4efdbf0c400039640cdee13974b727b4d","imageId":"<7fcc image ID>"},
    "to":{"tag":"320f938d2c96","gitSha":"320f938d2c964f20a4e3a45847760b025c3d056f","imageId":"<candidate image ID>","checksumSha256":"<sha256 of the marker file>"},
    "undoes":null,"installerSha256":"<P1>"}
   ```
   `agentCommit` must equal the AMI 1.0.32 bake's `agentCommit` (release32 required app = bake = 7fcc). Verify it from the release32 plan's `bake` before writing.
3. `deploy/aws/mum/rebase-release.sh app-archive-check --plan <abs plan> --archive <abs tar.gz> --runtime <abs runtime.tar.gz> --checksum <abs .sha256> --source-repo <REPO> --apply` writes `app-archive-receipt.json`. It refuses unless the marker pins both archives, the image matches the target source, and the runtime files are byte-identical to the baked commit. Before applying, compare the receipt's `publicConfigSha256` (P10).
4. **Pre-stage the restore plan** in a second directory: `operation: app-restore`, `from` and `to` reversed (so `from.tag` is `320f938d2c96`), `to.tag: 7fcc76d4efdb`, `to.checksumSha256: 20236fc8…`, `undoes`: the swap plan's SHA-256, `ledgerGeneration: N+2`. Run step 3 for it against the 7fcc archive now, so rollback needs no new artifact work.
5. **Dry run.** `rebase-release.sh app-swap --plan <abs> --source-repo <REPO>` prints `DRY RUN: would probe, append pending app-swap generation N+1 and send one install`. It reads only the app secret, under `app-secret.lock`. There is no SSM, S3 or ledger write.
6. **Apply.** Run the same command with `--apply`. It reads the secret under `app-secret.lock` and checks the before-probe (P7, live = from). It then fsyncs the pending row N+1, sends exactly one install, runs the after-probe and appends a completed row N+2. It prints `app-swap completed generation N+2 … kill switch remains closed`.

**Stop conditions:**
- **Refused before the pending row is written:** nothing changed. Fix the input and rerun.
- **Lost reply, timeout or crash:** rerun the same `--apply`. It resumes the same command by journal or comment and never sends a second install.
- **`one-shot SSM command failed` or `post-install state differs`:** do not rerun. Go to step 7.
- **`uncertain SSM submission; reconcile command before retry`:** the journal is `submitting` with no command ID, and the SSM listing shows zero or several matching comments. Wait for SSM's eventual consistency and rerun the same command. If it persists, the fence stays in place and the scheduler decides manually. Never write a new plan to get around it.

7. **Reconcile.** Run `rebase-release.sh app-swap-reconcile --plan <abs>` without `--apply`, then with it. It requires all of this generation's SSM commands to be terminal, two probes with the deploy lock free and a stable app and image, no running timer service, and no in-flight SSM command. It then closes the row as:
   - `completed` if the host is exactly at the expected state (SHA, image ID, `compose.env` tag, deployment, all six timers running);
   - `aborted` if the host is exactly at the before-state, on the same terms;
   - otherwise it refuses with `manual reconciliation required` and a nonsecret diff.

   Typical manual cases are timers left stopped, or `compose.env` already naming the candidate while the old container still runs (the installer writes it before `up`). Restore exactly the recorded value (the six timers enabled and active, or `OS_STAGING_TAG=<from.tag>`) with one reviewed command, then reconcile again. Never use `ledger-adopt-app` or `deploy.sh install` to close an app row. A new attempt needs a new plan at the new generation.
8. **Technical completion, with KS1 closed.**
   - Ledger row N+2 is a completed `app-swap`.
   - Public `/api/health` returns 200.
   - The served shell bundle's SHA-256 equals the reviewed `d5964836…3cb7d5`. Verify the served path first.
   - The scheduler records generation N+2 and replans.
9. **Recovery observation.** Run it under the scheduler's existing rules for the new app identity, then let the scheduler decide whether to reopen admission.
10. **Signed-in acceptance, only after reopening.**
    - Open a copied nested-folder URL in a fresh tab, then reload.
    - Test Forget/reconnect.
    - Check workspace persistence across a restart.
    - Check cache revalidation separately: `max-age=0` is not proof that open tabs refreshed.

## Rollback

- **Before the pending row:** nothing to undo.
- **Pending:** step 7 only.
- **After a completed swap:** run `rebase-release.sh app-swap --plan <restore plan> --source-repo <REPO> [--apply]`. It is the same one-send, probe and reconcile path. The ledger accepts it only as an undo of that exact swap, back to that swap's recorded before SHA and image ID. It uses the same installer, so it has the same restart and timer effects.
- **If a restore itself aborts,** the ledger's latest app row is the aborted restore. It cannot be restored again; returning to 7fcc then needs a fresh reviewed `app-swap` plan from the candidate.
- It restores the app image only. Environment files are re-rendered from the then-current secret. Secrets, the database schema, the Worker and the AMI tuple are not restored by it.

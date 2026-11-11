# Image rebase from a released warm-pool host (staging runbook)

This covers a STOPPED computer whose warm-pool host was released: the pool row is `retired` and the EC2 instance has been terminated and aged out. Design R; rationale is in the PR. This document authorizes nothing. Each real run needs its own approved window, lease and gate.

## When this path applies
`plan`/`prepare` switch to the released-pool source only when the server finds, under the admission lock, the retired claim row of exactly this allocation:
- the computer, instance, region and zone;
- `claim_generation`, `claim_lease_epoch`, `claim_fence` and `claim_volume_serial`;
- `dispatch_status = settled`.

With no such row, the regular-host rules below apply.

## Regular (non-pool) released host (Design R2)

A STOPPED computer's ordinary host is retired by the normal lifecycle `release` and then ages out of EC2, so the preparation helper cannot see it to fence it. It used to be reserved anyway and failed `writer_not_fenced` before the snapshot, leaving an active failed job. Now, with no claim row:
- **The source is still listed in EC2:** nothing changes. The helper stops and terminates it itself, and a hint is ignored.
- **The source is no longer listed:** `plan` and `prepare` refuse `source_identity_mismatch` **before any reservation**, unless `--source-retirement-execution-arn` names the SUCCEEDED normal `release` execution that retired exactly this placement. It must match the computer, instance, volume, generation, fence token and lease epoch, and the account, region, zone and namespace. It needs a strict `retired` receipt, must finish no later than now, and its complete history must witness `terminated` for exactly that instance (the same proof as `reconcile-replacement` and Design R (a)).
- **The proven release** is carried as the preparation document's last key, `retiredSource {releaseExecutionArn}`. It never appears together with `releasedPoolHost`, and preparation helpers before this change refuse it (strict).
- **The helper never stops or terminates the historical host.** It refuses a listed source (`source_identity_mismatch`) and an attached volume (`writer_not_fenced`), then snapshots.
- **The source release still comes from the registry,** via the placement's observed lower. A release is not evidence of the host's AMI, so a shared lower with an aged-out host stays refused.
- **Recovery's child job** drops `retiredSource`, like `releasedPoolHost`.

Find the release exactly as below: a SUCCEEDED `release` of this computer and its `providerInstanceId`. Use the same commands. The prerequisites (workflows rebuilt from this commit and published, registry capacity) apply unchanged.

**Operational hold (R2 is not an app-only change).** The `retiredSource` key changes the preparation document, and every helper built before this change refuses it at its first observation.
- **No hinted `plan --apply`/`prepare` for a retired regular source** until a release built from this commit is promoted: its app and its immutable lifecycle, preparation and recovery workflows, with their pinned Lambda versions, as one compatible tuple.
- **The app does not check the helper's capability.** On an older tuple a hinted `prepare` is reserved and started, and the helper then fails `preparation_failed`. That leaves another failed, active job.
- **Shipping the app alone is allowed only for `cancel-preparation`.** No R2 preparation may run until the whole tuple is live.

Every one of these must also hold, or the request is refused (`source_identity_mismatch`, `release_mismatch`, or a conflict). Nothing is guessed.
- **Placement state:** the placement is STOPPED, with no lifecycle job, no image reservation, no open migration or reverse move, and no `leased` pool host.
- **Provision proof:** the pool host's provision execution SUCCEEDED, its input is byte-equal to the row, and its receipt names this pool host and instance.
- **Release proof:** the operator-named release execution SUCCEEDED for exactly this allocation (computer, instance, volume, generation, fence, lease epoch). It has a `retired` receipt, started after the provision stopped, and its history witnesses `terminated` for exactly that instance. Absence from EC2 is never treated as termination.
- **Instance aged out:** EC2 no longer lists the instance. Launch, recovery and maintenance refuse a listed claim host, so retry later rather than snapshotting a host they would then refuse.
- **Source release:** exactly one registry record equals the provisioned tuple: AMI, launch template id and version, the lifecycle/preparation/recovery state-machine versions, and lower/previous. An alias that shares only a lower or an AMI never counts.
- **Lower:** the lower is known. NULL still gives `source_digest_unknown`.

The preparation document gains `releasedPoolHost {poolHostId, lifecycleDigest, releaseExecutionArn}`, which preparation helpers before this change refuse. The new helper never stops or terminates anything on this path. It refuses a listed instance, and refuses an attached volume immediately (`writer_not_fenced`, no waiting).

## Prerequisites (release window, not this change)
1. **Deploy.** Ship the app from this commit. Rebuild and publish all three workflows (lifecycle, preparation, recovery) from this commit with `apply-workflows`. Each state-machine version pins its own Lambda, and each strict-parses the preparation document. If any one is stale, the job fails after the snapshot.
2. **Active target.** The active target's `previousLowerImageDigest` must equal the computer's lower. For lower 34acdd28 that means re-releasing 1.0.30 with the new workflows, or a later bake with previous = 34acdd28 after the 67c939f0 computers have moved.
3. **Registry capacity.** The registry holds at most 26 records (25 before the twenty-six-record compatible app, 24 before the twenty-five-record one), and every re-release adds one. Check the current count first.
4. **Running computers.** Once two records share an AMI and differ only in workflows, matching a running computer by AMI is ambiguous (`release_mismatch`). Stop it through the normal lifecycle first, which releases its host, then use this path.

## Finding the release execution (read-only)
The release job id is not stored after STOPPED, so the operator supplies it as a lookup hint. The server re-proves it.
- List SUCCEEDED executions of the namespace lifecycle machine (`ezil-mum-lifecycle`) around the time the pool row was retired (`ezil_compute_pool_hosts.updated_at`).
- `describe-execution` each candidate, and keep the one whose input document is a `release` of this computer with this `providerInstanceId`.
- Step Functions keeps history for 90 days. Older releases cannot be proven, and those computers fail closed.

## Commands
Prepare, launch and recover print a dry run unless given `--apply`.
```bash
bash deploy/aws/mum/rebase-computer.sh plan    --computer "$C" --source-retirement-execution-arn "$RELEASE_ARN"
bash deploy/aws/mum/rebase-computer.sh prepare --computer "$C" --source-retirement-execution-arn "$RELEASE_ARN"           # dry run
bash deploy/aws/mum/rebase-computer.sh prepare --computer "$C" --source-retirement-execution-arn "$RELEASE_ARN" --apply
bash deploy/aws/mum/rebase-computer.sh launch  --computer "$C" --apply
bash deploy/aws/mum/rebase-computer.sh verify  --computer "$C"
```
- The hint is accepted only on plan and prepare.
- It is journaled with the pending request, so a lost prepare reconciles through `plan` with the same hint.
- Record the volume id, size and fsUuid before and after the run.
- Keep the journal.

## Failure handling
Follow `LEGACY-REBASE-OPERATOR-PRESERVATION.md` ("preserve, then stop"). Never delete volumes or snapshots, edit image-job rows, or reinstall an old app.
- **Refused before reservation:** nothing changed. Fix the evidence or wait for the host to age out, then plan again.
- **Refused in the helper before the snapshot:** this happens on a listed host, an attached volume, a tag or identity mismatch, or an old helper. The job is failed and the volume is untouched. Investigate any attachment as a possible concurrent writer before anything else.
- **Releasing that failed job:** while the job is active, every placement read for the computer refuses `image_job_conflict`, and `recover` needs a launch document this job never has. Release it only with the explicit operator cancel:
  ```bash
  python3 deploy/aws/mum/rebase_computer.py --namespace prd cancel-preparation --computer "$C" --job "$JOB" --check   # proves only
  python3 deploy/aws/mum/rebase_computer.py --namespace prd cancel-preparation --computer "$C" --job "$JOB" --apply   # cancels
  ```
  - **Cancel proves before it writes.** The preparation execution must have FAILED at its first observation with the job's own code. Its complete history must schedule no stop, terminate or snapshot. The source volume must still be free, unattached and this generation's.
  - **`check` writes nothing.** `apply` sets the job `cancelled`, keeping its failure history, and returns the placement to STOPPED with the reservation cleared.
  - **Any other outcome changes nothing:** `not_applicable`, `execution_not_proven` or `provider_not_proven`. Never edit job or placement rows instead.
- **Failure after the snapshot:** the ordinary recovery path applies. Recovery's child job drops `releasedPoolHost`, because its source is the live rebind host.

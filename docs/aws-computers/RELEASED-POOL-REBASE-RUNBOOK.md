# Image rebase from a released warm-pool host (staging runbook)

This covers a STOPPED computer whose warm-pool host was released: the pool row is `retired` and the EC2 instance has been terminated and aged out. Design R; rationale is in the PR. This document authorizes nothing. Each real run needs its own approved window, lease and gate.

## When this path applies
`plan`/`prepare` switch to the released-pool source only when the server finds, under the admission lock, the retired claim row of exactly this allocation:
- the computer, instance, region and zone;
- `claim_generation`, `claim_lease_epoch`, `claim_fence` and `claim_volume_serial`;
- `dispatch_status = settled`.

With no such row, behaviour is unchanged.

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
3. **Registry capacity.** The registry holds at most 28 records (27 before the twenty-eight-record compatible app, 26 before the twenty-seven-record one, 25 before the twenty-six-record one, 24 before the twenty-five-record one), and every re-release adds one. Check the current count first.
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
- **Failure after the snapshot:** the ordinary recovery path applies. Recovery's child job drops `releasedPoolHost`, because its source is the live rebind host.

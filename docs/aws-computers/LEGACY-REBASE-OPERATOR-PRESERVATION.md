# Legacy-source rebase: the operator preservation procedure (staging, contract amendment 2 B5)

Scope: a placement whose source release is a LEGACY record (1.0.2, lower 8dbc; null prep/recovery pins), rebased to a target with previous = 8dbc. First subject: builder2 `ca0121a6`.
Automated restore/rebind for a legacy source is REFUSED (`operator_required`, `app/src/server/lib/compute/aws-rebase-recover-orchestrator.ts:39-43`). This procedure stands in for that automation. It never fabricates a receipt and never clears a reservation.

## Preconditions (lead verifies before `prepare`, and records each in Notion)
1. The placement is STOPPED and has no lifecycle job. `lower_image_digest` equals the source record's lower, and the source release resolves uniquely (`plan` returns ok).
2. No non-terminal image job exists for the computer. Earlier failed or cancelled jobs are retained, never deleted.
3. The registry holds the source record (legacy) and the target record. The live tuple equals the target.
4. The admission gate state and the AWS budget are re-read.
5. The original data volume ID, its size and its fsUuid are recorded from DescribeVolumes and from the DB.

## Happy path (automated; operator observes)
prepare → preparation SFN (stop → terminate source → snapshot the detached volume → verified receipt) → launch on the target AMI with the same volume → host guard sees marker 8dbc ≠ host 34ac WITH a snapshot receipt → in-place rebase (rules 1–5; displaced files moved to `/.ezil-rebase-preserved/<ts>/`) → marker = 34ac → enrollment → desktop.
Evidence to keep:
- preparation execution ARN and status;
- snapshot ID, state `completed`;
- launch execution ARN;
- host console lines for the guard and the rebase;
- the job phase `succeeded`;
- the placement `lower_image_digest` = 34ac.

## If anything fails: preserve, then stop
| Failure point | State left | Operator action |
|---|---|---|
| Before fencing (preparation refused or failed early) | Source instance and volume untouched. The job is failed or cancelled (as 9601f3be was). | Nothing to restore. Keep the job row, record the failure code, fix the cause, and run a new `prepare`. |
| After fencing, before the snapshot completes (LEGACYSRC blocker 4) | Source instance stopped or terminated; volume detached. The snapshot may be pending. | Do NOT delete or reattach the volume. Wait for the snapshot to reach a terminal state and record it. Leave the job failed/unconfirmed. Escalate to the founder. There is no automated repair. |
| Snapshot completed, target launch failed, or the host refused (`rebase_failed` state on the volume) | Volume is either untouched or half-rebased; it is marked by the state file, so the guard refuses to start the desktop. The completed snapshot and the custody hold are retained. | 1. Verify every target writer is stopped or terminated: DescribeInstances for the job's launch instance. 2. Record the volume, the snapshot and `.ezil-rebase-state.json` (via console output only; never mount it read-write). 3. Leave the job in failed/unconfirmed. 4. Do NOT clear the reservation, `lifecycle_job_id` or the custody. 5. Escalate. Restoring means creating a NEW volume from the snapshot (the original is kept quarantined) and rebinding on a 1.0.2 host. That needs LEGACYSRC blockers 1–3 resolved, or a founder-approved manual run. |
| Rebase succeeded but enrollment or desktop failed | Marker is 34ac. Data is rebased; the preserved files are in `/.ezil-rebase-preserved`. | Treat it as an ordinary AWS host failure on the target release (replace on the same release). The snapshot stays retained until acceptance passes. |

Forbidden in every case:
- `DeleteVolume` / `DeleteSnapshot` (both IAM-denied);
- SQL that edits image-job phases, receipts or custody;
- reinstalling an old app;
- running a stale release plan.

## Acceptance after success (browser, synthetic builder2 account)
- first Code open;
- Browser;
- the user's files from before the rebase are still present (persistence);
- chat send, abort and retry;
- clipboard both ways (Code and Browser);
- restart desktop;
- Mumbai placement compared with egress.
Then the snapshot hold follows the normal retention rules. Nothing is deleted manually.

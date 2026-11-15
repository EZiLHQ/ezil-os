# NULL recorded lower: measured attestation (operator runbook)

This document authorizes nothing. Each real run needs its own approved window, its target named by Root, and the normal staging lease. The first and only planned target is the owned original QA computer. A production NULL record is not a target until it is authorized separately, and there is no fleet backfill.

## What this does and never does
A committed AWS placement whose `lower_image_digest` is NULL cannot cold-open (`computer_rebase_required`), and the operator rebase refuses it (`source_digest_unknown`). This path **measures** the lower from the guard marker of a snapshot **clone**. It then records that measurement, and only that, in one audited compare-and-set.

Never, at any step:
- attach, mount, write or rebind the original volume;
- infer a lower from config, the deployment or the launch tuple;
- weaken a fence, or write a marker or a customer file;
- delete a snapshot or volume.

Afterwards the ordinary rules apply unchanged:
- If the measured lower equals the deployment lower, a normal cold open starts on the original disk.
- If not, the normal operator rebase is now admissible.

## Pieces
| Piece | Where |
|---|---|
| Schema `0004_lower_attestations` (installer: separate lane) | `docs/aws-computers/sql/0004_lower_attestations.sql.txt` |
| Store, verifier, CAS | `app/src/server/lib/compute/aws-lower-attestation.ts` |
| Operator runner (this runbook) | `app/scripts/lower-attestation-operator.ts` → `aws-lower-attestation-operator.ts` |
| Host measurement (delivered by the one SSM proof command, pinned) | `infra/host-agent/lib/ezil_host/attest.py` |
| Internal route `attest-lower-*` | `/api/internal/computers/image-rebase`. Adopt there answers `attest_readers_unavailable` until the app role has every read below. |

## Trust model (strict AWS reads, nothing relayed)
Adopt reads every proof itself, under the operator profile, and the runner's `command` step checks the host part before the measurement too.

### 1. The one proof command
- Document `AWS-RunShellScript`: owned by Amazon, at the explicit numeric version the command ran, active, Sha256 hash equal to the pin.
- Exactly one target instance.
- Commands byte-equal to the canonical delivery of `attest.py` at the pinned sha256, with this reservation's arguments and its server challenge.
- Requested after the reservation.
- The invocation succeeded with response code 0 and printed one line: the receipt.

### 2. The receipt
- Challenge and tuple; raw marker bytes and their sha256.
- Clone mounted `ro` with `noload`/`norecovery`, plus `nosuid`, `nodev`, `noexec`. Block device set read-only; a journal that needs recovery is refused.
- The **marker** names the computer, the ORIGINAL volume and the fsUuid, with **exactly** the reserved generation and lease epoch (R2: no older or newer writer). instanceId, if present, equals the source.

### 3. A fresh maintenance host (R1), only for this job
- Exactly **one** CloudTrail `RunInstances` record for it, after the reservation and before the command.
- That launch carries the registry target's **full immutable tuple**: account, region, the pinned AMI (which equals the target AMI), launch template id and **numeric** version.
- **No user-data override** in the request, and **no user-data** on the instance. This scope accepts no bootstrap, because a later attribute hash cannot prove what booted.
- Its AWS-signed identity document names that instance and AMI. It does not sign the measurement.
- Running, in the placement's zone.
- Tags: `ezil:managed-by`, `ezil:stage` (namespace), `ezil:attestation-id`, `ezil:computer-id`; never `ezil:pool`. The original volume is not attached to it.
- Complete paginated reads show **no** SSM session (active or history) and **no** SSM command other than the proof command:
  - none before the measurement (checked by the runner's `command` step);
  - exactly the proof command at adoption.

### 4. Snapshot, clone and original
- **Snapshot:**
  - of the original;
  - completed, started after the reservation;
  - the deployment's KMS key;
  - tags `ezil:attestation-id` and `ezil:computer-id`.
- **Clone:**
  - created from it;
  - the same zone and KMS key;
  - the same two tags;
  - attached to nothing, or only to the maintenance host.
- **Original:**
  - `available`, with no attachment;
  - tags `ezil:computer-id`, `ezil:managed-by`, `ezil:stage`, and `ezil:generation`/`ezil:fence-token` equal to the reserved tuple.

### 5. The source launch
- Exactly one CloudTrail `RunInstances` record for the source instance, with no error, before the reservation.
- Its account, region, AMI, launch template id and numeric version must join **exactly one** registry release, and that release's lower must equal the measured one. A shared lower or AMI alone never selects.

### 6. The source instance and who wrote the marker
- The current placement instance is frozen at reserve. For the actual targets it is non-null but terminated; it may also be NULL.
- If the current instance is NULL, or the marker has no instanceId, **one complete historical binding** of exactly this allocation is required: computer, owner, provider, store, volume, fsUuid, generation, lease epoch, fence, region and zone. It is either:
  - the **one committed CF→AWS migration** (`ezil_compute_migrations`, `cloudflare` → `aws-ec2`, owner, not released), whose persisted `_awsProvision.placement` matches the allocation and whose persisted deployment's launch tuple equals CloudTrail's (never the current config); or
  - the one retired, settled pool claim row.
- Contradicting records refuse always. Two bindings refuse when one is needed. The latest usage session may only corroborate: an open, tied or conflicting session refuses.
- No current lifecycle job, and no `released` key, is required.

## Prerequisites (each verified, not assumed)
1. **Schema.** 0004 is applied by the reviewed installer, pinned to this lane's SQL sha256. Owner `postgres`; no client grants.
2. **Database identity.** The runner connects as role `postgres` to the pinned system identifier. Any other role fails closed, including another BYPASSRLS role.
3. **Runtime.**
   - The runner checks the checkout **its own script was loaded from** (`git -C <script root>`, toplevel asserted). It must be the pinned commit with no tracked modification (`runtime_not_pinned`, `runtime_dirty`).
   - This happens before any DB or AWS read. A clean pinned checkout elsewhere does not count.
4. **Trusted AMI.**
   - The registry's current target, pinned as `maintenanceAmiId`. It is qualified offline before the window, never by an interactive or extra command on the host.
   - Its agent library at `/opt/ezil-host/lib` must provide what `attest.py` imports: `guard.device_for_volume/fs_uuid/mount_opts/read_marker/read_rebase_state/MARKER`, `restore.read_state`, `fsops`, `lease.Imds/strict_json` and `config.load`.
   - It must also ship `dumpe2fs` and `blockdev`.
5. **CloudTrail window.** LookupEvents covers 90 days. Both the source launch and the maintenance launch must be inside it.
6. **Read-only IAM for the operator profile.** All of these are required:
   - `sts:GetCallerIdentity`;
   - `ec2:DescribeSnapshots`, `ec2:DescribeVolumes`, `ec2:DescribeInstances`;
   - `ec2:DescribeInstanceAttribute` (userData);
   - `ssm:ListCommands`, `ssm:DescribeDocument`, `ssm:GetCommandInvocation`, `ssm:DescribeSessions`;
   - `cloudtrail:LookupEvents`.

   `ec2:DescribeInstanceAttribute` and `ssm:DescribeSessions` are **new needs**. Confirm the profile has them; this lane creates no IAM.
7. **Execution steps under Root:**
   - `ec2:CreateSnapshot`, `ec2:CreateVolume`, `ec2:CreateTags`;
   - `ec2:RunInstances` and `ec2:TerminateInstances`, maintenance host only;
   - `ec2:AttachVolume` and `ec2:DetachVolume`, clone only;
   - `ssm:SendCommand`, once.

   `DeleteVolume` and `DeleteSnapshot` stay denied.

## Pins file (reviewed, no secrets)
```json
{"region":"ap-south-1","accountId":"<12 digits>","namespace":"<stage namespace>","dbSystemIdentifier":"<pg_control_system>",
 "sourceCommit":"<40-hex reviewed commit>","sourceSha256":"<sha256 of attest.py at that commit>",
 "documentSha256":"<DescribeDocument Hash of AWS-RunShellScript at documentVersion>","documentVersion":"<explicit number>",
 "maintenanceAmiId":"<registry target AMI>","userDataSha256":null}
```
- `--deployments`: the reviewed `EZIL_AWS_LIFECYCLE_DEPLOYMENTS` JSON. Its entry for the region must name the same account, region and namespace.
- `--identity-certs`: the reviewed `EZIL_AWS_IDENTITY_CERTS` JSON.
- The DB URL comes only from `EZIL_ATTEST_DATABASE_URL`, and AWS access only from the operator profile.
- Run with `bun --no-env-file`.

## Procedure (original QA computer only)
`R='bun --no-env-file scripts/lower-attestation-operator.ts'`; `P='--pins pins.json --deployments deployments.json --identity-certs certs.json'`.
Every `--apply` needs `--journal <private dir>`. The intent file is created O_EXCL 0600 **before** the store call, and the outcome or error is appended. Stdout carries phases, codes and hashes only.

0. **Read-only pre-witness.**
   - The placement is STOPPED, provider `aws-ec2`, lower NULL, with no image, lifecycle or open migration job.
   - The original volume is `available` and detached.
   - Exactly one committed CF→AWS migration exists whose provision matches the allocation.
   - Record this without printing identifiers.
1. **Reserve.** `$R reserve $P --request request.json` (dry run), then add `--journal J --apply`.
   - `request.json` holds the exact tuple: attestationId (a v4 uuid you generate), computer, historical source instance, volume, fsUuid, generation, lease epoch, fence, region, zone.
   - A refusal writes nothing.
   - The reservation fences every ordinary open, start and admission.
2. **Snapshot.** Snapshot the ORIGINAL with tags `ezil:attestation-id`, `ezil:computer-id`, `ezil:managed-by`, `ezil:stage`. Wait for `completed`.
3. **Clone.** Create a volume from it in the placement's zone, encrypted with the deployment data key, with tags `ezil:attestation-id` and `ezil:computer-id`. Never `ezil:pool`.
4. **Fresh maintenance host.** One per reservation, launched after step 1. Use the registry target launch template id and numeric version with the pinned AMI.
   - **No user-data** (no override). Without a lease the boot chain mounts nothing.
   - Tags `ezil:managed-by`, `ezil:stage`, `ezil:attestation-id`, `ezil:computer-id`; IMDSv2.
   - Open **no** SSM session and send **no** command to it before step 5. Inspect nothing interactively; any session or extra command makes the run fail closed.
   - Attach the **clone only**.
5. **Command.**
   - `$R command $P --attestation-id A --computer-id C --maintenance-instance-id I --clone-volume-id V --snapshot-id S --out send.json`.
   - This re-proves the fresh host: full launch tuple, no user-data, tags, and no command or session yet. Only then does it write the one accepted SSM input, O_EXCL.
   - Send it once: `aws ssm send-command --cli-input-json file://send.json`. Record the CommandId.
   - On a REFUSE output (for example `needs_recovery`, `marker_missing`, `generation_mismatch` or `epoch_mismatch`), go to "Failure".
6. **Adopt.** Do this while the maintenance host is still running.
   - `$R adopt $P --attestation-id A --computer-id C --command-id X`: the dry run is the store's read-only preview, so expect `adopted`.
   - Then add `--journal J --apply`.
   - An unknown outcome is reconciled with `status`, never resubmitted.
7. **After adoption.**
   - Read-only post-witness: lower and observation time recorded, fence cleared, original still `available` and untouched, audit row sealed with `committedMigration` and the source and maintenance launch hashes.
   - Detach the clone and terminate the maintenance host.
   - Retain the snapshot and clone under normal retention.
8. **Hand-off.** Pass to the cold-open journey owner: Reload, exactly one Start, the same customer file, a new epoch, and a re-witness.

## Failure
- **Any refusal before adopt:** `$R abort … --journal J --apply` seals `refused` and clears only this reservation, even after drift, owner change or deletion. The lower stays NULL.
- **Adopt refusal:** sealed `refused` with its code, and the fence released automatically. A transient AWS read error writes nothing; rerun the dry run.
- **A host that took any extra command or session** can never be used: abort and start over with a new reservation and a new fresh host.
- **Expiry:** a reservation older than 24 hours cannot be adopted (`reservation_expired`). Abort it; nothing expires by itself.
- **Never:** delete a snapshot or volume, edit attestation or placement rows by hand, or reuse a maintenance host.
- **Rollback of an adoption:** it only filled NULL columns. Reverting needs a separately reviewed compare-and-set under the same tuple, which this tooling does not provide; escalate to Root.

## Known limits
- The verifier cannot see a read-write mount of the clone between attach and the proof command. These narrow it:
  - the refusal of a journal that needs recovery;
  - a fresh host with no user-data, no lease, and no SSM command or session other than the proof;
  - attaching only the clone, immediately before step 5.
- The internal route's adopt stays fail-closed until the app role has every read above. The operator runner is the supported path.
- The pool claim binding reads the staging-only 0003 and 0008 pool columns.
- `.pg.test.ts` suites skip without `EZIL_PG_TEST_URL`. Run them against a disposable PostgreSQL.

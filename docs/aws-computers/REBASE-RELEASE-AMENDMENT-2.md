# Rebase release contract v1, amendment 2 (2026-10-23)

Amends amendment 1, sections A1 (release registry) and A3 (maintenance releases). Everything else in contract v1 and amendment 1 still applies.
Evidence: independent read-only reviews of the release model and of each tooling round (2026-10-23). The implementation is `deploy/aws/mum/` (see its README).

## B1. Two release roles, never conflated
Every reviewed release (bake → plan → finalize → apply-* → promote → rollback) pins TWO source artifacts:
- **deployed release** (`deployed-release.json`): the record whose PROMOTION tuple equals the live app secret's region entry at bake/plan time. Used ONLY for:
  - the "last promoted" check before the first promotion write;
  - the journal `before` tuple and the rollback target;
  - the launch-template diff baseline in apply-workflows (`sourceAmiId` → deployed AMI);
  - rollback readbacks (`source_readbacks`).
- **image predecessor** (`previous-rebase-release.json`, existing name): the retained registry record whose `lowerImageDigest`/`lowerImageRef` equal the bake's `previousLowerImageDigest`/`previousLowerImageRef`. Used ONLY for image lineage. It MUST already be in the live registry. It need NOT be the deployed release.
- The two may be the same record (1.0.5 case: both = 1.0.2). Both files are then present with identical content.
- A maintenance bake (A3) keeps its own `maintenance-source-release.json` provenance, keeps `previous=null`, and promote() still refuses it. Unchanged.
- A target whose lower equals the deployed lower but whose previous is a different, retained lower is a normal TARGET (the 1.0.6 case: lower 34ac, previous 8dbc, deployed 1.0.5, predecessor 1.0.2). The existing refusals stay: previous=null target, lower==previous.

## B2. Registry identity is (lowerImageDigest, amiId)
- `edit_release_secret` refuses two records with the same (lower, amiId) pair, and any record rewritten in place (same pair, different content). Several records may share a lower if their AMIs differ.
- The target is unique by the full PROMOTION tuple (unchanged).
- Capacity is 8, and records are never dropped (unchanged).
- App resolver (`resolveRebaseReleases`): unchanged behavior is accepted for this round.
  - The source set is the records whose lower equals the placement lower. Exactly one is required, otherwise `release_mismatch`.
  - So a placement on a shared lower (34ac) refuses closed until a later change disambiguates by observed instance AMI (deferred, see B5).
  - An 8dbc placement resolves (unique).

## B3. Release history survives rollback (stale-plan guard)
- **Ledger.** A durable local promotion ledger sits beside the releases directory (`/root/ezil-aws-mum/releases/promotion-ledger.json`; tests override the path through the existing fixture/config mechanism).
  - It is append-only and written atomically (temp + fsync + rename) under the app-secret lock.
  - Every app-mutating operation appends ONE entry after its verified success: apply-app, promote-canary, rollback.
  - Each entry is `{generation (int, +1 each), planSha256, operation, secretVersionId (after), tuple (PROMOTION fields after), appGitSha}`.
  - Nothing is added to the app secret; the app reader stays untouched.
- **Drift check.** Before any app-mutating operation, the latest entry's `secretVersionId` and tuple must equal the live secret. A mismatch refuses: "ledger drift".
- **Pinning.** New plans pin `ledgerGeneration` (the latest generation at plan time) as a new PLAN_KEYS field.
  - Legacy plans without that field (the 1.0.5 plan) still load, and have no pin.
- **Admission rule for plan P:**
  - P's FIRST app-mutating operation requires latest generation == P's pin.
  - A LATER operation requires the latest entry to be P's own (same planSha256).
  - Rollback additionally requires that P has a promote entry, and that no entry newer than P's own exists.
  - A legacy plan may continue only while the latest entry is its own.
- **Tuple equality alone never authorizes a release.**
- **Consequence:** once 1.0.6 performs apply-app, every 1.0.5 operation refuses. That holds even after 1.0.6 rolls back to the 1.0.5 tuple. So no reinstall of app 279b2443 and no restore of the 1.0.2 tuple can happen through stale plans.
- **Migration.** An explicit, dry-run-by-default `ledger-init --manifest <1.0.5 rebase-release.json> [--apply]` creates generation 1 attributed to the 1.0.5 plan sha.
  - It reads the live secret under the lock.
  - It verifies the live tuple == 1.0.5 journal `after`, and that the journal status is promoted.
  - It records the live VersionId and the running app gitSha. Get the gitSha from the existing gate/readback mechanism if one can run read-only, otherwise from the 1.0.5 apply-app receipt.
  - It refuses if a ledger already exists.

## B4. Rollback reinstalls the invoking plan's app
- The rollback of plan N restores N's journal `before` tuple (the deployed release) and installs plan N's app (`rollout.app`).
- That app must accept the restored tuple with N's record still retained. This is tested in `aws-rebase-release-registry.test.ts`.

## B5. Deferred, explicitly refused closed this round
- Automated restore/rebind for a LEGACY source (LEGACYSRC blockers 1–3) stays refused with `operator_required`. Builder2's failure path is the operator preservation procedure (lead-owned doc), not automation.
- A failure after fencing but before the checkpoint (blocker 4): there is no automation, the original volume is preserved, and nothing is fabricated.
- Premium `0769` is not registered and has no predecessor target, so it refuses. Unchanged.
- Source disambiguation by observed AMI: deferred. A shared-lower placement refuses closed.
- Start-mode wake (`EZIL_AWS_WAKE_MODE=start`) with an older-AMI instance fails `lifecycle_instance_invalid`. Staging runs `replace` (env unset). Recorded as a risk; no change.

## B6. What a 1.0.6 rollback does and does not revert
- `rollback` of the 1.0.6 plan restores the deployed 1.0.5 tuple in the app secret (AMI ami-0d5e…, LT 4, lifecycle:9, rebase-preparation:1, recovery:1). It keeps the 1.0.6 app installed, and that app accepts the 1.0.5 tuple with the 1.0.6 record retained.
- It does NOT revert CloudFormation:
  - the 1.0.6 lifecycle Lambda code stays deployed;
  - the unversioned recovery reconciler code stays deployed;
  - LT 5 stays.
- The restored tuple points at state machine versions that remain published and pin their own Lambda versions.
- **A secret-only rollback does not leave the platform able to launch.** The lifecycle stack's IAM policies pin the exact release:
  - the controller's RunInstances image resource is the target AMI only (`ami-0d5e…` → `ami-033d…`);
  - the KMS `aws:states:stateMachineArn` encryption-context conditions of the observer, recovery, reconciler and app-caller roles name the target versions only (`lifecycle:9/prep:1/recovery:1` → `:10/:2/:2`). Measured from the staged 1.0.6 lifecycle change set on 2026-10-23.
  - After a secret-only rollback, launches and decryption under the 1.0.5 tuple are refused by IAM.
- A **functional** rollback is therefore:
  1. stage and review an update of `ezil-mum-lifecycle` back to the retained 1.0.5 template (`review-106/lifecycle-before.json`). The foundation stack needs no change: LT 4 still exists and RunInstances pins the template ID, not the version;
  2. execute it under the closed gate;
  3. then run the tooling `rollback`.
  The reverted Version resources may publish new version numbers. If so, the restored tuple must pin the version numbers that are actually published. That requires a new reviewed plan, not the old 1.0.5 plan, which B3 fences anyway.
- After any 1.0.6 operation, every 1.0.5 plan operation refuses (B3), so the 1.0.5 rollback (app 279b2443, tuple 1.0.2) is unreachable.

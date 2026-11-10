# Production image rebase: source capability and operator prerequisites

This contribution implements offline-tested operator source. It is **not** a
production deployment, AMI qualification, IAM grant, DB migration or evidence
that existing users have upgraded. Only base `2913cd34` (PR329) was personally
certified by the user; this contribution has no new human certification or commit.
UI/open/preview/socket enforcement belongs to the separate mandatory writer.

Use `--namespace prd` on every command. Defaults remain mum. Production pins:
account `452630323510`, region `ap-south-1`, LT `lt-0b68cfb18ad22869a`, ECR
`ezil-prd-foundation-applicationimages439f25f1-xkgzfggtz2w4`, bucket
`ezil-prd-deploy-assets-452630323510`, secret `ezil-os/production/app`, origin
`https://os-prod.ezil.work`, and the reviewed production host caller
`arn:aws:iam::452630323510:role/ezil-os-prod-host-InstanceRole-uJIGAhHeIYOr`.
Stacks, execution role/boundary, operator locks, journals, registry context,
installer/S3 paths, app directory and DB identity all use production pins.
The production app host is re-read from `ezil-os-prod-host`, checked against its
VPC, tags and exact instance-profile role. No host instance ID is guessed.

The following is the artifact order for root/DF, after separate operational
authorization. Commands below describe future operations; none was executed
against a live provider in developing this contribution.

1. Fence app, pool and workflow writers through the established authority gate.
   Keep `EZIL_AWS_KILL_SWITCH=1` in both the live secret and running app. Obtain
   independent nonsecret evidence of the **current** legacy source: exact AMI,
   LT version, lifecycle version, Image Builder build ARN, recipe/agent commit,
   immutable ECR reference and observed lower identity. Retain the complete
   source-schema manifest at an absolute private path, e.g.
   `/root/ezil-aws-prd/releases/legacy/source.json`. Preparation and previous
   lower pair must be null; recovery may be null only if the live stack has no
   recovery version output. A target manifest cannot serve as this source.
2. Save a reviewed nonsecret legacy lifecycle config containing exactly the live
   deployment and the normalized published observer settings (including default
   features). Save the current app artifact `{tag,gitSha,checksumSha256}`; its
   checksum is the installer's checksum-marker SHA256, and its immutable bytes
   must already exist in the production artifact bucket. Independently capture
   the current secret `VersionId`; never place secret values in release files.
   `source-init` re-reads STS, lifecycle stack outputs/role, AMI/LT, published
   lifecycle/recovery versions, their immutable Lambda observers/settings, source
   build bindings/enroll URL and ECR manifest/config digest. It probes the running
   app and gate through the verified production SSM host.
3. Admit the source with an **absent local ledger** and absent/empty live registry:

   ```bash
   bash deploy/aws/mum/rebase-release.sh source-init --namespace prd \
     --manifest /root/ezil-aws-prd/releases/legacy/source.json \
     --config /root/ezil-aws-prd/releases/legacy/lifecycle.prd.json \
     --build-arn "$verified_source_build_arn" \
     --app-artifact /root/ezil-aws-prd/releases/legacy/current-app.json \
     --expect-secret-version "$verified_secret_version"
   ```

   The default is validation; it sends a read-only SSM app probe but performs no
   secret write or app install. Add `--apply` only for the authorized admission.
   Under the common operator/app-secret locks it appends **only** this source to
   the registry, preserving the plain deployed tuple, unrelated keys and region
   encoding. It refreshes the same pinned app artifact to adopt the registry,
   rechecks live app/provider state, then creates
   `/root/ezil-aws-prd/releases/promotion-ledger.json`, generation 1, operation
   `source-init`. No legacy promotion journal or target tuple is invented.
   Keep `source-registration.json` and all SSM journals. An interrupted operation
   can resume only in its original directory with the same input hashes, expected VersionId and
   exact before content, or its own write-token VersionId and exact after
   content. The install is one-shot. A completed admission, foreign ledger,
   unrelated secret edit, stale app, failed/uncertain SSM command or altered
   evidence refuses replay; retain the fence and reconcile the recorded command.
   All secret writers must honor the shared lock: Secrets Manager has no native
   conditional PutSecretValue, so the CAS guarantee is cooperative lock plus
   exact before/after checks and an idempotent request token.
4. Bake the target from the qualified desktop bytes and reviewed agent commit
   with `rebuild-ami.sh --namespace prd`, a strictly higher recipe version,
   `--previous-release` naming the admitted source,
   `--deployed-release` naming the current promoted source,
   `--previous-desktop-image-ref` and `--previous-desktop-image-id` naming its
   exact OLD lower. Supply the NEW desktop image and reviewed source SHA using
   the existing bake flags. Retain `bake-inputs.json`, `build-arn.txt`, `build.json`,
   `image.json`, `previous-rebase-release.json` and `deployed-release.json` in a
   new release directory. The target AMI must contain both immutable lower
   pairs. This step produces bake evidence, never launch authority.
5. Prepare the full desired lifecycle tuple: NEW lower/AMI, OLD previous lower,
   exact prd preparation/recovery/lifecycle version ARNs and LT version. The
   identity config's `imageJobDeployment` must equal that deployment, and its
   namespace-specific permissions boundary must authorize the reviewed image-job
   roles. `recoveryVersionArn` must equal the tuple's recovery version. Prepare
   exact before/candidate CFN templates, change sets and reviews (including any
   required pool IAM review) plus the qualified app artifact in `rollout.json`.
   The ordinary role-policy review and resource limits still apply. Stage the
   source SQL contract and independently verify production DB
   `7698288507300208674`, host `10.63.20.252`, database `postgres`, SSL required.
6. Run `rebase-release.sh plan --namespace prd --release-dir "$release_dir"`
   with `--config`, `--identity-config`, `--rollout` and
   `--expect-system-id 7698288507300208674`. The first plan consumes the real
   admitted source and generation-1 ledger, checks the running app and retained
   registry, and refuses secret-version drift since admission. Keep artifacts
   immutable. Then run the existing `apply-schema`, `apply-identity`,
   `apply-workflows`, `finalize` operations with `--namespace prd --plan
   "$release_dir/rebase-plan.json"`; validate first and add `--apply` for each
   separately authorized mutation. Finalize requires all receipts and fresh
   provider readbacks; preparation/recovery can never be null on the target.
7. Run `apply-app`, then `promote-canary` with `--namespace prd --manifest
   "$release_dir/rebase-release.json"` (validation first, authorized `--apply`
   second). Promotion retains source and target and updates the full matching
   lifecycle/preparation/recovery/LT/lower/AMI tuple together. It refreshes the
   pinned app and appends the real pending/completed ledger entries. Reconcile
   interruptions with the same plan and generation; never fabricate receipts.
8. Upgrade **every existing user** through the ordinary signed computer job:
   `rebase-computer.sh --namespace prd` with the exact computer/job journal and
   `plan`, `prepare`, `launch`, `verify`, or `recover`. Keep retained EBS identity,
   snapshot/job lineage, generation/ownership and host-absence fences. An unknown
   source or recovery requires reconciliation; never force a raw OLD-lower
   launch. `/etc/ezil-image-id` remains package-set identity. Independently verify
   official desktop code bytes using the mandatory writer's enforcement and
   reconciliation work before declaring all users upgraded.

Registry GC also requires `--namespace prd`, the ledger-bound plan, production
DB collection identity and fresh complete fenced evidence. It never drops a
record referenced by a volume, snapshot, job or uncertain execution. Collector
inputs are local exports; no fabricated receipts may substitute for live proof.

Offline validation: `python3 -B deploy/aws/mum/tests/offline_suite.py`; focused
`prd_rebase.py` and `prd_paths.py` exercise first admission through promotion,
shell OLD+NEW bake, recovery version rollback/races, client job identity and GC.
Real CDK synth checks additionally require installed infra dependencies and use
`tests/prd-synth-contract.py`; no cloud lookup is part of that check.

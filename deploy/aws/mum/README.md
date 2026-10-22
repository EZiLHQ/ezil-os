# Mumbai host AMI rebuild and lifecycle promotion

These operator scripts default to **dry-run**. They always pin AWS profile
`ezil-admin`, region `ap-south-1`, and account `452630323510`. Dry-run reads AWS
identity/stack/version metadata and, for rebuild, the local Docker image. It
prints proposed writes without logging in to ECR, pushing, uploading, changing
the real configuration, creating a change set, or fetching the app secret.
With `--recipe-version`, rebuild also writes a temporary candidate config and
runs the offline AMI synth. Promotion always synthesizes both its baseline and
candidate, including in dry-run. Temporary files are removed on exit. Run locally
with fake commands for an entirely offline check.

## Recipe version updates

Use `rebuild-ami.sh --recipe-version <x.y.z>` for changed desktop/agent inputs.
The default AMI config is `/root/ezil-aws-mum/config/ami.mum.json`, originally
`1.0.1`. The requested version must be numerically greater than its current
version, use three integer segments without leading zeroes, and keep each
segment at most `1073741823` (Image Builder's limit). No version is inferred.
The legacy path without this flag still refuses immutable recipe replacement.

The synth mechanism comes from `infra/app-computers/package.json`'s
`synth:ami`, `bin/ami.ts`, and README **Host AMI**, step **(d)**. It uses the
existing `EZIL_AMI_CONFIG` variable, `node --import tsx bin/ami.ts`, and a
`BootstraplessSynthesizer`; no publish-assets or bootstrap step is needed.
The package script disables credential-file access, metadata credentials,
lookups and telemetry. Rebuild copies `bin/`, `lib/`, and the four package/CDK/
TypeScript metadata files to a private directory, and links the already installed
`node_modules`. It never copies operator configs or credentials. It invokes:

```bash
EZIL_AMI_CONFIG="$work/ami.mum.json" npm --prefix "$work/ami/app-computers" \
  run synth:ami -- ezil-mum-ami
```

Here `$work` is the script's private temporary directory. The package script pins
`-o cdk.out/ami`; **do not add another `--output`** (CDK rejects it). npm runs with
the private project as its working directory, so the output is
`$work/ami/app-computers/cdk.out/ami`. The repository's `cdk.out` is never touched.
The resulting
`ezil-mum-ami.template.json` is compared with the live stack template before any
uploads. Resource identities, parameters, outputs and all unrelated properties
must remain unchanged. Component `Version`/`Data` and recipe `Version` may
change; infrastructure/distribution/pipeline template changes must be literal
substitutions of the old version with the requested version. Both live immutable
versions must agree with the local config, and both synthesized versions must
match the candidate. A template larger than 51,200 bytes is uploaded to
`s3://ezil-mum-deploy-assets-452630323510/ami/templates/<UTC timestamp>.json`;
otherwise CloudFormation receives `--template-body`. Above 1,048,576 bytes is
refused. The synthesized template is never rewritten by this script.

The change-set description is independently checked before execution. Only the
existing Component, ImageRecipe, ImagePipeline and version-forced
DistributionConfiguration/InfrastructureConfiguration may change. The component
and recipe must both be replaced with the new version. Additions, removals,
unexplained properties, IAM, network, KMS, ECR, S3 and other resource changes
are refused. All nonallowed parameters use previous values, including resolved
SSM values; Ubuntu parent drift stops the run.

Apply saves the byte-identical old config as `previous-ami-config.json` and the
candidate as `candidate-ami-config.json` in the release directory. **Only after
`execute-change-set` and `wait stack-update-complete` succeed** does it atomically
persist the new version to the real config, then start the existing bake path.
Config drift is checked before execution and again before persistence. A failed
synth/change set/stack update leaves the real config unchanged. A failed bake
keeps the successfully deployed new version and the old backup.

## Inputs and safeguards

Prerequisites: Bash, AWS CLI v2, Docker with a local `linux/amd64` desktop image,
git, Python 3, coreutils (`timeout`, `realpath`, `cmp`), util-linux `flock`, Node
and npm. AMI and lifecycle dependencies must already be installed in
`infra/app-computers`; `npx --no-install` forbids fetching a different CDK.
AWS credentials are managed by the lead's normal `ezil-admin` setup. Never
print credentials, read `.pem` files, or run these scripts under a tracing
wrapper that captures process stdin.

Defaults:

| Item | Value |
| --- | --- |
| AMI stack | `ezil-mum-ami` |
| Foundation stack | `ezil-mum-foundation` |
| Computer launch template | `lt-06f691fc1e4dfe3cc` (`ComputerLaunchTemplate`) |
| Lifecycle stack | `ezil-mum-lifecycle` |
| ECR repository | `452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6` |
| Asset bucket | `ezil-mum-deploy-assets-452630323510` |
| Lifecycle CloudFormation role | `arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec` |
| AMI config | `/root/ezil-aws-mum/config/ami.mum.json` |
| Lifecycle config | `/root/ezil-aws-mum/config/lifecycle.mum.json` |
| Release evidence | `/root/ezil-aws-mum/release/next/` |
| App secret | `ezil-os/billing-staging/app` |
| Operator lock | `/root/ezil-aws-mum/locks/operator.lock` |
| App-secret lock | `/root/ezil-aws-mum/locks/app-secret.lock` |

The role ARN follows `identityNames()` in
`infra/app-computers/lib/identity.ts`, including `/ezil/identity/`.
The AMI stack currently has **no RoleARN**: rebuild omits `--role-arn`, retaining
caller-credential execution. It passes the execution role only when the AMI
stack is already bound to that exact role; any other role is refused. Promotion
requires both the foundation and lifecycle stacks to use the execution role.
An absent or different foundation `RoleARN` is refused.
`--config` (either script) and `--release-dir` accept alternate local paths for
isolated tests or an explicitly selected release. They do not change AWS targets.
There are no new environment variables or secret names. Both scripts acquire the
common operator `flock` before reading shared configuration, journals or synth
inputs, for dry-run and apply. It is independent of the release directory and
checkout, is held for the whole run, and fails immediately on contention.
Do not unlink a lock file. Independent lifecycle publishers must also take the
operator lock; the version recheck cannot exclude a publisher that ignores it.
The rebuild already running from the older checkout does not use this new lock:
wait for it to finish before using the new scripts.

Rebuild resolves the source to a full commit, inspects the local image, tags its
immutable image ID as `host-<sha12>-<UTC YYYYMMDDhhmmss>`, and pushes it. ECR's
schema-2/OCI manifest digest pins the image. A classic Docker store's local ID
must match `manifest.config.digest`; a containerd store's ID may instead match
the pushed manifest digest. A containerd index is accepted only when its digest
matches the local ID and it contains exactly one `linux/amd64` image plus
attestation manifests only. Multi-platform indexes are refused. Both AMI image
parameters pin the selected child's digest for an accepted index. Temporary Docker login
configuration is removed on exit. The archive command is:

```bash
git archive --format=tar.gz --output host-agent-FULLSHA.tgz FULLSHA:infra/host-agent
```

This puts `.gitignore`, `ami/`, `bin/`, `lib/`, `security/`, `systemd/`, and `test/`
at archive root, matching the supplied `host-agent-c36fb784….tgz`; there is no
`infra/host-agent/` prefix. The archive goes to `ami/host-agent-<fullsha>.tgz` in
the asset bucket. Every live stack parameter is included, with
`UsePreviousValue=true` except the three permitted inputs. The change-set check
also refuses resolved Ubuntu SSM AMI drift and unexpected resource/property
changes. No AMI or snapshot is deregistered or deleted.

After an admissible stack update, the script reads its `PipelineArn`, starts one
bake, records `build-arn.txt` immediately, and polls every 30 seconds with a
90-minute deadline. Individual poll requests are bounded by the remaining time.
`FAILED` and other terminal failure states stop the script. Timeout does not
cancel the remote build. Re-running with a recorded build ARN is refused to
prevent duplicate paid bakes. `ami-id.txt` appears only after AVAILABLE and a
check of AMI ownership, architecture and availability.

## Lead execution order

Run from the integrated, reviewed EZiL-OS checkout. Keep the AMI config aligned
with the live stack and use a fresh release directory for each successful update.

1. Validate this lane offline, then install the pinned infrastructure dependencies on
   the lead's authorized builder if they are absent:

   ```bash
   bash deploy/aws/mum/tests/run.sh
   for script in deploy/aws/mum/*.sh deploy/aws/mum/tests/*.sh; do bash -n "$script" || exit 1; done
   npm --prefix infra/app-computers ci
   python3 deploy/aws/mum/tests/synth-contract.py
   ```

2. Obtain the reviewed desktop build from the desktop lane. Choose its local
   Docker reference and the full integrated source commit. These are local
   shell variables, not environment configuration:

   ```bash
   read -r -p 'Reviewed local desktop image: ' desktop_image
   read -r -p 'Reviewed host-agent source SHA: ' source_sha
   read -r -p 'New recipe version (greater than current): ' recipe_version
   bash deploy/aws/mum/rebuild-ami.sh --desktop-image "$desktop_image" --source-sha "$source_sha" --recipe-version "$recipe_version"
   aws --profile ezil-admin --region ap-south-1 --no-cli-pager cloudformation get-template \
     --stack-name ezil-mum-ami --template-stage Original --query TemplateBody --output json
   ```

3. Run the approved rebuild and inspect its non-secret evidence:

   ```bash
   bash deploy/aws/mum/rebuild-ami.sh --desktop-image "$desktop_image" --source-sha "$source_sha" --recipe-version "$recipe_version" --apply
   cat /root/ezil-aws-mum/release/next/desktop.txt
   cat /root/ezil-aws-mum/release/next/ami-id.txt
   aws --profile ezil-admin --region ap-south-1 --no-cli-pager ec2 describe-images \
     --owners 452630323510 --image-ids "$(cat /root/ezil-aws-mum/release/next/ami-id.txt)" \
     --query 'Images[].{Id:ImageId,State:State,Architecture:Architecture,Root:RootDeviceName}' --output json
   ```

4. Dry-run and apply promotion:

   ```bash
   bash deploy/aws/mum/promote-ami.sh --ami "$(cat /root/ezil-aws-mum/release/next/ami-id.txt)"
   bash deploy/aws/mum/promote-ami.sh --ami "$(cat /root/ezil-aws-mum/release/next/ami-id.txt)" --apply
   aws --profile ezil-admin --region ap-south-1 --no-cli-pager stepfunctions list-state-machine-versions \
     --state-machine-arn arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle --output json
   aws --profile ezil-admin --region ap-south-1 --no-cli-pager cloudformation describe-stacks \
     --stack-name ezil-mum-lifecycle --query 'Stacks[0].Outputs' --output json
   ```

   Promotion first checks that the configured launch-template version exists and
   its `LaunchTemplateData.ImageId` equals the configured AMI. It proposes the
   latest launch-template version plus one, independently of the configured
   version, and the maximum published workflow version plus one. It saves `promotion.json` containing
   the previous and target non-secret configs. Using `bin/lifecycle.ts` via
   `npm run synth:lifecycle`, it synthesizes baseline and candidate in separate
   private copies under `$work/before/app-computers` and
   `$work/target/app-computers`. Each uses its existing `cdk.out/lifecycle` default.
   The live template must match the baseline synth, and the configs may differ
   only in `amiId`, `launchTemplateVersion` and the predicted `stateMachineVersionArn`. For every changed
   resource property, the candidate must equal the baseline after recursively
   substituting only the old AMI and workflow version with their proposed values,
   plus the launch-template version inside the complete serialized deployment settings.
   This includes strings inside `Fn::Join`, `Fn::Sub` and IAM `PolicyDocument`.
   Separate numeric version arguments are changed only within an intrinsic
   expression resolving to the configured workflow version ARN; unrelated
   numbers and identifiers stay unchanged. An added IAM action or principal,
   a widened resource, or any unrelated property fails validation.

   After both synths validate, promotion creates a foundation UPDATE change set
   with `--use-previous-template`, the existing `ezil-mum-cfn-exec` role, and
   `HostAmiId=<new AMI>`. Every other discovered parameter uses its previous value.
   This change set is the server-side dry run: before execution the validator
   requires exactly one Modify of `ComputerLaunchTemplate`, only its
   `LaunchTemplateData` property, no replacement, and details explained by
   `HostAmiId`. It refuses extra resources, parameters, resolved SSM changes,
   unrelated property paths, incomplete pages and unexpected context values.
   The stack, role and latest template version are rechecked before execution.

   Once the foundation update completes, promotion reads the latest template
   version back from EC2. Its number must equal the prediction, its ImageId must
   equal the target AMI, and all other launch data must remain unchanged. The
   foundation's role, physical launch-template ID and parameters are also checked
   again. Only then can it edit the lifecycle config or publish lifecycle assets.
   `foundation-cs.txt`, the change-set description, `previous-foundation-stack.json`,
   `previous-latest-launch-template.json`, `promoted-foundation-stack.json` and
   `promoted-launch-template.json` retain non-secret evidence in the release directory.
   Default dry-run prints these mutations without creating or executing a change
   set; `--apply` always validates the real change set before executing it.

   Each removed/added `AWS::Lambda::Version` pair must independently reference the
   same existing function whose only change is its substituted environment.
   Version properties and attributes must match after substitution. The pinned
   CDK changes the Version's logical ID hash, with identical Version properties;
   explicit code hashes/descriptions do not receive a blanket exemption.
   References to that validated pair may move from the old to the new logical ID.
   All other resource additions/removals and replacements remain refused.

   After foundation verification, the script saves both synths and the live template
   in the release evidence, edits the config, then runs `cdk publish-assets` from
   the candidate's private copy, S3 template upload, and CloudFormation UPDATE
   through the execution role. Every live parameter uses its previous value.
   Before execution, it verifies CloudFormation's submitted template matches the
   candidate, requires the change set to describe exactly the synthesized
   resource actions and property differences, and checks parameter/resolved
   SSM values. The Version pair must appear as one Add and one Remove; other
   replacements are refused. Dynamic details are accepted only for exact
   references to that validated Version pair in the changed property. It
   rechecks version publication before execution, and requires the deployed
   `WorkflowVersionArn` to match the predicted published version.

   Only then does it update the app secret. The JSON transformation changes only
   `EZIL_AWS_LIFECYCLE_DEPLOYMENTS["ap-south-1"].amiId`,
   `.launchTemplateVersion` and `.stateMachineVersionArn`. All three must match
   either the complete old or complete target deployment before an edit.
   String-encoded and object-encoded deployment maps
   retain their encoding type; the deployed app renderer expects the existing
   string encoding. Other regions, deployment fields and outer secret keys are
   preserved. Payloads are edited in memory and sent through a private 0600
   temporary request file removed immediately after the AWS call; they never
   appear in logs, argv or release journals. The entire read/modify/write/read-back operation
   holds `/root/ezil-aws-mum/locks/app-secret.lock` using `flock(2)`. It re-reads
   VersionId immediately before `put-secret-value`, then verifies both the returned
   version and complete payload. Promotion and rollback use the same lock even
   when run from different checkouts/releases.

   **Every other writer**, including the lead's `set-staging-key.py`, must hold
   the same lock from its first secret read through its final verification. Run
   the complete command on this operator host through the supplied wrapper:

   ```bash
   bash deploy/aws/mum/with-app-secret-lock.sh python3 /path/to/set-staging-key.py <existing-arguments>
   ```

   Replace the example path/arguments with the lead's existing command; keep secret
   values out of argv. Do not wrap `promote-ami.sh` or `json-tool.py secret-update`
   in it: those acquire the lock internally. Lock order is operator then app-secret.
   AWS has no compare-and-swap for `PutSecretValue`: writers on other hosts or
   writers that ignore this lock remain unsafe and must be routed through this
   host/wrapper. Installing these files does not retrofit external writers.

5. Refresh the staging app so it loads the updated secret. Use the existing
   staging install procedure with its already configured
   `OS_STAGING_INSTANCE_ID` and `OS_STAGING_ARTIFACT_BUCKET`, and reinstall the
   current reviewed app tag:

   ```bash
   read -r -p 'Current reviewed staging app artifact tag: ' app_tag
   AWS_PROFILE=ezil-admin AWS_REGION=ap-south-1 bash deploy/aws/os-staging/deploy.sh install "$app_tag"
   AWS_PROFILE=ezil-admin AWS_REGION=ap-south-1 bash deploy/aws/os-staging/deploy.sh smoke
   ```

   The lead then runs Chromium and a new staging AWS computer canary: admission,
   enrollment, desktop readiness, AI request routing, stop and wake. On the new
   host, compare `/etc/ezil-host/lower-image-digest` with `DesktopImageId` and
   check `systemctl is-active ezil-host.target`. Confirm the launched EC2 AMI and
   launch-template version and lifecycle execution version match the promoted deployment. Existing computers do
   not acquire the new AMI automatically. The staging deploy runbook documents
   any health-route limitations affecting `smoke`; do not treat that as AMI proof.

## Rollback and partial failures

Keep `release/next/previous-ami-config.json` (the old recipe version),
`candidate-ami-config.json`, both templates, `promotion.json`, and all old AMIs,
snapshots, launch-template versions, lifecycle versions
and referenced Lambda versions until canaries and rollback checks finish. After
success, archive the entire release directory before starting a new promotion;
an existing journal is deliberately not overwritten. Keep the common lock files
in place permanently; archiving a release does not rotate them.

A recipe update does not promote an AMI. If it fails, leave the old AMI and
published lifecycle version in service. If CloudFormation succeeds but the
process exits before config persistence or bake startup, retain
`ami-update-complete.txt` and reconcile the saved candidate, old config and live
stack before doing anything else. Do not blindly reset the config to the old
version after a successful update: the live stack now uses the new version.
The old config backup records the previous version; it is not a command to
recreate that immutable version. CloudFormation controls replacement cleanup
of the old recipe/component; these scripts retain AMIs, snapshots and lifecycle
versions and do not delete them. Use a fresh, greater recipe version for a later
rebuild. Different release directories and checkouts share the operator lock.

Rollback restores the **previous configured AMI, launch-template version and workflow version**, even when those
versions were older than the latest published versions at promotion. It never
computes rollback by subtracting one. Run:

```bash
bash deploy/aws/mum/promote-ami.sh --rollback
bash deploy/aws/mum/promote-ami.sh --rollback --apply
AWS_PROFILE=ezil-admin AWS_REGION=ap-south-1 bash deploy/aws/os-staging/deploy.sh install "$app_tag"
AWS_PROFILE=ezil-admin AWS_REGION=ap-south-1 bash deploy/aws/os-staging/deploy.sh smoke
```

Rollback validates the prior lifecycle configuration using the same strict
allow-list and change-set mechanism, then restores only the three app-secret
fields. Rollbacks requiring IAM changes or resource replacement are also refused.
It first verifies the retained launch-template version's ImageId against the
journaled AMI, then checks it again just before lifecycle execution. Rollback
does not update foundation `HostAmiId`, switch the template's default version,
create another template version or delete any version. The lifecycle and app
explicitly pin the retained version, so foundation may still describe the newer
AMI afterward. Do not infer the active app deployment from the foundation alone.
A verified no-op can restore the app deployment without redeploying. The app is
deliberately pinned back to the retained **original previous** version. The script checks it
still exists. The lead must also verify its referenced Lambda versions and IAM
permissions remain usable before enabling new admissions; version existence
alone does not prove execution health.

For promotion, a failed synth or template validation leaves the journal and the
original config; the app secret remains unchanged. A later failed deploy leaves
the journal and edited local config. A failure after secret write can leave the target
deployment active, so inspect the failure stage and use the saved journal. Rollback
accepts the app secret already at either complete deployment, refuses a mixed/drifted
deployment, and refuses unrelated local config changes. If rollback's CloudFormation
change set is empty (e.g. promotion failed before changing the stack), AWS reports
the no-op as a failed change set. Rollback accepts only AWS's specific no-changes
reason with an empty change list; it skips execution and restores the app deployment.
Other change-set failures still stop the operation.

If the foundation update or read-back fails, lifecycle publication and the app
secret update stop, and the local config stays unchanged. Foundation may already
have created the new version: retain the evidence and use the journaled rollback
to restore the old deployment. The script never tries to undo this by deleting a
template version. A later attempt to promote an AMI already present in foundation
is refused; reconcile that partial promotion explicitly before retrying. All
foundation and lifecycle publishers must respect the common operator lock;
rechecks cannot exclude an external publisher that ignores it.

To resume inspection of a running/timed-out build without another bake:

```bash
aws --profile ezil-admin --region ap-south-1 --no-cli-pager imagebuilder get-image \
  --image-build-version-arn "$(cat /root/ezil-aws-mum/release/next/build-arn.txt)" --output json
```

If it becomes AVAILABLE after the script exited, the lead must verify the
regional AMI and record `ami-id.txt` before promotion. Do not delete the build
ARN and rerun rebuild to resume polling.

## Cost and validation limits

Each Image Builder bake runs a **t3a.large** in Mumbai, with the template's 30 GiB
gp3 root disk. EC2 runtime, EBS, AMI snapshot storage, retained old snapshots,
ECR image/layer storage, and S3 artifacts incur charges; applicable transfer and
logging charges can also apply. The poll timeout does not terminate the remote
builder. Infrastructure is configured to terminate the build instance on
failure. These scripts set no provider spending limits and perform no cleanup
of previous images or snapshots.

`tests/run.sh` uses fake `aws`, `docker`, `git`, `npm`, `npx`, `sleep` and `timeout`
on PATH, with synthetic data under `/tmp`. It covers dry-run sequencing,
parameter coverage, image identity, account/region guards, forbidden changes,
immutable recipes, explicit version replacements, synth/change-set allowlists,
inline/S3 template selection, delayed config persistence, polling outcomes,
promotion/rollback, strict lifecycle template/change-set allow-lists, private
synth directories, cross-checkout/operator locks, real concurrent app-secret
writers, killed-wrapper lock inheritance, and secret preservation and drift.
`tests/locking.py` uses real local processes and flock with synthetic data.
No live AWS, Docker,
Chromium, secret access, actual CDK synth or bake is covered by these tests;
those remain lead checks.

`python3 deploy/aws/mum/tests/synth-contract.py` is a separate optional offline
CDK check using only the repository example config and installed dependencies.
It synthesizes two isolated assemblies, validates the real promotion and rollback
IAM/environment/workflow/Version differences, checks exact change-set coverage,
and rejects unauthorized template and change-set mutations. It uses synthetic
references and does not validate the live Mumbai configuration or AWS responses.

## Rebase release tooling (contract v1, lane E increment)

The bake accepts a paired `--previous-desktop-image-ref` and
`--previous-desktop-image-id`. Supply the retained **promoted** source manifest
with `--previous-release` (default: `previous-rebase-release.json` in the release
directory). The source manifest must match the current app deployment tuple,
checked under the existing app-secret lock. A previous AMI build is insufficient.
A new component/recipe version is required to introduce the previous parameters.
Omitting the pair explicitly produces a bake without N−1; it does not inherit the
last build's previous parameters.

```bash
bash deploy/aws/mum/rebuild-ami.sh \
  --desktop-image "$NEW_DESKTOP_IMAGE" --source-sha "$REVIEWED_SHA" \
  --recipe-version "$NEW_RECIPE_VERSION" \
  --previous-desktop-image-ref "$PREVIOUS_DESKTOP_REF" \
  --previous-desktop-image-id "$PREVIOUS_LOWER_ID" \
  --previous-release "$PREVIOUS_RELEASE_MANIFEST" \
  --release-dir "$REBASE_RELEASE_DIR"
```

Review the dry run, then repeat with `--apply`. `bake-inputs.json` records the
resolved baked lower IDs, registry references, recipe version and full source
commit. In particular, a containerd index's selected child ID is recorded rather
than the original local index ID. The AMI validates distinct lower directories,
stored IDs, image configuration and installed package metadata. Equal IDs refuse
before extraction. The builder retains `previous-lower-image-digest` as bake
metadata; it never updates a computer's data-volume marker.

`rebase-release.schema.json` is the exact §10 JSON Schema. The companion Python
validator adds strict JSON parsing, calendar/time checks, namespace exclusions,
repository/workflow identity checks and semantic pair constraints. Both registry
manifest IDs and classic Docker config IDs are supported without assuming they
are equal.

The release phases are implemented and default to dry run. `plan` writes only a
local nonsecret plan. Every later mutation requires `--apply`. The legacy
`promote-ami.sh --ami` still refuses a rebase tuple; use `--manifest` instead.

Amendment A1's `rebase-source-release.schema.json` permits null preparation and
recovery versions in **source evidence only**. The target schema stays strict.
Promotion and rollback append/retain complete immutable release records under
`app-secret.lock`, preserve string/object encoding and other regions, and journal
both full deployment entries before writing. All records are retained, including
records referenced by placements or unfinished jobs. At eight records the tool
refuses a ninth; it never guesses whether a record can be collected. Duplicate
source digests refuse instead of making source resolution ambiguous.

For A3, a maintenance bake keeps the promoted lower ID, changes the reviewed
agent commit, clears both previous parameters, and records
`maintenance-source-release.json`. The selected commit must contain the
maintenance implementation. Containerd's resolved child ID is compared after
push; a different lower refuses before any AMI stack update.

```bash
bash deploy/aws/mum/rebuild-ami.sh --desktop-image "$CURRENT_DESKTOP_IMAGE" \
  --source-sha "$REVIEWED_SHA" --recipe-version "$NEW_RECIPE_VERSION" \
  --maintenance-release "$CURRENT_SOURCE_MANIFEST" --release-dir "$MAINTENANCE_RELEASE_DIR"
# Review, then repeat with --apply.
```

Maintenance plans/final manifests have `previous=null` and validate as full
source records, never rebase targets. `promote-canary` refuses a maintenance plan.
A same-digest maintenance record cannot replace a retained registry record.
The lead must resolve its source registration before using it for recovery;
retention and unique-source checks are intentionally not relaxed.

To plan an upgrade, supply the reviewed desired lifecycle/identity configs, the
independently observed preview PostgreSQL system ID, and a rollout review file.
The authority origin is fixed to `https://os-staging.ezil.work`; SQL is exactly
`docs/aws-computers/sql/0002_image_rebase.sql.txt`. A system ID must be observed
independently on the verified preview DB host, not learned through the connection
that this command is about to trust.

The lead first synthesizes, publishes assets and **stages, but does not execute**
three reviewed change sets. `rollout.json` has this closed shape (absolute file
paths and actual change-set ARNs replace the placeholders):

```json
{
  "schemaVersion": 1,
  "stacks": {
    "identity": {
      "stackName": "ezil-identity-mum",
      "changeSetArn": "arn:aws:cloudformation:ap-south-1:452630323510:changeSet/REVIEWED/UUID",
      "roleArn": null,
      "beforeTemplatePath": "/review/identity-before.json",
      "candidateTemplatePath": "/review/identity-candidate.json",
      "reviewPath": "/review/identity-review.json"
    },
    "foundation": {
      "stackName": "ezil-mum-foundation",
      "changeSetArn": "arn:aws:cloudformation:ap-south-1:452630323510:changeSet/REVIEWED/UUID",
      "roleArn": "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec",
      "beforeTemplatePath": "/review/foundation-before.json",
      "candidateTemplatePath": "/review/foundation-before.json",
      "reviewPath": "/review/foundation-review.json"
    },
    "workflows": {
      "stackName": "ezil-mum-lifecycle",
      "changeSetArn": "arn:aws:cloudformation:ap-south-1:452630323510:changeSet/REVIEWED/UUID",
      "roleArn": "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec",
      "beforeTemplatePath": "/review/lifecycle-before.json",
      "candidateTemplatePath": "/review/lifecycle-candidate.json",
      "reviewPath": "/review/lifecycle-review.json"
    }
  },
  "app": {
    "tag": "REVIEWED_IMMUTABLE_TAG",
    "gitSha": "FULL_REVIEWED_COMMIT_EQUAL_TO_AGENT_COMMIT",
    "checksumSha256": "SHA256_OF_THE_UPLOADED_TAG_SHA256_FILE"
  }
}
```

Each review file is `{ "schemaVersion": 1, "changes": { ... } }`. Its map names
**every and only** changed logical resource. Values are
`{"action":"Modify","properties":["PolicyDocument"],"attributes":[]}`;
property and attribute arrays are sorted. Add/Remove have empty arrays. The
foundation map is exactly `ComputerLaunchTemplate` / Modify /
`["LaunchTemplateData"]` / `[]`: it reuses its unchanged template and only changes
`HostAmiId`. All other parameter values and resolved SSM values are preserved.

The plan pins every review/template byte, config, SQL, bake/source record, and the
checked-in staging installer. The identity validator requires A2's dedicated
boundary, all shared global denies, and the 6144-byte limit; the shared boundary
can only gain DescribeSnapshots. Identity role-write conditions may admit the
new boundary alongside the existing one, with no other change. Workflow templates
must bind exactly the preparation and recovery execution roles to it. Existing
exports, conditions, storage/network resources and IAM denies remain fenced.
The lead must review the exact IAM/code deltas against the integrated BC source;
this operator does not replace BC's IAM/ASL security tests.

```bash
bash deploy/aws/mum/rebase-release.sh plan --release-dir "$REBASE_RELEASE_DIR" \
  --config "$REVIEWED_LIFECYCLE_CONFIG" --identity-config "$REVIEWED_IDENTITY_CONFIG" \
  --expect-system-id "$VERIFIED_PREVIEW_SYSTEM_ID" --rollout "$REVIEWED_ROLLOUT_JSON"
# For each command below: review its default dry run, then repeat with --apply.
bash deploy/aws/mum/rebase-release.sh apply-schema --plan "$REBASE_RELEASE_DIR/rebase-plan.json"
bash deploy/aws/mum/rebase-release.sh apply-identity --plan "$REBASE_RELEASE_DIR/rebase-plan.json"
bash deploy/aws/mum/rebase-release.sh apply-workflows --plan "$REBASE_RELEASE_DIR/rebase-plan.json"
bash deploy/aws/mum/rebase-release.sh finalize --plan "$REBASE_RELEASE_DIR/rebase-plan.json"
bash deploy/aws/mum/rebase-release.sh apply-app --manifest "$REBASE_RELEASE_DIR/rebase-release.json"
bash deploy/aws/mum/rebase-release.sh promote-canary --manifest "$REBASE_RELEASE_DIR/rebase-release.json"
# Equivalent promoter entry point:
bash deploy/aws/mum/promote-ami.sh --manifest "$REBASE_RELEASE_DIR/rebase-release.json"
# Rollback only after reviewing the retained promotion journal:
bash deploy/aws/mum/promote-ami.sh --rollback --manifest "$REBASE_RELEASE_DIR/rebase-release.json"
```

Schema application uses SSM on `i-014810524754b9ed0`, the existing
`ezil-main-preview-artifacts-452630323510-aps1/os-staging/images/` prefix and
`postgres:17-alpine`, matching `rw-sql.sh`. It validates host tags, restricts the DB
URL to `10.61.20.35:5432`, refuses btgq/curomaa and routing overrides, pins the system
ID inside the transaction, and enables error-stop. Catalog evidence before/after
covers columns, indexes, RLS, grants, constraints, defaults and triggers. An exact
existing installation is resumable; a partial/different schema refuses. Uploaded
operation payloads are removed after successful SSM completion. SQL never enters
a hosted migration runner.

Identity/workflow application verifies the exact submitted change-set template,
parameters, resolved SSM values, resource/property coverage and replacement
flags before executing its recorded ARN. It reconciles a lost execute result
against the same change set and live template. It does not recreate an uncertain
change set. Workflow completion additionally reads the foundation's pinned LT,
checks that launch data changed only in ImageId, and verifies all three retained
published Standard workflow versions. Finalization requires successful schema,
identity and workflow receipts before writing the immutable final manifest.

App installation embeds the existing `install-host.sh`, adds a checksum-marker
pin, verifies the running full commit, and holds the existing app-secret lock.
The app and agent must come from the same reviewed integrated commit. Promotion
rechecks live artifacts, CAS-checks the entire before/after tuple and secret
VersionId under that lock, restarts the pinned app, and checks its actual running
entry. Rollback restores the previous complete tuple and retains all registry
records; it changes no user-data volume or digest. Cloud resources/versions stay
retained, so rollback selects the source's published versions rather than
reverting IAM or deleting an AMI.

**Admission stays gated.** Cloud, app and promotion phases require the existing
`EZIL_AWS_KILL_SWITCH=1` in the app secret and verify it in the running app. No tool
opens it. After all readbacks and the running app entry agree, the lead reviews
canary policy/caps, performs the existing lock-protected gate change and app
refresh, then runs the computer canary below. Restore the gate before rollback.

Resume the failed phase using the same plan and directory. SSM journals precede
submission; an uncertain missing submission refuses until its command is found.
A known failed idempotent operation can retry and retains prior command IDs.
Successful app installs are followed by fresh running-app inspection. Keep all
phase journals after partial rollout. Provider errors and secret payloads are
suppressed; only nonsecret receipts are persisted. Offline doubles do not prove
live IAM effectiveness, PostgreSQL execution, Docker, or canary health.

The computer interface uses the existing
`EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET` environment value in memory, signs the exact
§3 path/body with the existing HMAC scheme, and never reads credential files.
AWS account/region and the HTTPS staging origin are fixed; other origins,
including btgq/curomaa, refuse. `plan` and `verify` are read/reconcile operations.
`prepare`, `launch` and `recover` print a dry run unless `--apply` is present.

```bash
bash deploy/aws/mum/rebase-computer.sh plan --computer "$CANARY_COMPUTER_ID"
bash deploy/aws/mum/rebase-computer.sh prepare --computer "$CANARY_COMPUTER_ID"
bash deploy/aws/mum/rebase-computer.sh prepare --computer "$CANARY_COMPUTER_ID" --apply
bash deploy/aws/mum/rebase-computer.sh launch --computer "$CANARY_COMPUTER_ID"
bash deploy/aws/mum/rebase-computer.sh launch --computer "$CANARY_COMPUTER_ID" --apply
bash deploy/aws/mum/rebase-computer.sh verify --computer "$CANARY_COMPUTER_ID"
# Only after reconciling failed-writer/marker/access history:
bash deploy/aws/mum/rebase-computer.sh recover --job "$FAILED_REBASE_JOB_ID"
bash deploy/aws/mum/rebase-computer.sh recover --job "$FAILED_REBASE_JOB_ID" --apply
```

Journals default to `/root/ezil-aws-mum/rebase-computers/<computer-or-job>.json`;
`--journal` selects another absolute private artifact path. Keep that journal
across retries. The pending request is durably written before mutation, and a
lost unbound prepare result requires a successful server plan reconciliation
before another prepare can be sent. Repeated work uses the recorded job ID.
Launch needs the preparation journal or an explicit `--job`; recover always
needs the failed job. Terminal journals never silently create a new image job.
No command automatically rebases a fleet or restores a volume.

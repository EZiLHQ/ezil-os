# Mumbai host AMI rebuild and lifecycle promotion

These operator scripts default to **dry-run**. They always pin AWS profile
`ezil-admin`, region `ap-south-1`, and account `452630323510`. Dry-run reads AWS
identity/stack/version metadata and, for rebuild, the local Docker image. It
prints proposed writes without logging in to ECR, pushing, uploading, changing
the real configuration, creating a change set, or fetching the app secret.
With `--recipe-version`, rebuild also writes a temporary candidate config and
runs the offline AMI synth. Temporary files are removed on exit. Run locally
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
lookups and telemetry. Rebuild invokes it with an isolated assembly directory:

```bash
EZIL_AMI_CONFIG="$work/ami.mum.json" npm --prefix "$repo_root/infra/app-computers" \
  run synth:ami -- ezil-mum-ami --output "$work/cdk.out"
```

Here `$work` is the script's private temporary directory, and the final
`--output` overrides the package script's default `cdk.out/ami`. The resulting
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
| Lifecycle stack | `ezil-mum-lifecycle` |
| ECR repository | `452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6` |
| Asset bucket | `ezil-mum-deploy-assets-452630323510` |
| CloudFormation role | `arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec` |
| AMI config | `/root/ezil-aws-mum/config/ami.mum.json` |
| Lifecycle config | `/root/ezil-aws-mum/config/lifecycle.mum.json` |
| Release evidence | `/root/ezil-aws-mum/release/next/` |
| App secret | `ezil-os/billing-staging/app` |

The role ARN follows `identityNames()` in
`infra/app-computers/lib/identity.ts`, including `/ezil/identity/`.
`--config` (either script) and `--release-dir` accept alternate local paths for
isolated tests or an explicitly selected release. They do not change AWS targets.
There are no new environment variables or secret names. Keep a single operator
and a shared release directory; its lock serializes local applies. Also exclude
independent lifecycle publishers and app secret writers during promotion.

Rebuild resolves the source to a full commit, inspects the local image, tags its
immutable image ID as `host-<sha12>-<UTC YYYYMMDDhhmmss>`, and pushes it. ECR's
schema-2/OCI manifest digest pins the image; `manifest.config.digest` must equal
the local Docker image ID. Image indexes are refused. Temporary Docker login
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
   for script in deploy/aws/mum/*.sh deploy/aws/mum/tests/*.sh; do bash -n "$script"; done
   npm --prefix infra/app-computers ci
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

   Promotion obtains the maximum published version number (not the locally
   configured number) and proposes `N+1`. It saves `promotion.json` containing
   the previous and target non-secret configs before editing the config. It
   runs the documented `npm run synth:lifecycle`, `cdk publish-assets`, S3
   template upload, and CloudFormation UPDATE change-set workflow through the
   execution role. It refuses replacement/removal of durable lifecycle resources,
   rechecks version publication before execution, and requires the deployed
   `WorkflowVersionArn` to match the predicted published version.

   Only then does it update the app secret. The JSON transformation changes only
   `EZIL_AWS_LIFECYCLE_DEPLOYMENTS["ap-south-1"].amiId` and
   `.stateMachineVersionArn`. String-encoded and object-encoded deployment maps
   retain their encoding type; the deployed app renderer expects the existing
   string encoding. Other regions, deployment fields and outer secret keys are
   preserved. Payloads stay in memory, go to AWS via stdin, and are never put in
   logs, argv, journals or files. Read-back verifies the result. AWS has no
   compare-and-swap for `PutSecretValue`; a VersionId recheck reduces but cannot
   eliminate races with independent writers. Serialize them operationally.

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
   lifecycle execution version match the promoted pair. Existing computers do
   not acquire the new AMI automatically. The staging deploy runbook documents
   any health-route limitations affecting `smoke`; do not treat that as AMI proof.

## Rollback and partial failures

Keep `release/next/previous-ami-config.json` (the old recipe version),
`candidate-ami-config.json`, both templates, `promotion.json`, and all old AMIs,
snapshots, lifecycle versions
and referenced Lambda versions until canaries and rollback checks finish. After
success, archive the entire release directory before starting a new promotion;
an existing journal is deliberately not overwritten. Keep the default directory
in place while either script holds its lock.

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
rebuild. Config and stack writers using different release directories are not
serialized by the local release lock; exclude them operationally.

The existing `promote-ami.sh --rollback` behavior is unchanged.
Rollback restores the **previous configured/published pair**, even when that
version was older than the maximum published version at promotion. It never
computes rollback by subtracting one. Run:

```bash
bash deploy/aws/mum/promote-ami.sh --rollback
bash deploy/aws/mum/promote-ami.sh --rollback --apply
AWS_PROFILE=ezil-admin AWS_REGION=ap-south-1 bash deploy/aws/os-staging/deploy.sh install "$app_tag"
AWS_PROFILE=ezil-admin AWS_REGION=ap-south-1 bash deploy/aws/os-staging/deploy.sh smoke
```

Rollback deploys the prior lifecycle configuration using the same change-set
mechanism, then restores only the two app-secret fields. CloudFormation may
publish another version while restoring the stack; the app is deliberately
pinned back to the retained **original previous** version. The script checks it
still exists. The lead must also verify its referenced Lambda versions and IAM
permissions remain usable before enabling new admissions; version existence
alone does not prove execution health.

For promotion, a failed synth/deploy leaves the journal and the edited local
config; the app secret remains unchanged. A failure after secret write can leave the target
pair active, so inspect the failure stage and use the saved journal. Rollback
accepts the app secret already at either complete pair, refuses a mixed/drifted
pair, and refuses unrelated local config changes. If rollback's CloudFormation
change set is empty (e.g. promotion failed before changing the stack), AWS reports
the no-op as a failed change set. Rollback accepts only AWS's specific no-changes
reason with an empty change list; it skips execution and restores the app pair.
Other change-set failures still stop the operation.

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
promotion/rollback, and secret preservation and drift. No live AWS, Docker,
Chromium, secret access, actual CDK synth or bake is covered by these tests;
those remain lead checks.

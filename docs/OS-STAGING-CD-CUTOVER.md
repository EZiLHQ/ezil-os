# OS staging delivery cutover — review packet

This patch retires the stale **staging** deployment path in `preview.yml`.
It does not activate AWS delivery, change production, disconnect a Vercel project,
change DNS, merge reviewed feature stacks, or replace OAuth providers.

## Effective old and intended bindings

| Binding | Observed source and destination |
| --- | --- |
| OS legacy GitHub CD | `EZiLHQ/ezil-os`, active `.github/workflows/preview.yml`, job `preview`, environment `staging`, push/manual invocation on `refs/heads/preview` |
| Exact legacy source | `167974774d38c1b805c02181a0816da0e8a01ced`; latest staging run [39509151648/job118929573380](https://github.com/EZiLHQ/ezil-os/actions/runs/39509151648/job/118929573380), 20 October 2026; GitHub deployment `7212892164` |
| Executed Vercel artifact | Evidence artifact `12305398130`: deployment `dpl_8Nh2LTbKLXeNwwCpzr14v6xMYnNx`, URL `https://ezil-igcfyooef-ezil1.vercel.app`; workflow assigns `ezil-os-staging.vercel.app` |
| Project selection | `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` secret bindings, `rootDirectory=app`, CLI upload from repository root. Secret values were not read. `app/vercel.json` already has `git.deploymentEnabled=false`. |
| Current AWS app | `https://os-staging.ezil.work`, EC2/Compose instance `i-014810524754b9ed0`, account `452630323510`, region `ap-south-1`, VPC `vpc-0f6bc19fdfd4209aa`; public health still reports app `293ac34d116ce50473c8464663b8786ef39f46f1` |
| AWS assets | `s3://ezil-main-preview-artifacts-452630323510-aps1/os-staging/images/`; fixed installer must admit only this host/account/region/bucket |
| AWS source graph | Reviewed [PR269](https://github.com/EZiLHQ/ezil-os/pull/269), frozen `c6c01536bfeeb339baab6b3e78de6f62258b9ddf` on S `7fcc76d4`; reusable release/delivery workflows and offline activation source generator; currently disabled with authority/config pins null |

The Vercel connector's visible team `team_HSmDkjUZTQAzFrAb2FfJ6Y94`
contains project `prj_fMwCVizVsIrE9SVeJtrnSnxoBWWJ` (`ezil-os`) and a different
older CLI deployment. It does **not** establish the historical workflow's secret
project binding. The legacy alias read returned 404, including one retry with the
verified visible team; its current alias/project state is unresolved in that
scope. No extra Vercel access was requested and no integration was disconnected.
The executed GitHub artifact above establishes the old deployment independently.

Works was inspected read-only: `EZiLHQ/ezil-work`, remote main
`448cc1e45a019278f9d009cbdd6524cb5cf28975`, active `works.yml`, job `deploy`,
requires successful checks and a non-draft same-repository PR. On its private
runner/environment `preview`, `tools/ci-runtime-release.mjs` deploys Vercel API
and web projects (separate API/web project secret bindings), then assigns
`works-api-preview.ezil.work` and `works-preview.ezil.work`. Those aliases are
separate from the owner's AWS `api-staging.ezil.work` at `0b26311c`. Current PR
runs being skipped does not remove that configured CD path. Works owners retain
its cutover and feature work; this patch changes no Works file. Gateway remains
Cloudflare Workers/Wrangler. A Vercel integration check is not runtime-host proof.
OAuth/Auth0 scope belongs to the current identity owners; delivery retirement
neither migrates nor relabels hosted Supabase authentication.

## Narrow source change and integration boundary

The old `preview` job is explicitly unreachable (`false && ...`) before any
checkout, environment credential, lease, Vercel or Worker operation. Its audited
body stays present for review and rollback. Preview can no longer request the
image-build job. A separate credential-free `staging-retired` job exits with an
error and identifies the AWS target; the old workflow cannot pretend it deployed
staging successfully. Tests exercise push/manual events, main/preview/tag/feature
refs, image-change flags and cancellation, retaining production behavior.

The complete `production` job is byte-preserved from the exact preview base
(SHA256 `a612bcb0c488e0c7492c3a0eedf8c7789f969746626553a05f00d8cb1e5a3af8`).
Global triggers, permissions, concurrency and image inputs are unchanged. All
other workflow/source files and provider/DNS settings remain unchanged.

This retirement-only branch deliberately targets the **active legacy preview
ref**. It is not a new AWS release source, and imports no S/application history.
cb1 must review/integrate this retirement patch into that ref before the old path
is actually disabled remotely. The same disjoint retirement hunk can be reviewed
for a later S successor; do not merge stale preview wholesale into S or main.

cb1's 18:15Z source-compatibility ACK for PR269 remains conditional: zero overlap
with S's 30 component files or PR268, clean composed tree `4954d6c2…`, but
**PR268/269 stay outside frozen AMI32→33**. Successor S′ composition is after that
chain or an explicitly approved rebake. Existing S-built app assets were uploaded
with matching S tooling at 19:00Z; the new uploader requires a source receipt, so
use matching S tooling or rebuild. Preserve explicit legacy install/rollback.
No app install, AMI change, rebake or new composed candidate is implied here.

## Smallest dependent activation approval packet

All items below are **proposed, not executed or authorized by this document**.
They apply only to staging in account `452630323510`; production/DNS remain held.
Current metadata: no self-owned SSM document exists in ap-south-1. The proven
GitHub role `ezil-os-staging-lease` has only GetItem/PutItem/DeleteItem on
`arn:aws:dynamodb:us-east-1:452630323510:table/ezil-ci-staging`, with no attached
policies. It is not an app deployer. The staging environment has no reviewers or
branch policy. Existing operator `ezil-admin` access is not transferable to GitHub.

1. **Source/timing decision:** cb1 chooses the reviewed successor source and
   integration window without disturbing AMI32→33. Recommended durable ref is
   `refs/heads/os-staging`; it is not created or selected by this patch. Preserve
   existing `staging/...`. Render/review PR269's activation source for that chosen
   ref: real push CI/CodeQL/DCO and mapped checkout evidence plus entry caller.
   Keep unrelated app/shell failures visible; PR269's final CI had 8 passing jobs,
   app69 and shell42/43 baseline failures, while DCO/CodeQL/provenance passed.
2. **New narrow delivery role:** approve creating
   `arn:aws:iam::452630323510:role/ezil-os-staging-app-delivery` with the following
   trust, then attaching the exact policy below. These are new persistent-access
   actions. No new OIDC provider/static secret, administrator grant, PassRole,
   production access or expansion of the existing lease role is proposed.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::452630323510:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:EZiLHQ@315435740/ezil-os@1339112799:environment:staging"
        }
      }
    }
  ]
}
```

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UploadOnlyStagingArtifacts",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::ezil-main-preview-artifacts-452630323510-aps1/os-staging/images/*"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "ap-south-1"
        }
      }
    },
    {
      "Sid": "DescribePinnedTarget",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances"
      ],
      "Resource": [
        "*"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "ap-south-1"
        }
      }
    },
    {
      "Sid": "ReadExactInstaller",
      "Effect": "Allow",
      "Action": [
        "ssm:GetDocument",
        "ssm:DescribeDocument"
      ],
      "Resource": [
        "arn:aws:ssm:ap-south-1:452630323510:document/EZiL-OS-Staging-InstallVerified-v1"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "ap-south-1"
        }
      }
    },
    {
      "Sid": "InvokeExactInstallerAndHost",
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand"
      ],
      "Resource": [
        "arn:aws:ssm:ap-south-1:452630323510:document/EZiL-OS-Staging-InstallVerified-v1",
        "arn:aws:ec2:ap-south-1:452630323510:instance/i-014810524754b9ed0"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "ap-south-1"
        }
      }
    },
    {
      "Sid": "ReadCommandOutcome",
      "Effect": "Allow",
      "Action": [
        "ssm:GetCommandInvocation"
      ],
      "Resource": [
        "*"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "ap-south-1"
        }
      }
    },
    {
      "Sid": "ReadOnlySharedStagingLease",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:452630323510:table/ezil-ci-staging"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "us-east-1"
        },
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": [
            "shared-staging"
          ]
        },
        "Null": {
          "dynamodb:LeadingKeys": "false"
        }
      }
    }
  ]
}
```

The actions cover immutable staging S3 writes, exact target/document validation,
fixed document invocation/readback, and **GetItem only** on the shared-staging
lease key. Delivery credentials receive no lease Put/Delete permission. The
host's existing GetObject authority already covers source receipts.

3. **Fixed installer document:** separately approve creating
   `EZiL-OS-Staging-InstallVerified-v1` in ap-south-1 from PR269's exact rendered
   document: canonical SHA256
   `764f539b45ce1fc84eee868e6c42dbe78f5c9d359803cc8f6e3706cb126d48e5`, reviewed
   artifact `13439848784`. Pin the actual numeric version and service hash after
   readback. No AWS-RunShellScript grant or caller shell/URL parameter. The source
   document checks IMDSv2 host/account/region before installer mutation.
4. **GitHub staging admission/config:** separately approve the chosen branch
   restriction and exact independent reviewer IDs for environment `staging`.
   Reviewer IDs remain an owner decision. Pin the approved public Supabase URL
   and anon-key fingerprint from known staging settings without disclosing key
   values; a hostname/SHA alone is not browser-backend acceptance. Existing
   GitHub/CF/host credentials are retained. No secrets/variables were changed.
   The 13-context proposal and workflow/job mapping are in PR269; if branch rules
   are needed, review a **staging-only** ruleset with exact coverage. Do not alter
   production/default-branch ruleset `22265548` during this staging cutover.
5. **Bounded run:** after those approvals and cb1's release plan/lease, authorize
   one exact candidate build and fixed-document install, then actual AWS app and
   independently pinned CF acceptance. PR269 bounds the build at 45 minutes and
   install job at 25 minutes; shared lease is 2100 seconds with >1020 seconds
   remaining before submission. No new EC2/AMI/CodeBuild/paid-model service is
   required. This public repository uses standard GitHub-hosted Ubuntu runners;
   no paid runner is proposed. Incremental AWS costs are artifact storage/writes
   and existing-host usage: the current app/runtime pair is about 361.4 MB;
   estimate roughly $0.01/month per retained pair plus four S3 PUTs at regional
   rates, excluding existing host charges. Size/cost and retention need readback
   before any extra build commitment; no new build or deployment was performed.

## Rollback and failure handling

Before activation, rollback is simply withholding integration/activation; no
runtime state has changed. Re-enabling old Vercel CD would itself require an
explicit staging decision, not an automatic fallback. If a newly created role or
document must be withdrawn, first disable the AWS entry path, verify no command
is in flight, then revoke only the new role policy/trust and document version
with separate approval; do not alter existing lease/host/provider identities.

After submitted installation, failure may already have replaced the app or
stopped timers. Do not claim nonmutating refusal or automatic rollback. Keep the
recorded candidate/previous recovery pins and retain the lease without DeleteItem
until its original expiry. cb1 must inspect/recover before normal leasing resumes
after TTL, restore the approved app/runtime pair if needed, verify health/source,
and restore the observed timer set. Legacy rollback remains an explicit owner
operation. No production promotion is authorized until user staging acceptance
and a separate production approval.

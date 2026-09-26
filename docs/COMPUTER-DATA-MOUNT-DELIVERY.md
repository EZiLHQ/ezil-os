# Trusted data-mount delivery

The host can receive an approved data-mount plan before configuration/image
preparation. The receiver verifies an independent root-owned authorization and
provisioning record, downloads exact immutable bytes, mounts the identified
disk, and returns a scoped receipt. It does not start the supervisor, Docker
containers or EC2 instances.

This is a disabled host-side building block. The control-plane issuer, durable
authorization ledger, SSM delivery workflow and reviewed AMI provisioning are
not wired to it yet. No production launch should call this receiver until those
pieces exist. Local VM results do not establish AWS attachment, IAM, SSM,
encryption or stopped-compute behavior.

## Independent authority

The trusted controller must provision two protected regular root-owned files:

- `/etc/ezil-supervisor/provisioning.json`: existing v1 computer, generation,
  fence token, instance, volume, account/region and S3/KMS scope.
- `/etc/ezil-supervisor/data-mount-authorization.json`: strict v1
  `authorizationId`, the same `scope`, `filesystemUuid`, `mode`, plan `digest`,
  and Unix-second `issuedAt`/`expiresAt`. Lifetime is at most 900 seconds.

The authorization cannot be supplied by the delivery request, application or
publisher. Its issuer must read the durable filesystem identity, verify current
ownership/admission/cancellation state and provider-observed disk/writer scope,
and explicitly distinguish a newly allocated disk from a retained one. A UUID
reservation is not formatting authority. An existing/imported disk with unknown
UUID cannot be initialized as a way to discover its identity. Replacement
writers get **mount** authority only. The prior writer must first be fenced and
observed detached by the lifecycle controller.

No existing HostConfig or lifecycle intent bytes change. The new authorization
is a separate record; overwriting old immutable documents is not a migration.
Issuing or renewing authority must be durable, attributable and rechecked by the
future workflow before dispatch. Copying an earlier writer's authorization to
a replacement instance fails identity checks and is not a recovery procedure.

## Delivery order

1. The controller stores canonical `DataMountPlan` JSON in the private versioned,
   KMS-encrypted bucket at
   `<namespace>/computers/<computerId>/generations/<generation>/data-mounts/<authorizationId>.json`.
2. Trusted root provisioning invokes
   `node /opt/ezil-supervisor/dist/data-mount-receiver.js` with a bounded JSON
   request on stdin: `schemaVersion: 1`, `authorizationId`, `scope`, `digest`
   and the exact `object` reference (`bucket`, `key`, `versionId`, `sha256`,
   `bytes`). There are no CLI path, endpoint, shell or test-bypass options.
3. The receiver checks both independent root files, actual IMDSv2 identity,
   bucket owner, exact version/checksum/length/KMS, canonical plan bytes, volume,
   filesystem UUID and authorized mode. It never fetches registry credentials.
4. It creates `/etc/ezil-supervisor/data-volume.json` with **mount-only** mode.
   An existing file must have the identical identity and mount-only mode;
   conflicting, malformed or unsafe files are not overwritten.
5. It mounts using a private temporary plan. Initialization authority exists only
   for this bounded invocation. The existing helper rechecks inventory and
   authority before effects, fully scans new media, fsyncs an attempt journal
   before `mkfs`, and never retries an ambiguous formatting attempt.
6. Only a successful scoped `mounted` receipt allows the caller to proceed to
   existing configuration preparation. That preparation still independently
   verifies the mount. App readiness requires subsequent host and serving-path
   checks; a mount receipt is not app readiness.

Expired, replaced or cancelled authority interrupts delivery. An in-flight
kernel operation may already have taken effect, so failure does not assert that
the disk is unchanged. The attempt journal is retained and no receipt reports
success. Normal reboot uses only the persisted mount-only plan and the shipped
`ezil-data-mount.service`; it does not download or format. Missing markers,
partial plans, wrong UUIDs and uncertain attempts fail closed for inspection.
Do not clear a real attempt journal to retry formatting.

## Local verification

Run `bash tools/test.sh supervisor` and `bash tools/test.sh tools`. The unit
suite covers strict authority, scope, lifetime, path/version/content integrity
and redacted errors, including installed symlink entrypoints.

For actual block-device acceptance, use a disposable QEMU Linux VM with its own
50 GiB NVMe fixture, fixed serial `vol11111111111111111`, a separate root disk,
Node 24 and Docker. Never run this against EC2, a shared Docker daemon or a
valuable disk. The test checks VM, root ownership, fixed identities, absence of
foreign provisioning and an empty Docker instance before altering fixtures.

```sh
# Fresh blank fixture; existing root fixture contains only its mount-only plan.
bash tools/test.sh supervisor --linux-mount-delivery initialize
# Actually reboot the VM, then:
bash tools/test.sh supervisor --linux-mount-delivery verify

# In another disposable root with the retained data fixture:
bash tools/test.sh supervisor --linux-mount-delivery retained
```

The acceptance uses local IMDS/S3 transport fixtures with actual SDK requests,
real root files/locks, ext4 mounting, configuration preparation and systemd.
It verifies identity/content denial, revocation before formatting, preserved
attempt ambiguity, retries, cancellation, mount-only reboot, `.git`, renames,
deletions and committed SQLite state. It starts no application containers and
is not Reticle acceptance. The runtime target remains Linux/amd64; an ARM64
local VM validates host behavior without establishing EC2 image compatibility.

Rollback removes the unused receiver from the next host release. Keep retained
disks, attempt journals and valid mount-only plans. No schema, feature flag,
provider configuration or hosted database change is part of this stage.

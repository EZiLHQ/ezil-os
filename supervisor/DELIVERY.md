# Trusted computer configuration delivery

The host configuration source implements the AWS side of the control plane's
immutable configuration-reference contract. It is not enabled by a public API
or a login. A controller must first authorize the current computer, writer,
release, installation, selected folders and requested operation.

The root-owned provisioning record contains `schemaVersion: 1`, the complete
writer `scope` (computer UUID, generation, EC2 instance ID, data-volume ID and
fence UUID), account ID, `us-east-1`, namespace, private bucket and KMS key ARN.
This record is independent of SSM input and publisher manifests. Provisioning
must bind it to the observed instance and fenced data volume; this module does
not create the record or allocate its identities.

The delivery reference matches the control-plane AWS transport: version 1,
`prepare` or `reload`, immutable configuration UUID, scope, revision, digest,
and an object reference with bucket, key, S3 version ID, SHA-256 and byte count.
Only the exact provisioned namespace/computer/generation key is accepted.
Mutable/null versions, cross-computer/fence references and arbitrary commands
are rejected. Configuration parsing requires canonical bytes and explicit host
defaults, matching scope/revision/digest, the fixed production directory/port/
memory layout and images in the provisioned account's ECR registry.

The host obtains an IMDSv2 token from the fixed `169.254.169.254` endpoint,
verifies account, region and instance ID, and retrieves only that instance's
temporary role credentials. A dedicated HTTP agent ignores proxy, profile and
metadata endpoint environment overrides. Responses have deadlines and size
limits. Redirects, v1 fallback, stale credential extension and stored keys are
not supported. Installed app networks must independently block metadata access.

The S3 SDK request names the exact object version and expected account owner.
Reads require the approved KMS key, SHA-256, exact length and bounded streamed
bytes. Registry authentication calls ECR for the same account and accepts only
its HTTPS endpoint and a token valid for the preparation deadline. The caller
must keep the password in protected host memory/files, remove it after use,
and never put it in workflow input, command-line arguments or logs.

The scoped host role must permit only its configuration versions/prefix,
required KMS decrypt context and approved ECR repository pulls. The existing
shared foundation role alone does not provide those restrictions. Host
credentials and signing keys must not enter application containers.

Tests use actual local HTTP for the metadata exchange and the real AWS SDK
serializer, signer and response decoder with a local request handler. They
verify malformed references, identity mismatches, redirects, expiration,
cancellation, wrong versions/encryption/bytes and cross-registry rejection.
These fixtures do not establish AWS identity, IAM enforcement, EBS readiness,
SSM dispatch, actual ECR authorization or production application availability.

Run `bash tools/test.sh supervisor` for typecheck, tests and the production
Node build. The receiver, protected-file installation/reload, service packaging
and the Standard/SSM controller workflow are separate integration steps.

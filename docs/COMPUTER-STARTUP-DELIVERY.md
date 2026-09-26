# Computer startup delivery

`dispatchNextComputerStart` consumes the startup outbox created by
`issueComputerStart`. It leases one pending authorization and passes immutable
DB-derived work to `createAwsComputerStartTransport`. Configuration preparation,
host startup, configuration acknowledgement and application readiness remain
separate operations. Only an exact historical host receipt records startup.

Each claim has an attempt number and a bounded lease. A retry or replacement
worker keeps the authorization ID and its original five-minute deadline. Live
user/app authority, the prepared configuration, accepted disk mount, writer and
key policy are checked before dispatch and settlement. Revoked grants, changed
scope and expired leases cannot settle late receipts. No check reserves a new
key or issues replacement startup authority.

The AWS adapter reads the existing, versioned configuration object at the
computer/generation/configuration-derived key. It checks ownership, KMS,
content type, byte length, checksum and digest before constructing the exact
host preparation reference. A missing object is not recreated. A changed object
version conflicts with an existing execution and with the host's saved prepared
reference; matching bytes alone do not authorize replacing that reference.

Startup uses one version-pinned Standard execution named from the authorization
UUID. Retries observe its exact input, workflow version, start time and receipt.
Express workflows, aliases, redrives, expired grants and mismatched output fail.
Requests use explicit temporary credentials, fixed service endpoints, bounded
cancellation and no automatic retries. The adapter never receives key bytes or
starts EC2 instances; it submits a supervisor-start workflow for an existing writer.

The approved workflow still needs implementation and deployment. It must:

- Authenticate to the startup authority endpoint against the same immutable work
  immediately before host effects, then independently verify EC2/EBS identity,
  ownership, attachment and running state. Database state alone is insufficient.
- Supply the existing root-only receiver with its exact prepared configuration
  reference, mount authorization, control domain, secret version and original
  DB-issued deadline. Never give the host or a publisher authority to issue grants.
- Observe the exact supervisor startup receipt. On revocation, cancellation,
  timeout or ambiguous dispatch, reconcile/stop and observe the host as required;
  a stale database consumer result does not prove host effects were undone.
- Keep configuration reload separate. Do not delete attempt history, renew an
  expired grant or silently retry a consumed host-start allowance.

No scheduler, credentials or feature flag is activated by these modules.
Apply reviewed migration 0012 before deploying consumers. Activation requires
the configured authority endpoint, protected SSM delivery, reconciler and
approved AWS pilot, with the end-to-end Reticle/browser acceptance still pending.

Run `bash tools/test.sh app` and, against a disposable loopback Postgres instance,
`bun run test:db:start-delivery` from `app/`. SDK fixtures exercise real request
serialization and streams; DB tests exercise real locks and transactions. They
do not establish AWS permissions, host execution, application readiness or billing.

## Signed current-authority endpoint

`POST /api/internal/computers/start-authority` accepts the strict
`ComputerStartWork` body. It invokes `authorizeComputerStart` with the operator's
configured control-key policy and deployment allowlist, never a request-selected
policy. A successful response is `{ authorized: true, work }`. It is a
point-in-time check, not new authority or proof that the supervisor started.
Replays repeat current database checks, including owner access, configuration,
mount, key, writer, expiry, revocation and unsettled delivery. No AWS call, key
creation, startup grant issuance or host start occurs in this handler.

The endpoint defaults off. Before enabling it, apply reviewed migration 0012 and
configure these server-only settings:

- `EZIL_START_AUTHORITY_ENABLED=true`.
- `EZIL_START_AUTHORITY_SECRET`: an independently generated 32-byte key encoded
  as 64 lowercase hexadecimal characters, distinct from the lifecycle, mount
  and configuration signing keys. Store the same key in the approved workflow's
  secret store; do not place it in workflow inputs or browser data.
- `EZIL_START_CONTROL_KEY_POLICY`: strict JSON containing `accountId`,
  `region` (`us-east-1`), `namespace`, `controlDomain` and `kmsKeyArn`, matching
  the issuer's approved policy. Domain ownership, KMS and IAM access need actual
  deployment verification; syntax validation does not establish them.
- `EZIL_LIFECYCLE_DEPLOYMENTS`: reviewed deployment approvals. At least one must
  match the policy's account, region and namespace; both exact and per-writer
  approvals are supported. Every request still has to match the full current
  server-recorded deployment.

Set `x-ezil-workflow-timestamp` to a ten-digit Unix timestamp within 30 seconds
of the server clock. Set `x-ezil-workflow-signature` to the lowercase hexadecimal
HMAC-SHA256 using the decoded key, over these newline-separated UTF-8 fields
(no trailing newline):

```text
ezil-start-authority-v1
POST
/api/internal/computers/start-authority
<timestamp header>
<lowercase hexadecimal SHA-256 of exact request body bytes>
```

Use HTTPS and `Content-Type: application/json` (optional UTF-8 charset). Query
strings, encoded bodies, other paths and user cookies/bearers do not grant
access. The handler bounds the body to 16 KiB, body reading to five seconds and
authorization waiting to fifteen seconds. Late answers cannot produce success.
Responses use `Cache-Control: no-store`, set no cookies and contain fixed error
codes without request, credential or database details. Disable the flag to deny
new checks; workflows must separately reconcile any already dispatched effects.

HTTP tests cover signature binding, replay, input limits, cancellation, deadlines
and redaction. Route tests check operator-policy wiring; the real PostgreSQL
delivery suite exercises signed checks and denial after authority changes.

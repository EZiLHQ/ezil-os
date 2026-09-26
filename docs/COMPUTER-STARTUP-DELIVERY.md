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

- Authenticate and call `authorizeComputerStart` against the same immutable work
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

No route, scheduler, credentials or feature flag is activated by these modules.
Apply reviewed migration 0012 before deploying consumers. Activation requires
the authenticated authority endpoint, protected SSM delivery, reconciler and
approved AWS pilot, with the end-to-end Reticle/browser acceptance still pending.

Run `bash tools/test.sh app` and, against a disposable loopback Postgres instance,
`bun run test:db:start-delivery` from `app/`. SDK fixtures exercise real request
serialization and streams; DB tests exercise real locks and transactions. They
do not establish AWS permissions, host execution, application readiness or billing.

# Computer startup issuer

`issueComputerStart` is a trusted internal producer. It accepts only the computer,
prepared configuration and completed mount authorization IDs. It returns a durable
startup authorization reference with its original five-minute expiry, or an explicit
disabled, denied, unconfirmed or recovery-required result. It does not start a host,
deliver a credential, complete installation or establish application readiness.

Apply reviewed migration `0012_computer_start_authority` before deploying this
consumer. No public route, scheduler or activation flag is introduced here.
Operator wiring must supply current lifecycle approvals, OS access policy and
`createAwsComputerControlKeys` with explicitly federated temporary credentials and
approved account, namespace, control domain and KMS key. The lifecycle transport
is always called with `allowStart=false`; observation cannot start missing compute.

The issuer recompiles live user/application authority and checks the exact writer,
prepared configuration and accepted mount before and after external I/O. Completed
mounts remain valid after their execution deadline; a subsequent computer restart
needs its own completed mount. AWS observations must still be recent after key I/O.
Provider/key calls run outside database locks and have bounded cancellation.

Each writer generation reserves one immutable Secrets Manager version. A committed,
one-time attempt marker precedes the only allowed creation call. Concurrent workers
and retries can only observe that version. Verification checks metadata, KMS, tags,
full scope, origin, ARN and `AWSCURRENT` content independently of a creation response.
No key bytes leave the transport or enter Postgres, audit, workflow input or logs.

An absent key after an attempted creation requires reconciliation. Do not clear the
attempt, call creation again, rotate the generation's key or renew an expired grant.
Re-observation may recover a delayed/lost response. Conflicting or expired grants
require explicit reconciliation before a replacement grant. The issuer cannot decide
that a prior host attempt had no effects; delivery/recovery must observe actual state.

Confirmation, startup grant, delivery enqueue and one attributable audit event commit
atomically. Retried issuance preserves the existing authorization and deadline. A
historical startup receipt will still require a separate live readiness check.

Validation:

```sh
bash tools/test.sh app
cd app
EZIL_TEST_DATABASE_URL='<local disposable PostgreSQL admin URL>' bun run test:db:start-issuer
```

The database helper rejects remote URLs and creates/drops a unique test database.
Tests exercise real Postgres locks, races, rollback, access revocation and restart;
SDK tests serialize/sign requests through a local handler. Neither establishes AWS
IAM, networking, mounted-disk durability, production typing or Reticle functionality.
The remaining integration is protected startup delivery, host-side reauthorization,
lease-fenced settlement, failure reconciliation and bounded scheduling.

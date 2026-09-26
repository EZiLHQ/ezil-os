# Control-key delivery and first start

`dist/control-bootstrap.js` is a root-only host receiver. It supplies the missing
first-start operation; configuration delivery continues to reload only an active
supervisor. This code is not a cloud provisioning workflow or a public API.

Before invocation, a trusted controller must reauthorize the current computer,
generation, fence, instance, volume, approved configuration and completed mount
against Postgres and actual EC2/EBS state. It must provision the named Secrets
Manager binding and deliver a protected, root-owned `0600`
`/etc/ezil-supervisor/control-start-authorization.json` matching
`ControlBootstrapAuthorizationSchema`. The grant expires within five minutes
and binds the exact prepared configuration, mount authorization, control domain
and secret version. Publisher data cannot issue this grant. The receiver cannot
create or refresh it. Its controller/SSM transport and secret creation are still
required before pilot activation; do not manually construct production grants.

The existing secret name is
`<namespace>/computers/<computer UUID>/generations/<generation>/control`.
Its exact approved version must also be `AWSCURRENT`, containing only
`{schemaVersion:1, scope, origin, keyHex}`. Scope binds the computer, generation,
fence, instance and volume; the origin is derived from the approved domain.
The host uses verified IMDSv2 temporary credentials and a fixed regional endpoint.
The host IAM role must permit only its own binding and required KMS decryption.
No key is accepted in CLI arguments, environment variables, SSM data or output.

Send only `{schemaVersion:1, authorizationId}` as JSON on stdin to
`/usr/local/bin/node /opt/ezil-supervisor/dist/control-bootstrap.js`. The receiver:

- Confirms protected provisioning, the exact prepared configuration receipt,
  completed uncancelled mount evidence, actual device/UUID and writable mount.
- Fetches the pinned secret and rechecks authority before installing exactly
  32 raw bytes as `control.key`. Links, foreign permissions, partial files and
  differing keys fail. Matching keys are verified and fsynced again on retry.
- Persists an attempt before asking systemd to start the fixed unit. It never
  enables boot startup. Reusing an attempt only observes an existing service;
  it cannot restart a stopped service, refund a failed start or rotate its key.
- Reports started only after observing the unit and receiving its exact signed
  configuration descriptor on loopback. Authority changes, cancellation or
  failures after dispatch stop the unit and require observed quiescence.

The receiver serializes with configuration preparation and mount management.
It checks the protected grant before and after asynchronous effects. The grant
is a bounded dispatch authorization, not an ongoing runtime lease. Remote
revocation and hard process/host failure still need controller reconciliation.
After an ambiguous/crashed attempt, observe the host and issue a new grant only
after confirming it stopped. Do not delete attempt records to retry. A machine
reboot requires fresh controller authorization; automatic boot startup remains
disabled. Existing keys/configuration and user data are retained on failure.

Run `bash tools/test.sh supervisor`. In a dedicated overlay of the retained
host-installation QEMU fixture, run
`bash tools/test.sh supervisor --linux-first-start run`, reboot the VM, then
`bash tools/test.sh supervisor --linux-first-start verify`. The test supplies
local AWS wire fixtures but executes the real device checks, preparation,
installed supervisor, systemd start/stop, signed HTTP and retained filesystem.
It tests no-remount observation, invalid/stale grants, key conflicts, activation
failure, authority replacement during activation, same-PID retry, consumed
startup replay and retained `.git`/rename/deletion/SQLite after reboot.

These checks do not establish AWS IAM, secret issuance, AMI readiness, tunnel
routing, container isolation, Neko typing or Reticle product acceptance.

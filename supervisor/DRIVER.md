# Docker execution driver

`DockerComputerDriver` connects the authenticated control service to actual
Docker containers. It currently implements one Node HTTP service or the pinned
Reticle foreground adapter per installation. Multi-service layouts are rejected
before resource creation. This code is not enabled in a deployed host. The
[Linux executable](HOST.md) supplies bootstrap and locking; the transactional
Postgres producer and cloud provisioning remain pending.

The bootstrap must hold an OS-level singleton lock for the computer before
constructing this driver. Within that process, all start/stop/admission operations
share one serialized queue. Two driver processes must never manage one Docker
host. The bootstrap must also call `expire()` periodically and on recovery,
disconnect proxies on shutdown, and obtain its identity, signing key, exact
approved policy/image allowlist, and volume association from trusted provisioning.
The executable fulfills the local process requirements; simply constructing this
class does not. Its required deadline callback must persist through process loss.

Starts require the actual ext4/XFS data mount and matching volume marker,
an approved locally prepared immutable Linux/amd64 image, and available memory
within the host-configured budget. A running foreign computer generation blocks
admission until it is fenced separately. At most two applications may run. Images
declaring implicit volumes or build triggers are refused. Images are never
pulled or built during launch or observation; preparation belongs to a separate
authorized installation job. Production approval must reject local image IDs
and bind the exact registry digest to an approved policy.

Project grants map to existing `Projects/<project UUID>` directories on the
computer disk. Private data maps to host-protected
`Applications/<installation UUID>/<approved directory name>`; only the last
directory belongs to app UID 1000. Sources use the [pinned mount layer](MOUNTS.md).
Containers have a read-only root, UID/GID 1000, dropped capabilities,
`no-new-privileges`, Docker init, memory/CPU/process limits, bounded temporary
storage and logs, and no Docker socket or host credentials.

Each installation gets a Docker internal bridge network. Docker's internal
network did not publish the requested loopback port in local validation, so the
driver instead owns a loopback-only TCP proxy to the provider-observed private
address. The port comes from the authenticated controller's persisted lease;
collisions are rejected, not silently reallocated. This carries HTTP/WebSocket
bytes without putting the app on an internet-enabled bridge. A 250 ms timer
checks existing sockets for revoked command generations or expired leases.
Cloudflare session authorization and tunnel integration remain separate work;
this loopback proxy must not be exposed as a public unauthenticated endpoint.

Starts check generation and approval around asynchronous work. A superseded
start is stopped and removed before its mounts are released. Health checks are
bounded, reject redirects, and authenticate Reticle with its private pairing
token. A running container is revalidated before reattachment; a stopped one is
recreated from its prepared image and retained disk. An observed `running`
state is a process/service observation, not proof of functional browser readiness.

Stops remain possible after image approval is revoked. They observe and remove
only this computer generation's labelled containers. Cleanup releases this
installation's host-owned mount slots after removal is observed, including slots
left by an earlier driver instance. Uncertain Docker or unmount outcomes fail
closed and retain anchors. Networks and images remain reusable; installation
deletion and host orphan-resource reconciliation still need controller wiring.

Runtime deadlines are committed to the host ledger before container creation and
copied to container labels. Expiry stops the container; removing it cannot reset
the same generation's allowance. This is not the user/day accounting ledger
or the computer idle-stop policy, which must be enforced by the controller.

Run the complete local package/host suite:

```sh
docker pull --platform linux/amd64 node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
bash tools/test.sh supervisor --linux-driver
```

The privileged Linux test host uses a private 64 MiB ext4 loop disk and the real
Docker socket. Its Node fixture runs unprivileged. Signed HTTP commands prove
launch deduplication, driver-object replacement and reattachment, retained file
data after container recreation, stable/colliding ports, two-app admission,
metadata/public-network denial, live WebSocket revocation, cancellation after
creation, deadline enforcement, and launch denial with the disk unmounted.
Driver-object replacement is not an EC2 or Linux host restart test.

After privately building the pinned Reticle artifact, set
`EZIL_TEST_RETICLE_IMAGE` to its local `sha256:...` content ID and run the same
command. This uses the real daemon and checks authenticated status and pairing
token retention through container recreation. The separate Reticle browser suite
establishes operations against its React fixture; this driver test alone does
not establish that operation or the finished Projects/Sessions/Runs/Settings UI.

Do not run these two host suites concurrently: they reserve test ports
24400–24402. The tests clean up their labelled containers, networks, mounted
stages, loop attachment, and disk files. No AWS resource, hosted database,
production endpoint, or published artifact is changed.

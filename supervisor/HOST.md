# Linux host executable

`dist/host.js` runs the authenticated control service with the real Docker
driver. It requires Node 24, Linux root, Docker's Unix socket, and util-linux
`flock`, `mount`, and `umount`. Run it directly in the Docker host's mount
namespace. The privileged container used by acceptance tests is a test host,
not an application container or the production packaging model.

The trusted installer provisions root-owned code, a mounted computer data
volume, and a private configuration directory. It writes `config.json` and
`control.key` there as root-owned, single-link, non-symlink regular files with
mode 0600. `control.key` contains exactly 32 raw random bytes, not base64 text
or an environment variable. Neither file belongs in the repository or an app
mount. Configuration has these strict fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `configurationRevision` | Monotonic approved snapshot revision, independent of runtime commands; legacy initial files default to 1 |
| `computerId`, `computerGeneration`, `volumeId` | Provisioned computer/writer identity |
| `dataRoot` | Actual ext4/XFS data mount with matching `.ezil-volume.json` |
| `stateDirectory` | Private host SQLite state, separate from the data mount |
| `stagingRoot` | Private directory for stable Docker bind mounts |
| `controlPort` | Loopback control listener; cannot overlap an approved app port |
| `memoryBudgetMiB` | App memory budget, capped at 4096; reserve built-in capacity separately |
| `suspended` | Deny starts and stop owned apps when true |
| `preparedInstallations` | Immutable release ID, policy digest, image and private-directory records; preparation only, no project access or execution authority |
| `approvedInstallations` | Entries containing `installationId` and the entire approved `ExecutionPlan` |

The installer must compile approvals from authorized control-plane records.
Matching an image or policy digest alone is insufficient: authorization binds
the installation and every plan field, including project mounts, origins,
entrypoints, limits and port leases. A publisher cannot place its own plan in
this file. The control-plane producer and approval-file delivery are not wired
yet; this executable does not provide a public configuration-write endpoint.

Preparation and execution are separate. Reticle can be installed with only a
`preparedInstallations` record, before any project is selected. Only a later exact
`approvedInstallations` plan authorizes execution and its selected-project mounts.
When both records exist they must agree on release, policy, image and private
directories. Existing approved plans also supply their preparation records for
compatibility. Do not treat prepared files as permission to run an application.

For an installed, provisioned host, the entry command is:

```sh
sudo /usr/local/bin/node /opt/ezil-supervisor/dist/host.js /etc/ezil-supervisor/config.json
```

Production mode accepts only digest-pinned `us-east-1` ECR references and HTTPS
origins. The explicit `--private-validation` argument permits exact local image
IDs and loopback HTTP origins for private testing. It never disables signatures,
replay protection, installation approval, locks, filesystem checks or quotas.
The image must already exist locally; launch and status do not pull or build it.

The process holds `/run/ezil-supervisor/host.lock` independently of configuration
paths and computer IDs. A short `flock` child locks inherited FD 3; the parent
retains the same open-file description. A second process is refused. Process
death releases the kernel lock without a stale PID file or an orphaned helper.
Do not replace the lock file while the host is running.

Startup examines existing owned containers. Unapproved, unknown, expired or
volume-mismatched runtimes are stopped. It never starts stored plans or
reconnects an application route. A fresh signed launch is required, including
after a process crash. `host_ready` denotes the control listener, not a ready
application, EBS validation, or a functional OS window.

Each running command has a persisted deadline in the host-private
`runtime_leases` table, created additively on ledger open. The reservation commits
before Docker creation and can only tighten for that generation. Failed starts,
container deletion and supervisor restarts do not grant more time. Docker labels
carry the same deadline for observation/recovery. The one-second expiry sweep
does not need controller traffic. It shares the driver's serialized operation
queue; slow Docker operations can delay a stop. An independent EC2 watchdog,
service-manager restart policy, and daily user accounting remain required before
production rollout. Local expiry is not proof that EC2 compute billing stopped.

`SIGHUP` reloads only suspension, prepared releases and exact installation approvals. Changes to
identity, paths, listener, budget or signing key require a restart. While
reloading, requests are unavailable and old routes lose authorization. An invalid
reload denies further control requests and stops owned apps; expiry sweeps cannot
restore the rejected configuration. A valid subsequent reload can recover it.

The host persists the highest accepted configuration revision and its exact
canonical digest in SQLite. Changed content requires a higher revision. An older
revision or conflicting same-revision file is rejected on reload and startup;
startup rejection still stops already-owned containers. Retry identical content
at the same revision. Restoring a previous policy intentionally requires a new
revision, not replay of an old file. The trusted controller must allocate and
retain these revisions durably; no browser or publisher may choose them.

`SIGTERM`/`SIGINT` stop accepting requests, cancel pending starts, drain work,
disconnect proxies, and wait for Docker to report owned containers stopped.
Images, app data and deadline records remain. Shutdown errors are reported as
`host_shutdown_unconfirmed`, with exit status 1; they never claim stopped compute.
The CLI has a 60-second shutdown deadline. Provisioned service management must
allow that interval and independently reconcile an unconfirmed result.

Logs contain fixed event names and, for committed command observations, only
installation UUID, generation and state. The optional observation callback is
best-effort telemetry, not a durable control-plane callback/outbox. File contents,
keys, request bodies and raw provider errors are not logged.

## Acceptance

```sh
npm --prefix supervisor ci --ignore-scripts
docker pull --platform linux/amd64 node@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7
bash tools/test.sh supervisor --linux-host
```

The Linux suite uses a private ext4 loop disk and actual Node processes/Docker
containers. It tests lock contention; abrupt `SIGKILL` and durable replay denial;
no automatic start/routing; signed reattachment; graceful observed stop; retained
files; unchanged deadlines after recreation; expiry without controller requests;
denial after deleting an expired container; suspension/invalid reload; and unsafe
configuration/key files. It waits for committed command observations as well as
real serving-path results, not merely an HTTP health response mid-start.

Set `EZIL_TEST_RETICLE_IMAGE` to the previously built Reticle content ID to run
the same complete suite with its real daemon and persistent pairing token. Run
these suites sequentially: they use test ports 24400–24402 and 24818. They are
local process/container acceptance, not an EC2 stop/replacement test, a Linux VM
reboot, a new connected-project Reticle operation, or the marketplace UI.

## Trusted installation preparation

`dist/prepare.js` consumes a desired configuration already approved and transferred
as a protected root-owned file. It is an installation operation, separate from
Open/status. Provisioning must first mount the correct computer data disk, create
root-owned target/configuration directories, and supply the generation-scoped
`control.key`. The command does not generate keys, attach disks, provision EC2,
create containers, execute image code, register projects, or enable app routing.

```sh
sudo /usr/local/bin/node /opt/ezil-supervisor/dist/prepare.js \
  /var/lib/ezil-provisioning/desired.json /etc/ezil-supervisor/config.json \
  /var/lib/ezil-provisioning/registry-credentials.json
```

The optional credential file contains an array of `{ registry, token }` entries
for exact `us-east-1` ECR registries. Tokens are short-lived ECR authorization
passwords supplied by trusted host provisioning; username is always `AWS`.
Use the host's scoped ECR pull identity, never an administrator key or application
secret. The file must satisfy the same root ownership, 0600, regular-file,
single-link and protected-ancestor rules as host configuration. Its contents go
only to Docker's Unix-socket registry-auth header and are never logged or copied
into an image, application environment, manifest or approval file. Provisioning
owns token refresh and removal. Cached verified images need no token lookup.

Preparation validates all single-service requirements and stable port assignments,
admits the mounted data volume, and inspects each approved digest. Missing images
are pulled by digest for Linux/amd64, then inspected again. Mutable tags, wrong
architecture/digest, implicit Docker volumes, and OnBuild instructions are rejected.
Pull progress has a five-minute limit, bounded lines/total bytes, and recognizes
errors carried inside an HTTP 200 stream. Cancellation aborts the pull request;
Docker may retain cached layers, which are not activated or treated as an installed
release. The whole preparation has a fifteen-minute cancellation budget; an
in-flight inspection may take its existing bounded thirty seconds to return.

It creates only `Applications/<installation UUID>/<approved directory name>` on
the admitted data volume, using protected directory handles and private permissions.
Existing data is retained. It does not modify selected projects or pairing state.
Once images/directories are verified, it fsyncs a 0600 temporary configuration,
renames it atomically, and fsyncs the parent. Failure or cancellation before the
rename leaves the previous approval file in place. An error after rename reports
an unconfirmed commit; verify the active file/revision before retrying and do not
report successful installation. Completed image caches or empty directories
may remain for retry; no shared image or user data is deleted on failure.

A separate kernel preparation lock serializes writers while the host keeps its
own process lock. Existing configuration identity cannot be changed by preparation,
and stale/conflicting revisions are refused. A suspended snapshot can be installed
without fetching images or accessing a failed data mount, allowing revocation to
remain available during storage faults.

`host_prepared` reports the computer generation, configuration revision and digest.
It means the files are prepared, not that the host loaded the new approval or an
app is running. Trusted service management must reload the host and verify the
result before marking installation complete. A signed `configuration` operation
on `/v1/control` accepts the host identity envelope (no installation ID) and returns
only the loaded computer generation, configuration revision and digest. It never
loads files, pulls images or starts an app. During failed/pending reloads it is
unavailable. Compare this loaded descriptor to the preparation receipt.
No production file-transfer/SSM consumer or configuration-revision producer is
wired yet; public installation and
runtime flags must remain off. Reticle still needs the separate explicit project
connection and authenticated OS window.

The Linux host acceptance suite runs the real preparation executable, a tiny local
OCI registry with a real Docker digest pull, and actual host start/stop/recovery.
It proves failed preparation retains prior files, cached retry avoids another pull,
preparation creates no app container, and stale approval files cannot restore
permissions. The separate Node and Reticle runs exercise actual prepared data and
daemon state. This does not prove authenticated ECR access, EC2/EBS attachment,
a full VM reboot, or finished marketplace installation.

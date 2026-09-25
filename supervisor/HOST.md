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
| `computerId`, `computerGeneration`, `volumeId` | Provisioned computer/writer identity |
| `dataRoot` | Actual ext4/XFS data mount with matching `.ezil-volume.json` |
| `stateDirectory` | Private host SQLite state, separate from the data mount |
| `stagingRoot` | Private directory for stable Docker bind mounts |
| `controlPort` | Loopback control listener; cannot overlap an approved app port |
| `memoryBudgetMiB` | App memory budget, capped at 4096; reserve built-in capacity separately |
| `suspended` | Deny starts and stop owned apps when true |
| `approvedInstallations` | Entries containing `installationId` and the entire approved `ExecutionPlan` |

The installer must compile approvals from authorized control-plane records.
Matching an image or policy digest alone is insufficient: authorization binds
the installation and every plan field, including project mounts, origins,
entrypoints, limits and port leases. A publisher cannot place its own plan in
this file. The control-plane producer and approval-file delivery are not wired
yet; this executable does not provide a public configuration-write endpoint.

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

`SIGHUP` reloads only suspension and exact installation approvals. Changes to
identity, paths, listener, budget or signing key require a restart. While
reloading, requests are unavailable and old routes lose authorization. An invalid
reload denies further control requests and stops owned apps; expiry sweeps cannot
restore the rejected configuration. A valid subsequent reload can recover it.

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

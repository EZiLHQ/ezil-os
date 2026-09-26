# Computer admission checks and Reticle adapter

This package contains an authenticated HTTP control service factory, a durable
command ledger, host admission checks, and a foreground adapter for the pinned
Reticle 3.2.0 daemon. A [real Docker driver](DRIVER.md) performs local
container execution through that HTTP boundary. The [Linux host executable](HOST.md)
adds protected configuration, a kernel singleton lock and process recovery.
The EBS controller, Cloudflare routing, and marketplace integration remain pending.
The [offline host installer](INSTALLATION.md) packages a verified release under
both fixed operation paths. The [first-start receiver](FIRST-START.md) accepts
separate controller authorization; image publication and its cloud orchestration remain separate.
The HTTP unit tests use an instrumented driver; the separate Linux acceptance
suite uses actual Docker containers and an ext4 loop disk.

Control requests use a computer-specific secret of at least 32 bytes,
provisioned outside the repository. The signature binds the method, raw path,
timestamp, nonce, and exact body digest. The HTTP service uses the host-private
SQLite ledger for nonces, command generations, request idempotency, and observed
state. Its synchronous FULL transactions persist intent before execution; a
process restart does not reset replay protection. The standalone in-memory
guard remains available for isolated tests. This protocol must never be exposed
through the unauthenticated local development server or forward Supabase tokens
to apps. See [the host control protocol](CONTROL.md) for integration requirements.

The volume verifier reads Linux mount evidence and a private computer/volume
marker. A directory on the root disk, wrong marker, or read-only mount fails
admission. The controller must separately verify encryption and attachment,
fence previous writers, manage backups, and configure mount ordering.

The [Linux mount primitive](MOUNTS.md) pins approved directories through path
renames and stages stable binds for Docker. Its separate real Linux suite runs
with `bash tools/test.sh supervisor --linux-mounts`. Add the driver suite with
`--linux-driver`, or the complete process-restart suite with `--linux-host`;
none establishes EBS recovery.

## Reticle runtime

`reticle/Dockerfile` consumes an externally built `@reticlehq/server` artifact
from commit `39cc34a84bfb78023154c9f4e99c61f3cbe8fc19`; the source and artifact
stay outside this repository. The adapter calls the actual `startDaemon` entry
point on port 4400. It does not run the detached CLI, load project `.env` files,
or automatically instrument projects.

The host supplies `EZIL_RETICLE_PROJECT_PATH` under `/workspace/` and
`EZIL_RETICLE_PRIVATE_PATH` under `/data/`, matching the approved manifest's
mount destinations. Both must be actual writable mount points; a broader
parent mount is rejected. The private mount must have owner-only permissions.
The legacy local defaults `/project` and `/data` remain available when both
variables are absent. Partial or unsafe configuration fails startup.

The adapter creates `.reticle` inside the selected project before startup, after the
host has supplied the approved project mount. Without that marker Reticle
treats a fresh directory as unapproved and selects its non-persistent home
directory for journals. Escaping state symlinks fail startup.
Project state stays inside that directory; a private, durably created pairing
token lives inside the approved private mount. Provisioning failures block startup
instead of allowing upstream's best-effort token creation to disable auth.
`EZIL_RETICLE_ALLOWED_ORIGINS` is an explicit JSON array of exact HTTPS origins
(loopback HTTP is allowed for local tests). It is configuration, not a secret.

Run as UID 1000 with a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, bounded memory/CPU/processes, and an isolated network.
The adapter does not itself enforce those host-side Docker options. Never
mount the Docker socket, host credentials, or another installation's data.

## Verification

```sh
npm --prefix supervisor ci --ignore-scripts
bash tools/test.sh supervisor
```

The unit tests cover real HTTP signature/scope enforcement, durable replay,
two-process generation races, stale observations, mount and marker failures,
exact origins, token provisioning races, and fail-closed startup.
The artifact-verifier test additionally checks content digests and rejects
escaping symlinks and native modules. See [the private build and container
acceptance recipe](reticle/README.md) for reproducible real-browser checks.

Private local Docker validation on 2026-09-25 used the pinned artifact and two
separate computer volumes/networks. A browser connected to the real React
fixture; `reticle_look` found its counter and `reticle_act.click` changed the
rendered count from 0 to 1. After an observed container stop/start using the
same image, the pairing token, project configuration, event journal (7,526
bytes), and action journal (237 bytes) matched their earlier hashes, and the
operation succeeded again. The suite also passed three real operations with
the manifest's `/workspace/projects` and `/data/reticle` mounts, including after
container replacement. Anonymous and cross-installation requests failed;
the second computer did not contain the first computer's project history.

This establishes local adapter behavior. It does not establish EC2/EBS
recovery, production routing, a finished Reticle window, public license
approval, or completion of either marketplace milestone. The React fixture
is a test target, not the Reticle product interface.

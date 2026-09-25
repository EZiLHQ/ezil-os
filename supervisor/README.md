# Computer admission checks and Reticle adapter

This package contains host admission checks and a foreground adapter for the
pinned Reticle 3.2.0 daemon. The HTTP supervisor, Docker reconciler, EBS
controller, Cloudflare routing, and marketplace integration are still pending.
The admission checks are not yet wired into a running host service.

Control requests use a computer-specific secret of at least 32 bytes,
provisioned outside the repository. The signature binds the method, raw path,
timestamp, nonce, and exact body digest. The replay cache is bounded but lives
in memory: a host service must additionally persist generations and idempotency
before performing operations. This protocol must never be exposed through the
unauthenticated local development server or forward Supabase tokens to apps.

The volume verifier reads Linux mount evidence and a private computer/volume
marker. A directory on the root disk, wrong marker, or read-only mount fails
admission. The controller must separately verify encryption and attachment,
fence previous writers, manage backups, and configure mount ordering.

## Reticle runtime

`reticle/Dockerfile` consumes an externally built `@reticlehq/server` artifact
from commit `39cc34a84bfb78023154c9f4e99c61f3cbe8fc19`; the source and artifact
stay outside this repository. The adapter calls the actual `startDaemon` entry
point on port 4400. It does not run the detached CLI, load project `.env` files,
or automatically instrument projects.

The container requires writable `/project` and `/data` mounts. The supervisor
must supply only the explicitly selected project and installation directory.
Project state lives in `/project/.reticle`; a private, durably created pairing
token lives in `/data/reticle/pairing-token`. Provisioning failures block startup
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

The 14 unit tests cover request replay, signature scope, mount and marker
failures, exact origins, token provisioning races, and fail-closed startup.

Private local Docker validation on 2026-09-25 used the pinned artifact and two
separate computer volumes/networks. A browser connected to the real React
fixture; `reticle_look` found its counter and `reticle_act.click` changed the
rendered count from 0 to 1. After an observed container stop/start using the
same image, the pairing token, project configuration, event journal (7,526
bytes), and action journal (237 bytes) matched their earlier hashes, and the
operation succeeded again. Anonymous and cross-installation requests failed;
the second computer did not contain the first computer's project history.

This establishes local adapter behavior. It does not establish EC2/EBS
recovery, production routing, a finished Reticle window, public license
approval, or completion of either marketplace milestone. The React fixture
is a test target, not the Reticle product interface.

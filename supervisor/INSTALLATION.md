# Offline supervisor installation

The reviewed installer installs one digest-addressed release and its four
systemd units. The existing configuration SSM document and units use
`/opt/ezil-supervisor/dist`; the mount document uses
`/opt/ezil-supervisor/current/dist`. Both resolve to the same release and locked
production dependencies. The pinned document bytes remain unchanged.

From a clean, reviewed checkout with Node 24 and existing build dependencies:

```sh
npm --prefix supervisor ci --ignore-scripts --no-audit --no-fund
bash tools/test.sh supervisor
node supervisor/deploy/build-host-release.mjs /absolute/new-release-directory
```

The packager compiles into a fresh output directory, restores only production
dependencies with the frozen npm lockfile and lifecycle scripts disabled, and
records the source commit plus every payload file's digest/size. It emits a
`releaseDigest`. This is integrity metadata, not a signed provenance or approval.
Review the source/lockfile and bind that digest to the approved image build.
Do not accept a digest from an untrusted party alongside its payload.

On the dedicated Linux image builder, provision an approved Node 24 executable
at `/usr/local/bin/node`, systemd, Docker, util-linux, GNU cmp and e2fsprogs.
The AMI build must pin and verify those components separately. Transfer the
release directory and run the **reviewed checkout's installer**, not unchecked
code from the release directory:

```sh
sudo /usr/local/bin/node /trusted/checkout/supervisor/deploy/install-host.mjs \
  /absolute/release-directory <reviewed-release-digest>
```

The installer performs no downloads, package scripts, key generation, data-disk
operation, service enable/start, or cloud API call. It requires protected
root-owned destination ancestors. File size/count limits, content hashes and
pinned source directory descriptors reject path escapes, symlinks, hard links,
special files and changed input. It writes/fsyncs a separate release before
publishing the aliases; an interrupted install remains unconfirmed. Failed
staging directories remain for diagnosis and are never selected by an alias.

Repeating the same install verifies the existing tree and completes any missing
aliases/units. Extra or modified installed files, writable code, different
units, foreign symlinks and implicit release upgrades fail. A maintenance or
rollback installer is separate work; do not remove existing computer state to
make this installer accept an upgrade. `state: installed` only confirms code
and unit installation. It does not mean a mounted disk, loaded supervisor or
running application.

Per-computer provisioning must separately deliver the current mount authority,
control key, and approved configuration. Start/enable the supervisor only after
the mount and preparation steps succeed; verify its authenticated loaded
descriptor before acknowledging installation. The configuration reload operation
still cannot start an inactive host. That first-start orchestration, bounded
scheduling, AMI publication, tunnel/TURN setup and AWS acceptance remain required.

## Disposable VM acceptance

Use fresh overlays of the retained `mount-operation.linux.mjs` QEMU fixture,
with its NVMe serial `vol33333333333333333`. Preserve the original images. Stop
and disable prior fixture services; preserve their unit files, `/opt/ezil-supervisor` alias,
`/etc/ezil-supervisor` and `/var/lib/ezil-supervisor` under separate fixture names
so the new overlay has an empty installation target. Never run this on a real
computer or move real user state. The test requires QEMU, an empty Docker daemon
and the fixture's existing filesystem identity and data.

```sh
sudo bash tools/test.sh supervisor --linux-host-install install /opt/ezil-host-release
sudo systemctl reboot
sudo bash tools/test.sh supervisor --linux-host-install verify /opt/ezil-host-release
sudo systemctl poweroff
```

The suite tests the actual installer, shipped systemd units and installed Node
modules. It verifies tamper denial, repeat installation, both operation paths,
signed host configuration and cross-computer denial, followed by a real reboot
and retained `.git`, rename/deletion and committed SQLite state. Explicit test
provisioning creates only an empty approval and VM-only control key; no app is
started. ARM64/HVF validation does not establish a production Linux/amd64 AMI,
EC2/EBS attachment, Reticle operations, cloud routing or stopped billing.

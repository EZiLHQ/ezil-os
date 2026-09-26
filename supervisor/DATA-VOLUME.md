# Trusted computer data-volume bootstrap

The supervisor now waits for `ezil-data-mount.service` to identify and mount the
computer's disk at `/srv/ezil-data`. A directory on the disposable root disk is
not a substitute. The mount helper neither starts applications nor downloads,
repairs, resizes, unmounts or deletes a filesystem.

This is a host primitive. Controller delivery, persistent tracking of the
filesystem UUID, production AMI packaging and AWS acceptance remain separate
work. No cloud resource or deployment is enabled by this change.

## Controller authority

Install Node 24, the built supervisor package with its locked dependencies, and
the systemd units under the fixed paths in `deploy/`. The host requires Linux,
util-linux (`lsblk`, `blkid`, `wipefs`, `mount`, `flock`), GNU `cmp`, and e2fsprogs.
Write `/etc/ezil-supervisor/data-volume.json` as a root-owned 0600 regular file,
under protected root-owned directories. Do not put it on the data disk.

```json
{
  "schemaVersion": 1,
  "computerId": "11111111-1111-4111-8111-111111111111",
  "volumeId": "vol-11111111111111111",
  "filesystemUuid": "22222222-2222-4222-8222-222222222222",
  "mode": "mount"
}
```

These are fixture identities. Production identities must come from the current
controller record. The controller must generate and persist `filesystemUuid`
before first use and preserve it across restart/replacement. `initialize` is
explicit first-use authority for a newly created blank disk; it must never be
inferred from a missing mount or missing filesystem. Retained, replacement and
migrated volumes use `mount`, which cannot format or create a marker.

Before delivering authority, independently verify the computer, current writer,
generation fence, exact encrypted gp3 volume, attachment, Availability Zone,
size and `DeleteOnTermination=false`. A guest's NVMe serial cannot establish
these AWS properties. Stop/fence the previous writer and observe detach before
replacement. Coordinate changes to the protected plan with the same
`data-mount` host lock; never replace it during an active operation. Do not
change mount identity while the supervisor or applications are running.

The helper resolves the full EBS serial rather than a changing NVMe ordinal.
It requires one identifiable root and one unpartitioned writable 50 GiB NVMe
data disk, disjoint from the root ancestry, with no conflicting mounts. It
probes filesystem bytes directly rather than trusting cached udev metadata.
Mounted evidence must match the block major/minor, filesystem UUID, ext4 root,
`rw,nosuid,nodev` flags and the protected `.ezil-volume.json` computer/volume
identity. The existing host admission checks still run before services start.

## First use and failures

First use checks `wipefs --no-act` and compares the **entire** disk with zeros.
Signature-free media can still contain data. This initial read is bounded to
ten minutes; the whole helper has a fifteen-minute deadline. Failure makes no
format attempt. Validate this deadline on the approved AWS pilot before use.

Before `mkfs.ext4`, the helper commits and fsyncs a 0600 attempt record under
`/var/lib/ezil-bootstrap/<volumeId>.json` on the root disk. It pins the actual
block-device descriptor and uses the controller's filesystem UUID. A lost
process, failed format or timeout never refunds the format attempt. A later
run can observe a completed matching filesystem; it cannot reformat an
ambiguous disk. Only that exact recorded initialization can create its marker,
and only when the filesystem contains nothing except `lost+found`. Marker and
parent directory are fsynced before readiness.

Keep the journal and disk on failure. Investigate with read-only inventory and
filesystem probes; do not delete the journal, erase signatures, change UUIDs,
run forced formatting or adopt a foreign marker as a retry. CLI failure is the
fixed `data_mount_unconfirmed` code. No raw command output or configuration is
logged. A replacement root needs only `mount` authority and a matching existing
filesystem/marker, not the prior root's initialization journal.

No applications may run until the mount unit and supervisor admission succeed.
Stopping the unit does not unmount data. Normal machine shutdown owns unmount
ordering after applications stop. Encrypted snapshots and application-consistent
backup hooks remain required; a persistent disk is not a backup. The controller
must retain AWS audit events and encrypted operational logs/metrics. This local
helper cannot prove provider stop, retained-volume billing or snapshot recovery.

## Repeatable isolated Linux acceptance

### Loaded supervisor and retained disk

After completing the disk suite below, an additional opt-in suite exercises
the **real** supervisor, shipped systemd units and Docker daemon on that same
dedicated QEMU fixture. It requires an empty Docker daemon, the existing test
NVMe identity/files, no previous host configuration, and the installed
`/opt/ezil-supervisor` symlink. It never formats or replaces the data disk.
Do not copy a real computer's configuration, keys or application data here.

Install Docker in the guest (`sudo apt-get install --no-install-recommends
docker.io` on Ubuntu 24.04), then run from `/opt/ezil-mount-acceptance`:

```sh
sudo bash tools/test.sh supervisor --linux-retained-host setup
sudo systemctl reboot
# Reconnect after an actual reboot; the enabled units start the host.
sudo bash tools/test.sh supervisor --linux-retained-host verify
sudo systemctl poweroff
```

The suite creates a VM-only control key and an empty approved-installation
configuration. It checks the actual host process and signed configuration
digest, unsigned/cross-computer denial, replay denial across service restart,
singleton locking, clean observed shutdown, and wrong-filesystem denial by the
real mount dependency. `verify` requires a different kernel boot ID and checks
automatic service startup plus retained `.git`, renamed/deleted files and the
committed SQLite fixture. Each phase leaves the supervisor stopped; it stays
enabled for the next boot. An unsuccessful fixture setup should be investigated
or repeated on fresh overlays, without erasing existing configuration.

This suite starts no application containers. It does not establish Reticle
operations, application persistence, amd64 compatibility, EBS attachment,
encryption, provider stop or stopped-compute billing. Those acceptance gates
remain separate.

### Disk initialization and replacement

Run normal checks with `bash tools/test.sh supervisor`. The destructive disk
suite is deliberately opt-in and refuses non-root, non-Linux and non-QEMU
execution. Never run it in OrbStack, a privileged Docker/systemd container, an
EC2 computer, or a VM containing useful data.

Prepare a **dedicated** QEMU guest with Ubuntu 24.04, systemd, Node 24, npm and
two separate disk images: an ordinary virtio root and a blank sparse 50 GiB
NVMe disk. Example host-side disk creation and QEMU disk arguments:

```sh
qemu-img create -f qcow2 -F qcow2 -b /absolute/path/verified-ubuntu-base.img root.qcow2 8G
qemu-img create -f qcow2 data.qcow2 50G
# Add to your local QEMU invocation; the serial is a fixture, not an AWS volume.
# -drive if=virtio,file=root.qcow2,format=qcow2
# -drive if=none,id=data,file=data.qcow2,format=qcow2
# -device nvme,drive=data,serial=vol11111111111111111
```

Verify the downloaded Ubuntu cloud image and Node archive against their
published checksums. Use a VM-only SSH key and loopback port forwarding, with
no app `.env`, cloud credentials, host filesystem shares, or production data.
Copy only `supervisor/` (without `node_modules`) and `tools/test.sh` into the
guest at `/opt/ezil-mount-acceptance/`, owned by root. Install the fixed runtime
path and locked dependencies inside the guest:

```sh
sudo ln -s /opt/ezil-mount-acceptance/supervisor /opt/ezil-supervisor
cd /opt/ezil-mount-acceptance/supervisor
sudo npm ci --no-audit --no-fund
cd /opt/ezil-mount-acceptance
sudo bash tools/test.sh supervisor --linux-data-volume initialize
sudo systemctl reboot
# Reconnect after reboot. The shipped mount unit mounts the retained disk.
sudo systemctl is-active ezil-data-mount.service
cd /opt/ezil-mount-acceptance
sudo bash tools/test.sh supervisor --linux-data-volume verify
sudo systemctl poweroff
```

`initialize` requires a blank disk and absent plan/journal. It rejects retained
mode on blank media, an ambiguous attempt record, concurrent bootstrap and a
signature-free nonzero disk before exercising real initialization. It then
writes `.git`, renames/deletes files and kills a SQLite writer after a committed
transaction while another remains open. `verify` confirms the durable files
and committed transaction, and rejects the unfinished transaction.

For replacement, **observe the old QEMU process exit first**, preserve
`data.qcow2`, create a new root overlay from the verified base, and attach only
that retained data image. Repeat the code/Node/dependency installation without
copying `/etc/ezil-supervisor` or `/var/lib/ezil-bootstrap`. Run:

```sh
cd /opt/ezil-mount-acceptance
sudo bash tools/test.sh supervisor --linux-data-volume replacement
```

Every phase rejects wrong serial/UUID, missing or foreign markers, symlinks,
hard links, FIFOs and permissive marker modes with bounded redacted errors. It
runs the shipped mount unit and tests the supervisor unit's dependency ordering
using a readiness probe in place of Docker/the host process. The probe is not
evidence of a loaded supervisor or an installed application. No stage erases a
retained disk; keep failed fixtures for diagnosis.

Apple Silicon/HVF guests prove ARM64 Linux filesystem behavior. They do not
prove the production Linux/amd64 AMI, EBS encryption/attachment, two-user app
isolation, Reticle persistence, or stopped compute billing. Those remain
explicit cloud/application acceptance gates.

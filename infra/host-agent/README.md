# EZiL AWS computer host agent (I4)

Runs on each AWS computer host (one EC2 instance per computer, Stage A). It mounts the
computer's retained data volume, checks the C-4 disk marker, starts the desktop container
on an overlay rootfs, enrolls with the app (C-6), supervises the per-epoch Cloudflare
tunnel, and idle-stops or honours a control-plane stop (R9). The contracts live in
`docs/AWS-COMPUTERS.md`; this directory implements the host side of R3, R4, R5, R9 and R15,
C-4, C-6, and §3a. The S1 spike (`feat/aws-s1-runtime-spike`) holds the runtime evidence.

Python 3 standard library only. Nothing here calls an AWS API.

## Threat model

**Guest root controls every byte of the data volume** (R5, §3a). The marker, the upper
layer, the profiles and anything the guest reports are hostile input to the host. The
agent therefore:
- never follows a link or opens a device node on the volume (`fsops.py`, `rebase.py`);
- mounts the volume `nosuid,nodev` and the merged overlay `nodev`;
- keeps every secret (tunnel token, control key) on the host root volume under
  `/var/lib/ezil-host` (0700/0600), never in the container's view or on the data volume.

The guest has no network path to the instance metadata service: its network namespace has
loopback only in `none` mode. In `veth-nat` mode (production) it can reach only the
internet through NAT and the host resolver at 10.200.0.1:53. All of 169.254/16 (instance
metadata included), RFC1918 (the VPC and its peers), CGNAT, the configured VPC CIDR and
every other host port are dropped (see "Network" below; exercised in disposable
namespaces).

The marker catches **bugs**, not attacks (C-4). The fences that hold against a hostile
guest are EBS single-attach, generation compare-and-swap, tunnel deletion and the
migration head.

## Boot order (systemd, `systemd/`)

Each unit `Requires=` and is `After=` its predecessor, so a failed step stops everything
below it. Every step after the guard also refuses unless two things hold:
- the guard's run stamp matches this lease's (generation, epoch);
- the data volume is still mounted from **the lease's device**, and the upper resolves
  to it (`findmnt -T`).

`data-down` and any shutdown remove the stamp. A unit started by hand, or a volume
unmounted or swapped behind the agent's back, therefore cannot put the upper on the host
root disk.

| # | Unit | Step | Refuses on |
|---|---|---|---|
| 1 | `ezil-lease` | IMDSv2 token PUT → user data (lease + one-time nonce), identity document, PKCS7 → `/run/ezil-host/lease.json` (0600) | malformed user data, IMDS failure |
| 2 | `ezil-guard` | Resolve the NVMe device from the lease `volumeId` and check its fs UUID. Provisioning formats an *empty* device with the control plane's `fsUuid`. Mount **read-only** `nosuid,nodev`, then run the C-4 checks; on a digest change with a receipt, run the rebase job. Remount rw, write the marker (tmp → fsync → rename → fsync dir), then write the stamp | device missing or not a block device; fs UUID ≠ lease; marker missing (unless provisioning an empty volume) or malformed; computerId/volumeId/fsUuid mismatch; `generation` above the lease; `leaseEpoch` not below the lease; digest mismatch without a valid snapshot receipt; `rebase_failed` state; a planted symlink at a host-only layout dir. Guest-reachable profile entries (`profiles/chrome`, `profiles/code-server-*`) that are not real directories are **quarantined** (renamed aside, never followed) instead. The marker is bumped only after all of this passes |
| 3 | `ezil-host-clean` | No-follow removal of Chrome `Singleton*` (R15, only after the guard) and of legacy `upper/tmp`, `upper/run` | a symlinked path component |
| 4 | `ezil-overlay` | Overlay `nodev,index=off,redirect_dir=off,metacopy=off,xino=off`; netns; OCI spec | lower missing, unknown network mode |
| 5 | `ezil-desktop` | `runc run` with the hardened spec (below); stop = TERM → KILL → delete → sync | |
| 6 | `ezil-enroll` | POST `{computerId, generation, leaseEpoch, nonce, identityDocument, signature}` over verified HTTPS. Store the tunnel token and control key host-only. **Wipe the nonce** from local state and from cloud-init's cached copies after any HTTP answer, and never re-send it | refusal, malformed response |
| 7 | `ezil-cloudflared` | Run cloudflared with the token in the **environment**, and restart it with backoff | token missing, or bound to another epoch |
| 8 | `ezil-agent` | Control socket (presence/stop/fence, HMAC + epoch + timestamp), idle predicate, quiesce, shutdown | |

**Fence.** A `fence` op, a stop, a token from another epoch, or SIGTERM stops cloudflared
and **wipes** the token.

**Idle (#183 predicate).**
1. No gateway presence for 600 s.
2. Host 1-minute load below 0.5, strictly parsed; an unknown load counts as busy.
3. A **successful** flush. A dpkg/apt lock held in the guest (`busy`, detected host-side
   through `/proc/locks`) or a stale lease or fence (`stale`) blocks the stop and the
   check repeats.

Then the agent stops the desktop, unmounts the overlay, syncs, unmounts the data volume
and runs `shutdown -h now`.

**Control-plane stop.** warn → flush (cannot be blocked) → the same ordered stop. The agent
**never renews its lease** and makes no outbound call after enrollment.

**Control channel.** Each request carries `{op, leaseEpoch, ts, seq, mac}`.
- `mac` = HMAC-SHA256 with the per-epoch control key.
- `ts` must be finite, at most 120 s old and at most 5 s ahead of the host.
- `seq` is an integer that must strictly increase within the epoch. The high-water mark
  is persisted host-only (0600) and fsynced *before* the request acts, so a replay is
  refused even across an agent restart.
- `warnSeconds` must be an integer in 0..900.
- Malformed requests never kill the channel.

## Network (`networkMode: veth-nat`)

The veth pair is `ezh0` (host, 10.200.0.1/30) and `ezc0` (container, 10.200.0.2/30). The
container's default route goes via the host, IPv6 is off inside it, and `resolv.conf`
points at 10.200.0.1. Three dedicated chains carry the rules:

| Chain | Rules |
|---|---|
| `EZIL-CT-FWD` (from FORWARD, first) | **anti-spoof:** drop anything from `ezh0` not sourced from 10.200.0.2; drop to 169.254/16, 10/8, 172.16/12, 192.168/16, 100.64/10, 0/8, 224/4, 240/4 and `vpcCidr`; accept the rest out; accept ESTABLISHED back; drop new inbound |
| `EZIL-CT-IN` (from INPUT, first) | anti-spoof as above; accept DNS udp/tcp 53 to 10.200.0.1; accept ESTABLISHED (replies to host-initiated connections, e.g. cloudflared → desktop); drop the rest |
| `EZIL-CT-NAT` (nat POSTROUTING) | MASQUERADE the container out |
| `EZIL-CT-FWD6`, `EZIL-CT-IN6` (ip6tables FORWARD/INPUT, first) | drop everything in or out of `ezh0`. IPv6 is also **disabled on `ezh0`** (`net.ipv6.conf.ezh0.disable_ipv6=1`, set when the veth is created, before the link comes up, so it never gets a link-local address) and in the container; the ip6tables drops are the second layer |

`ensure_rules` is idempotent:
- a chain already exactly as desired is left alone;
- otherwise a fresh chain is built and swapped in behind a single jump;
- the drift check also requires IPv6 to be off on `ezh0`, and `net-ensure` turns it back off;
- `net-check` reports drift and `net-ensure` repairs it.

The AMI makes systemd-resolved answer on 10.200.0.1 (`DNSStubListenerExtra`).

`test/test-network.sh` exercises all of this **without touching the machine's networking**.
- A disposable namespace plays the host (`hostNetns`, a test-only setting; if the namespace
  is missing the commands fail rather than fall back to the real host).
- Namespaces play the internet (203.0.113.2), an RFC1918 VPC peer (10.0.0.2) and link-local
  metadata (169.254.169.254, 169.254.10.10). Each peer has a positive control from the fake
  host.
- The probe container resolves names through the host resolver and reaches the internet
  peer, but not the metadata, link-local, RFC1918 or host ports.
- The host can still connect into the container.
- **Anti-spoof:** a forged source (192.0.2.7, added outside the container, with a return
  path in place) gets no connection, and the internet peer only ever sees the NATed
  source.
- **IPv6:** `ezh0` has IPv6 disabled and no address, not even link-local. With IPv6
  deliberately re-enabled on both ends (test only), the container still cannot reach the
  host over v6; the drift check reports it, and `net-ensure` restores it.
- Re-applying the rules leaves `iptables-save` identical. A deleted rule is detected as
  drift, actually reopens the hole, and is repaired.
- The real host's `ezh0`, `EZIL-CT` rules, `ip_forward` and test links are compared before
  and after.

## Container confinement (`desktop.py build_spec`)

- Docker's default capabilities **minus `CAP_NET_RAW`** (13): no raw or packet sockets, so
  the container cannot forge packets. The full desktop (Xvfb, openbox, neko, Chrome,
  code-server) boots and passes its gate without it (`test-boot`).
- `noNewPrivileges`.
- seccomp `security/seccomp.json`.
- AppArmor `ezil-desktop` (`security/apparmor-ezil-desktop`).
- pids limit 4096, 2 CPU / 8 GiB.
- Read-only binds for `hosts`, `hostname` (`ezil-gen-<g>-e<e>`) and `resolv.conf`.
- tmpfs `/tmp` and `/run`.
- `/workspace` bound `nosuid,nodev`; `/var/lib/ezil-profiles` bound `nosuid,nodev,noexec`.
- Profiles set through `CHROME_PROFILE_DIR`, `CODE_SERVER_*` and `EZIL_PERSISTENT_PROFILES=1`.
  `worker/scripts/start-neko.sh` now skips its profile wipe when that flag is 1; the
  default behaviour is unchanged.

## §3a mapping

| §3a rule | Code | Test (`test/`) |
|---|---|---|
| 1 Host ops on volume content: no-follow, `S_ISREG`, openat | `fsops.py` (`open_dir_below`, `read_regular_at`, `remove_singletons`, `clear_dir`); `rebase.py` (dir-fd walk); `guard.py` (`read_marker`, `_mkdirs_nofollow`) | `test-hostile.sh` (symlink to a host file, block device, symlinked parents, symlinked upper, symlinked profiles/tmp); `test-guard.sh` (symlinked marker, planted layout symlink) |
| 2 `nosuid,nodev` volume and binds (profiles `noexec`) | `guard.py MOUNT_OPTS`, remount keeps them; `desktop.py` binds | `test-guard.sh`, `test-boot.sh` |
| 3 Confinement: seccomp blocking userns + mount, AppArmor, NNP, pids, ro binds, tmpfs | `desktop.py build_spec`, `security/` | `test-boot.sh` (each asserted inside the running desktop), `test-units.sh` (profile contents) |
| 4 User namespaces decided before the first user | not adopted (see Open items) | S1 experiment E3 |
| 5 Rebase: collisions moved aside; every rule has a failing test | `rebase.py move_aside` | `test-rebase.sh` (per-rule mutation table, collisions under `/usr/local` and `/opt`) |
| 6 Upper on the data device; durable marker | `guard.py write_file_durable_at` | `test-boot.sh` (`findmnt -T` on both hosts); `test-guard.sh` (strace order) + mutation M6 |
| 7 Merged overlay `nodev` | `desktop.py overlay_mount` | `test-hostile.sh` (device node through the merged path refused; control without `nodev` reads it); `test-boot.sh` |
| 8 Rebase failure → snapshot restore; planted preserve dir; deep trees; FIFOs/devices at image paths moved aside | `rebase.py run_job`, state file `.ezil-rebase-state.json` on the data root (invisible to the guest); iterative one-fd walk | `test-rebase.sh` (receipt required, fault → sticky `rebase_failed`, nothing downstream, restore + rebase, planted preserve symlink, 5000-deep tree; the recursive spike aborts on the same input) |
| 9 Profiles `noexec` | profiles bind | `test-boot.sh` (asserted). Extensions with native binaries are **not yet re-tested** |
| 10 Allowlist seccomp + dedicated AppArmor | `security/gen-seccomp.py`, `security/apparmor-ezil-desktop` | `test-units.sh`, `test-boot.sh` (the desktop boots under both) |

## Rebase job (R4, §3a.8)

An image upgrade is a per-computer job.
1. The control plane snapshots the volume.
2. It writes a **snapshot receipt** into that epoch's user data:
   `rebase: {snapshotId, volumeId, fromDigest, toDigest}`.
3. The guard rebases only if all of these hold:
   - the receipt's `fromDigest` equals the marker's digest;
   - its `toDigest` equals this host's lower;
   - its volume equals the lease's;
   - the old lower is present on the AMI.
   Without a receipt the guard refuses.
4. It writes `in_progress` durably, runs the rebase as a subprocess, and on any non-zero
   exit or crash records `rebase_failed`.
   - That state blocks every later boot until the control plane restores the snapshot
     named in the receipt; a restored volume has no state file.
   - The desktop never starts on a half-rebased upper.

## AMI (`ami/`)

**Packages are pinned.** The base must be Ubuntu 24.04. Every apt package is installed at
an exact version: the set the I4 tests ran with, overridable only by an explicit `PIN_*`
variable. They are then held. A pin that has left the archive fails the build, so either
bump it in review or set `UBUNTU_SNAPSHOT` for a fixed snapshot.ubuntu.com point in time.
cloudflared is pinned by version and SHA-256.

**cloud-init, verified versus unverified:**

| Item | Status |
|---|---|
| The agent wipes, after enrollment: `instances/*/user-data.txt`, `user-data.txt.i`, `obj.pkl`, `instance/…`, `/run/cloud-init/instance-data-sensitive.json` | **verified here** against a simulated cloud-init tree; unrelated cloud-init state (`sem/`, `datasource`) is untouched, and no nonce copy is left in the agent's tree |
| `allow_userdata: false` stops cloud-init from acting on the JSON user data | **unverified on a real AMI** |
| cloud-init rebuilds a missing `obj.pkl` on the next boot without re-running per-instance modules | **unverified** (it is a cache that `cloud-init clean` also removes) |
| `cloud-init clean --logs --seed` at build removes the build instance's own cached data | **unverified on a real build** |
| `DNSStubListenerExtra=10.200.0.1` binds although `ezh0` appears only after resolved starts | **unverified**; if it does not, the agent must restart resolved after `netns_up` |
| The AMI build as a whole | **not run** (no cloud calls) |

`build-host-ami.sh` runs on the Image Builder instance (`imagebuilder-component.yaml`).
It installs:
- `runc`, python3, AppArmor;
- **cloudflared pinned by version, with a required SHA-256** (no default; `sha256sum -c`);
- the agent, the units and the profiles.

It then extracts the desktop image **by digest** into `/var/lib/ezil/lowers/<image id>`,
verifies the image ID, and records it as `lowerImageDigest`. It can keep the N−1 lower
for rebases, removes the build-time Docker, sets cloud-init `allow_userdata: false`, and
enables the units.

It bakes in no secrets: `agent.json` holds only the enrollment URL. It was **not run** here
(no cloud calls); `test-units.sh` checks it statically.

## Tests

Run as root on a Linux host with Docker, runc, AppArmor and the `ezil-final` image:

```
test/run-all.sh       # cleanup -> units, guard, hostile, enroll/tunnel, rebase, full boot, worker test
test/mutate.sh        # mutation proof (--quick skips the two full-boot mutants); MUT_ONLY="M2 M9"
test/cleanup.sh       # removes every container, mount, loop device, netns, profile and scratch
```

**What is real:**
- a loop-device ext4 data volume behind a fake `/dev/disk/by-id` link;
- real runc and the real desktop image;
- the AppArmor profile, loaded as `ezil-host-fb25d9f4-desktop`.

**What is stubbed:**
- IMDSv2 and the HTTPS app run on **unix sockets** with a throwaway CA;
- `cloudflared` and `shutdown` are stubs.

The container network is loopback only, and no ports are published. Scratch goes under
`/var/tmp/ezil-host-fb25d9f4`.

**Mutation proof** (`test/mutate.sh`). Each mutant is applied to a throwaway copy of this
directory, and it counts as killed only if the named check fails.

| # | Mutation | Killed by |
|---|---|---|
| M1 | guard: epoch check removed | `test-guard`: same epoch replayed |
| M2 | guard: device fs-UUID check removed | `test-guard`: forged/copied marker that agrees with the lease |
| M3 | guard: generation-ahead check removed | `test-guard` |
| M4 | guard: digest mismatch accepted without receipt | `test-guard` |
| M5 | downstream units: stamp check removed | `test-guard`: steps refuse without a stamp |
| M6 | durable write: fsync(tmp) removed | `test-guard`: strace order |
| M7 | fsops: `O_NOFOLLOW` removed | `test-hostile`: symlinked profiles/chrome |
| M8 | rebase: move-aside → delete | `test-rebase`: collisions preserved |
| M9 | rebase: open non-regular dpkg status | `test-hostile`: FIFO never opened |
| M10 | rebase: failure swallowed | `test-rebase`: fault → `rebase_failed` |
| M11 | overlay without `nodev` | `test-hostile` (static; the `nodev` behaviour itself is shown by the control case) |
| M12 | tunnel: token not wiped on fence | `test-enroll-tunnel` |
| M13 | enroll: nonce kept after an answer | `test-enroll-tunnel` |
| M14 | control: HMAC check removed | `test-enroll-tunnel` |
| M15 | control: epoch check removed | `test-enroll-tunnel` |
| M16 | unit `Requires=` → `Wants=` | `test-units` |
| M17 | idle: dpkg-lock busy check removed | `test-boot` (real desktop) |
| M18 | spec: `noNewPrivileges` false | `test-boot` |
| M19 | data-down keeps the stamp | `test-guard`: steps refuse after data-down |
| M20 | data-device assertion removed | `test-guard`: volume unmounted behind the agent's back |
| M21 | upper-on-data-volume check removed | `test-guard`: upper bind-redirected to the host disk |
| M22 | non-finite ts accepted | `test-enroll-tunnel`: NaN ts |
| M23 | seq replay check removed | `test-enroll-tunnel`: exact replay |
| M24 | seq high-water mark not reloaded | `test-enroll-tunnel`: replay across a restart |
| M25 | warnSeconds bounds removed | `test-enroll-tunnel`: warnSeconds=901 |
| M26 | future skew 120 s | `test-enroll-tunnel`: ts +60 s |
| M27 | link-local not blocked | `test-network`: 169.254.10.10 |
| M28 | 10/8 not blocked | `test-network`: RFC1918 peer |
| M29 | DNS to the host dropped | `test-network`: DNS through the host resolver |
| M30 | ensure_rules always rebuilds | `test-network`: re-apply changes nothing |
| M31 | INPUT final drop removed | `test-network`: host port from the container |
| M32 | special files at image paths kept | `test-hostile`: FIFO/device moved aside |
| M33 | profile quarantine → refuse | `test-guard`: planted profiles/chrome |
| M34 | an unpinned apt install | `test-units`: AMI pins |
| M35 | obj.pkl not scrubbed | `test-units`: default scrub list |
| M36 | anti-spoof rule removed | `test-network`: forged source |
| M37 | ip6tables INPUT drop removed | `test-network`: v6 to the host with IPv6 re-enabled |
| M38 | `net-ensure` no longer disables IPv6 on `ezh0` | `test-network`: repair |
| M39 | drift check ignores IPv6 on `ezh0` | `test-network`: drift reported |
| M40 | `CAP_NET_RAW` back in the spec | `test-network` (probe container) |
| M41 | IPv6 never disabled on `ezh0` (both places) | `test-network`: no IPv6 address. Removing only the early, pre-link-up setting survives: `ensure_rules` sets it as well, and the early one only closes the window before the rules run |

`worker/src/neko-persistent-profiles.test.ts` (bun) executes the real `start-neko.sh`
profile block. It fails against the pre-change script.

## Operator runbook (stubs)

- **Guest planted something in its profiles.** Boot does not stop: the guard renames the
  odd `profiles/<name>` entry to `profiles/<name>.ezil-quarantine-<time>-<pid>` (never
  following it) and creates a real directory; `journalctl -u ezil-guard` shows
  `quarantined=…`. The user's old profile content is in that entry if it was a directory
  tree elsewhere; delete it once reviewed. If the **host-only** layout (`data/profiles`,
  `data/workspace`, `data/root`) is odd, the guard refuses
  (`layout_not_a_real_directory`): the guest cannot reach those paths, so this means
  operator error or corruption; attach the volume to a recovery host and inspect it.
- **Host will not become ready.** Run `journalctl -u ezil-guard`. A `REFUSE <code>` line
  names the check; the volume is left unmounted.
  - `epoch_not_increasing` or `generation_ahead`: a stale or duplicate lease. Recover
    through the lifecycle workflow; never hand-edit the marker.
  - `rebase_failed`: restore the snapshot in the state file's receipt to a new volume,
    then re-run the upgrade with a new receipt.
- **Tunnel down.** Check `journalctl -u ezil-cloudflared`. A fence exit is final for that
  epoch; a new lease brings a new token.
- **Stuck idle stop.** `journalctl -u ezil-agent` shows `flush=busy` while apt/dpkg runs in
  the guest. Caps still stop the instance from the control plane.

## Open items

These are interim or prototype:
- **seccomp:** an allowlist *mechanism* (default ERRNO) whose *content* is every x86_64
  syscall in the build headers minus the S1 denylist. It is not yet tightened to
  Docker's or containers-common's curated set.
- **AppArmor:** a dedicated profile modelled on the shape of docker-default, plus
  `deny mount, userns, pivot_root`, and `signal peer=runc`, which is needed on Ubuntu
  24.04. It has not been reviewed by a security owner.
- **User namespaces: not adopted, so the decision is still open (§3a.4).** The S1
  experiment showed that only an idmapped lower with a plain upper boots, and it shifts
  on-disk ownership. Decide before the first user.
- **Production networking:** exercised only in disposable namespaces, not on a real EC2
  host. The cloudflared ingress mapping to the desktop and the control socket belongs to
  the gateway lane and does not exist yet.
- **Enrollment response shape** `{tunnelToken, controlKey}` and the HMAC control
  protocol are defined here and need the app and gateway lanes to adopt them.
- **Not tested:**
  - code-server extensions with native binaries under `noexec` (§3a.9);
  - an NVMe device resolved on real Nitro hardware;
  - cloud-init `allow_userdata` on the real AMI;
  - the AMI build itself.

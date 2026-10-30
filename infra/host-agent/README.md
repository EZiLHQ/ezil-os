# EZiL AWS computer host agent (I4)

Runs on each AWS computer host (one EC2 instance per computer, Stage A). It mounts the
computer's retained data volume, checks the C-4 disk marker, starts the desktop container
on an overlay rootfs, enrolls with the app (C-6), supervises the per-epoch Cloudflare
tunnel, and idle-stops or honours a control-plane stop (R9). The contracts live in
`docs/AWS-COMPUTERS.md`; this directory implements the host side of R3, R4, R5, R9 and R15,
C-4, C-6, and §3a. The S1 spike (`feat/aws-s1-runtime-spike`) holds the runtime evidence.

The runtime agent uses Python 3 standard library only and makes no AWS API calls.
The AMI build uses its temporary instance role to pull the desktop image from ECR.

## Pool mode

A lease `{kind:"pool", poolHostId, poolGeneration, appOrigin?}` (optional `v:1`)
skips disk discovery at boot. `appOrigin` must be an HTTPS origin; when omitted,
the origin of the existing baked `enrollUrl` is used. No new environment settings
are required. The guard unit enrolls the pool host and starts a disposable desktop
using `stateDir/pool-desktop` for its writable overlay, workspace and profiles.
It has no user disk, tunnel or control key. Readiness requires both Neko on 8181
and code-server's `/healthz` on 8443 to answer inside the running container.

The pool client's wire format is:

- `POST /api/compute/aws/pool/enroll`: `{poolHostId, poolGeneration,
  identityDocument, signature}`; `signature` is the IMDS PKCS7, as in C-6.
- `POST /api/compute/aws/pool/ready`: `{poolHostId,
  health:{editorOk:true}}`.
- `GET /api/compute/aws/pool/claim`: no body. All three requests carry
  `X-Ezil-Pool-Host-Id`, `X-Ezil-Pool-Generation`, `X-Ezil-Identity-Document`
  (base64 of the exact document bytes), and `X-Ezil-Identity-Signature`
  (PKCS7 base64 without whitespace). Identity material never goes into a URL.

A 204 is an empty poll; polls are spaced by one second. Transport failures, 429,
and the existing enrollment retryable responses use exponential backoff from 1
to 30 seconds, bounded by `enrollRetrySeconds`. Other refusals and malformed
claims stop adoption. Idle hosts refresh enrollment and readiness every five
minutes to remain inside the contract's ten-minute enrollment window.

Claims require `{computerId, generation, leaseEpoch, fence, volumeSerial,
enrollNonce}`. The nonce uses the existing C-6 format and is passed as `nonce`
to the ordinary computer enrollment endpoint. There is no alternate pool proof.
Counters use the ordinary lease's positive 32-bit range. Duplicate JSON keys,
nonfinite values, malformed claims and device paths in `volumeSerial` refuse.

Before disk access, the host accepts only the claim returned by the authenticated
app connection for its signed instance identity. IMDS metadata tags are disabled;
the host never reads them. A host-only, fsynced `stateDir/pool-epoch.json` stores
the accepted generation, lease epoch, fence and instance binding. Both counters
must increase for a new acceptance, and single-use hosts refuse every second claim.
A nonblocking lock excludes concurrent guard activations.

A reserved claim resumes only on the same instance and pool generation, with
the exact saved claim. The saved lease pins the UUID before the marker commit; an
interrupted commit may reuse only the normal guard's exact same-instance marker.
Durable enrollment credentials are reused after a crash, and the nonce is removed
from both the lease and reservation after persistence. A settled enrollment
refusal burns the host. It never becomes an idle spare again.

After enrollment, the disposable desktop stops and its scratch data is deleted.
The existing clean/overlay/agent/edge/tunnel ordering lets the relay config arrive
before the desktop unit starts the user's disk-backed `/root`, workspace and
profiles. Pool desktops require that config within a bounded 30-second wait and
never start with `ice_missing`. The desktop unit starts detached runc and supervises
it; a process restart attaches to an already-running desktop instead of issuing
a second start. After an actual container exit, the existing bounded systemd
restart policy still applies. Editor/desktop health gets a separate 30-second wait.

The existing authenticated GW-5 `desktop` status response adds `sessionReady` for
adopted hosts. It is true only with the committed disk stamp, matching completed
claim, applied and unexpired relay config, and both desktop/editor health checks.
Until then, a running container is reported as `starting`. After the one desktop
switch and successful health check, the host sends an identity-authenticated
`POST /api/compute/aws/pool/session-ready` with `{sessionReady:true}`. The app
finishes the consumed enrollment at this time; acknowledgement retries preserve
that timestamp. Initial enrollment supplies tunnel credentials without starting billing.

New-volume claims carry `createVolume:true` and the placement's `fsUuid`. Only a
serial-selected device with no filesystem or partition signature can use the
existing cold-path initialization. Retained volumes are never reformatted.
Claim-to-ready p90 <=30 seconds still requires live measurement.

Offline tests (no sockets, AWS, Docker, real mounts or credentials):

```sh
python3 infra/host-agent/test/run-offline.py
python3 -m unittest discover -s infra/host-agent/test -p test_pool.py
python3 infra/host-agent/test/mutate-pool.py
```

The offline runner discovers the Python tests and explicitly excludes the TCP
`test_edge.EdgeE2E` class. Pool protocol tests use the in-process `PoolApp` variant
of `stub_servers.py`; block devices, IMDS and runc are mocked. The mutation runner
uses throwaway copies and names the regression for each removed guard. The full
privileged `test/run-all.sh` also includes pool tests through `test-units.sh`.

## Canary serial diagnostics (default off)

Set `canaryConsole: true` in the baked `/etc/ezil-host/agent.json` for a canary.
Only JSON boolean true enables it. Every record is a single `EZIL-CANARY `-prefixed
JSON line, at most 512 bytes. The destination is `/dev/ttyS0`, EC2 Linux's first
serial port; `/dev/console` can instead follow a VGA kernel-console selection.
The writer uses a nonblocking open/write, creates no device/file, and drops console
errors without redirecting general logs. Delivery is best effort, not an acknowledgement.

Read with `aws ec2 get-console-output --instance-id <id> --query Output --output text`.
On supported Nitro instances, add `--latest` for the latest available buffer.
See https://docs.aws.amazon.com/cli/latest/reference/ec2/get-console-output.html.
Actual serial capture and buffer timing on the target AMI are UNCONFIRMED.

Records:

- `guard`: verdict, committed marker generation/leaseEpoch and `lastStop` from
  `.ezil-last-stop.json`, projected to outcome/time/generation/epoch only. Refusal
  or error reports null metadata after unmount; no exception detail or stop reason.
- `persistence`: after the overlay mount and after every desktop stop attempt, before
  teardown. Reads only `/root/.ezil-canary-sentinel` and `/root/.bash_history` through
  the merged overlay (the spec fixes HOME to `/root`). Reports sentinel SHA-256,
  physical history-line count (including an unterminated final line), and exact
  presence of the line `: EZIL-CANARY-HISTORY-v1`; never history or sentinel contents.
- `desktop`: `started` only after observing runc's `running` state, otherwise
  `unconfirmed` after a bounded wait. This confirms the container, not app readiness.
- `stop`: each desktop stop outcome, including systemd/teardown without enrollment;
  an agent shutdown additionally reports its worst outcome and whether quiesce
  steps succeeded. Repeated stop calls (including restarts) can report `absent`.

Prepare the sentinel with public test data and the history marker in an offline or
boot fixture before comparing stops/cold boots. Probes never create or repair them.
Missing/unreadable files produce explicit statuses and null measurements; symlinks,
special files and oversized files are unreadable (64 KiB sentinel, 4 MiB history).
Compare the shutdown hash/count/marker with the next boot probe. This observes persisted
bytes; it does not establish that a live interactive shell flushed its history.

These hooks need no enrollment or control key and preserve guard/enrollment requirements.
Without an existing stop record, `lastStop` is null; its durable writer remains the agent.
Run the unprivileged tests with
`python3 -m unittest discover -s infra/host-agent/test -p test_canary.py`.

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
| 1 | `ezil-lease` | IMDSv2 token PUT → user data (lease + one-time nonce), identity document, PKCS7 → `/run/ezil-host/lease.json` (0600). IMDS transport errors are retried, bounded (`imdsRetrySeconds`, 60 s). Provisioning waits, bounded (`volumeWaitSeconds`, 300 s), for the data volume the workflow attaches only after the instance runs | malformed user data, IMDS HTTP refusal or persistent outage |
| 2 | `ezil-guard` | Wait, bounded (`volumeWaitSeconds`), for the lease volume's by-id link (the workflow attaches it after the instance runs), then resolve the NVMe device from the lease `volumeId` and check its fs UUID. Provisioning formats an *empty* device with the control plane's `fsUuid`. Mount **read-only** `nosuid,nodev`, then run the C-4 checks; on a digest change with a receipt, run the rebase job. Remount rw, write the marker (tmp → fsync → rename → fsync dir), then write the stamp | device missing or not a block device; fs UUID ≠ lease; marker missing (unless provisioning an empty volume) or malformed; computerId/volumeId/fsUuid mismatch; `generation` above the lease; `leaseEpoch` not below the lease (except the SAME instance rebooting in place in the same generation and epoch: the marker records the `instanceId` that took the epoch, read from the stored identity document; verdict `reboot`); digest mismatch without a valid snapshot receipt; `rebase_failed` state; a planted symlink at a host-only layout dir. Guest-reachable profile entries (`profiles/chrome`, `profiles/code-server-*`) that are not real directories are **quarantined** (renamed aside, never followed) instead. The marker is bumped only after all of this passes |
| 3 | `ezil-host-clean` | No-follow removal of Chrome `Singleton*` (R15, only after the guard) and of legacy `upper/tmp`, `upper/run` | a symlinked path component |
| 4 | `ezil-overlay` | Overlay `nodev,index=off,redirect_dir=off,metacopy=off,xino=off`; netns; OCI spec | lower missing, unknown network mode |
| 5 | `ezil-desktop` | `runc run` with the hardened spec (below); stop = TERM → KILL → delete → sync. `Restart=always` (5 s; at most 5 starts per 10 min) brings a crashed desktop back; an `ice` push that finds the unit exited or failed makes the agent `reset-failed` + restart it (at most `desktopRestartMax` per `desktopRestartWindowSeconds`, then `restartsExhausted`) | `runDir/stopping` exists: the agent is stopping this host (exit 2, `RestartPreventExitStatus=2`) |
| 6 | `ezil-enroll` | POST `{computerId, generation, leaseEpoch, nonce, identityDocument, signature}` over verified HTTPS. Store the tunnel token and control key host-only, and which instance enrolled which epoch (`enrolled.json`). A same-instance reboot in the same epoch reuses those (the nonce was already consumed) instead of posting it. **Wipe the nonce** from local state and from cloud-init's cached copies after any answer that settles it (success or a final refusal), and never re-send it. An answer that consumed nothing (transport error, the app's `retryable: true`, a 5xx the app did not author) keeps the nonce and is retried with backoff, bounded by `enrollRetrySeconds` (540 s, inside the 600 s nonce TTL) | final refusal, malformed response, retries exhausted (`enroll_retry_exhausted`, nonce kept) |
| 7 | `ezil-cloudflared` | Run cloudflared with the token in the **environment**, and restart it with backoff | token missing, or bound to another epoch |
| 8 | `ezil-agent` | Control socket (presence/stop/fence, HMAC + epoch + timestamp), idle predicate, quiesce, shutdown. A failed poweroff is retried with backoff (alternating with `systemctl poweroff --force`) until accepted; `Restart=on-failure`, and a restarted agent resumes a begun shutdown (`runDir/shutdown-pending`) | |

**Fence.** A `fence` op, a stop, a token from another epoch, or SIGTERM stops cloudflared
and **wipes** the token.

**Idle (#183 predicate).**
1. No gateway presence for 600 s.
2. Host 1-minute load below 0.5, strictly parsed; an unknown load counts as busy.
3. A **successful** flush. A dpkg/apt lock held in the guest (`busy`, detected host-side
   through `/proc/locks`) or a stale lease or fence (`stale`) blocks the stop and the
   check repeats.

Then the agent marks `runDir/stopping` (so the desktop's `Restart=` cannot bring it back),
stops the desktop, unmounts the overlay, syncs, unmounts the data volume and runs
`shutdown -h now`, retried until the OS accepts it. A blocked idle stop clears the mark.

**Terminal work (SIGNAL C).** Before checking load or marking a stop, the agent probes the
running desktop through `runc exec` with the Worker's `terminal-keepalive.ts` script. Any
tmux session or terminal foreground job holds the agent's idle stop for up to 8 hours after
last presence; idle prompts and background jobs do not count. A held cycle sets no mark and
flushes nothing; it logs `idle stop held: tmuxSessions/terminalJobs=<t>/<j>` and the check
repeats. The hold does not extend the control plane's lease: only owner presence renews it
(`leaseSeconds`, 3600 by default), so a lapsed lease still stops a held computer about an
hour after the owner left. The probe times out after 30 s; a user who returns during the
probe cancels the stop, and a stopped desktop, probe failure, malformed output or expired
cap leaves the ordinary
idle path in charge. Control-plane stops and fences still proceed.

**Stop outcome is recorded, never assumed.** `desktop.stop()` first hangs up the terminal
shells (below), then sends TERM, waits the grace, and only then KILLs. It returns:
- `absent` if nothing was running;
- `clean` if the desktop exited after TERM within the grace;
- `killed` if KILL was needed.

How the outcome is used:
- A killed desktop makes the flush `unclean`, never `ok`.
- The idle stop still proceeds on `unclean`: the desktop is already gone, and a running
  computer without a desktop only bills. It is logged as `shutdown: idle flush=unclean`.
- Before the data volume unmounts, the agent writes the boot's worst outcome durably to
  the data root (`.ezil-last-stop.json`, 0600, next to the marker, not reachable by the
  guest) with its reason, epoch and time.
- The next boot reports it in the `clean` step (`lastStop`), so an unclean stop is in
  the boot log. Reporting it to the control plane (for example at enrollment) is an open
  item.

## Terminal history across stop and cold boot

Bash writes `~/.bash_history` only when a shell exits, and a stop never lets an open
terminal exit, so without this the commands typed in an open terminal were lost. HOME
(`/root`) is on the overlay upper, on the data volume, so a written history file already
survives. The fix is injected **from the host**, so the image and the user's rc files are
untouched.

**How terminals are spawned.** The only user terminal is code-server's integrated one:
1. The OCI env is passed to `start-desktop.sh`.
2. `start-desktop.sh` execs `start-neko.sh`.
3. `start-neko.sh` runs `supervise_app` → `setsid code-server` (start-neko.sh:1975).
4. code-server starts `bash --init-file shellIntegration-bash.sh`. That script sources
   `~/.bashrc` and keeps an inherited `PROMPT_COMMAND`, which it evals from its own prompt
   function.

The image's openbox menu has no terminal entry, and `xterm` is not launched.

**Two mechanisms:**
1. **Per prompt.** The container env carries `PROMPT_COMMAND="history -a; shopt -s
   histappend"`. Any image `PROMPT_COMMAND` is kept after it. Every completed command is
   appended as the next prompt is drawn, so it survives even a KILL or power loss.
   - A read-only bind `/etc/profile.d/ezil-history.sh` does the same for login shells
     that reset the env.
   - The user's own `~/.bashrc` still runs later and wins.
2. **Before the stop.** Every bash/zsh **attached to a terminal** in the desktop gets
   SIGHUP, signalled through a pidfd so a recycled pid is never hit. This is what happens
   when a terminal window closes: the shell saves its history, including a command that
   is **still running**, and exits.
   - Scripts (no tty) and other programs are not hung up.
   - A forced KILL (`teardown --kill`) skips this.

**What is not preserved:** running processes, RAM, shell state (cwd, variables) and
terminal scrollback. zsh/fish need their own per-command options (zsh
`INC_APPEND_HISTORY`), and only the pre-stop hangup covers zsh.

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

"Exactly as desired" includes **rule order**. If an ACCEPT moves ahead of the drops, every
rule is still present, but the metadata, private and spoof holes are open again.
- iptables rewrites rules when it prints them: it reorders options and adds implicit
  matches (`-p udp` gains `-m udp`). So the comparison form comes from iptables itself.
- The desired rules are built in an **unreferenced** scratch chain `<chain>-C`, which no
  packet can reach. That chain is listed and removed again, and its listing must equal
  the live chain line for line.
- A failed `ip netns delete` is reported (`netns_delete_failed`), not ignored.

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
  drift, actually reopens the hole, and is repaired. The same holds for a **reordered**
  chain (ACCEPT moved first, same count and members). No scratch chain is left behind.
- The real host's `ezh0`, `EZIL-CT` rules, `ip_forward` and test links are compared before
  and after.

## Container confinement (`desktop.py build_spec`)

- Docker's default capabilities **minus `CAP_NET_RAW`** (13): no raw or packet sockets, so
  the container cannot forge packets. The full desktop (Xvfb, openbox, neko, Chrome,
  code-server) boots and passes its gate without it (`test-boot`).
- `noNewPrivileges`.
- seccomp `security/seccomp.json`.
- AppArmor `ezil-desktop` (`security/apparmor-ezil-desktop`).
- pids limit 4096; CPU quota equals the online CPU count. Memory is host `MemTotal`
  minus `hostMemoryReserveMiB` (default 512 MiB); less than 1 GiB remaining refuses
  spec creation. `cpuQuota` and `memoryLimit` are no longer used.
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

An image upgrade is a per-computer, snapshot-gated replacement. The control plane
fences the old writer and verifies a completed snapshot before issuing the nonce.
Hosts have no EC2 role and cannot verify snapshot completion themselves.

The lease carries both closed objects, in this serialization order:

```text
rebase: snapshotId, volumeId, fromDigest, toDigest
rebasePermit: v, preparationJobId, launchJobId, computerId, fsUuid,
              generation, leaseEpoch, fenceToken, issuedAt, expiresAt
```

`rebase` retains its four fields; permit `v` is integer 1. The permit binds the
computer, filesystem and counters to the enclosing lease. UUIDs are lowercase,
counters are integers 1..2147483647, and timestamps are canonical UTC milliseconds.
The lifetime is exactly 600 seconds. Rebase requires `provision:false`, an existing
volume ID and nonce, and excludes Cloudflare restore and EBS rebind. Unknown fields,
duplicate JSON keys, nonfinite numbers, null authorizations and mismatches refuse.
IMDS returns decoded user data: the host bounds it to 3072 UTF-8 bytes before parsing
(the workflow wire remains standard base64, at most 4096 characters).

Before remounting writable, the guard verifies marker identity/counters, the receipt
volume and digest pair, and the previous lower's presence. It refuses future issue
times beyond 30 seconds and requires **more than 120 seconds** until expiry. The
subprocess gets the remaining time minus that reserve, with a monotonic deadline
rechecked after preflight. Timeout kills and reaps the subprocess. Enrollment requests
and retries are capped by the original expiry. Completed same-instance, same-generation,
same-epoch reboots reuse the committed state and ignore the old permit's expiry.

The worker writes `.ezil-rebase-state.json` durably before mutation and leaves it in
place on success. The guard alone performs the commit sequence:

1. Complete rebase and layout checks.
2. Write the marker with temp write, file fsync, rename and directory fsync.
3. Unlink the state file and fsync its directory.
4. Publish `guard-ok`, bound to the entire committed marker tuple.

A crash before cleanup remains sticky even if the marker already names the new
lower; reboot never auto-clears that state. All downstream steps check the stamp,
mounted volume, marker and absence of sticky state. Regular files count as identical
to the old image only when bytes, mode, UID, GID, **ACLs and all xattrs** agree.
Unreadable metadata is preserved. The private report is retained on the data root as
`.ezil-rebase-report.json`, with a boot-local copy in `runDir`; user paths in it must
not be forwarded to public logs.

Enrollment appends `lowerImageDigest` after `signature`. It reads that digest from
the committed marker via fd-relative no-follow access and checks it against the baked
digest and guard stamp. A requested target digest is not host evidence.

### EBS maintenance recovery

EBS recovery is separate from Cloudflare `lease.restore`. The control plane restores
the checkpoint to a **different volume ID**, quarantines the failed source, then
supplies the contract v1 `ebsRestore` object:

```text
v, preparationJobId, recoveryJobId, launchJobId, snapshotId, originalVolumeId,
volumeId, computerId, fsUuid, fromDigest, sourceGeneration, sourceLeaseEpoch,
generation, leaseEpoch, fenceToken, issuedAt, expiresAt, maintenance
```

`maintenance` must be true, target counters must exceed the snapshot bounds, and the
lease cannot provision or carry another restore/rebase mode. The maintenance AMI's
baked lower must equal `fromDigest`. The guard mounts only the clone with ext4
`ro,noload,nosuid,nodev` and inspects the original marker without following links.
Sticky rebase state, wrong lineage, missing marker or counters above the snapshot
bounds refuse. No formatting, profile cleanup or overlay layout work runs.

After inspection the agent unmounts and mounts the clone writable, dropping `noload`
so ext4 can recover its journal safely; it validates the marker again before the
durable rebind. The lower digest and all upper/workspace/profile bytes are preserved.
Only an already committed **exact** target tuple (including instance ID) may resume.
It creates `maintenance-ok`, never `guard-ok`. Direct clean/overlay/desktop/edge/
cloudflared/agent steps refuse this lease on every boot.

`ezil-maintenance-enroll.service` depends only on the guard and reports through the
existing enrollment URL. It appends `ebsRestore:{v,recoveryJobId,snapshotId,
originalVolumeId,volumeId,fsUuid}` after the digest. Only
`{maintenance:true,accepted:true}` is accepted; the durable host receipt is
`stateDir/maintenance-enrolled.json`. No tunnel token or control key is stored.
The receipt is durable before nonce retirement and supports an exact same-instance
reboot. The ordinary enrollment service still requires the overlay; it cannot grant
desktop access during maintenance. `boot-chain` routes maintenance directly to its
receipt step after the guard.

The control plane must fence the maintenance writer and take a **new** completed
snapshot of the rebound volume before issuing a new linked rebase job. The host
cannot verify the failed writer's epoch or snapshot/provider lineage beyond the
locally delivered fields; app/workflow authority checks remain required.

`test/test-rebase.sh` exercises real ext4 clone IDs, repeated maintenance completion,
crashes immediately before/after marker commit, expired permits and exhausted blocks/
inodes. It needs a disposable privileged Linux host and the reviewed local Docker
image. Existing test-only `EZIL_REBASE_FAULT_AFTER` accepts entry counts or
`before-marker` / `after-marker` (exit 99); production units never set it.

## AMI (`ami/`)

The founder deploys and runs the pipeline using the explicit
[Host AMI operator commands](../app-computers/README.md#host-ami).

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
for rebases, removes the build-time Docker and ECR credential helper, sets cloud-init
`allow_userdata: false`, and enables the units. The helper is pinned to Ubuntu package
`0.7.1-1ubuntu0.24.04.3` (apt verifies the signed archive SHA-256), obtains ECR credentials
from the build instance role through IMDSv2, and disables its token cache. Its temporary
Docker configuration/cache directory is removed on success and failure. No registry login
or build role is attached to runtime hosts.

It bakes in no secrets: `agent.json` holds only the enrollment URL. It was **not run** here
(no cloud calls); `test-units.sh` checks it statically.

## Tests

A PROVISION lease may omit `volumeId` (or supply null). Before saving it, the lease
step resolves exactly one attached non-root EBS disk from Nitro by-id serials.
Root backing devices and partition aliases are excluded; zero or multiple disks
refuse. NVMe controller identity must agree with the serial, and its EC2 attachment
name must equal `dataDeviceName` (default `/dev/sdf`, not the guest NVMe path).
Other operations, including rebase, still require a volume ID. Explicit IDs also
refuse root backing devices before any filesystem operation.

Unprivileged provisioning and resource-limit tests (mocked devices, no AWS calls):

```
python3 -m unittest discover -s infra/host-agent/test -p test_provision_resources.py -v
```

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
| M42 | drift check compares rules as a set (order ignored) | `test-units`: reordered chain is drift |
| M43 | same as M42 | `test-network`: real reordered chain (ACCEPT first) detected |
| M44 | history `PROMPT_COMMAND` not injected | `test-units`: env + profile.d (real pty bash) |
| M45 | profile.d bind removed | `test-units`: env + profile.d |
| M46 | hangup ignores the tty test (hits scripts) | `test-units`: scripts and non-shells not hung up |
| M47 | bash not hung up | `test-units`: running command saved on hangup |
| M48 | no hangup before the stop | `test-boot`: [host B] command still running at stop survived |
| M49 | killed desktop reported `flush=ok` | `test-units`: never ok after KILL |
| M50 | `stop()` always says clean | `test-units`: absent/clean/killed |
| M51 | stop record not written on shutdown | `test-units`: record exists before the volume unmounts |
| M52 | netns delete failure ignored | `test-units`: failure reported |
| M53 | stop record written without the data volume mounted | `test-units`: refused, nothing written |
| M54 | boot does not report `lastStop` | `test-units`: reported at boot |
| M55 | `PROMPT_COMMAND` without `history -a` | `test-units`: open terminal appends each command |

`test/test_history_stop.py` (run by `test-units`) is unprivileged. Its history tests drive
**real interactive bash shells on ptys**. There is a control showing that a plain shell
loses the line on KILL, and a VS Code-style prompt wrapper. `test-boot` then does it on the
real desktop:
1. On host A, a terminal is spawned exactly as code-server spawns one (its environment,
   its bash integration script), with one finished and one still-running command, and it
   is left open.
2. Host A goes through the idle stop.
3. Host B (same volume, cold boot) has both commands in `~/.bash_history` and reports
   `lastStop`.

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
  - `rebase_failed`: restore the snapshot in the state file's receipt to a new volume and run maintenance rebind,
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
  host. The gateway now exists as `ezil_host/edge.py` (`ezil-edge.service`), built to
  GATEWAY-CONTRACT-v1: cloudflared's tunnel ingress (set by the Worker) points at
  127.0.0.1:18080; the edge verifies `x-ezil-gw` gw1 against `control.key` and the lease,
  forwards `/__p/<port>` to the desktop's exposed ports, relays presence (every verified
  request, every 30 s per open WebSocket) and `/__ezil/control/stop|fence` to the agent
  socket, and is the socket's only client (it owns `seq`). Exercised in a disposable netns
  (`test-edge.sh`), not yet through a real tunnel.
- **Enrollment response shape** `{tunnelToken, controlKey}` and the HMAC control
  protocol are defined here and need the app and gateway lanes to adopt them.
- **Stop outcome to the control plane.** `lastStop` is only in the boot log for now. The
  app should receive it, for example in the enrollment request, so the UI can say "your
  last session did not stop cleanly".
- **Teardown leaves rules.** `netns_down` removes the namespace and veth, but leaves the
  `EZIL-CT-*` chains and their jumps. They are DROPs that only match `ezh0`, and the next
  boot's `ensure_rules` rebuilds them.
- **Not tested:**
  - code-server extensions with native binaries under `noexec` (§3a.9);
  - an NVMe device resolved on real Nitro hardware;
  - cloud-init `allow_userdata` on the real AMI;
  - the AMI build itself.

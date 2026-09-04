# Roadmap

What EZiL-OS is trying to become, item by item, with the state of each **as of
2026-09-04** and — for every one — the measurement that would settle whether it
is real.

There are no dates in this file, and that is deliberate. A date is a promise
about a schedule; what this project can honestly publish is a promise about
evidence. So each item carries **What would prove it**: something you could run,
or read, and get an answer from. Where an item is partly done, the split is
stated rather than averaged into a percentage.

The plan behind this file is [`docs/TASKS.csv`](docs/TASKS.csv) — every task, the
files it may touch, what it depends on, and the command that verifies it. Row ids
below (`T3`, `G4`, …) refer to it.

## How to read Status

| Status | Means |
|---|---|
| `landed` | Merged into `main`, with the task's artifact in [`artifacts/runs/`](artifacts/runs/) recording it as done. |
| `in progress` | Being built now: rows in [`docs/TASKS.csv`](docs/TASKS.csv) for the round currently running, or a named unmerged branch. |
| `not started` | Nothing in the current plan builds it. A research row is not a build row. |
| `blocked on <what>` | A named prerequisite that no row in the plan can clear on its own. |

`in progress` says the work is planned and under way, not that any particular row
has been dispatched this minute;
[`docs/ORCHESTRATION-LOG.md`](docs/ORCHESTRATION-LOG.md) is what tracks that, and
this file does not try to. The `status` column inside `docs/TASKS.csv` is folded
from the run artifacts after each wave, so it can lag what is already merged;
where the two disagree, the merged commit and the run artifact win.

---

## Local mode — the same desktop, on your own machine

**Status:** in progress · **Rows:** T0, T1, T2, T5 (T4 for its CI leg)

A native host that runs on macOS, Windows or Linux, drives Docker through the
`docker` CLI, and publishes the container's ports straight onto `127.0.0.1`. No
Cloudflare account, no Worker, no Durable Object, no TURN broker — the container
is already a plain Docker image, and everything Cloudflare-specific lives outside
it. The local `/os` is plain HTML rather than React, because the hydration hazard
that forces the cloud page's shape
([`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md) §14) does not exist when
there is no React on the page; and the ports are direct rather than proxied,
because a path proxy re-creates code-server's origin check as a deny-all (§20).

**What would prove it:** on a machine with Docker installed and no Cloudflare,
Vercel or Supabase credentials present, the local doctor reports clean, and the
smoke test boots the pinned image, drives a browser to the local host's `/os` on
`127.0.0.1`, and asserts the desktop canvas has **non-uniform pixels**. A canvas
that is a single flat colour is the failure this project has already paid for
once — [`docs/RUNBOOK.md`](docs/RUNBOOK.md) § "The black desktop" is the account
— so "the page loaded" is not the assertion.

## One system anywhere, proven by CI

**Status:** in progress · **Rows:** T4 (`.gitattributes` from T0)

Every portable job runs on Linux, Windows and macOS. The jobs that need Docker
run on Linux only and **hard-fail** rather than skip, because macOS runners have
no Docker daemon and Windows runners cannot run Linux containers — so a
"passing" skip on those platforms would be the claim this item exists to
disprove.

Today [`.github/workflows/ci.yml`](.github/workflows/ci.yml) has four jobs
(`worker`, `app`, `connectors`, `shell`), every one of them on `ubuntu-latest`,
and no matrix at all.

**What would prove it:** a pull request shows a green check run from each of the
three OS legs for every portable job; the Windows leg's log lists the files it
parsed with `bash -n`, so the parse test is proven to have actually run there
rather than silently no-op'd; and the Docker-backed jobs exit non-zero when the
image is missing instead of reporting a skip as a pass.

## Container images on GHCR

**Status:** in progress (amd64) · **Rows:** T3

The desktop image is built from inputs in this repository and published to GHCR
with a keyless cosign signature and build provenance, so anyone can check that
the image they pull is the one this repository's workflow built from this
repository's commit. The Neko build inputs, which are currently built out of
repo from public upstreams, move in.

**arm64 is blocked on an arm64 base.** The image installs Chrome from
`google-chrome-stable_current_amd64.deb`
([`worker/Dockerfile`](worker/Dockerfile), line 116) and there is no arm64
equivalent to swap in; Apple Silicon therefore runs the amd64 image under
emulation, which the local doctor should warn about rather than hide.

**What would prove it:** `cosign verify` accepts the keyless signature on the
pushed digest and `gh attestation verify` accepts its provenance — for the digest
that was actually pushed, not for a tag that could be moved afterwards. For the
arm64 half: the same image builds for `linux/arm64` and boots a desktop on an
arm64 host with no emulation layer.

## A signed download

**Status:** in progress (scripts and tarball) · **Rows:** T6 (needs T3, T5)

The download is a **launcher pair plus a tarball** — `ezil-os.sh` and
`ezil-os.ps1` next to the local host, with `SHA256SUMS`, cosign keyless
signatures and SLSA build provenance — rather than native binaries. A script can
be read before it is run; an unsigned native binary is quarantined by Gatekeeper
or SmartScreen regardless of what else signed it, so shipping one unsigned would
be worse than shipping none.

**Native installers are blocked on org-level signing prerequisites**: an Apple
Developer ID with notarytool credentials, and an Authenticode signing route. Both
are account-level things a person has to obtain; no amount of code produces them,
which is why they are named here instead of scheduled.

**What would prove it:** on a clean machine with nothing installed but Docker,
the published `SHA256SUMS` verifies against the downloaded tarball and both
launchers, `cosign verify` and `gh attestation verify` accept the signature and
provenance, and running the launcher boots a desktop from the **pinned image
digest**. For the installer half: a downloaded installer that Gatekeeper and
SmartScreen open with no warning at all.

## Invite-only in the cloud, unrestricted locally

**Status:** blocked on the `os.ezil.work` cutover (DNS, the Vercel project
domain, and the Supabase redirect allowlist are founder-owned writes) ·
**Rows:** N1, then A1, A2

The hosted deployment moves to `os.ezil.work` and admits only accounts that have
been invited. Local mode has no gate at all: it has no Supabase, no login and no
account.

The gate has to be an **authorization** check, not a signup switch. The Supabase
project is shared with `app.ezil.work`, where builders must be able to keep
signing up, so a project-wide "disable signup" is not available; and anyone
holding the public anon key can create a user directly, so removing a signup form
gates nothing either. That leaves the one place authorization already lives —
[`app/src/server/api/trpc.ts`](app/src/server/api/trpc.ts) — plus the three page
gates, backed by an allowlist table. Because every `/api/shell/*` route and the
bearer path resolve through that same context, the SDK and the MCP connector are
gated with no extra code.

[`docs/ORCHESTRATION-LOG.md`](docs/ORCHESTRATION-LOG.md) records the cutover
(row N1) as blocked at the permission boundary: the three writes are changes to
shared infrastructure and belong to the account owner.

**What would prove it:** `dig +short os.ezil.work` returns the Vercel A record
and *not* a proxied anycast address; an invited account signs in at
`https://os.ezil.work/login` and reaches `/os`; and an account created directly
against the public anon key is refused at **every** entry point — the page, the
tRPC procedure and the bearer path — with commenting the check out letting it
through (RED) and restoring it shutting it again (GREEN). For local mode: a grep
over the local source finds no literal hostname of any kind.

## Public-repo governance

**Status:** in progress · **Rows:** G1, D1, G3 (landed), G2 (this file), G4

The plumbing an open project needs before outside contributors arrive, rather
than after. Three rows have landed on `main`: `G1` (merge `aaf158a`) corrected the
CODEOWNERS login to an account that exists and added CodeQL, a path labeler and a
stale sweep; `D1` stopped Dependabot opening major-version pull requests and named
the deferred majors in [`CONTRIBUTING.md`](CONTRIBUTING.md); `G3` (merge
`6df8495`) added the DCO sign-off check. `G2` is
[`GOVERNANCE.md`](GOVERNANCE.md) and this file. What remains is `G4` — enabling
Discussions and putting the branch ruleset on `main`.

**What would prove it:** `gh api repos/EZiLHQ/ezil-os/codeowners/errors` returns
`{"errors":[]}`; a pull request whose commits carry no sign-off makes the DCO
check **fail** rather than sit pending — a check that never runs is a required
context that hangs forever — and amending with `-s` turns it green; reading the
ruleset back through the API shows the required contexts, linear history and no
force-push; and Discussions is enabled, which
[`.github/ISSUE_TEMPLATE/config.yml`](.github/ISSUE_TEMPLATE/config.yml) already
links to. These workflows only started producing check runs on open pull requests
on 2026-09-04, and until `G4` makes them required contexts a red one does not
stop a merge — so "the check exists" and "the check gates" are two different
measurements, and only the first has been taken.

## Workspace sync to R2 from a local install

**Status:** not started · **Rows:** —

The cloud half already ships: a workspace is hydrated from R2 at boot and flushed
back as it changes ([`worker/src/workspace-persist.ts`](worker/src/workspace-persist.ts),
and step 7 of [`README.md`](README.md) § "How it works"). What does not exist is
the other end — a local install syncing the same workspace, so the same files
follow you between your own machine and a cloud desktop. It has no row in the
current plan, and it would be opt-in: a local install that phones home by default
would contradict the point of local mode.

Two rules any implementation inherits, both already paid for: the workspace is
never an R2 mount ([`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md) §1 — s3fs
silently drops every second write, zero bytes, no error), and a sync loop never
deletes (§10).

**What would prove it:** a file written inside a local desktop appears under the
same R2 prefix as a cloud one, a cloud desktop opened afterwards has it byte for
byte, and deleting nothing locally deletes nothing remotely — including when the
local side starts from an empty directory, which is the case that turns a sync
loop into a data-loss bug.

## Build the OS inside the OS

**Status:** not started · **Rows:** —

The contributor loop the project is aiming at: sign up as a builder on
`app.ezil.work`, open `os.ezil.work`, and work on EZiL-OS issues in a cloud
desktop — the OS building itself.

The handover between those two products is already specified. EZiL-Universe (a
separate EZiL repository, not this one) publishes a Universe ↔ OS contract of
signed envelopes and short-lived, single-use launch grants bound to a user and a
workspace, with `os.ezil.work` as the default OS base URL. That contract also
states, in its own words, that nothing in it is live and there is no OS
implementation yet. So what is missing is an implementation at both ends, not a
design.

**What would prove it:** somebody who is not a maintainer signs up as a builder,
is handed a desktop by a launch grant rather than by hand, works an issue inside
it, and opens the pull request from that desktop — the whole loop, once, by
someone who was not told how.

## Local agents

**Status:** not started as a build item · **Rows:** X1 (research only)

Computer-use drivers running against a local desktop, and GPU/CUDA passthrough
into the container. This is a research row this round and nothing more: `X1`
produces a measured survey at `docs/research/local-agents.md`.

Two facts shape it. The hosted platform has **no GPU and no hardware encode**
([`docs/PLATFORM-NOTES.md`](docs/PLATFORM-NOTES.md) §7), so anything needing one
is a local-mode capability by construction. And the seam already exists: the
browser sidecar in [`worker/sidecar/`](worker/sidecar/) has a **closed verb
allowlist and no CDP passthrough**, a rule [`SECURITY.md`](SECURITY.md) states as
a security property — executing an unlisted verb is a finding. A driver has to
fit that shape; widening it into a passthrough would be the easy version and the
wrong one.

**What would prove it:** first, the survey lands with every claim citing a URL or
a command actually run against this repository — no capability claimed from a
vendor's marketing page. A build item only follows from that, and its own proof
would be an agent completing a task on a local desktop with the sidecar's verb
list unchanged.

## The mobile keyboard

**Status:** in progress · **Rows:** — (branch `wip/mobile-keyboard`)

A soft keyboard that survives predictive text on every mobile keyboard. It is the
one unchecked box under "Stream the desktop to any device" in
[`README.md`](README.md). As of 2026-09-04 the branch is one commit ahead of
`main` and 36 behind it, with container tests failing, and it is deliberately not
merged this round.

**What would prove it:** [`e2e/prod-mobile-keyboard.mjs`](e2e/prod-mobile-keyboard.mjs)
green against a real deployment on a real touch device — not a desktop browser
emulating a phone, which is a different code path and has passed while the real
thing was broken.

---

## What this file is not

It is not a commitment to deliver any of the above, and it is not ordered by
priority beyond the order the work actually depends on. An item can move to
`blocked` when a prerequisite turns out to be someone else's to give; one already
has, and two others carry a blocked half. When that happens the blocker is named here rather than absorbed into a
slipping estimate.

This file is updated the way anything else here is — a pull request, reviewed
under [`GOVERNANCE.md`](GOVERNANCE.md). If a status in it disagrees with
[`docs/TASKS.csv`](docs/TASKS.csv) or with what is merged, the merged commit is
right and this file is stale; say so in an issue.

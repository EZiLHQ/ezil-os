---
id: OSOS-01
title: Build the OS inside the OS — the Universe↔OS contract, OS side
labels: [app, "size/XL"]
prereq:
state: open
---

## The problem

The contributor loop this project is aiming at is: sign up as a builder on `app.ezil.work`,
open `os.ezil.work`, and work on EZiL-OS issues in a cloud desktop — the OS building itself.
The handover between those two products is already specified in a sibling repository:
EZiL-Universe publishes a full Universe ↔ OS contract of Ed25519-signed envelopes and
60-second, single-use launch grants bound to a user, an assignment, a workspace and a device
(`EZiL-Universe/core/app/Domain/OsContract/LaunchGrant/LaunchGrantService.php:111-119`), with
`os.ezil.work` as the default OS base URL. That contract's own README states, in its own
words: "**Status: nothing here is live.** There is no OS implementation yet" — this repository
has no code that consumes a launch grant, verifies its signature, or accepts a builder handed a
desktop this way (grepped: no `LaunchGrant`/`os-contract` reference anywhere under this
repository's source). So what is missing is an implementation at both ends, not a design.

## Acceptance criteria

- EZiL-OS accepts a launch grant issued by the Universe contract, verifies its Ed25519
  signature, and honors its binding (user, assignment, workspace, device) before opening a
  desktop — a forged or expired grant is refused.
- A single-use grant cannot be replayed — a second attempt to redeem the same grant fails.
- The 60-second TTL is enforced on the OS side independently, not only trusted from the
  issuer.
- End to end: someone who is not a maintainer signs up as a builder, is handed a desktop by a
  launch grant rather than by hand, works an issue inside it, and opens the pull request from
  that desktop — the whole loop, once, by someone who was not told how (`ROADMAP.md`'s own
  "what would prove it" for this item).

## Where to look

- `EZiL-Universe/core/app/Domain/OsContract/LaunchGrant/LaunchGrantService.php:111-119` — the
  grant-issuing side, including the 60-second TTL (`self::TTL_SECONDS`) and the `os.ezil.work`
  default base URL.
- `EZiL-Universe/docs/universe-v2/os-contract/README.md:16` — "Status: nothing here is live.
  There is no OS implementation yet."
- `ROADMAP.md` § "Build the OS inside the OS" — the exact framing and "what would prove it"
  this issue is opened from.
- This repository has **no** consuming code yet — verified by grep for `LaunchGrant` and
  `os-contract` across `app/`, `worker/`, `shell/`; the only hit is `ROADMAP.md` itself.

## How to prove it

The end-to-end loop stated in the acceptance criteria: a real builder signup, a real launch
grant issued and redeemed, a real desktop opened by it, and a real pull request filed from
inside that desktop.

## Prerequisite

None — but this is the largest issue in the backlog by scope (`size/XL`) and touches an
authorization boundary; expect review to be thorough.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../../CONTRIBUTING.md#how-to-send-a-pull-request).

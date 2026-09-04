---
id: SYNC-01
title: Opt-in workspace sync from a local install to R2
labels: [local, worker, "size/L"]
prereq:
state: open
---

## The problem

The cloud half of workspace sync already ships: `worker/src/workspace-persist.ts` hydrates a
workspace from R2 at boot and flushes it back as it changes. The other end does not exist — a
local install has no way to sync the same workspace, so files do not follow a user between
their own machine and a cloud desktop. `ROADMAP.md` § "Workspace sync to R2 from a local
install" names this directly: "It has no row in the current plan, and it would be opt-in: a
local install that phones home by default would contradict the point of local mode." Two rules
any implementation inherits are already paid for and must not be re-broken:
`docs/PLATFORM-NOTES.md` §1 (R2 mounted via s3fs silently drops every second write — never
mount R2 directly) and §10 (a sync loop must never delete).

## Acceptance criteria

- Sync is opt-in — off by default, requiring an explicit flag or config value in local mode;
  no local install phones home without the user asking it to.
- A file written inside a local desktop appears under the **same R2 prefix** a cloud desktop
  for the same workspace uses (`realPrefix`, `worker/src/workspace-persist.ts:164`) — the two
  ends share one namespace, not two.
- The flush path's bucket interface exposes **only `put()`**, per `docs/PLATFORM-NOTES.md` §10
  — "Enforce it in the type system, not by convention... It then cannot delete, because it has
  no method to." A sync loop that starts from an empty local directory must not delete anything
  remotely.
- R2 is never mounted as a filesystem (no s3fs) — reads and writes go through the R2 API
  directly, per `docs/PLATFORM-NOTES.md` §1.
- A cloud desktop opened after a local sync has the same files, byte for byte.

## Where to look

- `worker/src/workspace-persist.ts:190-260` — `hydrateWorkspaceFromR2`, the existing
  cloud-side hydration this issue's local half must produce byte-identical results against.
- `worker/src/workspace-persist.ts:327` — the `put`-only bucket interface type (`FlushR2PutResultLike`)
  the local sync path should mirror.
- `docs/PLATFORM-NOTES.md` §1 ("R2 mounted via s3fs silently drops every second write") and §10
  ("Sync loops must never delete").
- `ROADMAP.md` § "Workspace sync to R2 from a local install" — the exact framing and "what
  would prove it" this issue is opened from.

## How to prove it

A file written inside a local desktop, synced, then read back byte-for-byte from a cloud
desktop opened on the same workspace afterward — and, separately, a sync run starting from an
empty local directory against a non-empty remote prefix that deletes nothing remotely.

## Prerequisite

None.

---

Want to work on this? Comment on the issue to claim it, then read
[How to send a pull request](../../CONTRIBUTING.md#how-to-send-a-pull-request).

# Persistence signal — pinned contract

This is the single contract shared by the Worker producer and the app consumer and view. Change it here first, in the same commit as both sides.

The signal answers one question per computer: **did the last restore and the last saves of its two persistent layers succeed, and if not, why.**

Two layers are covered:
- `/workspace`, the workspace checkpoint;
- the system layer: HOME, apt, npm -g and /opt.

It is metadata only: reason codes, counts, size buckets and ages. It **never** carries file paths, file or package names, commands or content. That is what keeps it valid after the layers are end-to-end encrypted.

## 1. Telemetry event

| Field | Value |
|---|---|
| `eventClass` | `persistence` (added to `EVENT_CLASSES` in `app/src/server/telemetry/types.ts` and `TELEMETRY_EVENT_CLASSES` in `worker/src/telemetry.ts`) |
| `source` | `worker` |
| `site` | one of `PERSISTENCE_SITES` below |
| `code` | one of `PERSISTENCE_CODES` below (already `[a-z0-9_]+`) |
| `outcome` | `ok` (committed / unchanged / restored), `skipped` (a deliberate refusal: too_large, stale, not_restored, …), `error` (failed) |
| `durationMs` | the operation's wall time, when there is one |
| `computerId` | the real `ezil_computers.id` UUID that the app sent as `projectId` to `/sandbox/preview`, stored in DO storage. **Never** the sandboxId. Omitted if the DO has none. |
| `detail` | never set |
| `attrs` | only the keys in §2 |

`PERSISTENCE_SITES`:
- `persist.system.restore`, `persist.workspace.restore`;
- `persist.system.flush`, `persist.workspace.flush`;
- `persist.stop`: idle-stop or teardown actually discarded the container. `code` is the final flush outcome, and `discarded_unsaved` is true when that outcome was not ok.
- `persist.open_blocked`: the preview open returned `workspace_persistence_unavailable` or `workspace_checkpoint_failed`.
- `persist.heartbeat`: the current state of both layers, at most every 15 min while the computer is active.
- `persist.shell_seen`: **source `shell`** — the browser saw `savingPaused` change (§5).

`PERSISTENCE_CODES`:
- `ok`, `unchanged`
- `too_large`, `stale`, `not_restored`, `failed`, `busy`
- `no_baseline`, `no_manifest`, `no_computer`, `no_snapshot`
- `already_restored`, `legacy_discarded`
- `container_not_hydrated`, `hydration_incomplete`, `deferred`, `empty_prefix`, `flush_threw`
- `workspace_persistence_unavailable`, `workspace_checkpoint_failed`
- `unknown`

## 2. `attrs` allow-list for `persistence` (≤ 8 keys; anything else is stripped by the app)

| key | type | meaning |
|---|---|---|
| `entries` | number | entries in the capture or restore (when known) |
| `size_bucket` | string | `lt_64m` · `lt_256m` · `lt_512m` · `over_cap` (tar bytes, when known) |
| `system_age_s` | number | seconds since the system layer's last OK commit; −1 = never |
| `workspace_age_s` | number | seconds since the workspace's last OK commit; −1 = never |
| `consecutive_failures` | number | non-ok outcomes in a row for this site's layer |
| `trigger` | string | `interval` · `final` · `readiness` · `idle_stop` · `teardown` · `open` · `heartbeat` |
| `discarded_unsaved` | boolean | only on `persist.stop` |

## 3. Emission rule (Worker)

- An event is spooled **immediately** whenever a layer's `(site, code)` differs from the last one spooled for that layer.
- `persist.stop` and `persist.open_blocked` are always emitted.
- `persist.heartbeat` is emitted when ≥ 15 min (`PERSISTENCE_HEARTBEAT_MS`) have passed since the last persistence event *and* the container is running.
- Identical repeats in between, such as the failed-capture loop, are suppressed.

Events go to the existing R2 spool (`TELEMETRY_R2_BUCKET`, `buildTelemetryR2Key` + `serializeTelemetryBatch`). There is no new credential.

## 4. Attribution (app)

The drain (`app/src/server/telemetry/spool-drain.ts`) resolves `computerId → ezil_computers.user_id` and stores `safeUserHash(owner)` instead of `WORKER_SENTINEL_USER_HASH`. Events without a computer, or with an unknown one, keep the sentinel hash and get `computer_id = NULL`.

`ingestBatch` must never lose a whole batch to the `computer_id` foreign key:
- an unknown computer UUID nulls that row's `computer_id`, and the row is still inserted;
- on the shell path, a `computerId` not owned by the session user is nulled.

## 5. Status endpoint (Worker → app → shell)

**Worker:** `GET /sandbox/:name/persistence`, gated by the same signed control request as `relay-refresh`. It returns `{ ok: true, status: PersistenceStatus }`.

```ts
type PersistenceLayerStatus = {
  code: PersistenceCode;            // last outcome for this layer
  outcome: 'ok' | 'skipped' | 'error';
  committedAgeS: number | null;     // null = never committed
};
type PersistenceStatus = {
  system: PersistenceLayerStatus;
  workspace: PersistenceLayerStatus;
  savingPaused: boolean;            // system code ∈ {too_large, stale, not_restored} OR workspace code = too_large
  pausedLayer: 'system' | 'workspace' | null;  // system wins when both
  pausedReason: 'too_large' | 'stale' | 'not_restored' | null;
  lastStopDiscardedUnsaved: boolean; // the previous container was discarded with an unsaved layer
};
```

**App:** the tRPC query `cloudflareGuacamole.persistenceState({ computerId })` checks ownership with `assertOwnedComputer`, like `relayState`. It returns `{ ok: true, status }` or `{ ok: false, error }`.

**Shell:** while a computer is open, the shell polls this no faster than every 60 s.
- When `savingPaused` is true, it shows one line: "Saving is paused: your home folder is over the 512 MB limit" (`system`/`too_large`), or the workspace equivalent. "stale" and "not_restored" say that saving stopped and that reopening the computer restores it.
- It relays a `persistence` event through the authenticated `POST /api/shell/telemetry` on each window's first observation (`ok` included) and on each change of `pausedReason`, with site `persist.shell_seen` and the code being the reason (or `ok` when cleared). That makes broken saving visible within seconds for anyone who has the computer open, without waiting for the daily spool drain. The first observation is what clears a pause reported by an earlier window once saving has recovered.
- The shell's telemetry never drops a change of code for a computer (the per-key cap of three does not apply to this class). Identical repeats, one per window open, share a cap of 20 per page life.

## 6. Switch-off guarantee (power cut)

A computer must behave like a machine with a disk. Pull the plug with no
warning, no SIGTERM and no final save. Switch it on again, and everything that
was finished on disk is back.

Cloudflare containers have no persistent disk. "On disk" therefore means
"committed to R2", and the guarantee is time-bounded:

> **Anything finished at least 90 s before a sudden switch-off is restored**
> on the next start. That covers `/workspace`, files and installs under HOME,
> npm -g, apt, `/opt`, dotfiles and the editor's settings backup.
> Dependency trees that restore-deps rebuilds come back through restore-deps.

### Mechanism

**Workspace.** Each 10–60 s cycle uploads a changed workspace at most every 60 s.
This is unchanged.

**System layer, dirty-triggered capture.** This replaces "every 5 min only".

**Probe.** The new codec op is `sys-dirty`. It answers whether any entry under the system ROOTS (minus EXCLUDE, package caches in every home and regenerable project trees) has an mtime newer than `/var/lib/ezil-system/capture-started`, or a metadata-only change (chmod/chown: a newer ctime) that the next capture would save differently.
- Directories count, because creating or deleting a file bumps its directory's mtime.
- **Metadata.** A newer ctime with an unchanged mtime counts only where the capture would now hold a different entry than the committed layer:
  - an entry the committed record holds (`/var/lib/ezil-system/committed-meta.json`: kind, mode and owner of every entry restored or committed) counts when its kind, mode or owner differs from that record, so a chmod back to the exact baked mode counts too;
  - elsewhere, an entry counts when it differs from the image manifest and its ctime is newer than the desktop-up baseline.
  - A newer ctime alone never counts (on Cloudflare, untouched image files get a fresh ctime when first read), nor a root's own ctime, nor a platform change before the baseline.
  - Restore writes the record; capture stages it, and `sys-committed` promotes it with the marker. A container restored by a codec without the record compares restored entries with the image manifest instead.
- It stops at the first hit. The image manifest and the record load only at the first metadata-only candidate.
- It prints `{"dirty": true|false}` and exits 0.
- A missing marker means dirty.
- Cost on the real image: about 0.2–0.4 s warm, about 4 s for the first cold walk; about 0.8 s for a metadata hit and 1.4 s for a full walk over fresh ctimes (local image, 2026-10-12).

**Marker.** `sys-capture` touches `capture-started` *before* its walk. A change made during a capture is therefore seen as dirty by the next probe.

**Durable Object.** On each flush cycle, if at least `SYSTEM_DIRTY_PROBE_MS` (15 s) has passed since the last probe, it runs `sys-dirty`.
- If the layer is dirty and at least `SYSTEM_DIRTY_MIN_GAP_MS` (45 s) has passed since the last system capture start, and B2 backoff is not active, it runs an interval system capture now.
- If the layer is dirty inside the gap, the Durable Object remembers it (`ezil:systemDirtyPendingAt`, no re-probe) and schedules the next cycle for the gap's end instead of its backed-off cadence.
- After an interval capture, the next cycle comes as soon as the probe spacing allows, because a change made during the capture's walk is not in it.
- These never shorten a cycle below 1 s, never lengthen the cadence, and never apply during B2 backoff.
- A successful restore into a fresh container restarts the system clocks: its first cycle probes rather than running a full capture.
- The 5-min periodic capture stays as a backstop.
- Final captures (idle-stop, teardown, readiness) are unchanged.

**Measured bound — open for a founder decision (2026-10-12).** Let D be the system capture's duration. Measured with the Durable Object's own scheduled cadence:
- A change made just after a capture starts commits within max(45 s, D + 1 s) + D.
- A change on a computer whose cadence has backed off to 60 s commits within 60 s + D.

So the 90 s promise above holds while D ≤ 30 s. A small layer took D = 2.2 s on a local real-image run. A layer near the 512 MiB limit can take longer, and then exceeds 90 s. This promise is not changed here.

**Power cut (staging acceptance only).** The new acceptance fault is `power_cut`. It exists only in the scoped staging acceptance sandbox, like the existing faults. It destroys the running container at once:
- no final flush;
- no idle-stop path;
- no SIGTERM handling relied on.

The next open must hydrate from R2.

### Tests that prove it (all required)

1. **Worker unit, with a fake clock and container.**
   - A change, then cycles, then a capture happens within 90 s.
   - A clean probe means no capture.
   - B2 backoff is respected.
   - After a power cut (container gone, no final flush), hydrate restores the last commit.
2. **Container suite, real image, `docker kill -s KILL`.**
   - Install tools, a HOME project with a lockfile, dotfiles, and workspace and editor files.
   - Probe returns dirty, then capture, then the power cut.
   - A fresh container restores, then restore-deps runs.
   - Checksums match, `command -v opencode` resolves, and `next` resolves.
   - Work done *after* the last capture is reported dirty and is lost, which documents the RPO.
3. **Staging (real Cloudflare), `e2e/hosted-home-persistence.mjs`.**
   - Install with the official OpenCode installer, create a Next.js project in HOME, edit dotfiles.
   - Wait at least 90 s, then `power_cut`, then reopen.
   - Checksums and the commands must still work.

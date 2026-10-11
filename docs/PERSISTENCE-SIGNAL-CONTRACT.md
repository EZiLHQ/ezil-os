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
- It relays a `persistence` event through the authenticated `POST /api/shell/telemetry` on each change of `pausedReason`, with site `persist.shell_seen` and the code being the reason (or `ok` when cleared). That makes broken saving visible within seconds for anyone who has the computer open, without waiting for the daily spool drain.

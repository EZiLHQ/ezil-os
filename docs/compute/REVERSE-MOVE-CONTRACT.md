# Reverse move contract: AWS → Cloudflare (Phase B, round 6b)

**Status:** pinned (S0 r2), 2026-10-30. Lanes H, W, A, U and O build against this file in parallel.
A change to any wire shape, state, code or limit below changes this file first. Every lane cites the
section it implements. r2 applies the review of `dc362e53`; §10 lists what changed.

**Base:** citations are `path:line` at `74ed2c92`. They point to the code each rule is based on.
Citations to `provider-reverse-store.ts`, `0012` and the edited `provider-migrate-store.ts` are to this
branch (`r6/phaseb-20261030`).

**What S0 ships (done, tested):**
- `app/drizzle/0012_compute_reverse_moves.sql`: the table, §3.
- `app/src/server/lib/compute/provider-reverse-store.ts`: the store, §3.4, including the point-of-no-return
  marker `commit_sent_at` and the per-state anchor `state_entered_at`.
- The cross-direction exclusion in both stores, §3.3.
- The Drizzle model `computeReverseMoves` in `app/src/server/db/schema/computers.ts`.
- Registration: drizzle journal idx 8, staging `EXPLICIT_FILES` plus the aws-production refusal, and a
  production `snapshot` source (digest of the r2 file).

Everything else below is a contract for lanes that have not started.

---

## 0. Decisions this contract assumes (taken; not reopened here)

| # | Decision |
|---|---|
| D-1 | **Export channel.** A signed host edge op plus a maintenance-agent AMI bake. No SSM: hosts keep no instance role (rule R5, `infra/app-computers/README.md:176,194-214`; `infra/app-computers/lib/lifecycle/helper.ts:603`). |
| D-2 | **Reverse moves live in a NEW table.** 0006 is never relaxed. None of the forward readers filter by direction: `provider-migrate-store.ts:107-118,131-144`, `provider-migrate-placement.ts:27-34`, `placement.ts:1897`, `select.ts:120-126`. |
| D-3 | **The export boot is a normal replace boot on the published placement row**, at placement generation N+1 and lease epoch E+1. It is identified from the reverse row (`export_boot`), never from `lastError`, because enrollment overwrites `lastError` (`placement.ts:1533,1569`). |
| D-4 | **v1 moves `/workspace` only.** It records the codec's skipped count, and refuses when over the workspace cap (the files stay on AWS). The UI says before and after what is not moved (§6.3): settings and programs added on the AWS computer (HOME dotfiles, installed packages), browser sign-ins (profiles), and rebuildable build folders the codec drops (§2.3). |
| D-5 | **Triggers (D20).** v1 ships the user action "Move my files to my Free computer" (`startedBy: 'user'`) **and the next open** (`'open'`, §5.9). Cron (`'cron'`) follows after canary2 acceptance. A founder-owned account moves only on that account's own Move click (§5.9.1). |
| D-6 | **Retention (D21).** The AWS volume **and a snapshot** are kept 14 days after commit, on the reverse row. The snapshot is mandatory (§7). Deletion is operator-only (rule R11). |
| D-7 | **No new env vars or flags.** The existing AWS admission kill switch gates new move work (`aws-config.ts:274`). |

**Naming rule (all new wire formats):**
- `generation` always means the move's **import generation**: a lowercase UUID, immutable per reverse row.
  It is the chunk owner and the new v1 head's `generation`/`chunkGeneration` in the store. This holds for
  HTTP bodies, the export head, Worker routes and the DB.
- The placement's integer counters are always `placementGeneration` and `leaseEpoch`. They are never
  called `generation`.
- **Exception, inside the host agent only** (socket messages, `state.json`, Python): the import
  generation is `importGeneration`, because the agent's lease already uses `generation` as an integer
  (`lease.py:45`).

---

## 1. Lanes and ownership

| Lane | Owns | Builds | Must prove (live, canary2 only) |
|---|---|---|---|
| **S0** (done) | 0012, `provider-reverse-store.ts`, the forward exclusion, registry | §3 | 0012 applied on the staging DB before the app deploys: plan, then apply with `--target aws-preview` (schema before code). |
| **H** host + AMI | `infra/host-agent/lib/ezil_host/{edge,agent,export,desktop}.py`, the additive codec op in `worker/src/workspace-snapshot-script.ts` (§2.6; W does not edit that file), codec parity, maintenance-agent bake | §2 | T0 (b), (b2), (e), (k); staged files on the root volume only. |
| **W** Worker import | `worker/src/index.ts` routes, `workspace-migration-import.ts`, start-fence change, prefix helper | §4 | T0 (g), (h), (l); heads before and after (T3); the first Cloudflare open hydrates with no `workspace_migrated`. |
| **A** app machine | `provider-reverse.ts`, `provider-reverse-runtime.ts`, the `aws-receipts.ts` export-boot mode, `placement.ts` writers, `select.ts` routing, trigger mutations and the open trigger, sweep hook, summary DTO | §5, §6.1 | T0 (c), (d), (f), (j); race T6. |
| **U** shell | `shell/ezil/ui/Settings/tabs/computers.js` move cards, copy and retry | §6 | Copy matches §6.3 in every state, with screenshots. |
| **O** retention | the D21 snapshot executor, `retention.ts` listing, `ops.ts` DLM role, operator purge runbook | §7 | `iam get-role` path; a snapshot recorded on the T3 row; listing shows the committed row after 14 days (dry run). |

---

## 2. Host export (lane H)

### 2.1 Why a new op, and why a bake

- The edge routes are a closed set: `/__p` to desktop ports, `stop`/`fence`, `ice`, `desktop`, and `restart-desktop`. Everything else gets 404 (`edge.py:9-16,51-62,350-376`).
- The agent refuses any other op with `unknown_op` (`agent.py:159-176`).
- Lease keys are closed (`lease.py:45,166`).
- The agent code lives in the AMI at `/opt/ezil-host` (`build-host-ami.sh:59-61`).

So the export needs new edge routes, a new agent op and a bake. The bake is the **maintenance-agent** bake, which keeps the promoted lower (`deploy/aws/mum/json-tool.py:1020-1025`), so the volume's digest guard still passes (`guard.py:323`).

### 2.2 Edge routes (all gw1-verified; each verified request counts as presence)

The signature is unchanged: `x-ezil-gw: gw1.<ts>.<hex>` = HMAC-SHA256(controlKey, `gw1|ts|computerId|generation|leaseEpoch|METHOD|path`), with skew −120/+5 s (`edge.py:1-7,45-46`; Worker signer `aws-origin.ts:165-173`). Here `generation` is the placement's integer, as today. The signature covers the path only, so **every input is in the path, or a body whose sha256 is in the path**, as `ice` does (`edge.py:58-60,408-425`).

| Method + path | Body | Served by | Success | Errors (JSON `{ok:false,error}`) |
|---|---|---|---|---|
| `POST /__ezil/control/export/<sha256hex(body)>` | Required. `Content-Length` 1..1024, no `Transfer-Encoding`, no query. Canonical JSON `{"v":1,"moveId":"<uuid>","generation":"<uuid>"}` with exactly these keys, lowercase UUIDs. | edge → agent op `export` (§2.5), then the edge reads `state.json` | `202` with the §2.4 status. Idempotent for the same `{moveId, generation}`. | `400 export_body_invalid`, `400 export_digest_mismatch`, `409 export_busy` (another `{moveId, generation}` holds the host), `409 export_invalid` (the agent refused the message), `503 agent_unavailable` (the agent socket failed or timed out, as `edge.py:393,401`) |
| `GET /__ezil/control/export/status` | none, no query | **edge, from disk** | `200` with the §2.4 status (`state: "none"` before any POST) | `503 export_state_unreadable` |
| `GET /__ezil/control/export/head` | none, no query | **edge, from disk** | `200` with the §2.3 export head | `409 export_not_ready` |
| `GET /__ezil/control/export/chunk/<i>` | none, no query. `<i>` is decimal with no leading zeros, `0 ≤ i < chunks.length`. | **edge, from disk**, streamed | `200 application/octet-stream`, exact chunk bytes, `Content-Length` = `chunks[i].size` | `400 bad_chunk_index`, `409 export_not_ready`, `404 export_chunk_missing` |

- The edge runs as root and reads `/var/lib/ezil-host/export/state.json` and the staged files directly. Status, head and chunk never go through the agent socket: a 1 MiB chunk or a 128 KiB head cannot travel over the JSON-line socket (`agent.py:380-386`, 64 KiB read cap), and the edge's `_agent` passthrough keeps only a fixed key list (`edge.py:397-405`).
- The gw1 binding (computerId, placementGeneration, leaseEpoch) already ties each request to this host's lease. It is the export boot's N+1/E+1, so no other host can serve or be asked for this export.

### 2.3 Export head JSON (host → Worker → app)

```json
{
  "v": 1,
  "moveId": "<uuid>",
  "generation": "<uuid: the move's import generation>",
  "sha256": "<64 lowercase hex: sha256 of the whole PAX archive>",
  "entries": 1234,
  "skipped": 2,
  "bytes": 2098410,
  "chunks": [ { "i": 0, "size": 1048576, "sha256": "<hex>" }, { "i": 1, "size": 1048576, "sha256": "<hex>" }, { "i": 2, "size": 1258, "sha256": "<hex>" } ]
}
```

Limits. These are the Worker codec's own limits, so the result is a valid Cloudflare v1 snapshot.
- Every chunk except the last is exactly **1 MiB** (1,048,576 bytes); the last is 1..1 MiB. Sources: `workspace-persist.ts:19`, `workspace-snapshot-script.ts:9,179-186`.
- `chunks.length` is 1..**512**, `chunks[k].i === k`, and `bytes === Σ size ≤ 512 MiB`. Sources: `workspace-persist.ts:20,127-140`; `workspace-snapshot-script.ts:10`.
- `entries` is 0..**100,000** (`workspace-persist.ts:21`, `workspace-snapshot-script.ts:11`).
- The head JSON fits in 128 KiB (`workspace-persist.ts:235`).
- `skipped` counts what the codec skips **and counts**: unrepresentable names, sockets, FIFOs, devices, and absolute or escaping links (`workspace-snapshot-script.ts:124,133,138`).
- **Dropped and not counted:** untracked `node_modules`, `.next`, `.turbo` and `dist` directories (`CACHES`, `workspace-snapshot-script.ts:13,121`), and the codec's internal files. The user copy must say so (§6.3); `skipped` never includes them.
- The app enforces all of this as `validExportHead` (`provider-reverse-store.ts:214`). The app also checks `v === 1` and `moveId === row.id`, then stores the head without `v` and `moveId`.
- When written to the store as a v1 head, `i` is dropped: `chunks: [{size, sha256}]` (`workspace-persist.ts:26-36`).

### 2.4 Status JSON

```json
{ "ok": true, "state": "none|capturing|ready|failed", "moveId": "<uuid>|null", "generation": "<uuid>|null",
  "startedAt": "<ISO>|null", "finishedAt": "<ISO>|null", "lastServedAt": "<ISO>|null",
  "error": null | "workspace_too_large" | "workspace_missing" | "capture_failed" | "desktop_stop_failed" | "staging_space_low",
  "entries": 0, "bytes": 0, "skipped": 0 }
```

- `entries`, `bytes` and `skipped` are present only when `state` is `ready`.
- **`workspace_too_large` is permanent.** It is the codec's exit code 3 on the byte, entry, Git-index or Git-paths limits. Today exit 3 applies only to `op == 'capture'` (`workspace-snapshot-script.ts:321-323`); §2.6 extends it to `export-capture`.
- `lastServedAt` is the last time the edge served an export `status`, `head` or `chunk` GET (the idle hold, §2.5 step 7).

### 2.5 Agent op `export`

**Message (closed field set).** `{op:"export", seq, ts, leaseEpoch, mac, moveId, importGeneration}`.
- `seq`, `ts`, `leaseEpoch` and `mac` are the fields every agent message carries; authentication, epoch binding, freshness and replay are the agent's existing rules (`agent.py:133-180`). The edge's sequencer builds them as for `stop` (`edge.py:388-394`).
- Any other key, or a `moveId`/`importGeneration` that is not a lowercase UUID, returns `{ok:false, error:"export_invalid"}`.
- The edge maps the HTTP body's `generation` to `importGeneration`.

**The agent answers within 1 s and runs the job asynchronously.** The socket is served by one thread with a 5 s client timeout (`agent.py:372-393,593-605`). So `handle()` only validates, persists the job and returns `{ok:true}` (or `export_busy`). Stopping the desktop and the capture run in a separate worker thread (one job per host). The edge then answers the POST with the §2.4 status read from `state.json`.

**Behaviour:**
1. **One job per host.** A durable state file `/var/lib/ezil-host/export/state.json` (0600, root, **root volume**, written atomically: temp file, fsync, rename) holds `{moveId, importGeneration, state, startedAt, finishedAt, lastServedAt, error, head}`. The same `{moveId, importGeneration}` resumes or reports; anything else gets `export_busy`.
2. **Free space.** Before capturing, `statvfs('/var/lib/ezil-host/export')` must show at least **1.75 GiB** free: the archive (≤ 512 MiB) plus its chunk copies (≤ 512 MiB) plus the codec's Git index copy (≤ 512 MiB, `workspace-snapshot-script.ts:96-98`) plus the Git paths file (≤ 16 MiB) plus slack. Otherwise `failed`/`staging_space_low`.
3. **Stop the desktop unit**, under the same runDir/stopping guard as `stop`. Failure → `failed`/`desktop_stop_failed`.
4. **Capture in a throwaway runc container** built by a new `desktop.build_export_spec(cfg, lease, export_dir)`. It does **not** use `build_spec` (`desktop.py:526-616`), whose `/tmp` is a 1 GiB RAM tmpfs (`:575`), whose `/workspace` and profiles binds are read-write (`:577-578`), whose root is the merged overlay (`:594`) and whose network is the host-wide netns (`:599`). The export spec pins:
   - **root:** the promoted lower `cfgmod.lower_dir(cfg, cfgmod.host_digest(cfg))` (`desktop.py:309`), `readonly: true`. The user's AWS upper layer is never executed.
   - **`/tmp`:** a bind of `<export_dir>/tmp` (a fresh, empty 0700 root-owned directory on the root volume), read-write. The codec's own `os.mkdir('/tmp/ezil-snapshot-<importGeneration>', 0o700)` (`workspace-snapshot-script.ts:274`) then succeeds, and its path assertion (`:18`) holds. Nothing else is mounted at `/tmp`.
   - **`/workspace`:** a bind of `<dataMount>/workspace` with `ro,nosuid,nodev,noexec`. No profiles bind, no `gen_dir` binds except `/etc/hosts` and `/etc/hostname` read-only.
   - **network:** a **new** network namespace (`{"type":"network"}` with no path): loopback only, no veth. Never `cfg.networkMode`.
   - **process:** `python3 -I -c <SNAPSHOT_SCRIPT> <json>` with `{"op":"export-capture","root":"/workspace","work":"/tmp/ezil-snapshot-<importGeneration>"}`, the desktop's caps, seccomp, AppArmor, `noNewPrivileges`, memory and pids limits.
   - **container id:** `ezil-export`, distinct from `cfg.containerId`; deleted after exit.
   - Never run the codec as host root on guest bytes. It runs `git ls-files` on the guest's index (`workspace-snapshot-script.ts:103`), and the host has no git (`build-host-ami.sh:33-43`). Doing so breaks safety rule 3a.
5. **Exit codes → status:** 0 → continue; **3 → `failed`/`workspace_too_large`**; anything else → `failed`/`capture_failed`. `/workspace` absent on the volume → `failed`/`workspace_missing` before the container starts.
6. **Staging.** The agent moves the chunk files out of `<export_dir>/tmp/ezil-snapshot-<g>/` into `<export_dir>/chunks/`, deletes `archive.tar`, re-hashes every chunk on the host and compares with the codec's JSON, then writes `head.json` (§2.3) and sets `state: ready`. Any mismatch → `capture_failed`. `export_dir` = `/var/lib/ezil-host/export/<importGeneration>/`, on the root volume, never the data volume. It dies with the instance at retire.
7. **Idle hold.** The idle stop (`agent.py:544-549`; window 600 s, `config.py:34`) is held:
   - always while `capturing`;
   - while `ready`, until **15 min after `lastServedAt`** (or after `finishedAt` before the first GET);
   - never more than **120 min after `startedAt`**. After that the normal predicate applies again.
   - Worker GETs are presence anyway (`edge.py:350`). The hold covers gaps between sweeps. The app's own deadlines (§5.4) end the host first: 15 min boot, then at most 100 min of exporting, copying and checking after the job starts.

### 2.6 Codec change (lane H edits `worker/src/workspace-snapshot-script.ts`; additive)

- New op **`export-capture`**: exactly `capture` without `marker()` (AWS volumes carry no `.ezil-hydrated.json`, `workspace-snapshot-script.ts:66-74,156`), writing `archive.tar` and the chunk files the same way (`:273-279`).
- The exit-3 branch (`:321`) applies to `op in ('capture', 'export-capture')`. The exit-4 `hydration incomplete` branch never applies to `export-capture`.
- The Worker's existing ops stay byte-for-byte unchanged in behaviour (the Worker codec tests prove it). The Worker never calls `export-capture`.
- The bake copies the script into `infra/host-agent`. A parity test generated from `worker/src/workspace-snapshot-script.ts` keeps the copy from drifting.

### 2.7 Lane H acceptance (unit, then live)

- Unit:
  - closed POST body and closed agent message, including `leaseEpoch`/`mac`;
  - digest mismatch; `503 agent_unavailable`;
  - idempotent POST; `export_busy`; the agent returns in under 1 s while a capture runs;
  - chunk index grammar; the edge serves status, head and chunk from disk;
  - the generated export spec: read-only lower root, read-only `/workspace`, `/tmp` on the export dir, new network namespace, no profiles bind;
  - free-space refusal;
  - codec parity; exit 3 from `export-capture` maps to `workspace_too_large`;
  - the idle hold bounds.
- Live: T0 (b), (b2), (e), (k) in §8.

---

## 3. The reverse row (S0, shipped)

### 3.1 Table `public.ezil_compute_reverse_moves` (`0012_compute_reverse_moves.sql:4-38`)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()`; this is the `moveId` everywhere. |
| `user_id`, `computer_id` | uuid NOT NULL | Owner and computer. Create refuses another owner's row. |
| `started_by` | text | `'user' \| 'open' \| 'cron'` (D-5) |
| `state` | text, default `requested` | §3.2 |
| `generation` | uuid NOT NULL, default `gen_random_uuid()` | The import generation. Immutable; a retry is a **new row**. |
| `export_boot` | jsonb object | `{placementGeneration, leaseEpoch, volumeId, jobId, instanceId, fsUuid, claimedAt}` (§5.1) |
| `export_head` | jsonb object | §2.3 without `v` and `moveId` |
| `import_progress` | jsonb object | `{bitmap, bytes, archiveSha256, first, last}`. The bitmap is 128 hex chars (512 bits): bit i = byte ⌊i/8⌋, mask `1<<(i%8)`, the same order as forward `restore_progress` (`provider-migrate-store.ts:89-106`). `last` is the time of the last new chunk (the copy-stall clock, §5.4). |
| `bytes_total` | bigint | 0..536,870,912. Set with the export head. |
| `skipped` | integer ≥ 0 | Set with the export head. |
| `aws_volume_id` | text | `^vol-[0-9a-f]{8,17}$` |
| `aws_fs_uuid` | uuid | |
| `aws_snapshot_id` | text | `^snap-[0-9a-f]{8,17}$` |
| `retain_until` | timestamptz | Only on `committed` (named CHECK). Set to commit + 14 d from the DB clock. |
| `attempts` | int 0..5 | Consecutive transient failures in the current state. |
| `last_error` | text ≤ 200 | Reason code from the closed list in §5.5, `^[a-z0-9_.:-]{1,200}$` |
| `state_entered_at` | timestamptz NOT NULL | DB clock of the last **state change**. claimStale, retries, progress and claim completion never move it. Every per-state deadline in §5.4 is measured from it. |
| `commit_sent_at` | timestamptz | **The point of no return.** Set once, from the DB clock, by `checking → flipping`, before the Worker commit may be sent. Named CHECK: only `flipping`, `committed` or `failed_needs_operator` may carry it, so a row that may have committed can never be `failed_reopened`. |
| `created_at`, `updated_at` | timestamptz | `updated_at` is the CAS token and is read as `::text`. |

- **One holding row per computer.** A partial unique index covers `state NOT IN ('committed','failed_reopened')`. This differs from 0006: **`failed_needs_operator` still holds the computer** (no new move in either direction). Whether Open still works is a routing rule (§5.3), not a table rule.
- RLS is enabled with no policy, and `REVOKE ALL … FROM public, anon, authenticated`, exactly as in 0006/0010/0011.
- Staging-only: the aws-production apply and baseline are refused (`billing-staging-schema.mjs`). It is registered as a production `snapshot` source like 0010 and 0011.
- Unlike 0008–0011 it has a drizzle journal entry (idx 8), so `billing-test-db.sh` applies it. `ci-migrate.mjs` still refuses it, because REVOKE is outside its grammar.

### 3.2 States, transitions and writers

```
requested ─► booting ─► exporting ─► copying ─► checking ─► flipping ─► committed
     │           │           │           │           │           │
     └───────────┴───────────┴───────────┴───────────┘           └──► failed_needs_operator
                                 │                                          (point of no return:
                                 ▼                                           never failed_reopened)
                  failed_reopened | failed_needs_operator
failed_needs_operator ─(operator)─► failed_reopened   only while commit_sent_at IS NULL
failed_needs_operator ─(operator)─► committed         only while commit_sent_at IS NOT NULL (finish a stuck flip)
```

The table is `REVERSE_MOVE_TRANSITIONS` (`provider-reverse-store.ts:43`). Every write is a store call. The writer is always the app (lane A), except the operator releases.

| Edge | Store call | Written by | Precondition the store enforces |
|---|---|---|---|
| — → `requested` | `createOrGetActive({computerId, userId, startedBy})` | trigger mutations (`'user'`), the open path (`'open'`, §5.9), sweep (`'cron'`, later) | No forward work for the computer (§3.3); same owner. |
| `requested → booting` | `recordExportBoot(m, claim)` | machine, **inside the placement claim transaction** (§5.1) | Valid claim. In `booting`, only `jobId`, `instanceId` and `fsUuid` may be added to the same claim. |
| `booting → exporting` | `advance(m,'exporting')` | machine, after enrollment | `exportBoot.instanceId` set. |
| `exporting → copying` | `recordExportHead(m, head)` | machine | The head is valid for `m.generation`; progress resets. |
| `copying` (self) | `recordImportProgress(m, indices)` | machine, after each Worker `pull` | Indices are within the head. Idempotent per index; resets `attempts`. |
| `copying → checking` | `advance(m,'checking')` | machine | Every chunk bit is set for the current `archiveSha256`. |
| `checking → flipping` | `advance(m,'flipping')` | machine, **in the locked transaction that re-checks the entitlement**, after `verifyOnly` passed and the export host is retired (§5.6 step 1) | Sets `commit_sent_at`. |
| `flipping → committed` | `finish(m, {awsVolumeId, awsFsUuid, awsSnapshotId: null})` | machine, **in the same transaction as the placement flip** (§5.6 step 3) | `commit_sent_at` set; `retain_until` = DB clock + 14 d |
| pre-flip in-flight → `failed_*` | `fail(m, to, reason)` | machine, after compensation (§5.7) | `failed_reopened` refused once `commit_sent_at` is set. |
| `flipping → failed_needs_operator` | `fail(m,'failed_needs_operator', reason)` | machine (§5.4 `flip_stuck`, §5.5) | — |
| `failed_needs_operator → failed_reopened` | `fail(m,'failed_reopened', reason)` | operator only, after manual cleanup | `commit_sent_at` is null. An operator who proved the commit never landed (P's head is not this move's) clears `commit_sent_at` by hand first, then releases. |
| `failed_needs_operator → committed` | `finish(m, …)` | operator only, through the same flip code (§5.6 step 3) | `commit_sent_at` is set. |
| committed (self) | `recordSnapshot(m, snapId)` | lane O (§7) | Once. |
| any in-flight (self) | `recordRetry(m, reason)` | machine | `attempts < 5`, else `{exhausted:true}` and nothing is written; the caller compensates and `fail`s. **In `flipping` it is never exhausted** (attempts saturate at 5): `flipping` is bounded by time (§5.4). |

A lost CAS throws `ReverseMoveConflictError('lost_race')`. An illegal edge throws `illegal_transition` and writes nothing. The caller re-reads; nothing retries inside the store.

### 3.3 Cross-direction exclusion and the computer lock

- Both creates follow the same order:
  1. INSERT … ON CONFLICT DO NOTHING;
  2. **the placement per-computer lock**: `pg_advisory_xact_lock(PLACEMENT_LOCK_NAMESPACE, hashtext(computerId::uuid::text))`, the same key as `placement.ts:212-214,542-548`, under READ COMMITTED only;
  3. check the other direction in a new statement;
  4. throw, which rolls back the insert.
- They run in one transaction when the executor has one (`inMoveTransaction`, `provider-reverse-store.ts:173`).
- The check comes after the lock, so the second creator sees the first's committed row. The PG race test runs 20 rounds with exactly one winner each. A mutant without the lock fails it 3/3.
- **Forward refuses** (`MigrationConflictError`, `provider-migrate-store.ts:142`) while a reverse row is in a holding state.
  - It first probes `to_regclass('public.ezil_compute_reverse_moves')` as its own statement.
  - A database without 0012 (production, and the forward suites' schemas) therefore behaves exactly as before.
- **Reverse refuses** (`forward_active`, `provider-reverse-store.ts:197`) while the forward machine still has work. That is an active forward row, or a `failed_*` row whose `_awsProvision` is not released: exactly what forward `claimStale` picks up (`provider-migrate-store.ts:107-118`).
- **Lock order** stays admission → computer (`placement.ts:30-41`). Never call either `createOrGetActive` on a *different* connection while holding the computer lock: the second call would wait on your own lock. Pass the same `tx`, or call it after commit.

### 3.4 Store surface (`createProviderReverseStore(db)`)

- **Reads:** `readById`, `readByComputer` (newest, any state), `readActiveByComputer` (holding), **`readByExportBoot(computerId, placementGeneration, leaseEpoch)`** (newest row of ANY state whose `export_boot` claimed exactly that pair; §5.2 keys on it).
- **Writes:** `createOrGetActive`, `recordExportBoot`, `advance`, `recordExportHead`, `recordImportProgress`, `recordRetry`, `fail`, `finish`, `recordSnapshot`, `claimStale(limit ≤ 10)`.
  - `claimStale` takes in-flight rows idle for 30 s, oldest first, with `FOR UPDATE SKIP LOCKED`, and bumps `updated_at` only. It mirrors forward `claimStale`. `failed_needs_operator` is never claimed.
- **Row fields added in r2:** `stateEnteredAt`, `commitSentAt` (DB-clock text).
- **Constants:** `REVERSE_MOVE_DTO_STAGE` (§6.1), `EXPORT_*` limits, `REVERSE_MOVE_MAX_ATTEMPTS = 5`, `REVERSE_MOVE_RETENTION_DAYS = 14`.
- To write inside a placement transaction, build the store over that `tx`.

---

## 4. Worker import routes (lane W)

### 4.1 Common rules

- **Path:** `POST /sandbox/<name>/migrate/import/{begin,pull,commit,abort}`.
  - The app reuses `migrateRequest` (`cloudflare-guacamole-provider.ts:3365-3401`) with `action = 'import/<op>'`: signed control auth, and a 409 maps to the closed reason enum.
  - **Timeouts are passed per action** (lane A): `import/begin` 60 s, `import/pull` 40 s, `import/commit` 30 s, `import/abort` 60 s. The existing check `action === 'begin' ? 120_000 : 30_000` (`:3382`) does not match `import/begin`.
  - Extend the route regex next to `index.ts:7827` and authorize with `authorizeSignedControlRequest` exactly as at `index.ts:7828-7830`.
- **`<name>`** = `deriveGuacamoleSandboxId(userId, computerId)` (`cloudflare-guacamole-provider.ts:1273-1277`). Every body carries the full `computerId`. The Worker refuses `400 invalid_body` unless `computerId.replace(/[^a-z0-9]/gi,'').slice(0,16)` equals the name's scope part.
- **Store (v1 is R2-only).** Every step resolves the store with `selectWorkspaceStore()` (`index.ts:2745-2765`), which honours the DO's pin (`WORKSPACE_STORE_KIND_KEY`, `:1882`) and `EZIL_WORKSPACE_STORE` (`workspace-store-s3.ts:670-690`).
  - Unless the selection is `kind: 'r2'` with a store present → `409 store_unsupported`. The S3 and migrating stores are out of v1: their conditional-put and read-routing semantics for this flow are unproven.
  - `begin` records `store: 'r2'` in the DO key. Any later step that resolves differently → `409 store_unsupported`.
  - Only the common store surface is used: `get`, `put` (with `onlyIf`), `list` (key, size, etag), `delete` (`workspace-store-s3.ts:58-84`, the `WorkspaceStore` interface at `:78`). No R2 `head()`, no `customMetadata`.
- **Prefix P.** P is the real key prefix the next Cloudflare hydrate of this computer reads: the derivation in `ensureWorkspaceMount` (`index.ts:1488-1525`), i.e. `realR2KeyPrefix(config.prefix ?? '/<projectId>/branches/<branch>')` (`workspace-seed.ts:94`), with the projectId and branch the app's Cloudflare open sends for this computer.
  - Lane W extracts that derivation into one helper used by both hydrate and import, and a unit test proves the import's P equals what the open route hydrates.
  - If the DO has a `WORKSPACE_FLUSH_CONTEXT_KEY` (`index.ts:1872`) **without** `freshProvision`, its `prefix` must equal P, else `409 prefix_mismatch`.
  - A `freshProvision` context with prefix `${name}/branches/main` (`index.ts:3470-3472`) is a fence placeholder for a never-used workspace. It is not compared; commit replaces it (§4.4).
  - System prefix `S = systemPrefixOf(P)` (`system-persist.ts:32-35`). Chunks go to `chunkKey(P, generation, i)` = `P/.ezil-snapshots/<generation>/<i>` (`workspace-persist.ts:304-305`).
- **Host binding:** the Sandbox DO for `<name>` reaches the host through the AWS tunnel record for the same `<name>`. It uses `lookupAwsTunnel` (`aws-tunnels.ts:565`) and signs every request with `signGatewayHeader` (`aws-origin.ts:165-173`), as `sendAwsControl` does (`aws-origin.ts:443-466`).
  - Every request carries `placementGeneration` and `leaseEpoch`. The tunnel record must match both, or the response is `409 export_host_mismatch`. The Worker only ever pulls from the export boot's host.
  - A tunnel or host transport failure is `503 export_unreachable`.
  - The bytes never pass through the app.
- **DO storage** (values stay under the 128 KiB DO value limit):
  - `ezil:reverseImport` = `{moveId, generation, computerId, placementGeneration, leaseEpoch, store:'r2', prefix:P, headKind:'none'|'migrated', migratedEtag, systemMigratedEtag, startedAt, verified?:{sha256, chunkCount}, committing?:true}`. At most one exists. A different `{moveId, generation}` gets `409 import_busy`.
  - `ezil:reverseImport:head` = the validated export head (≤ 128 KiB, §2.3).
  - `ezil:reverseImport:put:<i>` = `{etag, size, sha256}` per stored chunk, recorded from the bytes the Worker itself hashed.
  - Commit and abort delete every `ezil:reverseImport*` key.
- **Serialisation.** All four import ops on one DO run through one in-memory queue (the `withMigrationStart` pattern, `index.ts:2526-2531`), so `commit` and `abort` never interleave around the store I/O. `blockConcurrencyWhile` is not used: it would stall every request to the DO, including desktop traffic, for up to 30 s.
- **Start fence:** `migrationStartBlocked` (`index.ts:2532-2538`) returns false when the DO has no workspace flush context. That is exactly the case for a computer created on AWS.
  - Lane W makes it **also block while `ezil:reverseImport` exists**.
  - The hydrate fence already blocks on the flag by prefix (`index.ts:2781-2783`).
- **Flag:** `P/.ezil-snapshots/migrating.json` = `{startedAt, reverse:{moveId, generation}}` (`workspace-persist.ts:189`).
  - It goes stale 40 min after `startedAt` (`workspace-persist.ts:201`), so **every `begin`, `pull` and `commit{verifyOnly:true}` rewrites `startedAt`** (at most once per request).
  - Garbage collection is already safe: it is suspended under a migrated head and does nothing with no head (`workspace-persist.ts:594-597`).
- **Errors.** A transient store read or write failure is `503`, never a 409. 409 is only for the closed codes below.

### 4.2 `begin`

Request: `{moveId, generation, computerId, placementGeneration, leaseEpoch}`.

1. A container for `<name>` is running → `409 container_running`.
2. Store and prefix checks (§4.1).
3. An existing `ezil:reverseImport`: the same `{moveId, generation}` → skip to step 7 (idempotent). Another → `409 import_busy`.
4. Read `P`'s head (`readHead`/`readMigratedHead`, `workspace-persist.ts:232-258`):

| Head at `P` | Result |
|---|---|
| absent | OK, `headKind: 'none'`. The computer was created on AWS (fresh provision). |
| migrated v2, `targetProvider: 'aws-ec2'` | OK, `headKind: 'migrated'`. Record `migratedEtag` (the etag of `latest.json`) for the commit CAS. |
| migrated v2, any other target | `409 head_invalid` |
| **ordinary v1 snapshot** | **`409 head_moved`**: Cloudflare wrote since, and is never overwritten. If it is this move's own committed head (`generation` equal), `409 already_imported`. |
| present but unparseable or invalid | `409 head_unreadable` |

5. Read `S`. It must be absent (record `systemMigratedEtag: null`) or migrated v2 (record its etag). A v1 system head → `409 system_head_moved`.
6. Write the flag, then the DO key.
7. Send `POST /__ezil/control/export/<sha>` with `{v:1, moveId, generation}` to the host. Host `202` → continue. Host `409 export_busy` or any host `400` → `409 export_refused`. Host `503`/transport failure → `503 export_unreachable`.
8. Return `200 {ok:true, headKind, export:<host status §2.4>}`.

### 4.3 `pull`

Request: `{moveId, generation, computerId, placementGeneration, leaseEpoch, from, count}`, with `0 ≤ from < 512` and `0 ≤ count ≤ 64`. `count: 0` is a status poll.

1. The DO key must match. Otherwise `409 import_not_started`, or `409 import_mismatch` for other ids. Store and prefix unchanged, else `409 store_unsupported`/`prefix_mismatch`.
2. `GET …/export/status`:
   - `none` → the host lost or never got the POST: re-send it (idempotent) and answer as not ready.
   - `failed` → `409` with a **top-level** `error` (no sub-field): `workspace_too_large` → `workspace_too_large`; `workspace_missing` → `export_workspace_missing`; `capture_failed` → `export_capture_failed`; `desktop_stop_failed` → `export_desktop_stop_failed`; `staging_space_low` → `export_staging_space`.
   - `capturing` → `200 {ok:true, export, head:null, stored:[], next:from}`. This is how the app polls.
3. On the first `ready`, `GET …/export/head`. Validate it exactly as §2.3 and check `moveId` and `generation`, else `409 export_head_invalid`. Store it in `ezil:reverseImport:head`.
4. For `i` in `[from, min(from+count, n))`, with up to **4 chunk transfers in flight**, and starting no new transfer after **20 s** of wall time:
   - `put:<i>` exists → count it as stored.
   - Otherwise GET the chunk. Check `Content-Length`, `size` and sha256 against `head.chunks[i]`, else `409 chunk_mismatch`. Put it to `chunkKey(P, generation, i)` and record `put:<i>` from the put result's etag.
5. Response: `200 {ok:true, export, head, stored:[i…], next: <first index at or after from not stored> | null}`. `stored` lists every stored index in the window (previously or now), so the app records progress idempotently.

### 4.4 `commit`

Request: `{moveId, generation, computerId, sha256, chunkCount, verifyOnly: boolean}`.

- **`verifyOnly: true`** runs in the `checking` state.
  - The DO key must match (else `import_not_started`/`import_mismatch`). `sha256` and `chunkCount` must equal the stored head.
  - Every `i < chunkCount` has `put:<i>`, and **one paginated `list({prefix: 'P/.ezil-snapshots/<generation>/'})`** shows every chunk key with the recorded size and etag. No per-chunk HEAD, no customMetadata, no re-hash.
  - Build the v1 snapshot `{version:1, generation, chunkGeneration: generation, sha256, entries, chunks:[{size, sha256}]}` and check it with `parseSnapshot` (`workspace-persist.ts:127-140`).
  - Any failure → `409 not_verified`. Success: store `verified` and return `200 {ok:true, verified:true}`.
  - Integrity rests on per-chunk sha256 checked at pull time, the etag pinned at put, and hydrate re-verifying every chunk on the first open (`workspace-persist.ts:424`). **Do not re-hash 512 MiB in one request.**
- **`verifyOnly: false`** runs only in the `flipping` state (`commit_sent_at` set).
  - **Check order (retry-safe):** first read `P`'s head, **before** any DO-key check. A successful commit deletes the DO key, so a retry after a lost response would otherwise fail with `import_not_started`.
    - It is this move's own v1 head (`generation` and `chunkGeneration` equal to the request's) and the DO key is gone: every step already ran. Return `200 {ok:true, committed:true, store:'r2'}`.
    - Own v1 head with the DO key still present: run steps 3–5 below (each is idempotent), then return the same.
  - Otherwise it requires the DO key and `verified` for the same sha (else `409 not_verified`). Then:
  1. Persist `committing: true` in `ezil:reverseImport` **before** the CAS.
  2. **CAS the workspace head:** `put(P/latest.json, v1)` with `onlyIf: {etagMatches: migratedEtag}`, or `{etagDoesNotMatch:'*'}` when `headKind` is `none`. `previousChunkGeneration` is omitted, so the stale pre-move generation is garbage after the 1 h grace (`workspace-persist.ts:570`).
     - If the CAS fails, re-read. This move's own v1 head counts as success. Anything else → clear `committing`, `409 head_moved`.
  3. **Revert the system head:**
     - A migrated v2 head **with `previous`**: CAS-put `previous` back, with `onlyIf etagMatches systemMigratedEtag`.
     - A migrated v2 head **without `previous`** (legacy marker): delete the head.
     - Absent: no-op.
     - The etag moved → `409 system_head_moved`, after the workspace head is already committed. This is retryable and idempotent; `committing` stays set.
     - Why revert: a migrated system head blocks system saves forever (`system-persist.ts:172-174`). `previous` brings back the user's pre-move Cloudflare settings. Changes made on AWS outside `/workspace` are the "not moved" part of D-4.
  4. **DO keys:**
     - `WORKSPACE_FLUSH_CONTEXT_KEY = {prefix: P, mountPath: '/workspace'}` with no `freshProvision`. If the old context was a `freshProvision` placeholder, also delete its fence object `${name}/branches/main/.ezil-snapshots/migrating.json`.
     - `WORKSPACE_TOO_LARGE_KEY = false`, `SYSTEM_TOO_LARGE_KEY = false` (`index.ts:2009,2019`). A later re-upgrade's forward export then has its context and known sizes (`index.ts:3507-3523`).
     - `WORKSPACE_HYDRATED_KEY = false` (`index.ts:1873`): the first Cloudflare open hydrates from the new head.
     - `pinWorkspaceStore('r2')` (`index.ts:2767-2771`; it never moves an existing pin).
  5. Delete the flag, then every `ezil:reverseImport*` key. Return `200 {ok:true, committed:true, store:'r2'}`.
- A repeated commit after success returns the same 200. **The workspace-head CAS is the point of no return** on the Worker side; `commit_sent_at` is its durable mirror on the app side.

### 4.5 `abort`

Request: `{moveId, generation, computerId}`.

- `ezil:reverseImport.committing` is set → `409 commit_in_progress`.
- `P`'s head is this move's committed v1 → `409 already_imported`.
- Otherwise list and delete `P/.ezil-snapshots/<generation>/*`, then delete the flag **only if** its `reverse` is this move's, then the DO keys **only if** they are this move's. Return `200 {ok:true}`.
- With no DO key it still returns `200 {ok:true}` (idempotent).
- Abort sends nothing to the host. The app retires it.

### 4.6 Reason codes the app must add

`MIGRATE_CONFLICT_REASONS` is closed: anything unknown becomes `'other'` (`cloudflare-guacamole-provider.ts:3309-3314,3386-3396`). Lane A adds exactly:

`container_running`, `head_invalid`, `head_unreadable`, `system_head_moved`, `import_busy`, `import_not_started`, `import_mismatch`, `store_unsupported`, `prefix_mismatch`, `export_host_mismatch`, `export_refused`, `export_head_invalid`, `export_workspace_missing`, `export_capture_failed`, `export_desktop_stop_failed`, `export_staging_space`, `chunk_mismatch`, `already_imported`, `not_verified`, `commit_in_progress`.

`head_moved` and `workspace_too_large` already exist. `503 export_unreachable` maps to `unavailable`; a `404` (routes not deployed) maps to `not_found`. §5.5 says what each one does.

---

## 5. App reverse machine (lane A)

### 5.1 Export-boot claim (`requested → booting`)

The claim runs under `withAdmission` and then the computer lock (`placement.ts:582-588,542-548`), in one transaction:

1. Read the published row. It must be `aws-ec2`, `STOPPED`, with no lifecycle job pending and the owner equal to the row's user. If it is RUNNING or has a job, the row waits in `requested` (§5.4); the machine never takes over a live session.
2. Record a **cold replace** lease on the row (`leasePlacement` with `replace`, `placement.ts:1364-1405`; intent `aws-ec2.ts:258-283`): placement generation N+1, lease epoch E+1, the same `dataVolumeId`, ordinary user data (no new lease key, `lease.py:45`).
   - The transaction records the placement bump and the job id only.
   - `startLifecycleJob` (`aws-receipts.ts:218`, idempotent) runs **after commit**, never inside the lock transaction: a Step Functions start issued inside a transaction would be authorized against an uncommitted row (`aws-receipts.ts:294-295`). `refused` and `unknown` take the ordinary wake's undo paths (`markLifecycleStartUnknown`, `settleUnknownStart`, `aws-receipts.ts:481-517`).
   - Free never uses the pool (`aws-ec2.ts:476`).
   - Capacity admission (regional vCPU) applies. **Entitlement start-gate admission does not**: no `admitStart`/`decideStart`, which would refuse a Free user's size (`compute-access.ts:210-217`).
3. In the same `tx`, call `recordExportBoot(m, {placementGeneration: N+1, leaseEpoch: E+1, volumeId, jobId, instanceId: null, fsUuid, claimedAt})`.

### 5.2 Export-boot placement path (receipts mode and release; no new placement edges)

**Receipts: an export-boot mode, not a skip.** `applyLifecycleReceipt` (`aws-receipts.ts:247`) keeps running for the export boot. It switches to export-boot mode when `p0.provider === 'aws-ec2'` and `readByExportBoot(p0.computerId, p0.generation, p0.leaseEpoch)` returns a row **in any state**. (A database without 0012 has none: probe `to_regclass` first, as §3.3 does.) Keying on any state means a released row still keeps its own boot out of RUNNING, and the next boot at N+2/E+2 never matches. In this mode exactly two things change:
1. `STARTING → MOUNTING` is written with the receipt fields `done` and **no usage effect**. At base it carries `open` (`aws-receipts.ts:462`): the usage row opens at MOUNTING, not at RUNNING.
2. **`MOUNTING → RUNNING` is never taken**: not in the enrolled branch for a cleared job (`:290-291`), and not at the tail (`:463-466`). So there is no `meter.ready` and no epoch (`:265-277`), no usage row, and no `sessionLimitFor` lease or hours-cap stop (`:681-690`).

Everything else runs unchanged, so a failed export boot fails exactly like a failed Free open:
- execution `FAILED`/`TIMED_OUT`/`ABORTED` → UNCONFIRMED (`:322-345`);
- unknown starts → `settleUnknownStart` (`:481-517`);
- receipt conflicts → UNCONFIRMED (`:365-377`);
- an unenrolled MOUNTING past grace → `failUnenrolledPlacement` + `retireUnenrolledHost` (`:292-305`; `placement.ts:1467-1517`).

**Release writer (new, `placement.ts`):** `releaseExportBoot(db, p, expected: {placementGeneration, leaseEpoch})`, under `withAdmission` then `lockComputer`:
- CAS `{provider:'aws-ec2', state:'MOUNTING', generation: N+1, leaseEpoch: E+1, lifecycleJobId: null, instanceId: p.instanceId, updatedAt}` → **`UNCONFIRMED`** with `lastError: ENROLLMENT_FAILED` and the enrollment columns cleared. This is the exact write `failUnenrolledPlacement` makes (`placement.ts:1498-1502`). `MOUNTING → UNCONFIRMED` is an existing edge (`placement.ts:110`).
- After commit, the machine calls the existing **`retireUnenrolledHost`** (`aws-receipts.ts:833-878`): UNCONFIRMED → RECOVERING → RETIRING with `ENROLLMENT_HOST_RETIRE` and the retire job recorded first, then StartExecution. Its receipt lands **`STOPPED` with `INSTANCE_LOST` at N+1/E+1** (`aws-receipts.ts:413-416`): the instance is terminated and the volume kept. Every edge is already in `PLACEMENT_TRANSITIONS` (`placement.ts:110,114,117,120`).
- The retire's `close` usage effect is a no-op with no open usage row (`placement.ts:1234-1241`). `meter.stopped` closes only an epoch that was ready at or before it, and none exists (`compute-meter.ts:32-40`).
- A refused or failed retire hands the row back as UNCONFIRMED/`ENROLLMENT_FAILED` (`aws-receipts.ts:333-345,867-873`). The machine calls `retireUnenrolledHost` again on its next pass, and the fleet pass retries after 10 min anyway (`aws-receipts.ts:793,813`).
- **Never release a boot with a lifecycle job pending** (LEASED, STARTING, or MOUNTING with a job). Wait for the ordinary receipt path to settle it.

Lane A lists **every actor that acts on an `aws-ec2` row in LEASED, STARTING or MOUNTING**, and shows with a test that each one leaves an export boot below RUNNING and opens no usage. At least these, under `app/src/app/api/`:
- crons `aws-reconcile`, `aws-stop-settle`, `sandbox-reap`, `billing-session-sweep`, `pool-replenish`;
- internal `computers/lifecycle-authority`, `computers/image-rebase`.

The machine reads the boot's receipt itself (pattern: `readMigrationReadyReceipt`, `aws-receipts.ts:1116-1130`). It records `jobId`, `instanceId` and `fsUuid` with `recordExportBoot`, and advances to `exporting` once enrollment succeeded (`lastError === ENROLLMENT_SUCCEEDED`, the row MOUNTING with no job).

### 5.3 Routing while a move exists (`select.ts`, before the placement provider, like `providerForPendingMigration`, `provider-migrate-placement.ts:27-34`, `select.ts:101`)

| Newest reverse row for the computer | Open / session routing |
|---|---|
| in flight (`requested` … `flipping`) | The **waiting provider**. Opens wait and the shell shows the move card. They never boot or adopt the AWS computer for a session. |
| `failed_needs_operator` with `openBlocked` (§5.5: `commit_sent_at` set, or reason `already_imported`/`commit_in_progress`) | **Refuse at once** with a typed `PRECONDITION_FAILED` `computer_move_needs_attention`. Never the waiting provider: the shell shows the needs-attention card, never a spinner. |
| `failed_needs_operator` without `openBlocked` | Ordinary AWS routing. The files are intact on AWS; only Cloudflare-side cleanup is pending. The row still blocks new moves. |
| `committed`, `failed_reopened`, none | Ordinary routing on the placement. |

The open trigger (§5.9) runs in the open mutation path, never in `select.ts` reads or status polls.

### 5.4 Step work, deadlines and throughput

**Driver.** A new `advanceReverseMoves(startedAt)` runs in `billing-session-sweep` right after `advanceStaleMigrations` (`billing-session-sweep/handler.ts:169`).
- It has its **own 90 s budget**, measured from its own start, not the 40 s left over from the handler start that forward moves get (`provider-migrate-orchestrator.ts:136-147`).
- It takes at most 3 rows per pass (`claimStale(3)`).
- The route's `maxDuration` is 300 s (`billing-session-sweep/route.ts:11`). Lane A shows the handler's worst case stays under 240 s: billing work, forward work up to 40 s after handler start, then reverse work up to 90 s.
- Within its budget it drives a row step after step. A `copying` row gets back-to-back pulls (`count: 64`).
- `computer.move.start`, `computer.move.retry` and the open trigger also schedule one immediate 60 s drive with `after()` (pattern `schedulePaidMigration`, `provider-migrate-orchestrator.ts:149-152`), so the first steps do not wait for a cron tick.
- Two drivers on one row are safe: the Worker serialises per DO (§4.1), and every row write is a CAS.

**Throughput arithmetic (worst case).** A full workspace is 512 chunks of 1 MiB.
- At the minimum acceptable host → Worker → R2 throughput of **0.5 MiB/s**, one 90 s pass moves about 45 chunks, so 512 chunks take about 12 passes, about 12 min of wall time with a pass every minute.
- At 3 MiB/s or more, one pass moves its maximum, about 192 chunks, and 512 chunks take 3 passes.
- Throughput is a live proof (T0 (e2)). If T0 measures below 0.5 MiB/s, this section changes before lane A ships.

**Deadlines.** All are measured from durable DB timestamps: `created_at`, `exportBoot.claimedAt`, `state_entered_at`, `import_progress.last` and `commit_sent_at`. claimStale never moves any of them.

| State | Work per pass | Done when | Deadline → outcome (compensation first, §5.7) |
|---|---|---|---|
| `requested` | Kill switch on (`aws-config.ts:274`) → `kill_switch`. Entitlement paid → `entitlement_paid`. Placement RUNNING or job pending → wait. Otherwise claim (§5.1). | claim recorded | 10 min after `created_at`: `computer_busy` if the placement never became claimable, else `boot_unavailable` (capacity refused). |
| `booting` | Read the boot receipt and enrollment. | enrolled → `advance('exporting')` | Boot settled as failed (UNCONFIRMED, or STOPPED by an undo) → `boot_failed`. **15 min after `claimedAt`** → `boot_timeout`. |
| `exporting` | Worker `begin` (until it succeeds), then `pull{count:0}` on every pass | status `ready` and a valid head → `recordExportHead` | Host `failed` → §5.5. **20 min after `state_entered_at`** → `export_timeout`. |
| `copying` | `pull{from:next, count:64}` until the budget is spent, then `recordImportProgress(stored)` | bitmap complete → `advance('checking')` | No new chunk for **10 min** (`import_progress.last`, or `state_entered_at` before the first chunk) → `copy_stalled`. **60 min after `state_entered_at`** → `copy_timeout`. |
| `checking` | (1) Worker `commit{verifyOnly:true}` until verified. (2) Then `releaseExportBoot` + `retireUnenrolledHost` until the placement is `STOPPED` at N+1/E+1 with no job. (3) Then the §5.6 transaction 1. | `advance('flipping')` | **20 min after `state_entered_at`** → `check_timeout`. |
| `flipping` | §5.6 steps 2–4 | `finish` | **Never compensated.** **30 min after `commit_sent_at`** → `failed_needs_operator('flip_stuck')`. |

- **Retries before `flipping`:** a transient failure (§5.5 class `retry`) calls `recordRetry`. Five in a row (`attempts` 5) → compensation → `failed_reopened('<state>_retries')`, for example `copying_retries`. Progress and advances reset `attempts`.
- **In `flipping`:** `recordRetry` only records `last_error`, and the deadline above is the only bound. Nothing in `flipping` re-reads the entitlement, calls `abort`, or writes `failed_reopened`; the store and the 0012 CHECK refuse the last.
- **Host life after the claim:** at most 15 min (`booting`) plus 20 (`exporting`) plus 60 (`copying`) plus 20 (`checking`, which retires the host), so 115 min. The host's own hold (§2.5 step 7) is at most 120 min after its job starts, and the job starts after the boot. So the app's deadline always ends the host first.

### 5.5 Reason → outcome table (closed)

The classes are:
- `retry`: `recordRetry(code)`; five in a row → `<state>_retries`.
- `reopen`: compensate, then `failed_reopened(code)`; Try again is offered.
- `reopen_after_session`: as `reopen`, but Try again (and any new row) is refused while the placement's `leaseEpoch` still equals the row's `exportBoot.leaseEpoch` (no AWS session since).
- `reopen_final`: as `reopen`, Try again refused until an operator sets `last_error = 'operator_cleared'`. Open works, and an operator is alerted with a log line `[reverse-move] anomaly`.
- `operator`: `failed_needs_operator(code)`.

| Step (state) | Worker / host answer | Class → `last_error` |
|---|---|---|
| any pre-flip | entitlement became paid (re-read at every pass) | `reopen` → `entitlement_paid` (no Try again button needed, §6.3) |
| `requested` | kill switch on | `reopen` → `kill_switch` |
| `begin` (`exporting`) | `container_running`, `export_host_mismatch`, `unavailable` (incl. `export_unreachable`), `not_found` | `retry` |
| `begin` | `head_moved`, `head_invalid`, `head_unreadable`, `system_head_moved`, `import_busy`, `store_unsupported`, `prefix_mismatch`, `export_refused`, `other` | `reopen_final` → the code (`other` → `worker_conflict`) |
| `begin`/`pull` | `already_imported` | `operator` → `already_imported` (impossible before `flipping`; the Cloudflare head is ours) |
| `pull` (`exporting`/`copying`) | `unavailable`, `export_host_mismatch`, `not_found` | `retry` |
| `pull` | `import_not_started` | `retry`, and the next pass re-sends `begin` (idempotent) |
| `pull` | `workspace_too_large` | `reopen_after_session` → `workspace_too_large` |
| `pull` | `export_capture_failed`, `export_desktop_stop_failed`, `export_staging_space`, `export_head_invalid` | `reopen` → `export_failed` (`export_staging_space` and `export_head_invalid` also log `[reverse-move] anomaly`) |
| `pull` | `export_workspace_missing` | `reopen_final` → `workspace_missing` |
| `pull` | `chunk_mismatch` | `reopen` → `import_corrupt` |
| `pull` | `import_mismatch`, `store_unsupported`, `prefix_mismatch`, `other` | `reopen_final` → the code (`other` → `worker_conflict`) |
| `commit{verifyOnly}` (`checking`) | `unavailable`, `not_found` | `retry` |
| `commit{verifyOnly}` | `not_verified` | `reopen` → `import_corrupt` |
| `commit{verifyOnly}` | `import_not_started` | `reopen` → `import_lost` |
| `commit{verifyOnly}` | `import_mismatch`, `store_unsupported`, `prefix_mismatch`, `other` | `reopen_final` → the code |
| `commit` (`flipping`) | `200 committed` | continue §5.6 |
| `commit` (`flipping`) | `unavailable`, `not_found`, `other`, `import_not_started`, `system_head_moved` | keep retrying the same commit (`import_not_started` and `system_head_moved` are never failures here: the Worker reads P first and every step is idempotent) until `flip_stuck` |
| `commit` (`flipping`) | `head_moved` | `operator` → `import_head_moved` |
| `commit` (`flipping`) | `not_verified`, `import_mismatch`, `store_unsupported`, `prefix_mismatch` | `operator` → `import_not_verified` |
| `abort` (compensation) | `200` | continue §5.7 |
| `abort` | `unavailable`, `not_found` | retried inside compensation; still failing after 5 → `operator` → `abort_unconfirmed` |
| `abort` | `already_imported`, `commit_in_progress` | `operator` → that code (impossible before `flipping`) |
| boot (`booting`) | the boot settles failed / 15 min | `reopen` → `boot_failed` / `boot_timeout` |
| compensation | the placement does not settle to `STOPPED` with no job within 30 min of the first compensation step | `operator` → `boot_unsettled` |

**Closed `last_error` vocabulary** (U keys copy on it; anything else is a lane A bug):
- `failed_reopened`:
  - `reopen`: `entitlement_paid`, `kill_switch`, `computer_busy`, `boot_unavailable`, `boot_failed`, `boot_timeout`, `export_timeout`, `export_failed`, `copy_stalled`, `copy_timeout`, `check_timeout`, `import_corrupt`, `import_lost`, `requested_retries`, `booting_retries`, `exporting_retries`, `copying_retries`, `checking_retries`, `operator_released`, `operator_cleared`;
  - `reopen_after_session`: `workspace_too_large`;
  - `reopen_final`: `head_moved`, `head_invalid`, `head_unreadable`, `system_head_moved`, `import_busy`, `import_mismatch`, `store_unsupported`, `prefix_mismatch`, `export_refused`, `workspace_missing`, `worker_conflict`.
- `failed_needs_operator`:
  - Open works: `abort_unconfirmed`, `boot_unsettled`;
  - **Open blocked** (`openBlocked`): `flip_stuck`, `import_head_moved`, `import_not_verified` (all with `commit_sent_at`), `already_imported`, `commit_in_progress`.
- In-flight retry codes (`recordRetry`): `unavailable`, `not_found`, `lost_race`, `container_running`, `export_host_mismatch`, `import_not_started`, `system_head_moved`, `commit_unavailable`.

### 5.6 Flip (`checking → flipping → committed`)

1. **Transaction 1** (end of `checking`), under `withAdmission` then the computer lock:
   - re-read the reverse row, the placement and the entitlement;
   - the placement must be `aws-ec2` `STOPPED` at N+1/E+1 with no job (the export host is retired);
   - if `paidAccess(standing)` (`paid|grace|plan_ending`, `standing.ts:42-45`), compensate (§5.7) with `entitlement_paid`;
   - otherwise `advance(m,'flipping')` over `tx`, which **sets `commit_sent_at`**.
   - No HTTP call is made inside the lock transaction.
2. **After commit:** Worker `commit{verifyOnly:false}`. This and every retry of it are the only Worker calls in `flipping`.
3. **Transaction 2**, under `withAdmission` then the computer lock. A new `flipPlacementToCloudflare` in `placement.ts` mirrors `flipPlacementToAws` (`placement.ts:806-848`); `placement.ts` stays the single writer.
   - Delete the `aws-ec2` row by CAS on `STOPPED`, N+1/E+1, no job.
   - Insert a `cloudflare` `STOPPED` row with storage = the commit's `store` (`r2`; allowed values `placement.ts:57-61`).
   - **In the same transaction**, call the reverse store over `tx`: `finish(m, {awsVolumeId, awsFsUuid, awsSnapshotId: null})`.
   - So there is never a moment where the placement is Cloudflare while the row is not `committed`.
   - An operator finishing a `flip_stuck` row runs this same transaction from `failed_needs_operator`, after the Worker confirms the commit.
4. **After commit**, outside any lock: re-read the entitlement. If it is `paidAccess`, call `startPaidMigration(userId, sku)` (`provider-migrate-runtime.ts:173`). That runs a forward move onto a fresh volume; the retained volume is rollback-only. Then lane O's snapshot follows (§7).

There is no AWS call after the point of no return: the export host is retired in `checking`, before `commit_sent_at`.

### 5.7 Compensation (pre-flip only; before any `failed_*` write)

`failed_reopened` releases the computer, so it is written only after these steps:

1. **Worker `abort`**, only if the row reached `exporting` (a `begin` may have been sent). Retry up to 5 times inside compensation. Outcomes per §5.5.
2. **Export host**, only if a claim was recorded: wait while a lifecycle job is pending. A MOUNTING boot with no job → `releaseExportBoot` + `retireUnenrolledHost` (§5.2). Wait until the placement is `STOPPED` at N+1/E+1 (or later) with no job: either the host-retire receipt (`INSTANCE_LOST`), or a refused or undone start.
3. **Write `fail(m, 'failed_reopened', reason)` in a transaction that holds the computer lock and re-reads the placement as settled in the same transaction.** The next Free hold open is a replace at N+2/E+2, which satisfies the guard's epoch rule (`guard.py:250-254`).

If step 1 or step 2 cannot be confirmed within its bound, write `failed_needs_operator(abort_unconfirmed | boot_unsettled)`. Open still works for those (§5.3).

### 5.8 Re-subscribe race rule (pinned)

1. Forward and reverse creates are mutually exclusive per computer (§3.3).
2. The entitlement is re-read at every pre-flip pass, and once more in transaction 1 under the locks, in the same transaction that sets `commit_sent_at`. Paid before that commit → the move compensates to `failed_reopened('entitlement_paid')`. The placement stays `aws-ec2`, and the paid user keeps the same AWS computer; no move is needed.
3. Paid after `commit_sent_at` → the flip finishes; §5.6 step 4 then starts the forward move.
4. `invoice.paid` during a move:
   - `startPaidMigration` skips non-Cloudflare placements (`provider-migrate-runtime.ts:183-184`), or is refused by the exclusion.
   - Its errors are swallowed (`provider-migrate-orchestrator.ts:149-160`).
   - So rule 5.6 step 4 is the only catch-up, and it is mandatory.
5. Live T6: cancel, start the move, and resubscribe within 60 s while `copying`. Expect `failed_reopened` with reason `entitlement_paid`, the placement still `aws-ec2`, and no reverse row holding.

### 5.9 Triggers and gates

- **`computer.move.start`** (new mutation, `startedBy:'user'`).
  - Requires standing `files_on_aws` (`standing.ts:12-13`), an `aws-ec2` placement, the kill switch off, and no forward work.
  - It refuses `move_unavailable` after a `reopen_after_session` failure with no AWS session since, or a `reopen_final` failure that is not `operator_cleared`.
  - It returns the holding row (creating it when none holds).
- **`computer.move.retry`** (new mutation). It is the same as start. It exists because the shell's `move-retry` must stop calling `switchTo` (`computers.js:1255-1258`). It is refused while a row holds the computer, which includes `failed_needs_operator`.
- **Next open (`startedBy:'open'`, D20, in v1).** In the open mutation path (not reads), the open creates a row and returns the waiting provider when ALL of these hold:
  - standing `files_on_aws`;
  - the placement is `aws-ec2` `STOPPED` with no lifecycle job and no lease (no transition active);
  - no reverse row holds the computer, and the newest reverse row, if any, is not `failed_*` (after any failure, only a click starts the next move);
  - no forward work (§3.3);
  - the kill switch is off;
  - the account is **not founder-owned** (§5.9.1).
  - Otherwise the open proceeds as the D16 hold (a cold Free boot).
  - Lock order (§3.3): create on the same `tx`, or after commit.
- **Cron (`'cron'`, after canary2 acceptance).** It uses the same conditions as the open trigger, and never retries after any `failed_*` row.

#### 5.9.1 Founder-owned accounts (pinned; fail-closed; no new env)

An account is founder-owned for this contract when ANY of these holds:
1. its email's domain is `ezil.work` (case-insensitive). This covers contact@ezil.work, which STATUS treats as founder-owned (round 6 STATUS lines 19 and 93), and founder@ezil.work.
2. its email is on the existing operator allow-list read by `isTelemetryAdmin(email, env.TELEMETRY_ADMIN_EMAILS)` (`telemetry/admin.ts:15`). That is the same gate `billing.ts:277-280` already uses as the operator identity.
3. its email is missing or unreadable.

The rule over-excludes on purpose. A founder-owned account never gets an `'open'` or `'cron'` row; it moves only on the explicit Move click from its own session. The same helper drives the DTO's `moveOnOpen` (§6.1).

---

## 6. Summary DTO and shell (lanes A + U)

### 6.1 `summary.computer.move` and `summary.computer.moveOnOpen`

`ComputerMoveV3` at `contract.ts:242-247` is extended. `summary.ts:262` stops hard-coding `null`.

```ts
interface ComputerMoveV3 {
  direction: 'to_cloudflare' | 'to_aws';
  /** to_cloudflare: REVERSE_MOVE_DTO_STAGE[state] */
  stage: 'saving' | 'copying' | 'checking' | 'flipping' | 'committed' | 'failed_reopened' | 'failed_needs_operator' | string;
  bytesDone: string;          // decimal; import_progress.bytes, '0' before copying
  bytesTotal: string | null;  // decimal; bytes_total once the export head is known
  reason: string | null;      // failed_* only: last_error, from the §5.5 closed list
  skipped: number | null;     // export head `skipped`; null before it is known
  retainUntil: string | null; // ISO; committed only
  retry: 'now' | 'after_aws_session' | 'no' | null;  // failed_* only, from the §5.5 class
  openBlocked: boolean;       // true only for failed_needs_operator with openBlocked (§5.3)
}
// summary.computer.moveOnOpen: boolean. True when standing is files_on_aws, no move holds, and the open
// trigger would fire (§5.9: not founder-owned, newest row not failed_*). The pre-move card copy needs it.
```

- **Stage map** (`REVERSE_MOVE_DTO_STAGE`, `provider-reverse-store.ts:57`): `requested`, `booting` and `exporting` → `saving` (step 0); `copying` → `copying` (1, with bytes); `checking` → `checking` (2); `flipping` → `flipping` (3).
  - These are keys the dormant `MOVE_STEP_OF` already has (`computers.js:504`), and a unit test pins that.
  - The shell's own `exporting: 1` entry is never sent for `to_cloudflare`.
- **Visibility:** non-null when the newest row for the computer is holding, or is terminal with `updated_at` within the last 24 h. Otherwise null, and the standing banner applies. A `failed_needs_operator` row is always visible.
- The shell already accepts `reason` with `/^[a-z0-9_:-]{1,64}$/i` (`computers.js:511`).

### 6.2 Shell changes (lane U)

- The step 4 label changes from "Starting your desktop" to **"Switching to your Free computer"** (`computers.js:503`).
- `move-retry` calls `computer.move.retry`, and is shown only when `retry === 'now'`.
- The done, failed and needs-attention cards use the §6.3 copy.
- Add a pre-move card with the "Move my files…" action on the files-held state, with the variant chosen by `moveOnOpen`.
- An open refused with `computer_move_needs_attention` shows the needs-attention card, never a spinner.
- The `files_on_aws` banner (`computers.js:499`) drops the region name.

### 6.3 User copy per state (no city or region names, no speed or duration claims)

The "not moved" list, used verbatim wherever it says {NOT_MOVED}: **settings and programs you added on your AWS computer, saved browser sign-ins, installed packages, and build folders you can recreate (node_modules, .next, .turbo and dist, unless Git tracks them)**.

| State | Copy |
|---|---|
| files held, `moveOnOpen` true | **Your files are on your AWS computer.** The next time you open your computer, we'll first move the files in your Workspace folder to your Free computer. Not moved: {NOT_MOVED}. Your AWS computer's disk is kept for 14 days after the move. [Move my files now] |
| files held, `moveOnOpen` false | **Your files are on your AWS computer.** Opening it uses your Free limits. You can move the files in your Workspace folder to your Free computer. Not moved: {NOT_MOVED}. Your AWS computer's disk is kept for 14 days after the move. [Move my files to my Free computer] |
| `saving` | Moving your files to your Free computer. Step 1 of 4: Saving your files. |
| `copying` | Step 2 of 4: Copying your files to your Free computer. "X MB of Y GB copied" (existing `moveView`). |
| `checking` | Step 3 of 4: Checking your files. |
| `flipping` | Step 4 of 4: Switching to your Free computer. |
| `committed` | Your files are on your Free computer. Not moved: {NOT_MOVED}{skipped > 0: ", and N items that can't be copied, like links that point outside your Workspace folder"}. Your AWS disk is kept until {retainUntil date}. |
| `failed_reopened`, `retry: 'now'` (default) | We couldn't move your files. They're still on your AWS computer and nothing was deleted. [Try again] |
| `failed_reopened`, `workspace_too_large` | Your Workspace folder is larger than a Free computer can hold (512 MB), so your files stay on your AWS computer. Nothing was deleted. Remove some files on your AWS computer and try again, or upgrade to keep using them. [Upgrade] (Try again appears once `retry` is `now`) |
| `failed_reopened`, `entitlement_paid` | Your plan is active again, so your files stay on your AWS computer. (no button) |
| `failed_reopened`, `retry: 'no'` (`reopen_final`) | We couldn't move your files. They're still on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it. (no Try again) |
| `failed_needs_operator`, `openBlocked` false | We couldn't finish moving your files. They're safe on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it. (no Try again; Send feedback when enabled) |
| `failed_needs_operator`, `openBlocked` true | We're finishing moving your files to your Free computer. Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it. (no Try again; Send feedback when enabled) |

---

## 7. Retention and the D21 snapshot (lane O)

- After the flip, the placement row no longer exists (`placement.ts:838` deletes rows on flips). So **the committed reverse row is the only DB record of the AWS volume.** It holds `aws_volume_id`, `aws_fs_uuid`, `aws_snapshot_id` and `retain_until` (commit + 14 d, DB clock).
- **Snapshot (D21, mandatory).**
  - **Executor:** lane O ships a fenced `reverse_snapshot` lifecycle operation, modelled on the preparation machine's `createSnapshot` step (`preparation-helper.ts:83-96`, `preparation-definition.ts:40-47`). Its preconditions: the volume is `available` and unattached, owned by the account, and tagged with this computer's id.
  - **Started** by the reverse sweep for every `committed` row with `aws_snapshot_id IS NULL`.
  - **Recorded** with `recordSnapshot` (once) as soon as `CreateSnapshot` returns an id. A pending snapshot is already point-in-time.
  - **Alert:** a committed row with no snapshot 1 h after commit is listed by `retention.ts` as `snapshot_missing` and logged `[reverse-move] snapshot_missing`. An operator takes it by hand (T1 does so for canary2).
  - Lane O ships before the app deploy (release order, §8), so every committed move gets one.
- **Purge.** Extend `retention.ts` (dry run, `retention.ts:1-13,58-64`) with a read-only listing of `committed` rows whose `retain_until < now()`, and the `snapshot_missing` rows.
  - Deletion is a separate founder-owned principal, never a workflow role. Both workflow roles deny `DeleteVolume` and `DeleteSnapshot` (rule R11).
- **DLM.** `dlmRoleArn` pins `role/service-role/…` (`ops.ts:36`). Change it only after `iam get-role` confirms the path. T0 saw a DLM 12-hourly snapshot of the founder's volume (snap-053333a158f9cc895, 10-29 19:38Z), so DLM runs for at least that volume; DLM snapshots never replace the D21 snapshot.

---

## 8. Live proofs (T0 hypotheses, R5-8) and acceptance

| ID | Hypothesis | Status at S0 | Who proves, and how |
|---|---|---|---|
| a | canary2's history shape | **Settled at T0** (STATUS 07:36:43Z): forward migration committed 10-22 with a format-2 system head, so begin sees `headKind: 'migrated'`. The `none` shape is untested until T5. | W/A at T3; T5 for `none` (incl. the `freshProvision` context replacement, §4.4) |
| b | The volume's lower digest equals the baked lower | open | H: the marker's `lowerImageDigest` equals the manifest's; console `guard_result ok` at the export boot |
| b2 | The promoted lower has `/usr/bin/python3` and `/usr/bin/git`, which the codec needs (`workspace-snapshot-script.ts:1,103`) | open | H: a static check of the lower at bake time, before H ships |
| c | The export boot enrolls as an ordinary STARTING/MOUNTING row and never reaches RUNNING | code-confirmed (`placement.ts:1408`) | A: enroll log line; the EC2 tag `ezil:generation` = N+1; the row stays MOUNTING until `releaseExportBoot` |
| d | Wake path for a STOPPED Free row | code: cold replace (`aws-ec2.ts:476`) | A: lifecycle operation `replace`; the volume is `available` before the claim |
| e | Idle stop vs poll cadence; capture time for the real workspace and for 512 MiB | open | H: status timestamps; no idle stop while `capturing` or `ready` within the hold |
| e2 | Host → Worker → R2 throughput ≥ 0.5 MiB/s (§5.4) | open | H+W: bytes per pull and per pass on the T3 move; below the floor → §5.4 changes first |
| f | Caps, epochs and usage never touch the export boot | design (§5.2) | A: `ezil_billing_compute_epochs` and `ezil_compute_usage` have 0 rows for the computer from the move start |
| g | canary2's DO resolves the store to `r2` (pin or `EZIL_WORKSPACE_STORE`), and its `wctx.prefix` equals the P derivation | open | W: a read-only DO probe before T2; `s3` → v1 refuses `store_unsupported` and this contract changes first |
| h | The start fence on a never-on-Cloudflare prefix | design (§4.1) | W: unit test; live in the T5 `none` shape |
| i | Stripe test clocks vs the `stripe_event_created` drop | only if used | A |
| j | The staging app's `billing-session-sweep` runs every minute, as `vercel.json:15-17` schedules it in production | open | A: sweep log timestamps on staging |
| k | The host root volume has ≥ 1.75 GiB free for staging | open | H: `df` on a baked host |
| l | Founder-owned rule: canary2's email is outside §5.9.1, so the open trigger can be proven on it | open | A: read-only check; if canary2 is founder-owned, the open trigger is unit-proven only and acceptance says so |

**T-sequence (canary2 only; contact@ only on the founder's click):**

1. **T0**: read-only fingerprint, including (g), (j), (l).
2. **T1**: snapshot `vol-0b1ffbc8f8cfa6384`.
3. **T2**: failure injection, an abort during `copying`. Expect `failed_reopened`, the placement `aws-ec2` STOPPED (`INSTANCE_LOST`) at N+1/E+1 with the instance terminated, and the hold Open still working (a replace at N+2/E+2).
4. **T3**: the real move, triggered by the open when (l) allows, else by the click. Expect:
   - the §4.4 heads;
   - a Cloudflare STOPPED row, and the instance terminated before `commit_sent_at`;
   - the volume `available` and retained, and a snapshot recorded;
   - standing `free`.
5. **T4**: open on Cloudflare. The marker file is present.
6. **T5**: resubscribe → forward → cancel → reverse (`none` shape).
7. **T6**: the race in §5.8.
8. **T7**: a Free user with no placement is unchanged.

**Release order:**

1. Snapshot.
2. AMI bake and promote-canary (H).
3. Worker deploy (W). The routes stay unused until the app calls them.
4. Lane O snapshot executor and IAM (O, plus a founder IAM step).
5. **Apply 0012 on staging** (`billing-staging-schema.mjs plan`, then `apply --yes --target aws-preview --expect-system-id <digits>`).
6. App deploy with the user and open triggers (A+U). Only held `files_on_aws` placements are affected; founder-owned accounts get no open trigger.
7. canary2 acceptance.
8. Cron trigger.
9. DLM and the retention purge runbook (O).

---

## 9. Out of scope for v1

- The S3 and migrating workspace stores (`store_unsupported`).
- Anything outside `/workspace` (D-4).
- Automatic retries after any failure (the open trigger and cron never re-create after `failed_*`).

## 10. Changes in r2 (review of `dc362e53`)

1. Export-boot placement path pinned with **no new edges**. The receipts get an export-boot mode, keyed on `readByExportBoot` in any state, instead of a whole-function skip. It suppresses the MOUNTING-time usage open and RUNNING. The release reuses the existing enrollment-host-retire chain, which lands STOPPED/`INSTANCE_LOST` at N+1/E+1 (§5.2).
2. Capture mechanics pinned. A dedicated export spec: read-only lower root, `/tmp` on a root-volume dir so the codec's own `mkdir` works, read-only `/workspace`, no profiles bind, a new network namespace. Plus a free-space floor, and python3/git as T0 (b2) (§2.5).
3. `workspace_too_large` reaches the app. The codec's exit 3 now covers `export-capture`, the Worker sends top-level 409 codes, and retry is refused until an AWS session (§2.6, §4.3, §5.5).
4. The point of no return is durable. `commit_sent_at` is set by `checking → flipping` under the locks with the entitlement re-check. `flipping` never reopens (store and CHECK). The export host is retired before the commit. The Worker serialises commit and abort and adds `commit_in_progress` (§3, §4, §5.6).
5. Majors:
   - **Store:** R2-only v1 through `selectWorkspaceStore()`, with no `head()` and no customMetadata (§4.1).
   - **Prefix:** P derivation and the `prefix_mismatch` refusal (§4.1).
   - **Edge↔agent protocol:** the full agent message, an async job, and status/head/chunk served from disk by the edge (§2.2, §2.5).
   - **Outcomes:** a closed reason → outcome table and `last_error` vocabulary (§5.5).
   - **Throughput:** the driver's own budget, 64-chunk pulls, and progress-based deadlines with worst-case arithmetic (§5.4).
   - **D20:** the next-open trigger is restored, with a pinned founder-owned rule (§5.9).
   - **D21:** the snapshot is mandatory, with a named executor and an alert (§7).
   - **Copy:** the not-moved list now names dropped build folders (§6.3).
   - **`failed_needs_operator`:** Open is refused at once with a card, or allowed when the commit was never sent (§5.3).

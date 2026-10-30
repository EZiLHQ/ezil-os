# Reverse move contract: AWS → Cloudflare (Phase B, round 6b)

**Status:** pinned (S0), 2026-10-30. Lanes H, W, A, U and O build against this file in parallel.
A change to any wire shape, state, code or limit below changes this file first. Every lane cites the
section it implements.

**Base:** citations are `path:line` at `74ed2c92`, read from the untouched base worktree. They point to
the code each rule is based on. Citations to `provider-reverse-store.ts`, `0012` and the edited
`provider-migrate-store.ts` are to this branch (`r6/phaseb-20261030`).

**What S0 ships (done, tested):**
- `app/drizzle/0012_compute_reverse_moves.sql`: the table, §3.
- `app/src/server/lib/compute/provider-reverse-store.ts`: the store, §3.4.
- The cross-direction exclusion in both stores, §3.3.
- The Drizzle model `computeReverseMoves` in `app/src/server/db/schema/computers.ts`.
- Registration: drizzle journal idx 8, staging `EXPLICIT_FILES` plus the aws-production refusal, and a
  production `snapshot` source.

Everything else below is a contract for lanes that have not started.

---

## 0. Decisions this contract assumes (taken; not reopened here)

| # | Decision |
|---|---|
| D-1 | **Export channel.** A signed host edge op plus a maintenance-agent AMI bake. No SSM: hosts keep no instance role (rule R5, `infra/app-computers/README.md:176,194-214`; `infra/app-computers/lib/lifecycle/helper.ts:603`). |
| D-2 | **Reverse moves live in a NEW table.** 0006 is never relaxed. None of the forward readers filter by direction: `provider-migrate-store.ts:107-118,131-144`, `provider-migrate-placement.ts:27-34`, `placement.ts:1897`, `select.ts:120-126`. |
| D-3 | **The export boot is a normal replace boot on the published placement row**, at generation N+1 and lease epoch E+1. It is identified from the reverse row, never from `lastError`, because enrollment overwrites `lastError` (`placement.ts:1533,1569`). |
| D-4 | **v1 moves `/workspace` only.** It records the codec's skipped count, and refuses when over the workspace cap (the files stay on AWS). The UI says before and after what is not moved: settings and programs added on the AWS computer (HOME dotfiles, installed packages) and browser sign-ins (profiles). |
| D-5 | **Triggers.** v1 has only the user action "Move my files to my Free computer" (`startedBy: 'user'`). The next-open trigger (`'open'`, D20) follows after canary2 acceptance, and cron (`'cron'`) after that. A founder-owned account moves only on that account's own click. |
| D-6 | **Retention.** The AWS volume, plus a snapshot when one is taken, is kept 14 days on the reverse row. Deletion is operator-only (rule R11). |
| D-7 | **No new env vars or flags.** The existing AWS admission kill switch gates everything (`aws-config.ts:274`). |

**Naming rule (all new wire formats):**
- `generation` always means the move's **import generation**: a lowercase UUID, immutable per reverse row. It is the chunk owner and the new v1 head's `generation`/`chunkGeneration` in R2.
- The placement's integer counters are always `placementGeneration` and `leaseEpoch`. They are never called `generation`.

---

## 1. Lanes and ownership

| Lane | Owns | Builds | Must prove (live, canary2 only) |
|---|---|---|---|
| **S0** (done) | 0012, `provider-reverse-store.ts`, the forward exclusion, registry | §3 | 0012 applied on the staging DB before the app deploys: plan, then apply with `--target aws-preview` (schema before code). |
| **H** host + AMI | `infra/host-agent/lib/ezil_host/{edge,agent,export,desktop}.py`, codec parity, maintenance-agent bake | §2 | (b) guard passes on the baked AMI (`guard_result ok`); (e) capture time and idle hold; staged chunks on the root volume only. |
| **W** Worker import | `worker/src/index.ts` routes, `workspace-migration-import.ts`, start-fence change | §4 | Heads before and after (§8 T0/T3); the first Cloudflare open hydrates with no `workspace_migrated`. |
| **A** app machine | `provider-reverse.ts`, `provider-reverse-runtime.ts`, `aws-receipts.ts` skip, `select.ts` wait, `placement.ts` flip, trigger route, sweep hook, summary | §5, §6.1 | (c) the export boot enrolls as STARTING/MOUNTING and never reaches RUNNING; zero epoch and usage rows; race T6. |
| **U** shell | `shell/ezil/ui/Settings/tabs/computers.js` move card, copy and retry | §6 | Copy matches §6.3 in every state, with screenshots. |
| **O** retention | `retention.ts` listing, `ops.ts` DLM role, operator purge runbook | §7 | `iam get-role` path; listing shows the committed row after 14 days (dry run). |

---

## 2. Host export (lane H)

### 2.1 Why a new op, and why a bake

- The edge routes are a closed set: `/__p` to desktop ports, `stop`/`fence`, `ice`, `desktop`, and `restart-desktop`. Everything else gets 404 (`edge.py:9-16,51-62,350-376`).
- The agent refuses any other op with `unknown_op` (`agent.py:159-176`).
- Lease keys are closed (`lease.py:45,166`).
- The agent code lives in the AMI at `/opt/ezil-host` (`build-host-ami.sh:59-61`).

So the export needs new edge routes, a new agent op and a bake. The bake is the **maintenance-agent** bake, which keeps the promoted lower (`deploy/aws/mum/json-tool.py:1020-1025`), so the volume's digest guard still passes (`guard.py:323`).

### 2.2 Edge routes (all gw1-verified, each verified request counts as presence)

The signature is unchanged: `x-ezil-gw: gw1.<ts>.<hex>` = HMAC-SHA256(controlKey, `gw1|ts|computerId|generation|leaseEpoch|METHOD|path`), with skew −120/+5 s (`edge.py:1-7,45-46`; Worker signer `aws-origin.ts:165-173`). The signature covers the path only, so **every input is in the path, or a body whose sha256 is in the path**, as `ice` does (`edge.py:58-60,408-425`).

| Method + path | Body | Success | Errors (JSON `{ok:false,error}`) |
|---|---|---|---|
| `POST /__ezil/control/export/<sha256hex(body)>` | Required. `Content-Length` 1..1024, no `Transfer-Encoding`, no query. Canonical JSON `{"v":1,"moveId":"<uuid>","generation":"<uuid>"}` with exactly these keys, lowercase UUIDs. | `202` with the §2.4 status. Idempotent for the same `{moveId, generation}`. | `400 export_body_invalid`, `400 export_digest_mismatch`, `409 export_busy` (another `{moveId, generation}` holds the host), `409 export_unavailable` (the desktop could not be stopped) |
| `GET /__ezil/control/export/status` | none, no query | `200` with the §2.4 status (`state: "none"` before any POST) | none |
| `GET /__ezil/control/export/head` | none | `200` with the §2.3 export head | `409 export_not_ready` |
| `GET /__ezil/control/export/chunk/<i>` | none. `<i>` is decimal with no leading zeros, `0 ≤ i < chunks.length`. | `200 application/octet-stream`, exact chunk bytes, `Content-Length` = `chunks[i].size` | `400 bad_chunk_index`, `409 export_not_ready`, `404 export_chunk_missing` |

The gw1 binding (computerId, placementGeneration, leaseEpoch) already ties each request to this host's lease. It is the export boot's N+1/E+1, so no other host can serve or be asked for this export.

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
- `skipped` counts what the codec skips: unrepresentable names, sockets, FIFOs, devices, and absolute or escaping links (`workspace-snapshot-script.ts:124,133,138`).
- The app enforces all of this as `validExportHead` (`provider-reverse-store.ts:200`). The app also checks `v === 1` and `moveId === row.id`, then stores the head without `v` and `moveId`.
- When written to R2 as a v1 head, `i` is dropped: `chunks: [{size, sha256}]` (`workspace-persist.ts:26-36`).

### 2.4 Status JSON

```json
{ "ok": true, "state": "none|capturing|ready|failed", "moveId": "<uuid>|null", "generation": "<uuid>|null",
  "startedAt": "<ISO>|null", "finishedAt": "<ISO>|null",
  "error": null | "workspace_too_large" | "workspace_missing" | "capture_failed" | "desktop_stop_failed",
  "entries": 0, "bytes": 0, "skipped": 0 }
```

`entries`, `bytes` and `skipped` are present only when `state` is `ready`. **`workspace_too_large` is permanent.** It is the codec's exit code 3 on the byte, entry or Git-index limits (`workspace-snapshot-script.ts:321-323`).

### 2.5 Agent op `export` (closed field set)

- **Fields:** `{op:"export", seq, ts, moveId, generation}`. Any other field returns `export_invalid`. Replay and staleness rules are the agent's existing ones (`agent.py:135-180`). The edge relays the parsed body fields only.
- **Behaviour:**
  1. One job per host. A durable state file `/var/lib/ezil-host/export/state.json` (0600, **root volume**) holds `{moveId, generation, state, startedAt, finishedAt, error, head}`. The same `{moveId, generation}` resumes or reports; anything else gets `export_busy`.
  2. Stop the desktop unit, under the same runDir/stopping guard as `stop`.
  3. Capture in a **throwaway runc container from the desktop lower**. Use `build_spec`'s non-desktop mode (`desktop.py:526`). The volume's `workspace/` is bind-mounted **read-only** at `/workspace` (layout `desktop.py:577-578`). Network mode is `none` (loopback only, `desktop.py:463`). The staging dir is mounted at the codec's required `/tmp/ezil-snapshot-<generation>` (`workspace-snapshot-script.ts:14-18`).
     - Never run the codec as host root on guest bytes. It runs `git ls-files` on the guest's index (`workspace-snapshot-script.ts:103`), and the host has no git (`build-host-ami.sh:33-43`). Doing so breaks safety rule 3a.
  4. The codec is the Worker's `SNAPSHOT_SCRIPT` plus one new op, **`export-capture`**: `capture` without `marker()`. AWS volumes carry no `.ezil-hydrated.json` (`workspace-snapshot-script.ts:66-74`).
     - It is copied into `infra/host-agent` at bake time.
     - A parity test is generated from `worker/src/workspace-snapshot-script.ts`, so the copy cannot drift.
  5. Chunks and `head.json` are staged under `/var/lib/ezil-host/export/<generation>/`, never on the data volume. They die with the instance at retire.
  6. **Idle hold.** While a job is `capturing` or `ready`, the idle stop (`agent.py:544-549`; window 600 s, `config.py:34`) is held for at most **45 min from `startedAt`**. After that the normal predicate applies again.
     - Worker pulls are presence anyway (`edge.py:350`). The app polls at least every 60 s while `exporting` (§5.4).

### 2.6 Lane H acceptance (unit, then live)

- Unit:
  - closed body and fields;
  - digest mismatch;
  - idempotent POST;
  - `export_busy`;
  - chunk index grammar;
  - read-only bind and no network in the generated spec;
  - codec parity test;
  - the too-large exit code mapped to `workspace_too_large`.
- Live:
  - after the bake, `/etc/ezil-host/lower-image-digest` equals the manifest's `lowerImageDigest`;
  - canary2's export boot console shows `guard_result` `ok`;
  - status timestamps give the capture time of the real workspace (R5-8 e).

---

## 3. The reverse row (S0, shipped)

### 3.1 Table `public.ezil_compute_reverse_moves` (`0012_compute_reverse_moves.sql:4-32`)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()`; this is the `moveId` everywhere. |
| `user_id`, `computer_id` | uuid NOT NULL | Owner and computer. Create refuses another owner's row. |
| `started_by` | text | `'user' \| 'open' \| 'cron'` (D-5) |
| `state` | text, default `requested` | §3.2 |
| `generation` | uuid NOT NULL, default `gen_random_uuid()` | The import generation. Immutable; a retry is a **new row**. |
| `export_boot` | jsonb object | `{placementGeneration, leaseEpoch, volumeId, jobId, instanceId, fsUuid, claimedAt}` (§5.1) |
| `export_head` | jsonb object | §2.3 without `v` and `moveId` |
| `import_progress` | jsonb object | `{bitmap, bytes, archiveSha256, first, last}`. The bitmap is 128 hex chars (512 bits): bit i = byte ⌊i/8⌋, mask `1<<(i%8)`, the same order as forward `restore_progress` (`provider-migrate-store.ts:89-106`). |
| `bytes_total` | bigint | 0..536,870,912. Set with the export head. |
| `skipped` | integer ≥ 0 | Set with the export head. |
| `aws_volume_id` | text | `^vol-[0-9a-f]{8,17}$` |
| `aws_fs_uuid` | uuid | |
| `aws_snapshot_id` | text | `^snap-[0-9a-f]{8,17}$` |
| `retain_until` | timestamptz | Only on `committed` (named CHECK). Set to commit + 14 d from the DB clock. |
| `attempts` | int 0..5 | Consecutive failures in the current state. |
| `last_error` | text ≤ 200 | Reason code, `^[a-z0-9_.:-]{1,200}$` |
| `created_at`, `updated_at` | timestamptz | `updated_at` is the CAS token and is read as `::text`. |

- **One holding row per computer.** A partial unique index covers `state NOT IN ('committed','failed_reopened')`. This differs from 0006: **`failed_needs_operator` still holds the computer**, because a half-imported generation or a raised flag may remain. Only an operator releases it, to `failed_reopened`.
- RLS is enabled with no policy, and `REVOKE ALL … FROM public, anon, authenticated`, exactly as in 0006/0010/0011.
- Staging-only: the aws-production apply and baseline are refused (`billing-staging-schema.mjs`). It is registered as a production `snapshot` source like 0010 and 0011.
- Unlike 0008–0011 it has a drizzle journal entry (idx 8), so `billing-test-db.sh` applies it. `ci-migrate.mjs` still refuses it, because REVOKE is outside its grammar.

### 3.2 States, transitions and writers

```
requested ─► booting ─► exporting ─► copying ─► checking ─► flipping ─► committed
     │           │           │           │           │           │
     └───────────┴───────────┴───────────┴───────────┴───────────┴──► failed_reopened | failed_needs_operator
                                                                      failed_needs_operator ─(operator)─► failed_reopened
```

The table is `REVERSE_MOVE_TRANSITIONS` (`provider-reverse-store.ts:35`). Every write is a store call. The writer is always the app (lane A), except the operator release.

| Edge | Store call | Written by | Precondition the store enforces |
|---|---|---|---|
| — → `requested` | `createOrGetActive({computerId, userId, startedBy})` | trigger route (user), open path (`'open'`, later), sweep (`'cron'`, later) | No forward work for the computer (§3.3); same owner. |
| `requested → booting` | `recordExportBoot(m, claim)` | machine, **inside the placement claim transaction** (§5.1) | Valid claim. In `booting`, only `jobId`, `instanceId` and `fsUuid` may be added to the same claim. |
| `booting → exporting` | `advance(m,'exporting')` | machine, after enrollment | `exportBoot.instanceId` set. |
| `exporting → copying` | `recordExportHead(m, head)` | machine | The head is valid for `m.generation`; progress resets. |
| `copying` (self) | `recordImportProgress(m, indices)` | machine, after each Worker `pull` | Indices are within the head. Idempotent per index; resets `attempts`. |
| `copying → checking` | `advance(m,'checking')` | machine | Every chunk bit is set for the current `archiveSha256`. |
| `checking → flipping` | `advance(m,'flipping')` | machine, after Worker `commit {verifyOnly:true}` | — |
| `flipping → committed` | `finish(m, {awsVolumeId, awsFsUuid, awsSnapshotId})` | machine, **in the same transaction as the placement flip** (§5.5) | `retain_until` = DB clock + 14 d |
| in-flight → `failed_*` | `fail(m, to, reason)` | machine, **after** compensation (§5.6) | — |
| `failed_needs_operator → failed_reopened` | `fail(m,'failed_reopened', reason)` | operator only, after manual cleanup | — |
| committed (self) | `recordSnapshot(m, snapId)` | lane O | Once. |
| any in-flight (self) | `recordRetry(m, reason)` | machine | `attempts < 5`. Otherwise `{exhausted:true}` and nothing is written; the caller must compensate and `fail`. |

A lost CAS throws `ReverseMoveConflictError('lost_race')`. An illegal edge throws `illegal_transition` and writes nothing. The caller re-reads; nothing retries inside the store.

### 3.3 Cross-direction exclusion and the computer lock

- Both creates follow the same order:
  1. INSERT … ON CONFLICT DO NOTHING;
  2. **the placement per-computer lock**: `pg_advisory_xact_lock(PLACEMENT_LOCK_NAMESPACE, hashtext(computerId::uuid::text))`, the same key as `placement.ts:212-214,542-548`, under READ COMMITTED only;
  3. check the other direction in a new statement;
  4. throw, which rolls back the insert.
- They run in one transaction when the executor has one (`inMoveTransaction`, `provider-reverse-store.ts:159`).
- The check comes after the lock, so the second creator sees the first's committed row. The PG race test runs 20 rounds with exactly one winner each. A mutant without the lock fails it 3/3.
- **Forward refuses** (`MigrationConflictError`, `provider-migrate-store.ts:142`) while a reverse row is in a holding state.
  - It first probes `to_regclass('public.ezil_compute_reverse_moves')` as its own statement.
  - A database without 0012 (production, and the forward suites' schemas) therefore behaves exactly as before.
- **Reverse refuses** (`forward_active`, `provider-reverse-store.ts:183`) while the forward machine still has work. That is an active forward row, or a `failed_*` row whose `_awsProvision` is not released: exactly what forward `claimStale` picks up (`provider-migrate-store.ts:107-118`).
- **Lock order** stays admission → computer (`placement.ts:30-41`). Never call either `createOrGetActive` on a *different* connection while holding the computer lock: the second call would wait on your own lock. Pass the same `tx`, or call it after commit.

### 3.4 Store surface (`createProviderReverseStore(db)`)

- **Reads:** `readById`, `readByComputer` (newest), `readActiveByComputer` (holding).
- **Writes:** `createOrGetActive`, `recordExportBoot`, `advance`, `recordExportHead`, `recordImportProgress`, `recordRetry`, `fail`, `finish`, `recordSnapshot`, `claimStale(limit ≤ 10)`.
  - `claimStale` takes in-flight rows idle for 30 s, oldest first, with `FOR UPDATE SKIP LOCKED`, and bumps `updated_at`. It mirrors forward `claimStale`. `failed_needs_operator` is never claimed.
- **Constants:** `REVERSE_MOVE_DTO_STAGE` (§6.1), `EXPORT_*` limits, `REVERSE_MOVE_MAX_ATTEMPTS = 5`, `REVERSE_MOVE_RETENTION_DAYS = 14`.
- To write inside a placement transaction, build the store over that `tx`.

---

## 4. Worker import routes (lane W)

### 4.1 Common rules

- **Path:** `POST /sandbox/<name>/migrate/import/{begin,pull,commit,abort}`.
  - The app's `migrateRequest` (`cloudflare-guacamole-provider.ts:3365-3401`) is reused with `action = 'import/<op>'`. It applies signed control auth, a 409 maps to a closed reason enum, and timeouts are 120 s for begin and 30 s otherwise.
  - Extend the route regex next to `index.ts:7827` and authorize with `authorizeSignedControlRequest` exactly as at `index.ts:7828-7830`.
- **`<name>`** = `deriveGuacamoleSandboxId(userId, computerId)` (`cloudflare-guacamole-provider.ts:1273-1277`). Every body carries the full `computerId`. The Worker refuses `400 invalid_body` unless `computerId.replace(/[^a-z0-9]/gi,'').slice(0,16)` equals the name's scope part.
- **Prefixes:** workspace `P = <computerId>/branches/main`; system `S = systemPrefixOf(P)` (`system-persist.ts:32-35`). Chunks go to `chunkKey(P, generation, i)` = `P/.ezil-snapshots/<generation>/<i>` (`workspace-persist.ts:304-305`), with R2 `customMetadata {sha256}`.
- **Host binding:** the Sandbox DO for `<name>` reaches the host through the AWS tunnel record for the same `<name>`. It uses `lookupAwsTunnel` (`aws-tunnels.ts:565`) and signs every GET with `signGatewayHeader` (`aws-origin.ts:165-173`), as `sendAwsControl` does (`aws-origin.ts:443-466`).
  - Every request carries `placementGeneration` and `leaseEpoch`. The record must match both, or the response is `409 export_host_mismatch`. This means the Worker only ever pulls from the export boot's host.
  - The bytes never pass through the app.
- **DO key `ezil:reverseImport`:** `{moveId, generation, computerId, placementGeneration, leaseEpoch, headKind:'none'|'migrated', migratedEtag, systemMigratedEtag, startedAt, head?, puts:{[i]: r2Etag}, verified?}`. At most one exists. A different `{moveId, generation}` gets `409 import_busy`.
- **Start fence:** `migrationStartBlocked` (`index.ts:2532-2538`) returns false when the DO has no workspace flush context. That is exactly the case for a computer created on AWS.
  - Lane W makes it **also block while `ezil:reverseImport` exists**.
  - The hydrate fence already blocks on the R2 flag by prefix (`index.ts:2781-2783`).
- **Flag:** `P/.ezil-snapshots/migrating.json` = `{startedAt, reverse:{moveId, generation}}` (`workspace-persist.ts:189`).
  - It goes stale 40 min after `startedAt` (`workspace-persist.ts:201`), so **every `pull` rewrites `startedAt`**.
  - Garbage collection is already safe: it is suspended under a migrated head and does nothing with no head (`workspace-persist.ts:594-597`).

### 4.2 `begin`

Request: `{moveId, generation, computerId, placementGeneration, leaseEpoch}`.

1. A container for `<name>` is running → `409 container_running`.
2. Read `P`'s head (`readHead`/`readMigratedHead`, `workspace-persist.ts:232-258`):

| Head at `P` | Result |
|---|---|
| absent | OK, `headKind: 'none'`. The computer was created on AWS (fresh provision). |
| migrated v2, `targetProvider: 'aws-ec2'` | OK, `headKind: 'migrated'`. Record `migratedEtag` (R2 etag of `latest.json`) for the commit CAS. |
| migrated v2, any other target | `409 head_invalid` |
| **ordinary v1 snapshot** | **`409 head_moved`**: Cloudflare wrote since, and is never overwritten. One exception: if it is this move's own committed head (`generation` equal), return `409 already_imported`. |
| unreadable or invalid | `409 head_unreadable` |

3. Read `S`. It must be absent (record `systemMigratedEtag: null`) or migrated v2 (record its etag). A v1 system head with a migrated or absent workspace head is inconsistent → `409 system_head_moved`.
4. Write the flag, then the DO key.
5. Send `POST /__ezil/control/export/<sha>` with `{v:1, moveId, generation}` to the host. This is idempotent.
6. Return `200 {ok:true, headKind, export:<host status §2.4>}`.

Repeating `begin` with the same ids is idempotent. It re-reads nothing in R2 and re-sends the host POST.

### 4.3 `pull`

Request: `{moveId, generation, computerId, placementGeneration, leaseEpoch, from, count}`, with `0 ≤ from < 512` and `0 ≤ count ≤ 16`.

1. The DO key must match. Otherwise `409 import_not_started`, or `409 import_mismatch` for other ids.
2. `GET …/export/status`.
   - `failed` → `409 export_failed`, body `{ok:false, error:'export_failed', exportError:<§2.4 error>}`.
   - Not `ready` → `200 {ok:true, export, head:null, stored:[], next:from}`. This is how the app polls.
3. On the first `ready`, `GET …/export/head`. Validate it exactly as §2.3 and check `moveId` and `generation`, otherwise `409 export_head_invalid`. Cache it in the DO key.
4. For `i` in `[from, min(from+count, n))`, stopping when **20 s** of wall time is spent:
   - If the DO has `puts[i]` and R2 `head(chunkKey)` has that etag and size, count it as stored.
   - Otherwise GET the chunk. Check `size` and sha256 against `head.chunks[i]`, else `409 chunk_mismatch`. Put to R2, record `puts[i] = etag`, and refresh the flag.
5. Response: `200 {ok:true, export, head, stored:[i…], next: <first index not stored at or after from> | null}`.
6. A tunnel or host failure is `503 export_unreachable`; the app retries.

### 4.4 `commit`

Request: `{moveId, generation, computerId, sha256, chunkCount, verifyOnly: boolean}`.

- **`verifyOnly: true`** runs in the `checking` state.
  - Every `i < chunkCount` must have `puts[i]`, and R2 `head()` must show the same etag, size and `customMetadata.sha256`.
  - `sha256` and `chunkCount` must equal the cached head.
  - Build the v1 snapshot `{version:1, generation, chunkGeneration: generation, sha256, entries, chunks:[{size, sha256}]}` and check it with `parseSnapshot` (`workspace-persist.ts:127-140`).
  - Store `verified` in the DO key and return `200 {ok:true, verified:true}`.
  - Integrity rests on per-chunk sha256 checked at pull time, the R2 etag pinned at put, and hydrate re-verifying every chunk on the first open (`workspace-persist.ts:424`). **Do not re-hash 512 MiB in one request.**
- **`verifyOnly: false`** runs in the `flipping` state. It requires `verified` for the same sha and re-checks the etags with cheap HEADs. Then:
  1. **CAS the workspace head:** `put(P/latest.json, v1)` with `onlyIf: {etagMatches: migratedEtag}`, or `{etagDoesNotMatch:'*'}` when `headKind` is `none`. `previousChunkGeneration` is omitted, so the stale pre-move generation is garbage after the 1 h grace (`workspace-persist.ts:570`).
     - If the CAS fails, re-read. This move's own v1 head counts as success (idempotent). Anything else → `409 head_moved`.
  2. **Revert the system head:**
     - A migrated v2 head **with `previous`**: CAS-put `previous` back, with `onlyIf etagMatches systemMigratedEtag`.
     - A migrated v2 head **without `previous`** (legacy marker): delete the head.
     - Absent: no-op.
     - The etag moved → `409 system_head_moved`, after the workspace head is already committed. This is retryable and idempotent.
     - Why revert: today a migrated system head blocks system saves forever (`system-persist.ts:172-174`). `previous` brings back the user's pre-move Cloudflare settings. Changes made on AWS outside `/workspace` are the "not moved" part of D-4.
  3. **DO keys:** `WORKSPACE_FLUSH_CONTEXT_KEY = {prefix: P, mountPath: '/workspace'}` with no `freshProvision`, `WORKSPACE_TOO_LARGE_KEY = false`, `SYSTEM_TOO_LARGE_KEY = false` (`index.ts:1872,2009,2019`). A later re-upgrade's forward export then has its context and known sizes (`index.ts:3507-3523`).
  4. Delete the flag, then the DO key. Return `200 {ok:true, committed:true}`.
- A repeated commit after success returns `200 {ok:true, committed:true}`. **The workspace-head CAS is the point of no return.**

### 4.5 `abort`

Request: `{moveId, generation, computerId}`.

- If `P`'s head is this move's committed v1 → `409 already_imported`. The app must then finish the flip.
- Otherwise delete `P/.ezil-snapshots/<generation>/*` (list and delete), the flag and the DO key. Return `200 {ok:true}`.
- With no DO key it still returns `200 {ok:true}` (idempotent).
- Abort sends nothing to the host. The app retires it.

### 4.6 Reason codes the app must add

`MIGRATE_CONFLICT_REASONS` is closed: anything unknown becomes `'other'` (`cloudflare-guacamole-provider.ts:3309-3314,3386-3396`). Lane A adds:

`container_running`, `head_invalid`, `head_unreadable`, `system_head_moved`, `import_busy`, `import_not_started`, `import_mismatch`, `export_host_mismatch`, `export_failed`, `export_head_invalid`, `chunk_mismatch`, `already_imported`, `not_verified`.

`head_moved` already exists. `export_unreachable` arrives as 503, which maps to `unavailable` (retry).

---

## 5. App reverse machine (lane A)

### 5.1 Export-boot claim (`requested → booting`)

The claim runs under `withAdmission` and then the computer lock (`placement.ts:582-588,542-548`), in one transaction:

1. Read the published row. It must be `aws-ec2`, `STOPPED`, with no lifecycle job pending and the owner equal to the row's user. If it is RUNNING, the machine first requests the ordinary stop and waits; it never takes over a live session.
2. Start a **cold replace** (`aws-ec2.ts:258-283`): `targetGeneration = N+1`, `leaseEpoch = E+1`, the same `dataVolumeId`, and ordinary user data (no new lease key, `lease.py:45`).
   - Free never uses the pool (`aws-ec2.ts:476`).
   - Capacity admission (regional vCPU) applies. **Entitlement start-gate admission does not**: no `admitStart`/`decideStart`, which would refuse a Free user's size (`compute-access.ts:210-217`).
3. In the same `tx`, call `recordExportBoot(m, {placementGeneration: N+1, leaseEpoch: E+1, volumeId, jobId, instanceId: null, fsUuid, claimedAt})`.

The boot then enrolls as an ordinary `STARTING`/`MOUNTING` row (`ENROLLABLE_STATES`, `placement.ts:1408`). The guard writes the volume marker at N+1/E+1 (`guard.py:374`).

### 5.2 Receipts: no epoch, no usage, no caps

- Add a second early return in `applyLifecycleReceipt`, next to `aws-receipts.ts:252`. It fires when an active reverse row has `exportBoot.placementGeneration === p.generation && exportBoot.leaseEpoch === p.leaseEpoch` for `p.computerId`.
- The machine reads that boot's execution receipt itself (pattern: `readMigrationReadyReceipt`, `aws-receipts.ts:1116`). It records `jobId`, `instanceId` and `fsUuid` with `recordExportBoot`, and advances to `exporting` once enrollment succeeded.
- **The row never reaches RUNNING.** So:
  - no `meter.ready` and no epoch (`aws-receipts.ts:265-277`);
  - no usage row;
  - no `sessionLimitFor` lease or hours-cap stop (`aws-receipts.ts:681-690`).

### 5.3 Routing while a move holds the computer

`select.ts` asks the reverse store before the placement provider, like `providerForPendingMigration` (`provider-migrate-placement.ts:27-34`). A holding reverse row returns the **waiting provider**. Opens wait and the shell shows the move card. They never boot or adopt the AWS computer for a session.

### 5.4 Step work, timeouts and retries

The sweep hook runs next to `advanceStaleMigrations` (`billing-session-sweep/handler.ts:169`). It shares the 40 s budget and the claim of 10 rows (`provider-migrate-orchestrator.ts:136-147`), via `claimStale`. Every step re-reads the entitlement first (§5.6).

| State | Work per sweep | Done when | Timeout → compensation (§5.6) |
|---|---|---|---|
| `requested` | Kill switch off (`aws-config.ts:274`) → claim (§5.1) | claim recorded | 10 min after `created_at` → `failed_reopened('boot_unavailable')`; kill switch → `'kill_switch'` |
| `booting` | read receipt and enrollment | `instanceId` set and enrolled → `advance('exporting')` | **15 min** after `claimedAt` → `'boot_timeout'` |
| `exporting` | Worker `begin`, then `pull{count:0}` at least every 60 s | status `ready` and valid head → `recordExportHead` | host `failed`: `workspace_too_large` / `workspace_missing` / `export_failed`. **Total export-host life 45 min** from `claimedAt` → `'export_timeout'` |
| `copying` | `pull{from:next, count:16}` until the budget is spent, then `recordImportProgress(stored)` | bitmap complete → `advance('checking')` | the same 45 min host life → `'copy_timeout'` |
| `checking` | Worker `commit{verifyOnly:true}` | `verified` → `advance('flipping')` | `chunk_mismatch` → `'import_corrupt'` (fresh row on retry) |
| `flipping` | §5.5 | `finish` | none: retried until done. Stuck more than 30 min after the Worker commit → `failed_needs_operator('flip_stuck')`. |

- **Retries:** a transient failure (`unavailable`, `export_unreachable`, `lost_race`) calls `recordRetry`. Five in a row (`attempts` 5) → compensation → `failed_reopened('<step>_retries')`.
- Progress and advances reset `attempts`.

### 5.5 Flip (`flipping → committed`)

1. **Transaction 1**, under `withAdmission` then the computer lock: re-read the reverse row and the entitlement. If `paidAccess(standing)` (`paid|grace|plan_ending`, `standing.ts:42-45`), go to §5.6 with `'entitlement_paid'`. No HTTP call is made inside the lock transaction.
2. Worker `commit{verifyOnly:false}`. **This is the point of no return.**
3. Lifecycle **retire** of the export host: the instance is terminated and the volume kept. Wait for its receipt (volume `available`).
4. **Transaction 2**, under `withAdmission` then the computer lock. A new `flipPlacementToCloudflare` in `placement.ts` mirrors `flipPlacementToAws` (`placement.ts:806-848`); `placement.ts` stays the single writer.
   - Delete the `aws-ec2` row by CAS on N+1/E+1, not RUNNING.
   - Insert a `cloudflare`/`r2` `STOPPED` row.
   - **In the same transaction**, call the reverse store over `tx`: `finish(m, {awsVolumeId, awsFsUuid, awsSnapshotId})`.
   - So there is never a moment where the placement is Cloudflare while the row is not `committed`.
5. **After commit**, outside any lock: re-read the entitlement. If it is `paidAccess`, call `startPaidMigration(userId, sku)` (`provider-migrate-runtime.ts:173`). That runs a forward move onto a fresh volume; the retained volume is rollback-only.

### 5.6 Compensation (before any `failed_*` write)

`failed_reopened` releases the computer, so it is written only after these steps:

1. Worker `abort`. `already_imported` means the commit landed, so go back to §5.5 step 3 instead.
2. Retire the export host if one was claimed. The volume is kept.
3. The published `aws-ec2` row ends `STOPPED` at **N+1/E+1**. The next Free hold open is N+2/E+2, which satisfies the guard's epoch rule (`guard.py:250-254`).

If any step cannot be confirmed, write `failed_needs_operator(<step>_unconfirmed)`. It keeps holding the computer.

### 5.7 Re-subscribe race rule (pinned)

1. Forward and reverse creates are mutually exclusive per computer (§3.3).
2. The entitlement is re-read at every step and once more under the locks before the Worker commit. If paid before the commit, the move compensates to `failed_reopened('entitlement_paid')`. The placement stays `aws-ec2`, and the paid user keeps the same AWS computer; no move is needed.
3. `invoice.paid` during a move:
   - `startPaidMigration` skips non-Cloudflare placements (`provider-migrate-runtime.ts:183-184`), or is refused by the exclusion.
   - Its errors are swallowed (`provider-migrate-orchestrator.ts:149-160`).
   - So rule 5.5 step 5 is the only catch-up, and it is mandatory.
4. Live T6: cancel, start the move, and resubscribe within 60 s while `copying`. Expect `failed_reopened` with reason `entitlement_paid`, the placement still `aws-ec2`, and no reverse row holding.

### 5.8 Triggers and gates

- **`computer.move.start`** (new mutation, `startedBy:'user'`).
  - Requires standing `files_on_aws` (`standing.ts:12-13`), an `aws-ec2` placement, and the kill switch off.
  - It returns the holding row, or refuses `move_unavailable`.
- **`computer.move.retry`** (new mutation).
  - It is the same as start. It exists because the shell's `move-retry` must stop calling `switchTo` (`computers.js:1255-1258`).
  - It is refused while a row holds the computer, which includes `failed_needs_operator`.
- **D20 `'open'` / `'cron'` (follow-up release):**
  - They never create a row for a founder-owned account. The identity source is the existing admin allow-list `isTelemetryAdmin(email, TELEMETRY_ADMIN_EMAILS)` (`telemetry/admin.ts:15`); it is not a new env var. Lane A confirms contact@ is on it, reading through the admin path, not `.env`.
  - They never retry after `workspace_too_large`.

---

## 6. Summary DTO and shell (lanes A + U)

### 6.1 `summary.computer.move`

`ComputerMoveV3` at `contract.ts:242-247` is extended. `summary.ts:262` stops hard-coding `null`.

```ts
interface ComputerMoveV3 {
  direction: 'to_cloudflare' | 'to_aws';
  /** to_cloudflare: REVERSE_MOVE_DTO_STAGE[state] */
  stage: 'saving' | 'copying' | 'checking' | 'flipping' | 'committed' | 'failed_reopened' | 'failed_needs_operator' | string;
  bytesDone: string;          // decimal; import_progress.bytes, '0' before copying
  bytesTotal: string | null;  // decimal; bytes_total once the export head is known
  reason: string | null;      // failed_* only: last_error's leading code, ^[a-z0-9_]{1,64}
  skipped: number | null;     // export head `skipped`; null before it is known
  retainUntil: string | null; // ISO; committed only
}
```

- **Stage map** (`REVERSE_MOVE_DTO_STAGE`, `provider-reverse-store.ts:49`): `requested`, `booting` and `exporting` → `saving` (step 0); `copying` → `copying` (1, with bytes); `checking` → `checking` (2); `flipping` → `flipping` (3).
  - These are keys the dormant `MOVE_STEP_OF` already has (`computers.js:504`), and a unit test pins that.
  - The shell's own `exporting: 1` entry is never sent for `to_cloudflare`.
- **Visibility:** non-null when the newest row for the computer is holding, or is terminal with `updated_at` within the last 24 h. Otherwise null, and the standing banner applies.
- The shell already accepts `reason` with `/^[a-z0-9_:-]{1,64}$/i` (`computers.js:511`).

### 6.2 Shell changes (lane U)

- The step 4 label changes from "Starting your desktop" to **"Switching to your Free computer"** (`computers.js:503`).
- `move-retry` calls `computer.move.retry`.
- The done and failed cards use the §6.3 copy.
- Add a pre-move card with the "Move my files to my Free computer" action on the files-held state.
- The `files_on_aws` banner (`computers.js:499`) drops the region name.

### 6.3 User copy per state (no city or region names, no speed or duration claims)

| State | Copy |
|---|---|
| files held, no move (pre-move card) | **Move my files to my Free computer.** We'll copy everything in your Workspace folder. **Not moved:** settings and programs you added on your AWS computer, saved browser sign-ins, and installed packages. Your AWS computer's disk is kept for 14 days after the move. [Move my files to my Free computer] |
| `saving` | Moving your files to your Free computer. Step 1 of 4: Saving your files. |
| `copying` | Step 2 of 4: Copying your files to your Free computer. "X MB of Y GB copied" (existing `moveView`). |
| `checking` | Step 3 of 4: Checking your files. |
| `flipping` | Step 4 of 4: Switching to your Free computer. |
| `committed` | Your files are on your Free computer. Not moved: settings and programs you added on your AWS computer, saved browser sign-ins and installed packages{skipped > 0: ", and N items that can't be copied, like links that point outside your folder"}. Your AWS disk is kept until {retainUntil date}. |
| `failed_reopened` (default) | We couldn't move your files. They're still on your AWS computer and nothing was deleted. [Try again] |
| `failed_reopened`, `workspace_too_large` | Your files are larger than a Free computer can hold (512 MB), so they stay on your AWS computer. Nothing was deleted. Upgrade to keep using them. [Upgrade] |
| `failed_reopened`, `entitlement_paid` | Your plan is active again, so your files stay on your AWS computer. (no button) |
| `failed_needs_operator` | We couldn't finish moving your files. They're safe on your AWS computer and nothing was deleted. We're looking into it. (no Try again; Send feedback when enabled) |

---

## 7. Retention (lane O)

- After the flip, the placement row no longer exists (`placement.ts:838` deletes rows on flips). So **the committed reverse row is the only DB record of the AWS volume.** It holds `aws_volume_id`, `aws_fs_uuid`, `aws_snapshot_id` and `retain_until` (commit + 14 d, DB clock).
- **Snapshot (D21).** Take it after the flip through the existing preparation machine's createSnapshot, or as an operator step. Record it with `recordSnapshot` (once). A null snapshot means none was taken.
- **Purge.** Extend `retention.ts` (dry run, `retention.ts:1-13,58-64`) with a read-only listing of `committed` rows whose `retain_until < now()`.
  - Deletion is a separate founder-owned principal, never a workflow role. Both workflow roles deny `DeleteVolume` and `DeleteSnapshot` (rule R11).
- **DLM.** `dlmRoleArn` pins `role/service-role/…` (`ops.ts:36`). Change it only after `iam get-role` confirms the path.

---

## 8. Live proofs (T0 hypotheses, R5-8) and acceptance

| ID | Hypothesis | Status at S0 | Who proves, and how |
|---|---|---|---|
| a | canary2's history shape | **Settled at T0** (STATUS 07:36:43Z): forward migration committed 10-22 with a format-2 system head, so begin sees `headKind: 'migrated'`. The `none` shape is untested until T5 (resubscribe → forward → cancel → reverse). | W/A at T3; T5 for `none` |
| b | The volume's lower digest equals the baked lower | open | H: the marker's `lowerImageDigest` equals the manifest's; console `guard_result ok` at the export boot |
| c | The export boot enrolls as an ordinary STARTING/MOUNTING row | code-confirmed (`placement.ts:1408`) | A: enroll log line; the EC2 tag `ezil:generation` = N+1 |
| d | Wake path for a STOPPED Free row | code: cold replace (`aws-ec2.ts:476`) | A: lifecycle operation `replace`; the volume is `available` before the claim |
| e | Idle stop vs poll cadence; capture time for the real workspace and for 512 MiB | open | H: status timestamps; no idle stop while `capturing` or `ready` |
| f | Caps, epochs and usage never touch the export boot | design (§5.2) | A: `ezil_billing_compute_epochs` and `ezil_compute_usage` have 0 rows for the computer from the move start; the placement is never RUNNING during the move |
| h | The start fence on a never-on-Cloudflare prefix | design (§4.1) | W: unit test; live in the T5 `none` shape |
| i | Stripe test clocks vs the `stripe_event_created` drop | only if used | A |

**T-sequence (canary2 only; contact@ only on the founder's click):**

1. **T0**: read-only fingerprint.
2. **T1**: snapshot `vol-0b1ffbc8f8cfa6384`.
3. **T2**: failure injection, an abort during `copying`. Expect `failed_reopened`, the placement `aws-ec2` STOPPED at N+1/E+1, and the hold Open still working.
4. **T3**: the real move. Expect:
   - the §4.4 heads;
   - a Cloudflare STOPPED row, and the instance terminated;
   - the volume `available` and retained;
   - standing `free`.
5. **T4**: open on Cloudflare. The marker file is present.
6. **T5**: resubscribe → forward → cancel → reverse (`none` shape).
7. **T6**: the race in §5.7.
8. **T7**: a Free user with no placement is unchanged.

**Release order:**

1. Snapshot.
2. AMI bake and promote-canary (H).
3. Worker deploy (W). The routes stay unused until the app calls them.
4. **Apply 0012 on staging** (`billing-staging-schema.mjs plan`, then `apply --yes --target aws-preview --expect-system-id <digits>`).
5. App deploy with the user trigger only (A+U).
6. canary2 acceptance.
7. D20 open and cron triggers.
8. DLM and retention (O, plus a founder IAM step).

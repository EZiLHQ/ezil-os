# Reverse move contract: AWS → Cloudflare (Phase B, round 6b)

**Status:** pinned (S0 r5), 2026-10-30. Lanes H, W, A, U and O build against this file in parallel.
A change to any wire shape, state, code or limit below changes this file first. Every lane cites the
section it implements. r2 applied the review of `dc362e53` (§10). r3 closes the S0 verifier's contract gaps
G1–G4 and the minors (§11 maps each gap to its section). r4 applies the review of r3 (`4abd237a`; §12 maps each
finding to its section). **r5 dispositions every one of that review's 28 findings (r4 saw only the first 10) and every
r4 verifier gap (§12.1).** Sections r3 changed carry the gap id in brackets, e.g. **[G1]**; sections r4 changed carry
**[r4]**; sections r5 changed carry **[r5]**.

**Base [r6]:** citations are `path:line` at `7a1f2ed1` (`r6/integ-20261030`, round 6a, LIVE on os-staging). r6 rebased
this branch onto it (no conflicts) and re-pinned every citation into a file 6a changed; a file 6a did not change is
byte-identical to `74ed2c92`, so its citations carry over. They point to the code each rule is based on.
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
- **r3 (store only; 0012 is unchanged, so its registered digest stands):**
  - **[G4]** the lane O / lane A reads `listUnsnapshotted` and `listRetentionExpired`, and an idempotent
    `recordSnapshot` (§3.4, §7);
  - **[clocks]** no app clock in the store: `import_progress.first/last` are PostgreSQL's, and every row carries
    DB-computed `ages` (§3.4, §5.4);
  - **[0012 probe]** `reverseMovesTablePresent(db)` for every reader outside the machine (§3.4);
  - **[operator]** the operator runbook SQL (§5.5.1), executed verbatim by the store's PG suite.
- **r4 (store only; 0012 still unchanged):** `markSnapshotSpent` and the spent-row filter of `listUnsnapshotted`, so one
  failed snapshot execution can never hold the snapshot queue (§3.4, §7.1), with PG tests.
- **[r5] (store and tests only; 0012 still unchanged, its registered digest stands):**
  - `export_boot.region`, required and validated, kept while `booting` completes the claim (§3.1, §5.1.1 step 8, §7.1);
  - the purge marker: `retain_until = NULL` on a committed row, runbook `operator_purged` (§7); `listUnsnapshotted` skips
    purged rows (§3.4);
  - PG tests that fake the app clock (2001) around `recordImportProgress`, `advance('flipping')` and `finish`, and a
    retention boundary row (expires in 1 minute, must not be listed). Mutants C4, C5, C6 (app-clock writes) and R1b
    (bound loosened by a day) each fail them.

Everything else below is a contract for lanes that have not started. **r5 is the last S0 edit to the store. From r5 on,
lane A is the only writer of `provider-reverse-store.ts` and its two test files** (§1.1).

---

## 0. Decisions this contract assumes (taken; not reopened here)

| # | Decision |
|---|---|
| D-1 | **Export channel.** A signed host edge op plus a maintenance-agent AMI bake. No SSM: hosts keep no instance role (rule R5, `infra/app-computers/README.md:176,194-214`; `infra/app-computers/lib/lifecycle/helper.ts:603`). |
| D-2 | **Reverse moves live in a NEW table.** 0006 is never relaxed. None of the forward readers filter by direction: `provider-migrate-store.ts:107-118,131-144`, `provider-migrate-placement.ts:27-34`, `placement.ts:1897`, `select.ts:120-126`. |
| D-3 | **The export boot is a normal replace boot on the published placement row**, at placement generation N+1 and lease epoch E+1. It is identified from the reverse row (`export_boot`), never from `lastError`, because enrollment overwrites `lastError` (`placement.ts:1533,1569`). |
| D-4 | **v1 moves `/workspace` only.** It records the codec's skipped count, and refuses when over the workspace cap (the files stay on AWS). The UI says before and after what is not moved (§6.3): settings and programs added on the AWS computer (HOME dotfiles, installed packages), browser sign-ins (profiles), and rebuildable build folders the codec drops (§2.3). |
| D-5 | **Triggers (D20).** v1 ships the user action "Move my files to my Free computer" (`startedBy: 'user'`) **and the next open** (`'open'`, §5.9). **[r5] There is no cron trigger in v1** (§9): no v1 code writes `startedBy: 'cron'`. A founder-owned account moves only on that account's own Move click (§5.9.1). |
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
| **S0** (done, r5) | 0012, the store until r5, the forward exclusion, registry | §3 | 0012 applied on the staging DB before the app deploys: plan, then apply with `--target aws-preview` (schema before code). |
| **H** host + AMI | §1.1 | §2, **[r5]** §2.8 (the AMI train: C3, F11, `pool_desktop_not_ready`) | T0 (b), (b2), (e), (k); staged files on the root volume only; §2.8's live rows. |
| **W** Worker import | §1.1 | §4 | T0 (g), (h), (l); heads before and after (T3); the first Cloudflare open hydrates with no `workspace_migrated`. |
| **A** app machine | §1.1 | §5, §6.1, §5.10 (server side of `computer.progress`) | T0 (c), (d), (f), (j); race T6. |
| **U** shell | §1.1 | §6, §5.10 rendering | Copy matches §6.3 and §6.4 in every state, with screenshots; an open during a move never shows the opening bar, `needs_operator` or a 10-minute failure. |
| **O** retention | §1.1 | §7, **[r5]** §7.2 (the deployment field, end to end) | `iam get-role` path; a snapshot recorded on the T3 row; listing shows the committed row after 14 days (dry run); §7.2's rollout order held. |

### 1.1 File ownership (one lane per file) **[G1] [G4]**

Every file a Phase B lane touches has exactly one owning lane. A lane that needs a change in another lane's
file asks that lane (or the lead) and changes this table first. Files not listed are read-only for every lane.

| Lane | Files (new files marked *new*) |
|---|---|
| **H** | `infra/host-agent/lib/ezil_host/{edge,agent,desktop}.py`, `infra/host-agent/lib/ezil_host/export.py` *new*, their tests under `infra/host-agent/test/` (incl. `test_export.py` *new* and the codec parity test *new*), the bake inputs that copy the codec into `infra/host-agent` (`infra/host-agent/ami/`, `deploy/aws/mum/` maintenance-agent bake, **including `deploy/aws/mum/json-tool.py`, which lane O does not need to change, §7.2**), and `worker/src/workspace-snapshot-script.ts` (additive op only, §2.6). **[r5] The AMI train (§2.8):** `infra/host-agent/lib/ezil_host/{pool,lease,guard}.py`, `infra/host-agent/systemd/ezil-guard.service`, their tests; and the app side of those items, which no other lane owns: `app/src/server/lib/compute/{ready-pool,aws-pool-replenish,aws-pool-adopt,aws-pool-claim,aws-ec2,provider-migrate-runtime,provider-migrate-provision}.ts`, `app/src/server/lib/compute/provider-migrate-store.ts` (only the `_awsProvision` shape, C3), `app/src/app/api/compute/aws/pool/claim/route.ts`, and the tests next to each. The seams with lane A are in §2.8. |
| **W** | `worker/src/index.ts`, `worker/src/workspace-migration-import.ts` *new* (+ test *new*), `worker/src/aws-origin.ts` (export GETs over the existing signer), the prefix helper (*new*, `worker/src/workspace-prefix.ts`, + test). |
| **A** | `app/src/server/lib/compute/`: `provider-reverse.ts` *new*, `provider-reverse-runtime.ts` *new*, `provider-reverse-placement.ts` *new* (reverse waiting provider + routing read), **`provider-reverse-store.ts` and its `.test.ts`/`.pg.test.ts` (sole writer from r4 on)**, `admission.ts` (`admitExportBoot`, §5.1), `placement.ts` (`releaseExportBoot`, `flipPlacementToCloudflare`), `aws-receipts.ts` (export-boot mode), `select.ts`, **`progress.ts` (the `moving` description, §5.10)**; `app/src/server/api/routers/compute-dispatch.ts` (`computeMoving`, §5.3), `app/src/server/api/routers/computer.ts` (`computer.move.start`/`retry`, §5.9), `app/src/server/api/routers/cloudflare-guacamole.ts` (the open trigger in `previewUrl`, §5.9), `app/src/server/lib/cloudflare-guacamole-provider.ts` (`MIGRATE_CONFLICT_REASONS`, per-action timeouts, §4.1, §4.6), `app/src/server/billing/v3/{summary,contract}.ts` (§6.1), **[r4] `app/src/server/api/routers/billing.ts` (the `summary` procedure's reads and `userPlacement`, §6.1)**, **[r4] `app/src/server/lib/compute/aws-rebase-store.ts` (the reverse-row exclusion in `reserve`, §5.2.1)**, `app/src/app/api/cron/billing-session-sweep/handler.ts` (§5.4), **[r5] the actor routes of §5.2: `app/src/app/api/cron/{aws-reconcile,aws-stop-settle,sandbox-reap,billing-session-sweep,pool-replenish}/` and `app/src/app/api/internal/computers/{lifecycle-authority,image-rebase}/` (route and handler files). Any change to them, and to their tests, is lane A's** (the `pool-replenish` route is A's; the library it calls is H's, §2.8). Tests next to each (for `aws-rebase-store.ts`: `aws-rebase-store.test.ts` and `rebase.pg.test.ts`). |
| **U** | `shell/ezil/ui/computer-progress.js`, `shell/ezil/ui/app-spinner.js`, `shell/ezil/ui/boot-progress.js`, `shell/ezil/session.js`, `shell/ezil/apps/desktop-window.js`, `shell/ezil/ui/Settings/tabs/computers.js`, **[r4] `shell/ezil/ui/Settings/tabs/billing.js` and `shell/ezil/ui/Settings/billing-test.mjs` (the Billing tab during a move, §6.2; [r6] its banner copy is 6a's and is not edited)**, their shell tests, and the rebuilt committed shell bundle (`shell/build-shell.sh` output). |
| **O** | `app/src/server/lib/compute/provider-reverse-snapshot.ts` *new* (start the snapshot execution, read its receipt, `recordSnapshot`, `markSnapshotSpent`, and **[r5]** the per-pass `snapshot_missing` line, §7), `app/src/server/lib/compute/retention.ts`, `infra/app-computers/lib/lifecycle/reverse-snapshot-{contract,definition,helper}.ts` *new*, the stack and IAM wiring for that machine: `infra/app-computers/lib/reverse-snapshot.ts` *new* and **[r5]** its registration in `infra/app-computers/bin/lifecycle.ts` and `infra/app-computers/lib/computer-lifecycle.ts`. **[r5] The deployment field `reverseSnapshotStateMachineVersionArn`, end to end (§7.2):** `app/src/server/lib/compute/aws-intent.ts` (the deployment schema only) with `aws-intent.fixtures.json`, `aws-intent.test-support.ts` and the tests that pin that schema; `infra/app-computers/lib/lifecycle/deployment.ts` (the one strict schema every infra parser imports: `intent.ts`, `contract.ts`, `preparation-contract.ts`, `recovery-contract.ts`, `release-manifest.ts` and `identity.ts` take the change through the import and are not edited); `infra/app-computers/test/app-intent-contract.test.ts` and its fixtures; `infra/app-computers/lib/app-caller.ts` (StartExecution, DescribeExecution, GetExecutionHistory and the KMS `EncryptionContext` machine list) with `test/app-caller.test.ts`, `test/iam-exact.test.ts` and `test/__snapshots__/{app-caller,iam-policies}.json`. Also `infra/app-computers/lib/ops.ts` (DLM role), the tests of all of these, and the purge runbook (`docs/compute/REVERSE-MOVE-RETENTION.md` *new*). **[r5] Not O's:** `release-manifest.ts` and its strict app mirror `aws-rebase-release.ts` stay unchanged, because the field is not a release field (§7.2). |

**[r4] Read-only on purpose:** `app/src/components/desktop/boot-phases.ts` and `boot-phases.shell.js` (drift-guarded
against each other) belong to no lane. Nothing in this contract needs a new `BootErrorCode`: the move answers reuse
existing codes, and lane U reads the move flags before `classifyFailure` (§5.3, §6.4). `shell/ezil/apps/code.js` is
read-only too; its mint goes through the same answers.

Shared seams, each owned by one side:
- `provider-reverse-store.ts` is **A**'s. O only calls `listUnsnapshotted`, `listRetentionExpired`, `recordSnapshot` and
  **[r4] `markSnapshotSpent`**; a new read O needs is added by A.
- **[r5]** The AMI train (§2.8): host files and the pool/C3 app files are **H**'s; `aws-receipts.ts` and `placement.ts` stay
  **A**'s, and H's needs there are pinned in §2.8 for A to implement.
- **[r5]** The deployment field (§7.2) is **O**'s in every file it touches; no other lane edits `aws-intent.ts`,
  `deployment.ts` or `app-caller.ts`.
- **[r4]** The summary: the reads (`billing.ts`) and the builder (`summary.ts`) are **A**'s; the rendering (`computers.js`,
  `billing.js`) is **U**'s (§6.1, §6.2).
- The sweep's call site is **A**'s (`handler.ts`); the snapshot step it calls (`advanceReverseSnapshots`) is **O**'s (§5.4, §7).
- `computer.progress`: the server DTO is **A**'s (`progress.ts`), its rendering is **U**'s (§5.10).

---

## 2. Host export (lane H)

### 2.1 Why a new op, and why a bake

- The edge routes are a closed set: `/__p` to desktop ports, `stop`/`fence`, `ice`, `desktop`, and `restart-desktop`. Everything else gets 404 (`edge.py:9-16,51-62,350-376`).
- The agent refuses any other op with `unknown_op` (`agent.py:159-176`).
- Lease keys are closed (`lease.py:45,166`).
- The agent code lives in the AMI at `/opt/ezil-host` (`build-host-ami.sh:59-61`).

So the export needs new edge routes, a new agent op and a bake. The bake is the **maintenance-agent** bake, which keeps the promoted lower (`deploy/aws/mum/json-tool.py:1020-1025`), so the volume's digest guard still passes (`guard.py:323`).

### 2.2 Edge routes (all gw1-verified; each verified request counts as presence)

The signature is unchanged: `x-ezil-gw: gw1.<ts>.<hex>` = HMAC-SHA256(controlKey, `gw1|ts|computerId|generation|leaseEpoch|METHOD|path`), with skew −120/+5 s (`edge.py:1-7,45-46`; Worker signer `aws-origin.ts:174-182`). Here `generation` is the placement's integer, as today. The signature covers the path only, so **every input is in the path, or a body whose sha256 is in the path**, as `ice` does (`edge.py:58-60,408-425`).

| Method + path | Body | Served by | Success | Errors (JSON `{ok:false,error}`) |
|---|---|---|---|---|
| `POST /__ezil/control/export/<sha256hex(body)>` | Required. `Content-Length` 1..1024, no `Transfer-Encoding`, no query. A JSON object with exactly the keys `v`, `moveId`, `generation`, lowercase UUIDs (byte rules below). | edge → agent op `export` (§2.5), then the edge reads `state.json` | `202` with the §2.4 status. Idempotent for the same `{moveId, generation}`. | `400 export_body_invalid`, `400 export_digest_mismatch`, `409 export_busy` (another `{moveId, generation}` holds the host), `409 export_invalid` (the agent refused the message), `503 agent_unavailable` (the agent socket failed or timed out, as `edge.py:393,401`) |

**Body bytes and the path digest [minor: digest].** There is no canonical-JSON rule to agree on; the digest binds the bytes.
- The Worker builds the body once, `JSON.stringify({v: 1, moveId, generation})` (this key order, no whitespace), and sends
  **exactly those bytes**. The path digest is `sha256` of those bytes, lowercase hex.
- The edge reads exactly `Content-Length` bytes (`_recv_exact`, as `_ice` does, `edge.py:408-425`), compares
  `sha256(bytes)` with the path digest using `hmac.compare_digest` **before parsing**, then parses those same bytes once.
  It **never re-serializes** to compare, and checks key order and whitespace not at all: the digest already fixed them.
- Parse rules (`400 export_body_invalid` otherwise): UTF-8; `json.loads` with an `object_pairs_hook` that **refuses a
  duplicate key** (plain `json.loads` keeps the last duplicate, which a key-set check cannot see); the top level is an
  object whose key set is exactly `{v, moveId, generation}`; `v` is the integer `1` (not `true`, not `1.0`); `moveId`
  and `generation` match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
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
- The app enforces all of this as `validExportHead` (`provider-reverse-store.ts:255`). The app also checks `v === 1` and `moveId === row.id`, then stores the head without `v` and `moveId`.
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

### 2.8 The AMI train: C3, F11 and `pool_desktop_not_ready` (lane H) **[r5]**

The lead put three pool and upgrade items on lane H's AMI train. They are not part of the move, but their host halves
need the same kind of bake, so they ship in the §2 bake and promote (release order step 2, §8). Each file below has
one owner (§1.1). Sources: the round 6 understand phase (R2-1, R2-4) and the round 5 acceptance (F11).

| Item | What is wrong at base | Pinned outcome | Files (lane H) | Acceptance |
|---|---|---|---|---|
| **`pool_desktop_not_ready`** (R2-4) | First boot: the pool agent waits 180 s for neko (:8181) and code-server healthz (:8443), else raises `pool_desktop_not_ready` (`pool.py:282-293,355-363`). Each 300 s refresh waits 20 s and tolerates only `pool_retry_exhausted`/`pool_unavailable` (`pool.py:296-316`). `ezil-guard.service` is a oneshot with no `Restart=`, so one miss ends the host's pool agent for good. **[r6] The app side shipped in round 6a** (`07e3173a`, `0d49c24c`, `3403c33e`): a `booting` spare with `enrolled_at` set, created more than 6 min ago (`POOL_BOOT_STALLED_MS`) and enrolled more than 5 min ago (`POOL_ENROLLED_READY_WAIT_MS`), is failed by `planPool` and no longer counts as a spare (`ready-pool.ts:45-57,224,228,337`), and replenish retires only a boot its own fail mark took (`aws-pool-replenish.ts:158-161`). | A readiness miss is never fatal. First boot retries `wait_ready` within a bound H pins in the test. A refresh keeps the host on `pool_desktop_not_ready` and tries again next refresh. The unit restarts a failed agent, with a bounded restart rate. **[r6]** App: done in 6a, with 6a's predicate (created + 6 min **and** enrolled + 5 min), which supersedes r5's "6 min after `enrolled_at`". The provision budget (2 per pass) and the region cap are unchanged. | `pool.py`, `ezil-guard.service`, the pool tests under `infra/host-agent/test/`. **[r6]** No app file: `ready-pool.ts` and its tests need no change for this item (they stay H's for F11 and C3). **A file outside this set changes this table first (lead), before any edit.** | Unit: a first-boot miss followed by success ends `ready`; a refresh miss keeps the host; the unit file restarts on failure, rate-bounded. (The planner tests shipped in 6a, `ready-pool.test.ts` and `ready-pool.pg.test.ts`.) Live: no host's `ezil-guard` journal ends on `pool_desktop_not_ready`, and no spare is retired about 11 min after launch for that cause. |
| **F11** | After every pool adopt, the **first** refill the planner launches enrolls but never posts ready, and is retired about 10 min later (2/2 at 10-30 01:18Z, 2/2 at 07:14/07:18Z). The second refill is ready in 51–84 s. The pool is one spare short for about 10 min after each adopt. The cause is not known. | **Diagnosis first**, read-only on staging: the refill host's `ezil-guard` journal and its `ezil_compute_pool_hosts` timestamps (`enrolled_at`, `ready_at`, `editor_ready_at`), next to the adopt's own timeline. Then fix the cause in the file the diagnosis names. | Provisional: `pool.py`, `guard.py`, `ezil-guard.service` (host); `ready-pool.ts`, `aws-pool-replenish.ts`, `aws-pool-adopt.ts`, and the replenish-after-adopt call sites in `aws-ec2.ts` (`:550-556,658-660,816-819`) (app). **A cause outside this set changes this table first (lead), before any edit.** | Live: two consecutive adopts on staging, and each one's first refill posts ready. |
| **C3** (R2-1) | The first Cloudflare → AWS move with a non-empty R2 workspace is always a cold `provision` (`provider-migrate-runtime.ts:66-110`), never the warm spare. The pool agent cannot take a restore: pool user data rejects `restore`, `parse_claim` whitelists the claim keys and `computer_lease` builds a lease without one (`lease.py:153-162`, `pool.py:60-61,221-239`). | A pool-restore adopt. Host: `parse_claim` accepts an optional restore lease (the existing `RestoreLease` shape) and `computer_lease` copies it into the lease, so the guard restores before the marker (`guard.py:347-358`, unchanged unless the restore path needs it). App: `provision` leases a pool host (`leasePoolHost`) in the same `withAdmission` transaction and runs `validateCapacity`. It records an `adopt` intent with `createVolume` and `dataVolumeGiB` in `_awsProvision`, and the pool claim carries the migration's restore lease. **Order:** the app half ships only after the AMI that accepts a restore claim is promoted. Until then `provision` stays cold, which is today's behaviour. | Host: `pool.py`, `lease.py`, `guard.py` (only if the restore path changes), tests. App: `provider-migrate-runtime.ts`, `provider-migrate-provision.ts`, `provider-migrate-store.ts` (only the `_awsProvision` shape), `aws-pool-claim.ts`, `app/src/app/api/compute/aws/pool/claim/route.ts`, `ready-pool.ts`, tests. **A file outside this set (for example a pool-runtime or enroll helper) changes this table first (lead), before any edit.** | Unit: a claim carrying a restore lease; `provision` leases a pool host under admission; enrollment accepts the adopt path. Live: a Free → Standard upgrade with a non-empty workspace adopts a spare (an `ezil_compute_pool_hosts` row for the instance, EC2 tag `ezil:pool=1`) and the restored workspace opens. |

**Seams (one owner each):**
- **`aws-receipts.ts` stays lane A's.** C3 needs `readMigrationReadyReceipt` (`aws-receipts.ts:1116-1130`) to accept the
  migration-bound adopt receipt, not only the PROVISIONING path. Lane H writes the exact rule as a sub-row of this table
  before lane A implements it, and A ships it with (or before) H's app half. Lane A's export-boot mode (§5.2) and this
  path never overlap: a Free export boot is never a pool adopt (`aws-ec2.ts:498-500`).
- **`placement.ts` stays lane A's.** Lane H adds no placement writer; it asks lane A, through this section, for any it needs.
- **`aws-ec2.ts` is H's.** Lane A's §5.1.2 parity test only drives it. A change to `replaceIntent`'s fields updates
  that parity fixture in the same integration (H tells A first).
- **The `pool-replenish` cron route is A's** (an actor of §5.2); `aws-pool-replenish.ts` and `ready-pool.ts`, which it calls,
  are H's.
- **`deploy/aws/mum/json-tool.py` is H's**, and lane O's deployment field needs no change in it (§7.2).

---

## 3. The reverse row (S0, shipped)

### 3.1 Table `public.ezil_compute_reverse_moves` (`0012_compute_reverse_moves.sql:4-38`)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()`; this is the `moveId` everywhere. |
| `user_id`, `computer_id` | uuid NOT NULL | Owner and computer. Create refuses another owner's row. |
| `started_by` | text | `'user' \| 'open'` in v1 (D-5). **[r5]** The 0012 CHECK also admits `'cron'` and stays unchanged (its digest is registered), but no v1 code writes it (§9). |
| `state` | text, default `requested` | §3.2 |
| `generation` | uuid NOT NULL, default `gen_random_uuid()` | The import generation. Immutable; a retry is a **new row**. |
| `export_boot` | jsonb object | `{placementGeneration, leaseEpoch, region, volumeId, jobId, instanceId, fsUuid, claimedAt}` (§5.1). **[r5]** `region` is the placement's region (`AWS_REGION_PATTERN`, `aws-config.ts:123`), required; the flip deletes the placement row, so this is where §7 finds the retained volume's region. |
| `export_head` | jsonb object | §2.3 without `v` and `moveId` |
| `import_progress` | jsonb object | `{bitmap, bytes, archiveSha256, first, last}`. The bitmap is 128 hex chars (512 bits): bit i = byte ⌊i/8⌋, mask `1<<(i%8)`, the same order as forward `restore_progress` (`provider-migrate-store.ts:89-106`). `last` is the time of the last new chunk (the copy-stall clock, §5.4). **[clocks] r3:** `first` and `last` are written by PostgreSQL (`to_jsonb(statement_timestamp())`, ISO 8601 with offset), never by the app; `last` is `GREATEST(previous last, statement time)` so it never moves back; `first` is kept for the same `archiveSha256`. |
| `bytes_total` | bigint | 0..536,870,912. Set with the export head. |
| `skipped` | integer ≥ 0 | Set with the export head. |
| `aws_volume_id` | text | `^vol-[0-9a-f]{8,17}$` |
| `aws_fs_uuid` | uuid | |
| `aws_snapshot_id` | text | `^snap-[0-9a-f]{8,17}$` |
| `retain_until` | timestamptz | Only on `committed` (named CHECK). Set to commit + 14 d from the DB clock. **[r5]** `NULL` on a committed row means purged (runbook `operator_purged`, §7). |
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

The table is `REVERSE_MOVE_TRANSITIONS` (`provider-reverse-store.ts:44`). Every write is a store call. The writer is always the app (lane A), except the operator releases.

| Edge | Store call | Written by | Precondition the store enforces |
|---|---|---|---|
| — → `requested` | `createOrGetActive({computerId, userId, startedBy})` | trigger mutations (`'user'`) and the open path (`'open'`, §5.9). **[r5]** Nothing else: no cron in v1 (§9). | No forward work for the computer (§3.3); same owner. |
| `requested → booting` | `recordExportBoot(m, claim)` | machine, **inside the placement claim transaction** (§5.1) | Valid claim, **[r5]** including `region`. In `booting`, only `jobId`, `instanceId` and `fsUuid` may be added to the same claim; `region` and the rest are kept. |
| `booting → exporting` | `advance(m,'exporting')` | machine, after enrollment | `exportBoot.instanceId` set. |
| `exporting → copying` | `recordExportHead(m, head)` | machine | The head is valid for `m.generation`; progress resets. |
| `copying` (self) | `recordImportProgress(m, indices)` | machine, after each Worker `pull` | Indices are within the head. Idempotent per index; resets `attempts`. |
| `copying → checking` | `advance(m,'checking')` | machine | Every chunk bit is set for the current `archiveSha256`. |
| `checking → flipping` | `advance(m,'flipping')` | machine, **in the locked transaction that re-checks the entitlement**, after `verifyOnly` passed and the export host is retired (§5.6 step 1) | Sets `commit_sent_at`. |
| `flipping → committed` | `finish(m, {awsVolumeId, awsFsUuid, awsSnapshotId: null})` | machine, **in the same transaction as the placement flip** (§5.6 step 3) | `commit_sent_at` set; `retain_until` = DB clock + 14 d |
| pre-flip in-flight → `failed_*` | `fail(m, to, reason)` | machine, after compensation (§5.7) | `failed_reopened` refused once `commit_sent_at` is set. |
| `flipping → failed_needs_operator` | `fail(m,'failed_needs_operator', reason)` | machine (§5.4 `flip_stuck`, §5.5) | — |
| `failed_needs_operator → failed_reopened` | runbook SQL `operator_released` (§5.5.1); the store's `fail(m,'failed_reopened', reason)` has the same guard | operator only, after manual cleanup | `commit_sent_at` is null. An operator who proved the commit never landed (P's head is not this move's) runs `clear_commit_sent` first, then releases. |
| `failed_needs_operator → committed` | `finish(m, …)` | operator only, through the same flip code (§5.6 step 3) | `commit_sent_at` is set. |
| `failed_reopened` (self) | runbook SQL `operator_cleared` (§5.5.1) | operator only | The computer's newest row, with a `reopen_final` code. Sets `last_error = 'operator_cleared'`, so Try again is offered again (§5.9). No store method sets it. |
| committed (self) | `recordSnapshot(m, snapId)` | lane O (§7) | **[G4]** Once: a CAS on `aws_snapshot_id IS NULL`. The same id again returns the row (a lost response); a different id never replaces it. |
| committed (self) | **[r4]** `markSnapshotSpent(m, reason)` | lane O (§7.1 Failure) | `reason` ∈ `REVERSE_SNAPSHOT_SPENT_REASONS`. Once: a CAS on `state = 'committed' AND aws_snapshot_id IS NULL AND last_error IS NULL`. It writes only `last_error` and `updated_at`. A replay, or a row that already left the queue (snapshotted, or spent with another reason), returns the current row. |
| any in-flight (self) | `recordRetry(m, reason)` | machine | `attempts < 5`, else `{exhausted:true}` and nothing is written; the caller compensates and `fail`s. **In `flipping` it is never exhausted** (attempts saturate at 5): `flipping` is bounded by time (§5.4). |

A lost CAS throws `ReverseMoveConflictError('lost_race')`. An illegal edge throws `illegal_transition` and writes nothing. The caller re-reads; nothing retries inside the store.

### 3.3 Cross-direction exclusion and the computer lock

- Both creates follow the same order:
  1. INSERT … ON CONFLICT DO NOTHING;
  2. **the placement per-computer lock**: `pg_advisory_xact_lock(PLACEMENT_LOCK_NAMESPACE, hashtext(computerId::uuid::text))`, the same key as `placement.ts:212-214,542-548`, under READ COMMITTED only;
  3. check the other direction in a new statement;
  4. throw, which rolls back the insert.
- They run in one transaction when the executor has one (`inMoveTransaction`, `provider-reverse-store.ts:205`).
- The check comes after the lock, so the second creator sees the first's committed row. The PG race test runs 20 rounds with exactly one winner each. A mutant without the lock fails it 3/3.
- **Forward refuses** (`MigrationConflictError`, `provider-migrate-store.ts:142`) while a reverse row is in a holding state.
  - It first probes `to_regclass('public.ezil_compute_reverse_moves')` as its own statement.
  - A database without 0012 (production, and the forward suites' schemas) therefore behaves exactly as before.
- **Reverse refuses** (`forward_active`, `provider-reverse-store.ts:351`) while the forward machine still has work. That is an active forward row, or a `failed_*` row whose `_awsProvision` is not released: exactly what forward `claimStale` picks up (`provider-migrate-store.ts:107-118`).
- **Lock order** stays admission → computer (`placement.ts:30-41`). Never call either `createOrGetActive` on a *different* connection while holding the computer lock: the second call would wait on your own lock. Pass the same `tx`, or call it after commit.

### 3.4 Store surface (`createProviderReverseStore(db)`)

- **Reads:** `readById`, `readByComputer` (newest, any state), `readActiveByComputer` (holding), **`readByExportBoot(computerId, placementGeneration, leaseEpoch, volumeId)`** (the newest row in any state **except `committed`** whose `export_boot` claimed exactly that triple; §5.2 keys on it).
- **[G4] Reads added in r3** (plain reads, no row lock; bounds clamp like `claimStale`, and `0`, negative or `NaN` return nothing):
  - **`listUnsnapshotted(limit ≤ 10, committedForSeconds = 0, {includeSpent = false} = {})`**: `committed` rows with
    `aws_snapshot_id IS NULL`, ordered by `state_entered_at, id` (a committed row's `state_entered_at` is its commit time;
    `recordSnapshot` and `markSnapshotSpent` never move it), and only rows committed at least `committedForSeconds` ago
    **on the DB clock**. **[r4]** Rows marked spent (`last_error IN REVERSE_SNAPSHOT_SPENT_REASONS`) are left out unless
    `includeSpent` is true. The sweep's snapshot step calls `listUnsnapshotted(3)`; the `snapshot_missing` listing calls
    `listUnsnapshotted(10, 3600, {includeSpent: true})` (§7.1). **[r5]** Purged rows (`retain_until IS NULL`, §7) are left
    out in both modes.
  - **`listRetentionExpired(limit ≤ 100)`**: `committed` rows with `retain_until < clock_timestamp()`, ordered by `retain_until, id`.
    **[r5]** A purged row (`retain_until` NULL) is never listed, so already-purged rows never hide newer expired ones.
  - `REVERSE_SNAPSHOT_LIST_MAX = 10`, `REVERSE_RETENTION_LIST_MAX = 100`.
- **Writes:** `createOrGetActive`, `recordExportBoot`, `advance`, `recordExportHead`, `recordImportProgress`, `recordRetry`, `fail`, `finish`, `recordSnapshot`, **[r4] `markSnapshotSpent`**, `claimStale(limit ≤ 10)`.
  - **[r4] `markSnapshotSpent(m, reason)`**: takes a committed row whose snapshot execution is spent out of the sweep's
    queue (§7.1). `reason` is `snapshot_failed` (the execution ended FAILED, TIMED_OUT or ABORTED) or
    `snapshot_receipt_invalid` (it SUCCEEDED, but its receipt fails validation): `REVERSE_SNAPSHOT_SPENT_REASONS`. The CAS
    is on `state = 'committed' AND aws_snapshot_id IS NULL AND last_error IS NULL`, so the first reason wins and a
    replay is free. After a write that matched nothing it re-reads: a committed row that is snapshotted or already
    spent is returned unchanged; anything else is `lost_race`. A copy that is not `committed` is `illegal_transition`,
    and an unknown reason is `invalid_input`, both with no statement. It never moves `state_entered_at`,
    `retain_until` or `aws_snapshot_id`. A spent row still takes `recordSnapshot` and the `operator_snapshot` runbook
    statement. **A committed row's `last_error` is never shown to the user**: the summary's and `computer.progress`'s
    `reason` is null for `committed` (§5.10, §6.1).
  - `claimStale` takes in-flight rows idle for 30 s, oldest first, with `FOR UPDATE SKIP LOCKED`, and bumps `updated_at` only. It mirrors forward `claimStale`. `failed_needs_operator` is never claimed.
  - **[G4] `recordSnapshot` (r3)** is a compare-and-swap on `id`, `state = 'committed'` and `aws_snapshot_id IS NULL`, not on
    `updated_at`. After a write that matched nothing it re-reads: the same id already recorded returns the row (the replay
    after a lost response); a different id is `lost_race`. A caller whose copy already shows a different id gets
    `illegal_transition` with no statement. It never moves `state_entered_at` or `retain_until`. A PG race test writes two
    different ids at once: exactly one wins.
- **Row fields added in r2:** `stateEnteredAt`, `commitSentAt` (DB-clock text).
- **[clocks] Row field added in r3: `ages`**, `{created, stateEntered, commitSent | null, lastChunk | null}` in seconds, computed
  by PostgreSQL as `clock_timestamp() − anchor` in the same statement that read or wrote the row (every read, every
  `RETURNING`, `claimStale`). `lastChunk` is null before the first chunk, and also when `import_progress.last` is not ISO text
  (a hand edit never breaks a read). Lane A compares deadlines against `ages` only (§5.4).
- **Clock rule (r3):** the store has no app clock (the `now` option is removed). Every timestamp it writes is PostgreSQL's:
  `created_at`, `state_entered_at`, `commit_sent_at`, `retain_until`, `updated_at`, `import_progress.first/last`. The one
  app-clock value left in the row is `export_boot.claimedAt`; it is informational and **never** a deadline anchor (§5.4).
- **[0012 probe] `reverseMovesTablePresent(db)`** (r3): one `to_regclass` statement. Every reader of the table outside the
  reverse machine calls it first and treats `false` as "no reverse move": the forward create (`reverseMoveHolds`, now
  built on it), the receipts' export-boot lookup (§5.2), routing (§5.3), `computer.progress` (§5.10), the summary DTO
  (§6.1) and the open trigger (§5.9). Production has no 0012, and `readComputerProgress` swallows a throw into an empty
  progress (`progress.ts:165-168`), so a missing probe would blank `computer.progress` for every production computer.
- **[0012 probe] Production (no 0012) is a pinned, tested state, not an error:**
  - the sweep's `advanceReverseMoves` and lane O's `advanceReverseSnapshots` return at once when the probe is false. Like
    `advanceStaleMigrations` (`provider-migrate-orchestrator.ts:172-179`), neither ever throws out of the billing handler;
  - `computer.move.start`/`retry` answer the refusal value `move_unsupported` (§5.9), never a 500;
  - `summary.computer.moveAvailable` is false (§6.1), so no move action is shown;
  - routing, `computer.progress`, the summary and the open trigger behave exactly as today.
  - Lane A tests each of these on a database without 0012.
- **Constants:** `REVERSE_MOVE_DTO_STAGE` (§6.1), `EXPORT_*` limits, `REVERSE_MOVE_MAX_ATTEMPTS = 5`, `REVERSE_MOVE_RETENTION_DAYS = 14`,
  **[r4]** `REVERSE_SNAPSHOT_SPENT_REASONS = ['snapshot_failed', 'snapshot_receipt_invalid']`.
- To write inside a placement transaction, build the store over that `tx`.
- **Owner from r5 on: lane A** (§1.1; r5 was the last S0 edit). Lane O consumes the four snapshot/retention calls (`listUnsnapshotted`,
  `listRetentionExpired`, `recordSnapshot`, `markSnapshotSpent`) and adds nothing here. **[r5]** Lane A's one pinned change
  to the store is `claimStale`'s order (§5.4).

---

## 4. Worker import routes (lane W)

### 4.1 Common rules

- **Path:** `POST /sandbox/<name>/migrate/import/{begin,pull,commit,abort}`.
  - The app reuses `migrateRequest` (`cloudflare-guacamole-provider.ts:3365-3401`) with `action = 'import/<op>'`: signed control auth, and a 409 maps to the closed reason enum.
  - **Timeouts are passed per action** (lane A): `import/begin` 60 s, `import/pull` 40 s, `import/commit` 30 s, `import/abort` 60 s. The existing check `action === 'begin' ? 120_000 : 30_000` (`:3382`) does not match `import/begin`.
  - Extend the route regex next to `index.ts:7865` and authorize with `authorizeSignedControlRequest` exactly as at `index.ts:7866-7868`.
- **`<name>`** = `deriveGuacamoleSandboxId(userId, computerId)` (`cloudflare-guacamole-provider.ts:1273-1277`). Every body carries the full `computerId`. The Worker refuses `400 invalid_body` unless `computerId.replace(/[^a-z0-9]/gi,'').slice(0,16)` equals the name's scope part.
- **Store (v1 is R2-only).** Every step resolves the store with `selectWorkspaceStore()` (`index.ts:2745-2765`), which honours the DO's pin (`WORKSPACE_STORE_KIND_KEY`, `:1882`) and `EZIL_WORKSPACE_STORE` (`workspace-store-s3.ts:670-690`).
  - Unless the selection is `kind: 'r2'` with a store present → `409 store_unsupported`. The S3 and migrating stores are out of v1: their conditional-put and read-routing semantics for this flow are unproven.
  - `begin` records `store: 'r2'` in the DO key. Any later step that resolves differently → `409 store_unsupported`.
  - Only the common store surface is used: `get`, `put` (with `onlyIf`), `list` (key, size, etag), `delete` (`workspace-store-s3.ts:58-84`, the `WorkspaceStore` interface at `:78`). No R2 `head()`, no `customMetadata`.
- **Prefix P.** P is the real key prefix the next Cloudflare hydrate of this computer reads: the derivation in `ensureWorkspaceMount` (`index.ts:1488-1525`), i.e. `realR2KeyPrefix(config.prefix ?? '/<projectId>/branches/<branch>')` (`workspace-seed.ts:94`), with the projectId and branch the app's Cloudflare open sends for this computer.
  - **[minor: P] Pinned value: `P = ${computerId}/branches/main`**, `computerId` being the canonical lowercase uuid of the computer (the `computerId` of every import body). Evidence at base:
    - `projectId` is the computer id: the app's Cloudflare open sends `projectId: c.computerId` (`cloudflare.ts:97`), the AWS preview sends `projectId: placement.computerId` (`aws-preview.ts:241`; the shared rule is noted at `cloudflare-guacamole-provider.ts:217-224`), and the Worker uses it unchanged as `workspaceProjectId` (`index.ts:4720,4827`).
    - `branch` is `'main'`: the app sends none, and the Worker defaults it (`index.ts:4828`).
    - `config.prefix` is `env.SANDBOX_WORKSPACE_S3_PREFIX` (`index.ts:1411`), read in both store branches (`index.ts:1513,1525`). It is a **deployment-wide** value (the same for every computer) and is unset in the deployed Worker; T0 (g) confirms that on canary2's DO.
    - `realR2KeyPrefix` strips the leading slash (`workspace-seed.ts:94-95`); the stored flush context holds that real prefix (`index.ts:1660,3062`).
  - **Env-prefix rule:** if `SANDBOX_WORKSPACE_S3_PREFIX` is set, v1 never imports: every `import/*` answers `409 prefix_mismatch` before any write. Importing into a deployment-wide prefix would overwrite every computer's head.
  - Lane W extracts that derivation into one helper used by both hydrate and import, and a unit test proves the import's P equals what the open route hydrates.
  - If the DO has a `WORKSPACE_FLUSH_CONTEXT_KEY` (`index.ts:1872`) **without** `freshProvision`, its `prefix` must equal P, else `409 prefix_mismatch`.
  - A `freshProvision` context with prefix `${name}/branches/main` (`index.ts:3470-3472`) is a fence placeholder for a never-used workspace. It is not compared; commit replaces it (§4.4).
  - System prefix `S = systemPrefixOf(P)` (`system-persist.ts:32-35`). Chunks go to `chunkKey(P, generation, i)` = `P/.ezil-snapshots/<generation>/<i>` (`workspace-persist.ts:304-305`).
- **Host binding:** the Sandbox DO for `<name>` reaches the host through the AWS tunnel record for the same `<name>`. It uses `lookupAwsTunnel` (`aws-tunnels.ts:600`) and signs every request with `signGatewayHeader` (`aws-origin.ts:174-182`), as `sendAwsControl` does (`aws-origin.ts:487-510`).
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
  - It goes stale 40 min after `startedAt` (`workspace-persist.ts:201`), so **every `begin`, `pull` and `commit` (both kinds, before any other write) rewrites `startedAt`** (at most once per request). Between requests, `checking` (≤ 20 min) plus `flipping` (≤ 30 min) can outlast 40 min; the `ezil:reverseImport` start fence covers any such gap.
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

The claim is **one** transaction: admission lock, then computer lock, then the lease and the reverse row's
`recordExportBoot`. A Step Functions start never runs inside it.

#### 5.1.1 Composition **[G2]**

**The lead's rule as worded cannot ship, so r3 pins the closest rule that can.** The rule says lane A composes
`readAdmissionCounters → decideAdmission → mintAdmissionTicket → leasePlacement` by hand. But `mintAdmissionTicket` is
"ADMISSION ONLY" (`placement.ts:690-697`). `placement.test.ts:505-518` scans the whole repository and fails when any
non-test file other than `admission.ts` and `placement.ts` names it. That is the R-PL F3 invariant: holding the lock alone
never leases. A hand composition in `provider-reverse-runtime.ts` therefore fails CI.

**The workable rule keeps the same steps and moves them into one new function in `admission.ts`, owned by lane A:**

```ts
// admission.ts (lane A). The only new caller of mintAdmissionTicket, inside the file that may name it.
export function admitExportBoot(db: PlacementDb, input: {
    userId: string; computerId: string;
    expected: { generation: number; leaseEpoch: number };   // the STOPPED row's N / E
    leaseUntil: Date; fields: PlacementFields;              // the boot's job, digest, fence and nonce hash (below)
}, recordInTx: (tx: PlacementExecutor, leased: Placement) => Promise<void>, deps?: AdmissionDeps): Promise<AdmissionOutcome>;
```

It does exactly this, in one `withAdmission` transaction (`placement.ts:582-588`):
1. `readAwsAdmissionConfig`. If it is disabled, refuse with its reason before any statement, as `runAdmission` does (`admission.ts:242-244`).
2. `lockComputerUnderAdmission(tx, lock, computerId)` (`placement.ts:660-663`), keeping the order admission → computer (§3.3).
   `runAdmission` takes no computer lock (`leasePlacement` → `casInTx` takes none, `placement.ts:938-961`), so this lock is
   added explicitly. It serialises the claim with the reverse create, `releaseExportBoot` and the flip.
3. `readAdmissionCounters(tx, lock, {userId, computerId, monthStart: utcMonthStart(now), now})` (`placement.ts:1725-1735`).
4. `readPlacement(tx, computerId)`. The row must be `aws-ec2`, owned by `userId`, `STOPPED`, `lifecycleJobId` null, and at
   `expected`. Otherwise return `cas_conflict`.
   **[r4]** An image-rebase reservation makes `readPlacement`, `readAdmissionCounters` (through `readCounters`) and
   `leasePlacement` (through `casInTx`) throw `ImageJobConflictError` (`assertNoImageReservation`, `placement.ts:428-436`, called by
   `readPlacement` at `:401,407`, by `readCounters` through `readPlacement` at `:1780`, and by `casInTx` at `:961`, whose CAS also
   requires `image_upgrade_job_id IS NULL` at `:981`).
   `admitExportBoot` catches exactly that error from steps 3, 4 and 7, lets the transaction roll back, and returns
   `cas_conflict`. It never escapes as a 500 or an unclassified failure (§5.2.1).
5. `decideAdmission({config, counters, userId, now, region: {kind:'lease', region: placement.region}, instanceType: placement.instanceType})`
   (`admission.ts:93-143`). Then **remove `user_hours_cap` and `user_egress_cap` from `reasons`**. If any reason is left,
   refuse with the first one left.
   **[r5] 5b.** Count the reverse rows in `booting`, `exporting`, `copying` or `checking`, fleet-wide, in this transaction
   (the admission lock serialises every claim). At `REVERSE_MOVE_MAX_ACTIVE = 3` or more, refuse **`move_capacity`**, a
   wait reason like `max_running`. This keeps every host-bound move inside one driver pass (§5.4 throughput).
6. `mintAdmissionTicket(tx, lock, {computerId, userId, kind: 'lease'})`.
7. `leasePlacement(tx, lock, ticket, {computerId, ownerUserId: userId, expected, leaseUntil, replace: true, fields})`, with no
   `resizeInstanceType`. **The export boot keeps the placement's own `instanceType`** (`placement.ts:1394-1397`) and its own region.
8. `await recordInTx(tx, leased.placement)`. Lane A passes
   `tx => createProviderReverseStore(tx).recordExportBoot(m, {placementGeneration: N+1, leaseEpoch: E+1, region: placement.region, volumeId, jobId, instanceId: null, fsUuid, claimedAt})`.
   If it throws (for example `lost_race`), the lease rolls back with it. **[r5]** `region` is required (store r5, §3.1).

A unit test pins the step order (lock statement first, then the computer lock, then the counters, then the CAS, then the
reverse write) and the cap filter. The repository scan at `placement.test.ts:505-518` stays unchanged and green.

**Admission policy for the export boot (pinned).** The move is EZiL's cost and ends EZiL's AWS cost. Real capacity limits
apply; the user's own allowance does not.

| `decideAdmission` reason | Applies? | Outcome in `requested` |
|---|---|---|
| `aws_disabled`, `aws_config_invalid`, `kill_switch` | yes | `reopen` → `kill_switch` (**try later**) |
| `max_running`, `region_capacity`, `global_hours_cap`, `global_egress_cap`, **[r5]** `move_capacity` (step 5b) | yes | **wait**: stay in `requested` with no `recordRetry`, and claim again on the next pass. At `ages.created ≥ 600` → the deadline rule below. |
| **[r4]** `duplicate_placement`, `region_not_configured` | yes | **wait**, exactly like the capacity row, and log `[reverse-move] anomaly` once per pass. These come from the whole fleet or the deployment, not from this computer: `findDuplicatePlacements` groups the whole table (`placement.ts:501-508`, read at `:1819`, refused at `admission.ts:123`), and `region_not_configured` is deployment configuration (`admission.ts:136-137`). A final failure would need operator SQL on every move in `requested` during one episode. |
| `cas_conflict` (the row moved, the lease CAS was lost, or **[r4]** an image-rebase reservation, step 4) | — | **wait**: re-read on the next pass, with no retry count. |
| `user_hours_cap`, `user_egress_cap` | **no**: removed in step 5 | — |
| `user_has_aws_computer` | yes. It passes for this computer: the counter excludes the target computer (`p.computer_id <> target`, `placement.ts:1803-1807`) and its own demand (`:1810-1816`). It fails only when the user holds **another** AWS computer or demand. | `reopen_final` → `boot_refused`, logged `[reverse-move] anomaly` |
| `computer_not_owned`, `computer_deleted` | yes | `reopen_final` → `boot_refused`, logged `[reverse-move] anomaly` |
| `aws_tier_invalid` | cannot occur (no tier is requested) | — |

**[r4] The `requested` deadline rule (one rule; §5.4 and §5.5 say the same).** Nothing durable records why earlier passes
waited (waits write no `last_error`), so the outcome is decided **only from the deadline pass itself**, the first pass
with `ages.created ≥ 600`. That pass runs its ordinary work first (kill switch, entitlement, the placement read, then the
claim when the read is claimable), then, if the row is still `requested`:
- the pass's own placement read was **not claimable**: not `aws-ec2` `STOPPED`, a `lifecycleJobId` set, the read
  threw `ImageJobConflictError`, or **[r5]** the computer still has an open billing epoch (below) → `reopen` → **`computer_busy`**;
- otherwise the pass attempted the claim and it was refused (any wait reason above, including `cas_conflict`) →
  `reopen` → **`boot_unavailable`** (**try later**).

The **try-later** outcomes are exactly `kill_switch` and `boot_unavailable`. Both are `failed_reopened` with `retry: 'now'`,
and the user copy is the §6.3 "try later" row. `computer_busy` is an ordinary `reopen` (§6.3 default row).
`boot_refused` is now only computer-specific: `user_has_aws_computer`, `computer_not_owned`, `computer_deleted`.

**[r5] No open billing epoch.** A stale epoch from an earlier session, left open after the placement reached `STOPPED`
(for example a swallowed `meter.stopped` failure, `billing/v2/compute-meter.ts:41-43`), would otherwise be closed by the export
host's retire receipt (`aws-receipts.ts:416`, `meter.stopped` closes any epoch ready at or before it, `billing/v2/compute-meter.ts:32-40`)
and bill the whole move as Free hours. The sweep's stale-epoch close cannot help during the move: it needs a stop proof,
and it treats LEASED, STARTING and MOUNTING as running (`billing-session-sweep/route.ts:48-53`). So, when billing metering
is active (`billingMeteringActive`, `compute-access.ts:215`), the `requested` pass reads `openEpochFor(computerId)`
(`compute-access.ts:218`) before the claim. An open epoch makes the placement **not claimable** that pass: wait, so the
sweep's stale close runs while the placement is still `STOPPED`; at the deadline the outcome is `computer_busy`. The read
is outside `admitExportBoot` (it is a billing-store read), and that is safe: a `STOPPED` placement under the claim's
computer lock cannot open a new epoch, which needs `RUNNING` (§5.2).

**Entitlement start-gate admission does not apply**: there is no `admitStart`/`decideStart`, which would refuse a Free
user's size (`compute-access.ts:231-244`). Free never uses the pool (`aws-ec2.ts:498-500`), so lane A calls `admitExportBoot`
directly, not through `reservePoolHostForBoot`.

#### 5.1.2 The lease fields (the wake's cold replace, rebuilt) **[G2]**

The claim row must be `aws-ec2` and `STOPPED` with no job (step 4). **[G3]** `computer.move.start` already refuses a
RUNNING or busy computer (§5.9). The `requested` wait therefore covers only races, such as a reconciler's job.

Lane A rebuilds the cold replace from the exported builders, with the same values the wake uses (`aws-ec2.ts:737-781`):
- `generation = N+1`, `leaseEpoch = E+1`, `nonce = issueEnrollmentNonce(now, randomBytes)`, `fenceToken = newId()`.
- `userData = buildEnrollmentUserData({computerId, volumeId, fsUuid, generation: N+1, leaseEpoch: E+1, nonce, provision: false, enrollUrl})`:
  ordinary user data, with no new lease key (`lease.py:45`).
- The intent copies the private `replaceIntent` field for field (`aws-ec2.ts:285-301`): `{schemaVersion: 1, jobId: newId(),
  computerId, revision: 1, operation: 'replace', targetGeneration: N+1, fenceToken, providerInstanceId: null, dataVolumeId:
  p.volumeId, previousGeneration: N, previousInstanceId: p.instanceId, previousFenceToken: p.fenceToken, deployment,
  instanceType: p.instanceType, dataVolumeGiB: null, leaseEpoch: E+1, userData}`. `work = buildLifecycleWork(intent)`.
- `fields = {fenceToken, enrollNonceHash, enrollExpiresAt, enrollConsumedHash: null, lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null}`
  (`aws-ec2.ts:772-781`).
- `leaseUntil = now + 120 min`. This is the host's own hard hold bound (§2.5 step 7). The boot never reaches RUNNING, so no
  lease-lapse stop reads it.
- **Parity test:** for the same STOPPED placement, lane A's intent equals the intent the provider's wake builds (drive
  `aws-ec2.ts` with a fake starter). Only `jobId`, `fenceToken` and the nonce inside `userData` may differ.
  **[r5] Fixture:** a `STOPPED` placement with `lastError: INSTANCE_LOST` on a deployment that is not in pool mode. The
  wake builds a replace only for a resize, `ENROLLMENT_FAILED`, `INSTANCE_LOST`, `POOL_RELEASED`, `wakeMode: 'replace'` or
  pool mode; otherwise it builds a same-generation `start` (`aws-ec2.ts:709,750-755`), which no replace can equal. A second
  case uses the plain `STOPPED` placement with `wakeMode: 'replace'`. **[r6]** Both cases inject `grantPending: async () => false`:
  since 6a a Free open first asks whether a paid period's grant is pending and, if so, answers `computer_starting` without
  building any intent (`aws-ec2.ts:701-707`; dependency `:152`, default `:339-340`).

**After commit** (never inside the transaction: a Step Functions start issued inside a transaction would be authorized
against an uncommitted row, `aws-receipts.ts:294-295`):
- `startLifecycleJob` (`aws-receipts.ts:218`, idempotent);
- `started` → `transitionPlacement(… to 'STARTING')`, as the wake does (`aws-ec2.ts:814`);
- `refused` and `unknown` take the wake's undo for a replace, which is **UNCONFIRMED**, not STOPPED (`aws-ec2.ts:799-807`):
  `markLifecycleStartUnknown`, then `settleUnknownStart` (`aws-receipts.ts:481-517`). The existing recovery settles it, and
  §5.7 waits for STOPPED, bounded by `boot_unsettled`.
- **[r5] `refused`, exactly as the wake's `launch()` does it** (`aws-ec2.ts:324-328`): first
  `settleReplacementGeneration(…, startDefinitelyRefused: true)` (`aws-rebase-generation.ts:86`). With the source pair intact
  it lands `STOPPED` at the **previous generation N**, at lease epoch E+1, through `reconcileReplacementGeneration`
  (`placement.ts:1009-1025`: `casInTx` bump `{0, 0}`, `confirmedGeneration` N). Only when that does not settle does it take
  the undo above. A failed execution takes the same settle through the receipts (`aws-receipts.ts:330-332`). §5.7's
  "settled" therefore accepts generation N **or** N+1.

### 5.2 Export-boot placement path (receipts mode and release; no new placement edges)

**Receipts: an export-boot mode, not a skip.** `applyLifecycleReceipt` (`aws-receipts.ts:247`) keeps running for the export boot. It switches to export-boot mode when `p0.provider === 'aws-ec2'` and `readByExportBoot(p0.computerId, p0.generation, p0.leaseEpoch, p0.volumeId)` returns a row. (A database without 0012 has none: call `reverseMovesTablePresent` first, §3.4.) The lookup matches every state **except `committed`**, on the same volume:
- a released (`failed_*`) row still keeps its own boot out of RUNNING, and that placement's next boot at E+2 (generation N, N+1 or N+2, **[r5]** §5.7) never matches;
- a committed row never matches: the flip deleted that placement row, so a later `aws-ec2` row (a forward move onto a fresh volume) may reach the same counters and must boot normally.

In this mode exactly two things change:
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

**[r5]** Those route and handler files, and their tests, are lane A's (§1.1). If an actor needs a code change to keep an
export boot below RUNNING, lane A makes it there. The libraries they call keep their own owners (for example
`aws-pool-replenish.ts` is H's, §2.8); a change needed in one is requested from its owner.

The machine reads the boot's receipt itself (pattern: `readMigrationReadyReceipt`, `aws-receipts.ts:1116-1130`). It records `jobId`, `instanceId` and `fsUuid` with `recordExportBoot`, and advances to `exporting` once enrollment succeeded (`lastError === ENROLLMENT_SUCCEEDED`, the row MOUNTING with no job).

### 5.2.1 Image-rebase reservations and reverse moves exclude each other **[r4]**

**The gap at base.** The image store reserves an `aws-ec2` placement that is `STOPPED` or `RUNNING`
(`aws-rebase-store.ts:396-401`). It refuses while a forward migration is active (`:402-405`) or a pool host is leased
(`:406-408`), but it never looks at reverse rows. A move's placement is `STOPPED` in `requested`, in `checking` after the
host retire, and in `flipping`. A reservation taken then makes every ordinary placement read and CAS throw
`ImageJobConflictError` (§5.1.1 step 4), and the image job may move `generation`/`leaseEpoch` (`writeImagePlacement`,
`placement.ts:470-498`). The flip's "STOPPED at N+1/E+1" check would then fail for good.

**Rule (lane A owns `aws-rebase-store.ts` for this one edit, §1.1).** In `reserve`, inside the same `withAdmission`
transaction, after `lockImagePlacement` (`aws-rebase-store.ts:389`; it takes the computer lock, `placement.ts:445-447`) and
right after the `ezil_compute_migrations` check (`:405`), call `reverseMoveHolds(tx, j.computerId)`
(`provider-reverse-store.ts:228-233`). It probes 0012 first (none → no reverse move, so production is unchanged), re-takes the
same computer lock (re-entrant within the transaction) and reads the holding states. `true` →
`throw new ImageJobConflictError()`, exactly like the migrations check. A holding row includes `failed_needs_operator`.

**Why that closes it.** The reverse create inserts and then takes the same computer lock (§3.3). So under READ COMMITTED,
a reservation that locks after a reverse create commits sees the row and refuses. The reverse create does not check
reservations. One race is left: a reservation that committed **before** the row was created. Its only effect is in
`requested`: the claim catches `ImageJobConflictError` and waits (§5.1.1 step 4), bounded by the deadline rule
(`computer_busy`). Every later state (`booting` onward) is reached only through a claim that succeeded, which is a CAS
with `image_upgrade_job_id IS NULL` (`placement.ts:981`) under the computer lock. Any reservation after that point locks
after the row exists and is refused. So in `booting` … `flipping` a reservation is impossible, not merely handled.

**Mapping elsewhere (values, never a 500):**
- `computer.move.start`/`retry`: a placement read that throws `ImageJobConflictError` → `move_computer_unsettled` (§5.9).
- The open trigger (§5.9): it does not fire, and the open proceeds as today (today's open also fails closed on a reservation).
- `computer.progress` and the summary: unchanged from today for that read.

**Lane A tests:**
- `rebase.pg`: `reserve` is refused while a reverse row is in each holding state (`requested`, `booting`, `checking`,
  `flipping`, `failed_needs_operator`). It succeeds after `committed`/`failed_reopened`, and on a schema without 0012.
- The admission unit test: `admitExportBoot` turns a thrown `ImageJobConflictError` into `cas_conflict`, and the lease
  rolls back.
- start/retry answer `move_computer_unsettled`, never a throw.

### 5.3 Routing while a move exists (`select.ts`, before the placement provider, like `providerForPendingMigration`, `provider-migrate-placement.ts:27-34`, `select.ts:101`)

Every read here starts with `reverseMovesTablePresent` (§3.4); no 0012 means no reverse row.

| Newest reverse row for the computer | Open / session routing |
|---|---|
| in flight (`requested` … `flipping`) | The **reverse waiting provider** (below). Opens wait and the shell shows the move view (§5.10). They never boot or adopt the AWS computer for a session. |
| `failed_needs_operator` with `openBlocked` (§5.5: `commit_sent_at` set, or reason `already_imported`/`commit_in_progress`/**[r5]** `boot_unsettled`) | **[r4]** The **reverse blocked provider** (below): it refuses at once **as a value**, never a thrown tRPC error. Never the waiting provider: the shell shows the needs-attention card, never a spinner. |
| `failed_needs_operator` without `openBlocked` (**[r5]** only `abort_unconfirmed`, whose placement is settled, §5.7) | Ordinary AWS routing. The files are intact on AWS; only Cloudflare-side cleanup is pending. The row still blocks new moves. |
| `committed`, `failed_reopened`, none | Ordinary routing on the placement. |

The open trigger (§5.9) runs in the open mutation path, never in `select.ts` reads or status polls.

**[r5] Both reverse providers are `kind: 'aws-ec2'`** (the forward waiting provider is too, `provider-migrate-placement.ts:12-19`),
and `routeComputer` returns them as `{kind: 'aws-ec2', provider, instanceType: <the placement's>, reverse: 'moving' | 'blocked'}`.
Any other kind is unsafe:
- `routeComputer` swaps every provider of kind `'cloudflare'` for the real Cloudflare adapter (`compute-dispatch.ts:130`),
  so an open during a move would start a Cloudflare sandbox;
- `computer.delete` retires first only for kind `'aws-ec2'` (`computer.ts:342-350`). For any other kind
  `softDeleteComputer` deletes even after a failed teardown (`computer-store.ts:382-393`), and the flip would later insert
  a Cloudflare row for a deleted computer (§5.6 step 3).
- `awsStopProof` treats a non-`aws-ec2` kind as running (`billing-session-sweep/route.ts:48-49`).

The `reverse` marker is set only by `select.ts` for these two providers. Lane A tests the kind and the marker for both.

**[r5] Every open route answers the reverse provider first.** At base each open route calls `routeComputer`, then the
billing gate `gateComputerStart`, then (two of them) `stopCooldownAnswer`, and only then the provider
(`cloudflare-guacamole.ts:250-257` previewUrl, `:531-542` appPreviewUrl, `:732-749` codePreviewUrl, and the restart route at
`:1416-1422`). During a move the routed computer is `aws-ec2` with the placement's `instanceType`, so a held Free user is
refused by the gate: `files_on_aws` for any size but `HOLD_SIZE` (`compute-access.ts:231-244`, `billing/v3/admission.ts:12`),
and `decideStart` can refuse a `std-2` one under Free limits. Every re-ask would then answer a `billing_*` refusal, never
`computeMoving`, and the move overlay would break. So, in all four routes (lane A, `cloudflare-guacamole.ts`):
- when `routed.reverse` is set, the route returns the provider's own answer through `compute-dispatch.ts` (with
  `computeMoving` or `computeMoveNeedsAttention`) **immediately after `routeComputer`**, before `gateComputerStart`, before
  `stopCooldownAnswer`, before `syncAiCredential` and before any Worker call;
- the open trigger (§5.9) already runs before `routeComputer` and answers the same way.
- Lane A tests each route with a held Free user whose placement is not `HOLD_SIZE`, and with one whose Free hours are
  used up: both get the waiting answer during a move, never `billing_*`.

**The reverse waiting answer [G1] (pinned; `provider-reverse-placement.ts`, lane A).** It must not reuse the forward
answer `computer_migrating`: `compute-dispatch.ts:162-165` turns that into `computeMigrating`, and the shell then
applies its 10-minute `MIGRATION_DEADLINE_MS` (`session.js:239,464-474`) and the 600 s boot hard stop
(`boot-progress.js:23,30-31`). A move runs for up to 155 min (§5.10), so every open-triggered move would fail mid-move.
- `ensure` → `{ok: false, error: 'computer_moving', errorCode: 'sandbox_starting', retryable: true, computeProvider: 'aws-ec2'}`.
- `status` → the same plus `state: 'starting'`.
- `activity`, `restart` → `{ok: false, error: 'computer_moving'}`; `stop`, `terminate` → `{ok: false, terminated: false, outcome: 'computer_moving'}`.
  The user cannot stop the export boot; the machine owns it.
- `compute-dispatch.ts` adds **`computeMoving: true`** (never `computeMigrating`) to any answer whose `error` is
  `computer_moving`, next to `awsMigrationAnswer` (`compute-dispatch.ts:161-165`).
- An old cached shell sees an ordinary retryable `sandbox_starting`: it re-asks under its wake deadline, then shows
  Try again. The move goes on; the next open sees it. The shell that ships with A (lane U) reads `computeMoving` (§6.4).

**The reverse blocked answer [r4] (pinned; `provider-reverse-placement.ts`, lane A).** r3 threw `PRECONDITION_FAILED` from
`select.ts`. That breaks the shell's rule that the open route answers failures as values on a 200 (`session.js:753-756`).
The shell flattens an unrecognised tRPC code to `unknown` (`session.js:738-750`). `unknown` is retryable
(`boot-phases.shell.js:336-342,372-377`), so the shell re-asks once in silence. A throw from routing also reaches every
`routeComputer` caller. So `select.ts` returns a blocked provider, the same pattern as the waiting provider:
- `ensure` → `{ok: false, error: 'computer_move_needs_attention', errorCode: 'preconditions_unmet', retryable: false, computeProvider: 'aws-ec2'}`.
  `preconditions_unmet` is an existing deterministic code on both sides (`cloudflare-guacamole-provider.ts:344,391-397`;
  `boot-phases.shell.js:336-342`). The AWS preview path answers every `ok: false` as a value (`awsPreviewAnswer`,
  `compute-dispatch.ts:207-239`), and `shellCodeForAwsEnsure` passes the code through unchanged (`:144-146`). The shell
  therefore never re-asks it, and no new `BootErrorCode` is needed (§1.1).
- `status` → the same plus `state: 'error'`.
- `activity`, `restart` → `{ok: false, error: 'computer_move_needs_attention'}`. `stop`, `terminate` →
  `{ok: false, terminated: false, outcome: 'computer_move_needs_attention'}`.
- `compute-dispatch.ts` adds **`computeMoveNeedsAttention: true`** to any answer whose provider `error` is
  `computer_move_needs_attention`, next to `computeMoving`. (`awsPreviewAnswer` rewrites `error` to the errorCode, so the
  flag is the only carrier.)
- Lane U reads the flag in `session.js` **before** `classifyFailure` (`openDesktopOnce` and `pendingOrRefused`, which
  `code.js:219` also uses). It shows the §6.4 needs-attention card, with no retry and no spinner. An old cached shell gets
  the generic deterministic failure copy (`preconditions_unmet` → `unknown` copy, `boot-phases.ts:516-521`) with no
  silent re-ask. That is disclosed, and acceptable: the state is rare and operator-attended.
- Every other `routeComputer` caller sees an ordinary refusal value. `computer.delete` gets a `terminate` with `ok: false`
  and refuses with `PRECONDITION_FAILED aws_retire_unavailable: computer_move_needs_attention` (`computer.ts:103-108`; `AWS_RETIREMENT_UNDERWAY` is only the retire outcomes, `aws-ec2.ts:131`),
  as it does today for `computer_migrating`. The same holds during a move (`computer_moving`). A computer with a move
  in flight or open-blocked is never deleted, and its export boot is never retired by a delete. **[r5]** This holds only
  because both providers are `kind: 'aws-ec2'` (above), so `retireAwsComputerBeforeDelete` runs and refuses.

### 5.4 Step work, deadlines and throughput

**Driver [minor: sweep position].** A new `advanceReverseMoves(handlerStartedAt)` runs in `billing-session-sweep`
**after `drain()`**, as the handler's last step:
- **Main path:** `advanceStaleMigrations` → `reconcilePaidCloudflareUsers` → `drain()` → **`advanceReverseMoves`**
  (`billing-session-sweep/handler.ts:258-260`).
- **Metering-inactive early return:** `drain()` → **`advanceReverseMoves`** → `finish()` (`handler.ts:83`). Forward moves do not
  run there at base. Reverse moves must, because only the driver enforces their deadlines (§5.4 table), and a held row with
  no driver would hold the computer indefinitely.
- **Why after `drain()`:** `reconcilePaidCloudflareUsers` and `drain()` each start no work later than handler start + 40 s
  (`provider-migrate-reconcile.ts:59`, `handler.ts:75`). A 90 s reverse pass placed before them would starve both on every
  tick with a move in flight.
- It has its **own 90 s budget**, measured from its own start, not the 40 s left over from the handler start that forward
  moves get (`provider-migrate-orchestrator.ts:136-147`). A Worker or AWS call starts only if its own timeout (§4.1)
  fits in what is left of the budget, so the pass ends by its start + 90 s.
- It does **nothing** when called later than `handlerStartedAt + 150 s`; the next tick takes the rows.
- Order inside the budget: lane O's snapshot step `advanceReverseSnapshots` first (at most 3 rows and 20 s, §7), then the
  in-flight rows. **[r5]** The pass claims with **`claimStale(10)`** (the store's maximum) and drives the claimed rows
  **concurrently**, one sequential step chain per row, every call under the same timeout-fit rule against the one pass
  deadline. Rows do not share bandwidth: each pulls from its own host through its own DO (§4.1).
- **[r5] `claimStale` order (lane A's one pinned store change, §3.4):** rows in `booting` … `flipping` before `requested`
  rows, then `updated_at, id` as today. With at most `REVERSE_MOVE_MAX_ACTIVE = 3` rows past `requested` (§5.1.1 step 5b),
  every host-bound row is driven on every pass, and up to 7 `requested` rows share the rest. A PG test: 9 old `requested`
  rows and 1 newer `copying` row, then `claimStale(1)` returns the `copying` row.
- The route's `maxDuration` is 300 s (`billing-session-sweep/route.ts:13`). The worst case is 150 s + 90 s = 240 s.
  Lane A's handler test proves the order and both gates.
- Within its budget it drives a row step after step. A `copying` row gets back-to-back pulls (`count: 64`).
- `computer.move.start`, `computer.move.retry` and the open trigger also schedule one immediate 60 s drive with `after()` (pattern `schedulePaidMigration`, `provider-migrate-orchestrator.ts:149-152`), so the first steps do not wait for a cron tick.
- Two drivers on one row are safe: the Worker serialises per DO (§4.1), and every row write is a CAS.

**Throughput arithmetic (worst case) [r5].** A full workspace is 512 chunks of 1 MiB. r4's "45 chunks per pass" ignored
the snapshot step, the timeout-fit rule and the rows sharing one budget. Redone:
- The snapshot step may use the first **20 s**, which leaves **70 s** of the 90 s budget.
- A `pull` (40 s timeout, §4.1) starts only if 40 s still fits. The Worker starts no new transfer after 20 s of wall time
  (§4.3), and its at most 4 in-flight chunks finish after that, so one pull ends within about 30 s. A row therefore gets
  **2 pulls per pass**: at about 20 s, and at about 50 s (50 + 40 ≤ 90); a third never fits.
- At the floor of **0.5 MiB/s per move**, counting only each pull's 20 s transfer window, a pull stores at least
  **10 chunks**, so a row stores at least **20 chunks per pass**. 512 chunks take at most **26 passes, about 26 min** with
  a pass every minute, against the 60 min `copying` deadline: more than 2× margin.
- This holds per row because rows are driven concurrently, each over its own host and DO, and at most 3 rows are past
  `requested` (§5.1.1 step 5b), all claimed every pass (`claimStale` order above). r4's shared serial budget gave 3
  copying rows about 7 chunks per pass each, about 70 min: that would have hit `copy_timeout`.
- At 3 MiB/s or more, a pull reaches its `count: 64` cap, so a row stores 128 chunks per pass and 512 chunks take 4 passes.
- Throughput is a live proof (T0 (e2)). If T0 measures below 0.5 MiB/s, this section changes before lane A ships.

**Deadlines [clocks].** Every deadline compares the **DB clock** with a **DB-written** timestamp, through the row's `ages`
(§3.4), which PostgreSQL computes as `clock_timestamp() − anchor` when the row is read or written. Lane A never compares an
anchor against `Date.now()`. claimStale never moves an anchor.

| Deadline | Anchor (`ages` field) |
|---|---|
| `requested`: 10 min | `created_at` (`ages.created`) |
| `booting`: 15 min | **`state_entered_at` of `booting`** (`ages.stateEntered`). It is written by `requested → booting` in the claim transaction itself (§5.1.1 step 8); completing the claim never moves it. `export_boot.claimedAt` is an app-clock record only and is never compared. |
| `exporting` 20 min, `copying` 60 min, `checking` 20 min | `state_entered_at` (`ages.stateEntered`) |
| `copying` stall: 10 min | `import_progress.last` (`ages.lastChunk`), written by PostgreSQL (§3.1); before the first chunk, `ages.stateEntered` |
| `flipping`: 30 min | `commit_sent_at` (`ages.commitSent`) |
| compensation (`boot_unsettled`, §5.5) | `ages.stateEntered ≥` that state's own deadline **+ 30 min**. Compensation runs while the row keeps its state, so `state_entered_at` is its DB anchor; a compensation that starts before the deadline (a failure answer) ends at the same absolute point. |

| State | Work per pass | Done when | Deadline → outcome (compensation first, §5.7) |
|---|---|---|---|
| `requested` | Kill switch on (`aws-config.ts:274`) → `kill_switch`. Entitlement paid → `entitlement_paid`. Read the placement: not `aws-ec2` STOPPED, a job pending, **[r4]** the read throws `ImageJobConflictError`, or **[r5]** an open billing epoch for the computer (§5.1.1) → wait. Otherwise claim (§5.1.1); a capacity, fleet or deployment refusal, **[r5]** `move_capacity`, or `cas_conflict` → wait (§5.1.1 table). | claim recorded | **[r4]** 10 min after `created_at` (`ages.created ≥ 600`), decided from **this pass only** (§5.1.1 deadline rule): this pass's placement read was not claimable → `computer_busy`; otherwise this pass's claim was refused → `boot_unavailable`. |
| `booting` | Read the boot receipt and enrollment. | enrolled → `advance('exporting')` | Boot settled as failed (UNCONFIRMED, or STOPPED by an undo) → `boot_failed`. **15 min after `booting`'s `state_entered_at`** (`ages.stateEntered`) → `boot_timeout`. |
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
- `reopen_after_session`: as `reopen`, but Try again (and any new row) is refused while the placement's `leaseEpoch` still equals the row's `exportBoot.leaseEpoch` (no AWS session since). **[r5]** A computer the D16 hold cannot open (`holdOpenable` false: its size is not `HOLD_SIZE`, §6.1.1) can never have that session, so its `retry` is `'no'` and its copy offers only Upgrade (§6.3).
- `reopen_final`: as `reopen`, Try again refused until an operator sets `last_error = 'operator_cleared'`. Open works (under the D16 hold, for a computer the hold can open: `holdOpenable`, §6.1.1), and an operator is alerted with a log line `[reverse-move] anomaly`.
- `operator`: `failed_needs_operator(code)`.

| Step (state) | Worker / host answer | Class → `last_error` |
|---|---|---|
| any pre-flip | entitlement became paid (re-read at every pass) | `reopen` → `entitlement_paid` (no Try again button needed, §6.3) |
| `requested` | kill switch on | `reopen` → `kill_switch` |
| `requested` (claim, §5.1.1) **[G2]** | admission `aws_disabled`, `aws_config_invalid`, `kill_switch` | `reopen` → `kill_switch` (try later) |
| `requested` (claim) **[G2] [r4]** | admission `max_running`, `region_capacity`, `global_hours_cap`, `global_egress_cap`, `duplicate_placement`, `region_not_configured` (the last two also log `[reverse-move] anomaly`), **[r5]** `move_capacity` (§5.1.1 step 5b), or `cas_conflict` (including a caught `ImageJobConflictError`) | wait (no `recordRetry`); at the deadline pass → `reopen` → `boot_unavailable` (try later) |
| `requested` (read) **[r4]** | the pass's placement read is not claimable (not `aws-ec2` STOPPED, a job, `ImageJobConflictError`, or **[r5]** an open billing epoch, §5.1.1) | wait (no `recordRetry`); at the deadline pass → `reopen` → `computer_busy` |
| `requested` (claim) **[G2] [r4]** | admission `user_has_aws_computer`, `computer_not_owned`, `computer_deleted` | `reopen_final` → `boot_refused`, logged `[reverse-move] anomaly` |
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
| `commit{verifyOnly}` | `import_mismatch`, `store_unsupported`, `prefix_mismatch`, `other` | `reopen_final` → the code (**[r5]** `other` → `worker_conflict`, as for `begin` and `pull`) |
| `commit` (`flipping`) | `200 committed` | continue §5.6 |
| `commit` (`flipping`) | `unavailable`, `not_found`, `other`, `import_not_started`, `system_head_moved` | keep retrying the same commit (`import_not_started` and `system_head_moved` are never failures here: the Worker reads P first and every step is idempotent) until `flip_stuck` |
| `commit` (`flipping`) | `head_moved` | `operator` → `import_head_moved` |
| `commit` (`flipping`) | `not_verified`, `import_mismatch`, `store_unsupported`, `prefix_mismatch` | `operator` → `import_not_verified` |
| `abort` (compensation) | `200` | continue §5.7 |
| `abort` | `unavailable`, `not_found` | retried inside compensation; still failing after 5 → `operator` → `abort_unconfirmed` |
| `abort` | `already_imported`, `commit_in_progress` | `operator` → that code (impossible before `flipping`) |
| boot (`booting`) | the boot settles failed / 15 min | `reopen` → `boot_failed` / `boot_timeout` |
| compensation | the placement does not settle (§5.7 step 2: **[r5]** `STOPPED`, no job, lease epoch ≥ E+1, generation N or N+1) by the state's deadline + 30 min (`ages.stateEntered`, §5.4) | `operator` → `boot_unsettled` (**[r5]** open blocked, §5.3) |

**Closed `last_error` vocabulary** (U keys copy on it; anything else is a lane A bug):
- `failed_reopened`:
  - `reopen`: `entitlement_paid`, `kill_switch`, `computer_busy`, `boot_unavailable`, `boot_failed`, `boot_timeout`, `export_timeout`, `export_failed`, `copy_stalled`, `copy_timeout`, `check_timeout`, `import_corrupt`, `import_lost`, `requested_retries`, `booting_retries`, `exporting_retries`, `copying_retries`, `checking_retries`, `operator_released`, `operator_cleared`;
  - `reopen_after_session`: `workspace_too_large`;
  - `reopen_final`: `head_moved`, `head_invalid`, `head_unreadable`, `system_head_moved`, `import_busy`, `import_mismatch`, `store_unsupported`, `prefix_mismatch`, `export_refused`, `workspace_missing`, `worker_conflict`, **`boot_refused`** (r3, §5.1.1; r4: computer-specific refusals only).
  - **Try later** (r3, §5.1.1): `kill_switch` and `boot_unavailable` only. They are `reopen` codes with their own copy (§6.3).
- `failed_needs_operator`:
  - Open works: `abort_unconfirmed` only. **[r5]** It is written only after the placement settled (§5.7), so the next open is an ordinary hold replace that never matches `readByExportBoot`;
  - **Open blocked** (`openBlocked`): `flip_stuck`, `import_head_moved`, `import_not_verified` (all with `commit_sent_at`), `already_imported`, `commit_in_progress`, and **[r5]** `boot_unsettled` (no `commit_sent_at`: the export boot's placement never settled, so an open would meet a LEASED/STARTING/MOUNTING boot held in export-boot mode, or an UNCONFIRMED one that answers `computer_recovering`, `aws-ec2.ts:683-688`).
- **[r4]** `committed` (lane O's `markSnapshotSpent` only; never shown to the user, §3.4): `snapshot_failed`, `snapshot_receipt_invalid`.
- In-flight retry codes (`recordRetry`): `unavailable`, `not_found`, `lost_race`, `container_running`, `export_host_mismatch`, `import_not_started`, `system_head_moved`, `commit_unavailable`.

#### 5.5.1 Operator runbook SQL (pinned; the only operator writes) **[minor: operator_cleared]**

No store method sets `operator_cleared`, and the app has no operator surface. Operators use exactly these statements,
on the staging DB, one row at a time (`<move-id>` is the row's `id`). Each one:
- is guarded, so it changes 0 rows unless the precondition holds;
- bumps `updated_at` with the store's own STAMP expression, so any writer holding an older copy loses its CAS. The store's
  CAS also checks `state` (`provider-reverse-store.ts`, `cas`), so a careless hand edit that keeps `updated_at` still
  refuses a stale writer; a PG test proves both.

`provider-reverse-store.pg.test.ts` reads every `-- runbook:` block **from this file** (these three and §7.1's
`operator_snapshot`) and runs them verbatim against 0012. Editing a block here without keeping that test green is a
contract break.

**Release** a `failed_needs_operator` row whose commit was never sent, after the manual cleanup it names: the Worker
import aborted (or proven never begun), and the placement `STOPPED` with no job. Try again is offered afterwards.
**[r5]** For `boot_unsettled` (open blocked until this release), the cleanup is first to settle the export boot's
placement: the fleet pass retries a failed host retire every 10 min (`aws-receipts.ts:793,813`), or the operator retires
the export host by hand. Release only once the placement reads `STOPPED` with no `lifecycleJobId`; the computer's next
open is then an ordinary hold replace.

```sql
-- runbook: operator_released
UPDATE public.ezil_compute_reverse_moves
   SET state = 'failed_reopened', last_error = 'operator_released', state_entered_at = clock_timestamp(),
       updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id = '<move-id>'::uuid AND state = 'failed_needs_operator' AND commit_sent_at IS NULL
RETURNING id, state, last_error, updated_at::text AS updated_at;
```

**Clear `commit_sent_at`**, only after proving the Worker commit never landed: P's `latest.json` is not this move's v1 head
(`generation` ≠ the row's `generation`) and no `ezil:reverseImport` key says `committing`. Then run `operator_released`.

```sql
-- runbook: clear_commit_sent
UPDATE public.ezil_compute_reverse_moves
   SET commit_sent_at = NULL, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id = '<move-id>'::uuid AND state = 'failed_needs_operator' AND commit_sent_at IS NOT NULL
RETURNING id, state, commit_sent_at, updated_at::text AS updated_at;
```

**Clear a final failure** (`reopen_final`), after fixing its cause, so Try again is offered again (§5.9). Only the computer's
newest row counts, so only the newest row is cleared.

```sql
-- runbook: operator_cleared
UPDATE public.ezil_compute_reverse_moves m
   SET last_error = 'operator_cleared', updated_at = GREATEST(clock_timestamp(), m.updated_at + interval '1 microsecond')
 WHERE m.id = '<move-id>'::uuid AND m.state = 'failed_reopened'
   AND m.last_error IN ('head_moved', 'head_invalid', 'head_unreadable', 'system_head_moved', 'import_busy', 'import_mismatch',
                        'store_unsupported', 'prefix_mismatch', 'export_refused', 'workspace_missing', 'worker_conflict', 'boot_refused')
   AND m.id = (SELECT n.id FROM public.ezil_compute_reverse_moves n WHERE n.computer_id = m.computer_id
               ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
RETURNING id, state, last_error, updated_at::text AS updated_at;
```

Finishing a `flip_stuck` row (`failed_needs_operator → committed`) is **not** SQL: it changes the placement, so it runs the
§5.6 transaction 2 code after the Worker confirms the commit.

### 5.6 Flip (`checking → flipping → committed`)

1. **Transaction 1** (end of `checking`), under `withAdmission` then the computer lock:
   - re-read the reverse row, the placement and the entitlement;
   - the placement must be `aws-ec2` `STOPPED` at N+1/E+1 with no job (the export host is retired);
   - if `paidAccess(standing)` (`paid|grace|plan_ending`, `standing.ts:42-45`), compensate (§5.7) with `entitlement_paid`;
   - otherwise `advance(m,'flipping')` over `tx`, which **sets `commit_sent_at`**.
   - No HTTP call is made inside the lock transaction.
2. **After commit:** Worker `commit{verifyOnly:false}`. This and every retry of it are the only Worker calls in `flipping`.
3. **Transaction 2**, under `withAdmission` then the computer lock. A new `flipPlacementToCloudflare` in `placement.ts` mirrors `flipPlacementToAws` (`placement.ts:806-848`); `placement.ts` stays the single writer.
   - **[minor: flip walk] The walk is the same as `flipPlacementToAws` (`placement.ts:829-842`), on the `aws-ec2` row:**
     1. Read the row inside the transaction. It must be `aws-ec2`, owned by the move's user, `STOPPED` at N+1/E+1 (the row's `exportBoot`),
        with no `lifecycleJobId`, and on the move's volume. Anything else throws, the transaction rolls back, and the row stays `flipping`.
     2. `STOPPED → RETIRING → RETIRED`, each by `casInTx(…, {generation: 0, leaseEpoch: 0}, {}, {ownerUserId, provider: 'aws-ec2'})`.
        Both edges are in `PLACEMENT_TRANSITIONS` (`STOPPED: ['RETIRING']`, `RETIRING: [… 'RETIRED' …]`, `placement.ts:107,120`).
        No lifecycle job is recorded and no usage effect applies: the host is already terminated (§5.4 `checking`).
     3. `DELETE … WHERE computer_id AND owner_user_id AND provider = 'aws-ec2' AND state = 'RETIRED' AND generation = N+1 AND lease_epoch = E+1`.
        Exactly one row, else throw (as `placement.ts:839-842`).
     4. Insert the Cloudflare row with `createInTx(tx, {computerId, ownerUserId, provider: 'cloudflare', state: 'STOPPED'}, true)`
        (the computer lock is already held). **Its counters are those of every new Cloudflare row: `generation = 1`, `lease_epoch = 0`,
        `workspace_store = 'r2'`** (`placement.ts:749-752`, `INITIAL_LEASE_EPOCH` `:72`, `DEFAULT_STORE` `:63`). This is the same row
        `pinCloudflarePlacement` creates (`placement.ts:866-867`). The commit's `store` must be `'r2'` (§4.1, v1 is R2-only); anything else throws.
   - **In the same transaction**, call the reverse store over `tx`: `finish(m, {awsVolumeId, awsFsUuid, awsSnapshotId: null})`.
   - So there is never a moment where the placement is Cloudflare while the row is not `committed`.
   - An operator finishing a `flip_stuck` row runs this same transaction from `failed_needs_operator`, after the Worker confirms the commit.
4. **After commit**, outside any lock: re-read the entitlement. If it is `paidAccess`, call `startPaidMigration(userId, sku)` (`provider-migrate-runtime.ts:173`). That runs a forward move onto a fresh volume; the retained volume is rollback-only. Then lane O's snapshot follows (§7).

There is no AWS call after the point of no return: the export host is retired in `checking`, before `commit_sent_at`.

### 5.7 Compensation (pre-flip only; before any `failed_*` write)

`failed_reopened` releases the computer, so it is written only after these steps:

1. **Worker `abort`**, only if the row reached `exporting` (a `begin` may have been sent). Retry up to 5 times inside compensation. Outcomes per §5.5.
2. **Export host**, only if a claim was recorded, and **[r5] always, even when step 1 could not be confirmed**: wait while a lifecycle job is pending. A MOUNTING boot with no job → `releaseExportBoot` + `retireUnenrolledHost` (§5.2). Wait until the placement is **settled**.
   **[r5] Settled (pinned):** `provider = 'aws-ec2'`, `state = 'STOPPED'`, `lifecycleJobId` null, the claim's volume,
   `leaseEpoch ≥ E+1`, and `generation` **N or N+1**. r4's "STOPPED at N+1/E+1 (or later)" missed the generation rollback:
   a refused or failed export-boot replace is settled by `settleReplacementGeneration` back to **generation N at lease
   epoch E+1** (`aws-ec2.ts:326-328`, `aws-receipts.ts:330-332` → `reconcileReplacementGeneration`, `placement.ts:1009-1025`;
   §5.1.2). The host-retire receipt lands N+1/E+1 (`INSTANCE_LOST`, §5.2). Nothing else can move the counters meanwhile:
   the row still holds the computer, so every open meets the waiting provider. The flip's own precondition (§5.6) stays
   strict at N+1/E+1, because its path is always the host retire.
3. **Write `fail(m, 'failed_reopened', reason)` in a transaction that holds the computer lock and re-reads the placement as settled in the same transaction.** **[r5]** The next Free hold open is the wake's own intent at lease epoch E+2: a replace at the settled generation + 1 (N+1 or N+2), or, after a refused replace that left the source instance stopped (`LIFECYCLE_START_FAILED`, generation N) on a non-pool deployment, a same-generation start at N (the replace conditions, `aws-ec2.ts:709`). Either way E+2 is above the volume marker's E+1, so it satisfies the guard's epoch rule (`guard.py:250-254`), and `readByExportBoot` (N+1/E+1) never matches it.

**[r5] Which operator code.** If step 2 does not settle within its bound, write `failed_needs_operator('boot_unsettled')`,
whatever step 1 did. It is **open blocked** (§5.3, §5.5): the placement is in a state no open can use. Otherwise, if step 1
could not be confirmed, write `failed_needs_operator('abort_unconfirmed')`. Its placement is settled, so Open works (§5.3)
and only the Cloudflare-side cleanup is left. Lane A tests both orders: step 1 failing with step 2 settling gives
`abort_unconfirmed`; step 2 not settling gives `boot_unsettled`, with or without step 1. A settle at generation N (a refused
replace) counts as settled.

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

- **`computer.move.start`** (new mutation in `app/src/server/api/routers/computer.ts`, `startedBy:'user'`).
  - **[r5]** `computer.move` is a **nested** router (`computer.move.start`, `computer.move.retry`), never flat names such
    as `moveStart`. The SDK drift guard (`sdk/src/surface.test.ts`) matches only top-level procedures, so it stays green
    only with the nested form, and that file belongs to no Phase B lane.
  - **[r4]** To **create** a row it requires standing `files_on_aws` (`standing.ts:12-13`), an `aws-ec2` placement, the kill
    switch off, and no forward work (steps 3–8 below). None of these applies to a row that already holds the computer: step 2
    returns it first, with the kill switch on or off.
  - It refuses `move_unavailable` after a `reopen_after_session` failure with no AWS session since, or a `reopen_final` failure that is not `operator_cleared`.
  - It returns the holding row, or creates one when none holds and every check below passes.
  - **[G3] It never creates a row for a computer that is in use.** Refusals are **values**, like `switchConfiguration`'s
    (`computer.ts:241-246`): `{ok: false, reason}` or `{ok: true, move: ComputerMoveV3}`.
  - **[r4] Order.** r3 ran the placement checks before the holding-row check. With D20 the move usually starts from an open
    in another window, and the export boot's placement is LEASED/STARTING/MOUNTING (`booting`) or
    UNCONFIRMED/RECOVERING/RETIRING (`checking`). So a stale card's click answered `move_computer_running` or
    `move_computer_unsettled` in the middle of the move. With the kill switch on it answered `move_paused`, although an
    in-flight move continues under the kill switch (§5.10). **The holding-row check now comes first, and the placement
    checks run only when no row holds.** The steps, in this order, all in the same request:

    | # | Check | start answers | retry answers | Copy key (§6.3) |
    |---|---|---|---|---|
    | 1 | this database has no 0012 (`reverseMovesTablePresent` false: production today) | `move_unsupported` | `move_unsupported` | none; the action is not shown (`moveAvailable` false) |
    | 2 | **a reverse row holds the computer** (`readActiveByComputer`: any in-flight state or `failed_needs_operator`), owned by the user | **`{ok: true, move}` for that row**, in every state, with the kill switch on or off | `move_in_progress` | the move's own card (§6.3) |
    | 3 | standing is not `files_on_aws`, or the placement is not `aws-ec2` | `move_not_held` | `move_not_held` | none; the card is not shown |
    | 4 | the kill switch is on (`aws-config.ts:274`) | `move_paused` | `move_paused` | try later |
    | 5 | forward work for the computer (`forward_active`, §3.3) | `move_busy` | `move_busy` | try later |
    | 6 | the newest row's failure forbids Try again (above) | `move_unavailable` | `move_unavailable` | the failed card's own copy |
    | 7 | the placement is `RUNNING`, `LEASED`, `STARTING`, `MOUNTING`, `DRAINING` or `STOPPING`, **or has a `lifecycleJobId`** (a D16 hold session is open or a job is pending) | **`move_computer_running`** | `move_computer_running` | **stop first** |
    | 8 | any other non-`STOPPED` state (`UNCONFIRMED`, `RECOVERING`, `RETIRING`, …), or **the placement read throws `ImageJobConflictError`** (§5.2.1) | `move_computer_unsettled` | `move_computer_unsettled` | try later |
    | 9 | none of the above | `createOrGetActive` → `{ok: true, move}` | same (a new row) | the move's card |

  - `move_unavailable` (6) comes **before** the placement checks (7, 8) on purpose. The "stop first" copy promises that
    the move starts once the computer has stopped. For a computer whose Try again is forbidden, that promise would be
    false: the user would stop the computer only to be told the move is unavailable.
  - Store refusals from step 9 are values too: `forward_active` → `move_busy`; `owner_mismatch` → `move_not_held`;
    `create_failed` → `move_busy`. Step 2 checks the owner exactly like the forward row (`progress.ts:156`); another
    owner's row → `move_not_held`.
  - The closed union, in check order: `move_unsupported`, `move_in_progress` (retry only), `move_not_held`, `move_paused`,
    `move_busy`, `move_unavailable`, `move_computer_running`, `move_computer_unsettled`.
  - So a held computer is only ever claimed from `STOPPED`. The `requested` wait (§5.4) is left for races, such as a
    reconciler's job or an image-rebase reservation, and is still bounded by the deadline rule (`computer_busy`) at
    10 min. The next-open trigger fires only from `STOPPED` (below), so it is unaffected.
  - **Lane A tests [r4]:** start and retry in every in-flight state (`requested` … `flipping`, with the export boot's
    placement in each of LEASED, STARTING, MOUNTING, MOUNTING with a job, UNCONFIRMED, RECOVERING, RETIRING and STOPPED) and in
    `failed_needs_operator`: start returns that row, retry answers `move_in_progress`. One test turns the kill switch on
    mid-move: start still returns the row. One test per refusal in the order above, including `ImageJobConflictError` →
    `move_computer_unsettled` and `move_unavailable` before `move_computer_running`.
- **`computer.move.retry`** (new mutation). It is the same as start, except that a holding row answers
  `move_in_progress` (step 2). It exists because the shell's `move-retry` must stop calling `switchTo`
  (`computers.js:1402-1405`).
- **Next open (`startedBy:'open'`, D20, in v1).** In the open path, `previewUrl` in `app/src/server/api/routers/cloudflare-guacamole.ts` (lane A; it already stamps the open there, `cloudflare-guacamole.ts:212-216`), before `routeComputer`, never in reads, `computer.progress`, `status` or the hosted-app routes. The open creates a row and returns the reverse waiting answer (§5.3) when ALL of these hold:
  - standing `files_on_aws`;
  - the placement is `aws-ec2` `STOPPED` with no lifecycle job and no lease (no transition active);
  - no reverse row holds the computer, and the newest reverse row, if any, is not `failed_*` (after any failure, only a click starts the next move);
  - no forward work (§3.3);
  - the kill switch is off;
  - the account is **not founder-owned** (§5.9.1).
  - Otherwise the open proceeds as the D16 hold (a cold Free boot).
  - Lock order (§3.3): create on the same `tx`, or after commit.
- **[r5] No cron trigger in v1** (§9). r4's "Cron (after canary2 acceptance)" bullet is withdrawn: a scheduled scan that
  creates rows needs its own decision and its own contract revision.

#### 5.9.1 Founder-owned accounts (pinned; fail-closed; no new env)

An account is founder-owned for this contract when ANY of these holds:
1. its email's domain is `ezil.work` (case-insensitive). This covers contact@ezil.work, which STATUS treats as founder-owned (round 6 STATUS lines 19 and 93), and founder@ezil.work.
2. its email is on the existing operator allow-list read by `isTelemetryAdmin(email, env.TELEMETRY_ADMIN_EMAILS)` (`telemetry/admin.ts:15`). That is the same gate `billing.ts:303-306` already uses as the operator identity.
3. its email is missing or unreadable.

The rule over-excludes on purpose. A founder-owned account never gets an `'open'` row; it moves only on the explicit Move click from its own session. The same helper drives the DTO's `moveOnOpen` (§6.1).

---

### 5.10 `computer.progress` during a move **[G1]**

**Why.** At base, `describeProgress` reads only forward rows (`progress.ts:79-147`). During a move it would describe the
export boot's own `aws-ec2` placement, and the user watches that overlay for the whole move (D20 makes the next open the
main trigger):
- LEASED, STARTING and MOUNTING become `operation: 'opening'` (`progress.ts:95`). The overlay applies its 240 s expectation and
  the 600 s budget (`computer-progress.js:149-159`, `boot-progress.js:23,30-31`, `app-spinner.js:292-293`).
- `releaseExportBoot`'s UNCONFIRMED in every successful `checking` step sets `needsOperator` (`progress.ts:121`), and so does a
  MOUNTING boot past enrollment grace (`progress.ts:120`). Both are a false "needs attention".
- RECOVERING and RETIRING read as `stopping` (`progress.ts:96,110-113`).
- `openingOptions` stamps an opening record for the export boot's epoch (`progress.ts:177-201`, `describeOpening` `:415-423`).

**Ownership.** Lane A owns the server description (`progress.ts`). Lane U owns its rendering in `computer-progress.js`, the
open overlay and the Computer tab (§6.4).

**Server rule (lane A).** `readComputerProgress` calls `reverseMovesTablePresent` (§3.4), then reads the newest reverse row
with `readByComputer`. It checks the owner exactly as for the forward row (`progress.ts:156`). This happens **before**
anything placement-derived. With no 0012, or no row, the output is byte-for-byte today's.

| Newest reverse row | `computer.progress` |
|---|---|
| in flight (`requested` … `flipping`) | the **moving view** below. Nothing placement-derived drives it: no `opening` or `stopping` operation, no lifecycle stage, no `needsOperator` from UNCONFIRMED or enrollment expiry, no capacity wait, no transition. **`openingOptions` is not called**, so no opening record is read or written for the export boot's epoch. |
| `failed_needs_operator` with `openBlocked` (§5.3; **[r5]** including `boot_unsettled`) | the moving view with `stage: 'needs_operator'`, `needsOperator: true`, `active: false`, `move.outcome: 'failed_needs_operator'`, `move.openBlocked: true` |
| `committed`, `failed_reopened`, or `failed_needs_operator` without `openBlocked`, and visible (§6.1) | today's placement description, unchanged, **plus** `move` with its outcome. A reverse `failed_reopened` never takes over `stage`: the old shell's copy for that stage says "The original computer was reopened" (`computer-progress.js:26`), which is wrong here. |
| none, not visible, or no 0012 | unchanged, and `move` is `null` |

**The moving view (pinned DTO; additive; `version` stays 2).**

```ts
// Existing fields, with their values in the moving view:
operation: 'moving';                    // NEW value. Never 'opening', 'stopping' or 'migration'.
stage: 'moving' | 'needs_operator';     // 'moving' is NEW: an old shell has no copy for it, so its progressView returns null.
recordedStage: ReverseMoveState;        // the row's state (diagnostics only)
lifecycleState: null;                   // [r4] always null in the moving view (the real state is move.placementState)
paused: false; operationsPaused: false; // an in-flight move continues under the kill switch: D-7 gates new work only
needsOperator: boolean;                 // true only in the openBlocked row above
active: boolean;                        // true while in flight
startedAt: string;                      // the row's created_at (ISO)
updatedAt: string;                      // the row's updated_at (ISO)
durable: true; resumePolicy: 'unavailable';
bytes: { transferred: number | null; total: number | null };  // import_progress.bytes / bytes_total; null before the head
percent: number | null;                 // floor(100 × transferred / total) in 'importing', else null
etaSeconds: null;                       // no speed or duration claims (§6.3)
transferStartedAt: string | null; transferUpdatedAt: string | null;  // import_progress.first / .last (DB clock)
typicalSeconds: number;                 // = move.expectedSeconds
openingStartedAt: null; path: null; expectedSeconds: null; milestones: [];  // never an opening
transition: null; selectedNextOpenHardware: null;           // hardware: unchanged

// NEW, additive and optional (absent or null with no visible reverse row; old shells ignore it):
move?: null | {
    moveId: string;
    direction: 'to_cloudflare';
    phase: 'export_boot' | 'exporting' | 'importing' | 'checking' | 'committing' | null;  // null once terminal
    step: 0 | 1 | 2 | 3 | null;          // the §6.1 step of `phase`; null once terminal
    startedAt: string;                   // created_at (ISO)
    phaseStartedAt: string;              // state_entered_at (ISO, DB clock)
    expectedSeconds: number;             // whole move, from startedAt (below)
    budgetSeconds: number;               // 9300 (below)
    bytesDone: number | null; bytesTotal: number | null;
    outcome: null | 'committed' | 'failed_reopened' | 'failed_needs_operator';
    reason: string | null;               // failed_* only: last_error, from the §5.5 closed list; null for committed [r4]
    retry: 'now' | 'after_aws_session' | 'no' | null;   // terminal only, as §6.1
    openBlocked: boolean;
    holdOpenable: boolean | null;        // [r5] as §6.1.1: the D16 hold can open this AWS computer; null once committed
    placementState: PlacementState | null; // [r4] diagnostics only: the export boot's placement state; no shell reads it
};
```

- **Phases** (the lead's "export boot, exporting, importing, checking, committing"): `requested` and `booting` → `export_boot`
  (step 0); `exporting` → `exporting` (step 0); `copying` → `importing` (step 1); `checking` → `checking` (step 2); `flipping` →
  `committing` (step 3). The steps equal `REVERSE_MOVE_DTO_STAGE`'s (§6.1), so the overlay and the Computer tab never disagree.
- **`expectedSeconds`** is the bar's time ease only, never shown as a number. It is provisional and is re-pinned from T0 (e)
  and (e2), like §5.4: `clamp(240 + 120 + import + 150, 600, 3600)`, where 240 is the export boot (`OPENING_TYPICAL_SECONDS`,
  `progress.ts:45`), 120 the capture, `import = ceil(bytesTotal / 1,048,576)` seconds (1 MiB/s; 120 before the head is known),
  and 150 the check, host retire and commit.
- **`budgetSeconds = 9300`**, the sum of the §5.4 deadlines: 600 (`requested`) + 900 (`booting`) + 1200 (`exporting`) +
  3600 (`copying`) + 1200 (`checking`) + 1800 (`flipping`). With the driver running (§5.4), every row is terminal by then.
  The shell never fails a move on its own clock before `startedAt + budgetSeconds + 300 s` (§6.4).
- **Old cached shells:** `progressView` returns null for the unknown stage `moving` (`computer-progress.js:131-133`), so they
  show no opening bar, no `needs_operator` and no wrong copy. Their open loop sees an ordinary `sandbox_starting` (§5.3).
- **[r4] Why `lifecycleState` is null.** The Computer tab derives `running`, `stopped`, its chip and the Stop button from
  `lifecycleState` (`computers.js:458-460,478-482,778,792`) and dismisses on `STOPPED` (`:919`). The export boot's placement
  is `STOPPED` in `requested`, in `checking` after the host retire and in `flipping`, and `MOUNTING` in `booting`. Passed
  through, it would show "Stopped" and offer Open or Start mid-move in old and new shells alike. With `null`, an old
  shell shows no chip, no Stop and no "Now running". Its Open button stays enabled, and opening meets the waiting
  answer (§5.3). The new shell follows §6.4. The real state is `move.placementState`, for diagnostics only.
- **[r4] Terminal rows keep today's placement description, so `stage` never identifies the outcome.** A `failed_reopened`
  row arrives with the hold's own stage (for example `stopped`). A `failed_needs_operator` row without `openBlocked`
  (**[r5]** only `abort_unconfirmed`, placement settled) arrives with the hold's stage, and a placement that a later
  recovery moved can still read `needs_operator` with `move.openBlocked: false`. A committed row arrives with the Cloudflare placement's stage (`unavailable` or `stopped`). **Whenever `move` is
  non-null and `move.outcome` is set, the shell keys the outcome on `move.outcome` and `move.openBlocked` only, never on
  `stage`** (§6.4). Only the openBlocked row (table above) sets `stage: 'needs_operator'` from the move itself.
- **Lane A tests:** for each export-boot placement state with an in-flight row (LEASED, STARTING, MOUNTING, MOUNTING past
  enrollment grace, UNCONFIRMED/`ENROLLMENT_FAILED` from `releaseExportBoot`, RECOVERING, RETIRING, STOPPED/`INSTANCE_LOST`),
  check `operation: 'moving'`, `needsOperator: false`, **[r4] `lifecycleState: null` with the real state in `move.placementState`**,
  `typicalSeconds` equal to the move's, and no opening written. **[r4]** A committed row's `move.reason` is null even when
  `last_error` is a §7.1 spent reason. Also: a
  database without 0012 gives today's output exactly.

## 6. Summary DTO and shell (lanes A + U)

### 6.1 `summary.computer.reverseMove`, `moveOnOpen` and `moveAvailable` **[r5]**

**[r5] The move rides a new additive key, `summary.computer.reverseMove`. `summary.computer.move` stays `null`.** r4 put
the move in `computer.move`, which an old cached `computers.js` already renders (the dormant `moveView`,
`computers.js:571-598`). Its failed card always offers [Try again], and that calls `switchTo` (`:1402-1405`), which is an
open. After a failed row there is no open trigger (§5.9), so the click boots the AWS computer under the D16 hold and uses
Free hours; for an open-blocked row it meets the refused open; and its step 4 still says "Starting your desktop"
(`:567`). With `move` kept null, an old shell never renders a reverse move: it keeps today's files-held banner until the
commit makes the standing `free`. Only the shell that ships with lane A (lane U) reads `reverseMove`. `ComputerMoveV3`
(`contract.ts:242-247`) and `summary.ts:282`'s `move: null` stay as they are; the new type is `ComputerReverseMoveV3`.
Everywhere below, "the summary's move" means `summary.computer.reverseMove`.

```ts
interface ComputerReverseMoveV3 {   // summary.computer.reverseMove: ComputerReverseMoveV3 | null (additive, optional)
  direction: 'to_cloudflare';
  /** to_cloudflare: REVERSE_MOVE_DTO_STAGE[state] */
  stage: 'saving' | 'copying' | 'checking' | 'flipping' | 'committed' | 'failed_reopened' | 'failed_needs_operator' | string;
  bytesDone: string;          // decimal; import_progress.bytes, '0' before copying
  bytesTotal: string | null;  // decimal; bytes_total once the export head is known
  reason: string | null;      // failed_* only: last_error, from the §5.5 closed list
  skipped: number | null;     // export head `skipped`; null before it is known
  retainUntil: string | null; // ISO; committed only
  retry: 'now' | 'after_aws_session' | 'no' | null;  // failed_* only, from the §5.5 class
  openBlocked: boolean;       // true only for failed_needs_operator with openBlocked (§5.3)
  holdOpenable: boolean | null; // [r5] the D16 hold can open this AWS computer (§6.1.1); null once committed
}
// summary.computer.moveOnOpen: boolean. True when standing is files_on_aws, no move holds, and the open
// trigger would fire (§5.9: not founder-owned, newest row not failed_*). The pre-move card copy needs it.
// summary.computer.moveAvailable: boolean (r3). True only when this database has 0012, AWS computers are enabled
// with the kill switch off (aws-config.ts:274), standing is files_on_aws and the placement is aws-ec2 (r4: and the
// newest row's failure does not forbid Try again, §6.1.1). Without it no move action is shown: production has no
// 0012 today, and its users must never see a button that cannot work.
```

- **Stage map** (`REVERSE_MOVE_DTO_STAGE`, `provider-reverse-store.ts:58`): `requested`, `booting` and `exporting` → `saving` (step 0); `copying` → `copying` (1, with bytes); `checking` → `checking` (2); `flipping` → `flipping` (3).
  - These are keys the dormant `MOVE_STEP_OF` already has (`computers.js:568`), and a unit test pins that.
  - The shell's own `exporting: 1` entry is never sent for `to_cloudflare`.
- **Visibility [clocks]:** non-null when the newest row for the computer is holding, or is terminal and entered its terminal state within the last 24 h **on the DB clock** (`ages.stateEntered < 86400`, §3.4; r3 replaces "`updated_at` within 24 h", which the snapshot write and the runbook move). Otherwise null, and the standing banner applies. A `failed_needs_operator` row is always visible. `computer.progress`'s `move` uses the same rule (§5.10).
- Every read here starts with `reverseMovesTablePresent` (§3.4): no 0012 → `reverseMove: null`, `moveOnOpen: false`, `moveAvailable: false`.
- Lane U's new `reverseMove` view accepts `reason` with the same `/^[a-z0-9_:-]{1,64}$/i` the dormant view uses (`computers.js:575`).
- **[r4]** `reason` is null for `committed` and for in-flight rows. A committed row's `last_error` (a §7.1 spent reason) is
  never shown.

#### 6.1.1 The summary's move computer and its reads **[r4]**

**Why this needs pinning.** `billing.summary` takes no input. Its only placement read is `placementAndVolume(ctx.db,
ctx.user.id)` (`billing.ts:328-338`), which feeds `buildSummaryV3` the provider of "any aws-ec2 placement among the user's
live computers" (`userPlacement`, `billing.ts:160-191`; builder input `summary.ts:200-219`). `buildSummaryV3` is pure and
hard-codes `move: null` (`summary.ts:282`). The operator gate is in the router (`telemetryOperator`, `billing.ts:303-306`).
After a committed move the user has no `aws-ec2` placement, so "the newest row for the computer" needs a computer.
**Lane A owns `billing.ts` for these reads (§1.1).**

**Reads (router, lane A), with no new store method and no new placement query:**
- `userPlacement` also returns the live computer ids it already reads (`billing.ts:165-168`) and, for each `aws-ec2`
  computer, the placement record it already reads (`:176`): `state`, `leaseEpoch` and `lifecycleJobId`. A read that
  throws (including `ImageJobConflictError`) is no record, as today (`:180-183`).
- `reverseMovesTablePresent(ctx.db)` once (§3.4). If true, `readByComputer(id)` for each live computer id. Users hold few
  computers (one main computer, round 3), so this is a handful of indexed reads (`computer_id, created_at`, 0012).
- The kill switch and "AWS enabled" from `aws-config.ts` (the same reads as §5.9). Founder-owned (§5.9.1) from
  `ctx.user.email` and `telemetryOperator`.

**The move computer, first match wins:**
1. the computer whose newest row **holds** (in flight or `failed_needs_operator`). The holding row is always that
   computer's newest row, because a new row is created only when none holds;
2. else the computer of the user's `aws-ec2` placement (a Free user holds at most one: `user_has_aws_computer`; with
   several, the lowest computer id);
3. else the computer whose newest row is terminal and **visible** (§6.1 24 h rule), the most recent by
   `ages.stateEntered`. This is the "after commit" case: the placement is now Cloudflare;
4. else none: `reverseMove: null`, `moveOnOpen: false`, `moveAvailable: false`.

**New `buildSummaryV3` input (pure; lane A):**

```ts
reverseMove?: {
    tablePresent: boolean;                          // reverseMovesTablePresent
    row: ComputeReverseMove | null;                 // the move computer's newest row (null: none, or no 0012)
    placement: { provider: 'aws-ec2' | 'cloudflare' | null; state: PlacementState | null;
                 leaseEpoch: number | null; lifecycleJobId: string | null;
                 instanceType: string | null } | null;  // the move computer's ([r5] instanceType: for holdOpenable)
    awsEnabled: boolean; killSwitchOn: boolean;     // aws-config.ts (as §5.9)
    founderOwned: boolean;                          // §5.9.1
};  // omitted = today's output exactly (reverseMove null, moveOnOpen false, moveAvailable false; move is always null)
```

**Derived fields (pinned):**
- `reverseMove`: from `row` when visible (§6.1), else null. `move` is always null (§6.1).
- **[r5] `holdOpenable`:** the placement is `aws-ec2` and its `instanceType` meters as `HOLD_SIZE`
  (`meteredSizeForInstanceType(instanceType) === HOLD_SIZE`, the billing gate's own test, `compute-access.ts:224,231-244`;
  `billing/v3/admission.ts:12`). False for a held computer of another size: the gate refuses its opens with
  `files_on_aws`, so the D16 hold can never open it. Null when the placement is not `aws-ec2` (after a commit).
  `computer.progress`'s `move.holdOpenable` uses the same rule (§5.10).
  **[r6]** It is 6a's "held closed" test (R4-02) for the same computer: `userPlacement` already meters each `aws-ec2`
  placement's `instanceType` with `meteredSizeForInstanceType` (`billing.ts:179,185`) into `summary.computer.awsSize`
  (`summary.ts:284-285`), and the Computer tab's `heldClosed` is `current !== HOLD_SIZE` (`computers.js:465,468`). A Free
  user holds one AWS computer (`user_has_aws_computer`), so `reverseMove.holdOpenable === false` exactly when 6a shows the
  held-closed card. Lane A's summary test pins `holdOpenable === (awsSize.size === HOLD_SIZE)` for `std-2`, `cmp-4` and
  `cmp-8`.
- `retry` (failed rows only): `failed_needs_operator` → `'no'`. For `failed_reopened`, by the §5.5 class of `last_error`:
  `reopen` → `'now'`, except `entitlement_paid` → `'no'` (standing is then paid; nothing to retry). `reopen_after_session`
  → `'now'` when `placement.leaseEpoch > row.exportBoot.leaseEpoch` (an AWS boot since: the next Free hold open is a
  replace at E+2, §5.7); else **[r5]** `'after_aws_session'` when `holdOpenable`, and `'no'` when not (no AWS session can
  ever come, so the only way on is Upgrade, §6.3). `reopen_final` → `'no'`; `operator_cleared` is a `reopen` code →
  `'now'`. In flight and `committed` → null.
- `openBlocked`: `failed_needs_operator` and (`commitSentAt` set, or `last_error` ∈ {`already_imported`, `commit_in_progress`, **[r5]** `boot_unsettled`}).
- `moveOnOpen`: `tablePresent`, standing `files_on_aws`, placement `aws-ec2`, no holding row, the newest row (if any)
  not `failed_*`, not `founderOwned`, `awsEnabled` and not `killSwitchOn`. It chooses the pre-move card's copy only, so it
  does not depend on the placement's state; the trigger re-checks everything (§5.9).
- `moveAvailable`: `tablePresent`, `awsEnabled`, not `killSwitchOn`, standing `files_on_aws`, placement `aws-ec2`, and
  **[r4] the newest row's failure does not forbid Try again** (start would answer `move_unavailable`, §5.9 step 6). No
  action is ever shown that start would refuse for a reason the user cannot change.
- **Copy precedence (U):** a reason-specific §6.3 row (`workspace_too_large`, the try-later codes, `entitlement_paid`,
  **[r5]** `boot_unsettled`) wins over the `retry`-keyed rows. **[r5]** Within a row, `holdOpenable: false` selects the
  variant without "keep using it", "remove some files" and [Open my AWS computer] (§6.3, §6.4).

**Lane A tests:** the selection order (holding row first; then the `aws-ec2` computer; then the newest visible terminal
row; a deleted computer's rows are ignored); no 0012 → today's output exactly; founder-owned → `moveOnOpen` false;
`after_aws_session` → `now` once `leaseEpoch` passes the boot's; `moveAvailable` false after an uncleared `reopen_final`;
a committed row's `reason` is null with `last_error = 'snapshot_failed'`. **[r5]** `computer.move` is null in every case;
`holdOpenable` true for a `std-2` placement and false for a larger one; `workspace_too_large` on a non-`HOLD_SIZE`
computer gives `retry: 'no'`; `boot_unsettled` gives `openBlocked: true`.

### 6.2 Shell changes (lane U)

- **[r5]** The move card reads `summary.computer.reverseMove` only, never `computer.move` (which stays null for old shells,
  §6.1). The dormant `moveView`/`moveHtml` may be reused for it, with the changes below.
- The step 4 label changes from "Starting your desktop" to **"Switching to your Free computer"** (`computers.js:567`).
- `move-retry` calls `computer.move.retry`, and is shown only when `retry === 'now'`.
- The done, failed and needs-attention cards use the §6.3 copy.
- Add a pre-move card with the "Move my files…" action on the files-held state, with the variant chosen by `moveOnOpen`.
  **r3:** the card and its action are shown only when `moveAvailable` is true. Otherwise the files-held state keeps the
  banner without any move sentence or button (§6.3, "files held, `moveAvailable` false").
- **[r4]** An open answered with `computeMoveNeedsAttention: true` (§5.3, the blocked answer: a value with errorCode
  `preconditions_unmet`) shows the needs-attention card, never a spinner and never a retry. `session.js` reads the flag
  before `classifyFailure`, in `openDesktopOnce` and in `pendingOrRefused` (which the Code app's mint also uses,
  `code.js:219`). `boot-phases.*` is unchanged (§1.1).
- **[r4] [r6] The files-held banner, both tabs.** **[r6] Round 6a settled this banner; lane U leaves it exactly as 6a
  shipped it.** r4's region-free sentence is superseded by 6a's R1-11 (one provider string, "AWS (India)", on every tab)
  and R4-02 (a held 4 or 8 vCPU computer cannot open on Free). Both copies of `standingCopy('files_on_aws')`
  (`computers.js:547-553`, `Settings/tabs/billing.js:78-83`) say exactly **"Your files are still on your AWS (India)
  computer. It opens on the Free plan with Free limits; upgrade for no session time limit."**, or, when the summary's
  placed size `computer.awsSize` is `cmp-4`/`cmp-8` (6a's "held closed"), `heldClosedText(vcpu)`: **"Your files are still
  on your {vcpu} vCPU AWS (India) computer. The Free plan can't open it at that size; upgrade to open it again."**
  (`billing-format.js:152-161`; the Computer tab's twin `computers.js:557-565`). `billing-test.mjs` pins both sentences
  (`:988`, `:1023`) and the cross-tab equality (`:1082-1083`). The Billing tab shows only this banner (`billing.js:474`)
  for files-held and **during a move**: no move card, no move action and no move sentence. During a move the standing
  stays `files_on_aws` (the placement is `aws-ec2` until the flip); after the commit the standing is `free` and the
  banner goes. The move lives on the Computer tab. The provider label is "AWS (India)" since 6a (`computers.js:515`, was
  "AWS (India) · files kept"), like the System tab's "AWS (India)" (`system-describe.js:33-36`); both are provider
  labels, not move copy, and stay unchanged. The move copy (§6.3, §6.4) still names no city or region.
- **[G3] [r4]** `computer.move.start`/`retry` answers (§5.9) render as follows. `{ok: true, move}` renders that move's card,
  in any state: a stale pre-move card's click during a move shows the move. `move_in_progress` (retry) re-reads the summary
  and shows the current move's card (`reverseMove`). Every refusal renders its §6.3 row.
- **[r4] [Stop and move my files]** (shown only after a `move_computer_running` refusal):
  1. It **first calls `computer.move.start` again**. `{ok: true, move}` → show the move card and stop nothing. Any refusal
     other than `move_computer_running` → show that refusal and stop nothing. This way, if a move started in another
     window in the meantime, `closeSandboxWindows` (`computers.js:1083`) never closes a window that shows the move.
  2. Only on `move_computer_running` again: run the tab's existing Stop (`handleStop`, `computers.js:1062-1094,1392`, the
     same confirm). Watch `computer.progress` until `stage` is `stopped`, bounded by the existing stop budget
     (`computer-progress.js:347-348`: 200 polls). Then call `computer.move.start` **once**. If that refuses again, the card
     shows that refusal.
  3. Closing the tab in between starts nothing; the pre-move card returns.
- **[r4] A stop answered `computer_moving` or `computer_move_needs_attention`** (the waiting or blocked provider's `stop`,
  §5.3; `confirmAwsStop` returns that first answer unchanged, `compute-dispatch.ts:282,292`; `/api/shell/stop` passes the
  `terminate` answer through, `app/api/shell/stop/route.ts:11`) is **not** "couldn't confirm the stop". `handleStop`
  reads `data.outcome`, re-reads the summary and shows the move card (or the needs-attention card) instead of the
  `computers.js:1087` notice.
- **[G1]** The open overlay and the Computer tab render the moving view of `computer.progress` (§5.10) as §6.4 says.
- **[minor: too-large]** The cap in copy comes from one constant, `MOVE_LIMIT_BYTES = 536870912`, exported by
  `computer-progress.js` and imported by `computers.js`. It is formatted by the shell's own MB unit (÷ 1,000,000, no decimals,
  as `formatBytes` at `computer-progress.js:69` and `moveView` at `computers.js:579`), which gives **"537 MB"**. The string
  "512 MB" appears nowhere. Lane U's shell test pins "537 MB". Lane A's `provider-reverse-store.test.ts` reads the constant
  from `computer-progress.js` and asserts it equals `EXPORT_MAX_BYTES`, the same cross-file pattern as the `MOVE_STEP_OF` test.
  **Order:** that assertion lands in the same integration as lane U's constant, or after it, never before: the constant does
  not exist until U ships it.

### 6.3 User copy per state (no city or region names, no speed or duration claims)

The "not moved" list, used verbatim wherever it says {NOT_MOVED}: **settings and programs you added on your AWS computer, saved browser sign-ins, installed packages, and build folders you can recreate (node_modules, .next, .turbo and dist, unless Git tracks them)**.

| State | Copy |
|---|---|
| files held, `moveOnOpen` true | **Your files are on your AWS computer.** The next time you open your computer, we'll first move the files in your Workspace folder to your Free computer. Not moved: {NOT_MOVED}. Your AWS computer's disk is kept for 14 days after the move. [Move my files now] |
| files held, `moveAvailable` false (r3) | **Your files are on your AWS computer.** Opening it uses your Free limits. (no move sentence, no button) |
| files held, `moveOnOpen` false | **Your files are on your AWS computer.** Opening it uses your Free limits. You can move the files in your Workspace folder to your Free computer. Not moved: {NOT_MOVED}. Your AWS computer's disk is kept for 14 days after the move. [Move my files to my Free computer] |
| **[r6]** files held, `holdOpenable` false (6a's held-closed card, `computers.js:613-616`) | 6a's card stays as its first line: `heldClosedText` (§6.2) and its [Upgrade]. With `moveAvailable` true it continues: You can move the files in your Workspace folder to your Free computer. Not moved: {NOT_MOVED}. Your AWS computer's disk is kept for 14 days after the move. [Move my files to my Free computer]. The `moveOnOpen` variant is never used for it: 6a shows no Open desktop for a held-closed computer (`computers.js:791`). With `moveAvailable` false, 6a's card is unchanged. "Opening it uses your Free limits" is never said for it. |
| `saving` | Moving your files to your Free computer. Step 1 of 4: Saving your files. |
| `copying` | Step 2 of 4: Copying your files to your Free computer. "X MB of Y GB copied" (existing `moveView`). |
| `checking` | Step 3 of 4: Checking your files. |
| `flipping` | Step 4 of 4: Switching to your Free computer. |
| `committed` | Your files are on your Free computer. Not moved: {NOT_MOVED}{skipped > 0: ", and N items that can't be copied, like links that point outside your Workspace folder"}. Your AWS disk is kept until {retainUntil date}. |
| `failed_reopened`, `retry: 'now'` (default) | We couldn't move your files. They're still on your AWS computer and nothing was deleted. [Try again] |
| `failed_reopened`, `workspace_too_large` | Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Remove some files on your AWS computer and try again, or upgrade to keep using them. [Upgrade] (Try again appears once `retry` is `now`). **r3:** "537 MB" is `MOVE_LIMIT_BYTES` (536,870,912 bytes) in the shell's MB unit (§6.2), never a literal. |
| **[r5]** `failed_reopened`, `workspace_too_large`, `holdOpenable` false | Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Upgrade to use them again. [Upgrade] (no Try again: `retry` is `'no'`, §6.1.1; the Free plan cannot open this computer's size, so no files can be removed first) |
| `failed_reopened`, `kill_switch` or `boot_unavailable` (**try later**, §5.1.1) | We couldn't start moving your files right now. They're still on your AWS computer and nothing was deleted. **[r5]** Try again later. [Try again] (time-neutral: `boot_unavailable` also covers the monthly fleet caps `global_hours_cap` and `global_egress_cap`, `admission.ts:127,129`, which no number of minutes clears) |
| `failed_reopened`, `entitlement_paid` | Your plan is active again, so your files stay on your AWS computer. (no button) |
| `failed_reopened`, `retry: 'no'` (`reopen_final`) | We couldn't move your files. They're still on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it. (no Try again) **[r5]** With `holdOpenable` false, without ", and you can keep using it". |
| `failed_needs_operator`, `openBlocked` false (**[r5]** `abort_unconfirmed`) | We couldn't finish moving your files. They're safe on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it. (no Try again; Send feedback when enabled) **[r5]** With `holdOpenable` false, without ", and you can keep using it". |
| `failed_needs_operator`, `openBlocked` true, **[r5]** `reason` `boot_unsettled` | We couldn't finish moving your files. They're safe on your AWS computer and nothing was deleted. Your computer can't open until we've checked it; we're looking into it. (no Try again; Send feedback when enabled) |
| `failed_needs_operator`, `openBlocked` true, any other reason (the commit may have been sent) | We're finishing moving your files to your Free computer. Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it. (no Try again; Send feedback when enabled) |

**Start/retry refusals (§5.9) [G3]:**

| `reason` | Copy |
|---|---|
| `move_computer_running` | **Your AWS computer is open.** Stop it first, and your files start moving to your Free computer as soon as it has stopped. [Stop and move my files] |
| `move_paused`, `move_busy`, `move_computer_unsettled` | We can't start moving your files right now. They're still on your AWS computer and nothing was deleted. **[r5]** Try again later. [Try again] |
| `move_in_progress` | (no new card: the current move's card stays) |
| `move_unavailable` | (the newest failed row's own card above) |
| `move_not_held`, `move_unsupported` | (no card / no action) |

### 6.4 The open overlay and the Computer tab during a move (lane U) **[G1]**

**Open loop (`session.js`, `desktop-window.js`, `boot-progress.js`).**
- An open answered with `computeMoving: true` (§5.3) is **a move, not a boot**. The 10-minute `MIGRATION_DEADLINE_MS`
  (`session.js:239`), the wake deadline and the 600 s `AWS_BOOT_HARD_STOP_MS` (`boot-progress.js:23`) do not apply to it, and
  `awsBootTimeoutVerdict`/`awsBootWaitVerdict` never return `budget_spent` or `fail` for it.
- The overlay watches `computer.progress` (5 s polls, as today) and re-asks the open **at most every 30 s**. Each ask is
  harmless: the reverse waiting provider never boots anything.
- The watch ends when, after this open has itself seen `operation: 'moving'` (the `seenInFlight` rule of
  `watchComputerTransition`, `computer-progress.js:359-376`):
  - `move.outcome` is `committed`, or the open stops answering `computeMoving` → re-ask the open (it now opens the Free computer);
  - `move.outcome` is `failed_reopened` or `failed_needs_operator` → show the outcome below. **Never auto-open the AWS
    computer**: under the D16 hold that boot uses Free hours at the AWS size, so the user chooses it;
  - `startedAt + budgetSeconds + 300 s` passes with no outcome → `OPENING_COPY.runningLong` and Send feedback. That is
    never a failure claim: only the server's outcome ends a move.
- `progressView` maps `operation: 'moving'` and `stage: 'moving'` before its unknown-stage return (`computer-progress.js:133`).
  `activeAws` is false in the moving view; it is never an AWS opening.
- **[r4] Outcome keying.** Whenever `move` is non-null and `move.outcome` is set, the overlay and the Computer tab choose
  the outcome **from `move.outcome` and `move.openBlocked` only, whatever `stage` says**. Terminal rows carry today's
  placement description (§5.10): `stopped` for a `failed_reopened` hold, possibly `needs_operator` for a
  `failed_needs_operator` row without `openBlocked` (**[r5]** `abort_unconfirmed` whose placement a later recovery moved; `boot_unsettled` is now open blocked), `unavailable` after a commit.
  The open-blocked card is shown **if and only if** `move.outcome === 'failed_needs_operator' && move.openBlocked === true`,
  or the open was answered `computeMoveNeedsAttention: true` (§5.3). A lane U test feeds each terminal outcome with
  each of those stages and checks the card.
- **[r4]** An open answered `computeMoveNeedsAttention: true` shows the open-blocked row below at once. There is no watch
  and no re-ask: the answer is deterministic (`preconditions_unmet`).

**Overlay copy** (status line / one sentence / bar). No countdown, no speed or duration claims.

| Moving view | Status line | Sentence | Bar |
|---|---|---|---|
| `phase` `export_boot` or `exporting` | Moving your files to your Free computer | Step 1 of 4: Saving your files. | determinate: four equal steps, time-eased by `move.expectedSeconds` from `move.startedAt`, never past the next step's floor |
| `importing` | Moving your files to your Free computer | Step 2 of 4: Copying your files. X MB of Y GB copied. (`moveView`'s units) | step 2's segment, filled by `bytesDone / bytesTotal` |
| `checking` | Moving your files to your Free computer | Step 3 of 4: Checking your files. | step 3 |
| `committing` | Moving your files to your Free computer | Step 4 of 4: Switching to your Free computer. | step 4 |
| elapsed > `move.expectedSeconds` | (unchanged) | (unchanged) | meta line `OPENING_COPY.long` ("Taking a little longer than usual") |
| outcome `committed` | Your files are on your Free computer | Opening your Free computer. | full, then the ordinary Cloudflare open |
| outcome `failed_reopened` | We couldn't move your files | They're still on your AWS computer and nothing was deleted. (`entitlement_paid`: "Your plan is active again, so your files stay on your AWS computer." `workspace_too_large`: the §6.3 sentence with "537 MB", **[r5]** its `holdOpenable` variant when false.) | none. [Open my AWS computer] re-asks the open (the D16 hold), **[r5] shown only when `move.holdOpenable` is true** (otherwise the gate refuses the open, §5.3). Send feedback when enabled. Try again for the move lives on the Computer tab card. |
| outcome `failed_needs_operator`, `move.openBlocked` false | We couldn't finish moving your files | They're safe on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it. (**[r5]** without ", and you can keep using it" when `move.holdOpenable` is false) | none. [Open my AWS computer] (**[r5]** only when `move.holdOpenable`). Send feedback. |
| outcome `failed_needs_operator`, `move.openBlocked` true, **[r5]** `move.reason` `boot_unsettled` | We couldn't finish moving your files | Your files are safe on your AWS computer and nothing was deleted. Your computer can't open until we've checked it; we're looking into it. | none. Send feedback. No retry. |
| outcome `failed_needs_operator`, `move.openBlocked` true, any other reason (or the open answered `computeMoveNeedsAttention` with no `move` read yet) | We're finishing moving your files | Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it. | none. Send feedback. No retry. **[r5]** On a bare `computeMoveNeedsAttention` answer the overlay reads `computer.progress` once and uses the `boot_unsettled` row when `move.reason` says so. |

**Computer tab.** The move card reads `billing.summary`'s **[r5]** `computer.reverseMove` (§6.1) for its copy. While the tab is open
during a move it may also poll `computer.progress` for live bytes. Both come from the same row through the same step map,
so they agree.

**[r4] Computer tab while a move is in flight** (`computer.progress` `operation: 'moving'`, or `summary.computer.reverseMove`
in a non-terminal stage):
- `computerModel` (`computers.js:448-517`): **chip** `{state: 'moving', text: 'Moving files…'}`, which takes precedence
  over every chip except `stopping` while the user's own stop is in progress. `busy` is **true** when `operation === 'moving'`
  (today it is true only for opening and stopping, `:517`). `running` and `stopped` are false (`lifecycleState` is null,
  §5.10).
- **Actions:** no Open desktop, no Stop and no Start now (`:790-792,728-731`). Rename stays; Delete is disabled (a delete
  is refused during a move, §5.3). Configuration cards stay locked (held).
- **Body:** the move card only (`moveHtml`, §6.3 copy). No transition, "Now running" or switch-failed card.
- If `computer.progress` shows `operation: 'moving'` while the summary's `reverseMove` is still null (a move started from an open
  in another window), the tab re-reads `billing.summary` once per poll until `reverseMove` appears, at most 6 times.
- `openBlocked` true: chip `{state: 'attention', text: 'Needs attention'}`, no Open, and the needs-attention card.
- A lane U test renders the tab in each phase and in each terminal outcome, with every `lifecycleState` and `stage`
  value §5.10 can send.

---

## 7. Retention and the D21 snapshot (lane O)

- After the flip, the placement row no longer exists (`placement.ts:838` deletes rows on flips). So **the committed reverse row is the only DB record of the AWS volume.** It holds `aws_volume_id`, `aws_fs_uuid`, `aws_snapshot_id` and `retain_until` (commit + 14 d, DB clock).
- **Snapshot (D21, mandatory).**
  - **Executor:** lane O ships a fenced `reverse_snapshot` lifecycle operation, modelled on the preparation machine's `createSnapshot` step (`preparation-helper.ts:83-96`, `preparation-definition.ts:40-47`). Its preconditions: the volume is `available` and unattached, owned by the account, and tagged with this computer's id.
  - **Started** by the reverse sweep for every `committed` row with `aws_snapshot_id IS NULL` that is not marked spent (**[r4]**, §7.1 Failure).
  - **Recorded** with `recordSnapshot` (once) as soon as `CreateSnapshot` returns an id. A pending snapshot is already point-in-time.
  - **Alert:** a committed row with no snapshot 1 h after commit is listed by `retention.ts` as `snapshot_missing` and logged `[reverse-move] snapshot_missing`. An operator takes it by hand (T1 does so for canary2).
  - **[r5] Its invoker (pinned).** r4 named the log line but no caller: `retention.ts` has no runtime caller at base,
    only its unit test. Lane O's `advanceReverseSnapshots` runs the listing (`listUnsnapshotted(10, 3600, {includeSpent:
    true})`, through `retention.ts`) **once per pass**, after its snapshot step and inside the same 20 s. When the listing
    is not empty it logs **one** line, `[reverse-move] snapshot_missing {count, moveIds}` (at most 10 ids). The sweep runs
    every minute, so the line repeats until the row has a snapshot or is purged (§3.4). It runs even when a region's
    deployment has no ARN, which is exactly when such rows pile up; with no 0012 the step returns at once (§3.4). Lane O's tests: a row committed 61 min ago with no snapshot
    makes the line fire with its id; a row committed 30 min ago does not; a spent row is still listed; a purged row is not.
  - Lane O ships before the app deploy (release order, §8), so every committed move gets one.

### 7.1 The `reverse_snapshot` operation (pinned) **[G4]**

| Item | Rule |
|---|---|
| **Name** | `reverse_snapshot`. It is a **separate** Standard Step Functions state machine, owned, deployed and versioned by lane O like the preparation machine (`infra/app-computers/lib/rebase-preparation.ts`). Its version ARN reaches the app on the deployment as **`reverseSnapshotStateMachineVersionArn`**, an optional deployment field. **[r5]** Lane O owns that field end to end, in every file it touches, with a pinned rollout order (§7.2). It is a deployment field, not a release field. It is **not** a new value in `LIFECYCLE_OPERATIONS` (`aws-intent.ts:183`): the placement lifecycle machine and its allowlist are unchanged. |
| **Intent** | Strict JSON with exactly these keys: `{"schemaVersion": 1, "operation": "reverse_snapshot", "jobId": "<moveId>", "moveId": "<moveId>", "computerId": "<uuid>", "region": "<the row's export_boot.region>", "accountId": "<12 digits>", "volumeId": "<the row's aws_volume_id>", "fsUuid": "<the row's aws_fs_uuid> \| null", "committedAt": "<ISO of the row's commit, state_entered_at>"}`. **[r5]** r4 hard-coded `ap-south-1`, but `AWS_REGIONS` allows up to 4 regions (`aws-config.ts:119-121`) and the flip deletes the placement row. So the region comes from the claim (`export_boot.region`, §3.1), and the deployment (account, ARN) is `cfg.deployments[region]`. A region with no deployment, or a deployment without the ARN, starts nothing: the row is listed as `snapshot_missing`. The execution input is `{schemaVersion: 1, document, digest}` with `digest = sha256(document)`, as `buildRebasePreparation` builds it (`aws-rebase-preparation.ts:23-32`). |
| **Idempotency key** | **`jobId = moveId`, so the execution name is `computer-<moveId>`** (the `EXECUTION_NAME` grammar, `aws-clients.ts:212`). A start whose name is already used counts as success (`ExecutionAlreadyExists`, `aws-clients.ts:228-247`). A Standard execution's name cannot be reused for 90 days, longer than the 14-day retention. So a lost StartExecution response, a retried start, or two sweeps never run a second execution for one move. Names are scoped to one state machine, so `computer-<moveId>` never collides with a placement job's name. |
| **EC2 dedupe inside the execution** | EC2 `CreateSnapshot` takes **no client token**. The SDK's `CreateSnapshotRequest` has only `Description`, `OutpostArn`, `VolumeId`, `TagSpecifications`, `Location` and `DryRun` (`app/node_modules/@aws-sdk/client-ec2/dist-types/models/models_2.d.ts:1969`, client-ec2 3.1140.0), and the preparation step passes only `VolumeId`, `Description` and `TagSpecifications` (`preparation-definition.ts:40-42`). So the lead's "client token derived from the move id" is the execution name above, and inside the one execution the helper dedupes as the preparation helper does (`preparation-helper.ts:83-96`): it calls create **at most once** (`createAttempted`), tags the snapshot at creation with `ezil:reverse-move = <moveId>` and `ezil:computer-id = <computerId>`, looks that tag up before creating, and resolves an uncertain create by the tag (`snapshot_ambiguous` when 2 or more exist, `snapshot_create_unconfirmed` when none exists after an attempt). |
| **Preconditions** | As above, plus `volumeId` equals the row's `aws_volume_id`. Any failure ends the execution failed with a closed code; the helper never mutates the volume. |
| **Success** | As soon as the tagged snapshot is `pending` or `completed`. `error` → failed `snapshot_error`. The output is the receipt `{schemaVersion: 1, jobId, digest, moveId, computerId, volumeId, snapshotId, snapshotState: 'pending' \| 'completed', snapshotStartedAt}`, at most 8 KiB, as the preparation receipt is (`preparation-helper.ts:104`). |
| **How the id reaches the app** | Lane O's `advanceReverseSnapshots` reads execution `computer-<moveId>` with the existing reader (`createSfnExecutionReader`, `aws-clients.ts:254`). It validates the receipt against the intent it built (digest, `moveId`, `computerId`, `volumeId`; the `validateRebaseSnapshotReceipt` pattern, `aws-rebase-preparation.ts:44-53`), then calls `recordSnapshot(m, snapshotId)`. A replay of the same id returns the row (§3.4). |
| **Which sweep starts it** | `advanceReverseSnapshots(budget)` (lane O, `provider-reverse-snapshot.ts`). Lane A's `advanceReverseMoves` calls it **first** in its pass (at most 3 rows and 20 s, §5.4), with `listUnsnapshotted(3)`, which **[r4]** leaves out spent rows. Per row: no execution yet → StartExecution; running → nothing; succeeded with a valid receipt → `recordSnapshot`; succeeded with an invalid receipt → `markSnapshotSpent(m, 'snapshot_receipt_invalid')`; FAILED, TIMED_OUT or ABORTED → `markSnapshotSpent(m, 'snapshot_failed')`. The deployment has no `reverseSnapshotStateMachineVersionArn` → nothing (the row then appears under `snapshot_missing`). |
| **Failure** | A failed, timed-out or aborted execution is **not** retried automatically: its name is spent, and a second name could create a second snapshot. **[r4]** The sweep marks the row spent with `markSnapshotSpent` (§3.4) and logs `[reverse-move] snapshot_failed`. A spent row leaves the sweep's queue, so spent rows never fill `listUnsnapshotted(3)` and starve newer commits. (r3's queue was the oldest 3 unsnapshotted rows with no other filter, so three spent rows stopped every later D21 snapshot.) It stays listed as `snapshot_missing` (`listUnsnapshotted(10, 3600, {includeSpent: true})`) until an operator snapshots by hand and records the id with the runbook statement below. `recordSnapshot` also still accepts it. **PG test (store, r4):** 3 spent rows plus 1 new row → `listUnsnapshotted(3)` returns only the new row; the `snapshot_missing` listing returns all 4 once they are 1 h old. |

```sql
-- runbook: operator_snapshot
UPDATE public.ezil_compute_reverse_moves
   SET aws_snapshot_id = '<snapshot-id>', updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id = '<move-id>'::uuid AND state = 'committed' AND aws_snapshot_id IS NULL
RETURNING id, state, aws_snapshot_id, updated_at::text AS updated_at;
```

- **Purge listing.** `retention.ts` (dry run, `retention.ts:1-13,58-64`) lists `listRetentionExpired(100)` and the
  `snapshot_missing` rows (`listUnsnapshotted(10, 3600, {includeSpent: true})`, **[r4]** spent rows included). Both are read-only (§3.4).
- **Purge.** Deletion is a separate founder-owned principal, never a workflow role. Both workflow roles deny `DeleteVolume` and `DeleteSnapshot` (rule R11).
- **[r5] Purge marker.** After deleting a row's volume and snapshot, the operator runs `operator_purged`. It sets
  `retain_until = NULL` on that committed row; the 0012 CHECK allows it (`retain_until IS NULL OR state = 'committed'`), so
  0012 is unchanged. `listRetentionExpired` already skips NULL, so more than 100 expired rows never hide newer ones behind
  rows already purged. `listUnsnapshotted` skips purged rows in both modes (store r5), so a purged row never re-enters the
  snapshot queue or the `snapshot_missing` alert. The row keeps `aws_volume_id` and `aws_snapshot_id` as history.

```sql
-- runbook: operator_purged
UPDATE public.ezil_compute_reverse_moves
   SET retain_until = NULL, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id = '<move-id>'::uuid AND state = 'committed' AND retain_until IS NOT NULL AND retain_until < clock_timestamp()
RETURNING id, state, aws_volume_id, aws_snapshot_id, retain_until, updated_at::text AS updated_at;
```
- **DLM.** `dlmRoleArn` pins `role/service-role/…` (`ops.ts:36`). Change it only after `iam get-role` confirms the path. T0 saw a DLM 12-hourly snapshot of the founder's volume (snap-053333a158f9cc895, 10-29 19:38Z), so DLM runs for at least that volume; DLM snapshots never replace the D21 snapshot.

### 7.2 The deployment field `reverseSnapshotStateMachineVersionArn` (lane O, end to end) **[r5]**

**Why it is more than two files.** The lifecycle deployment is strict on both sides, and every lifecycle intent embeds it.
- App: `LifecycleDeploymentSchema` is `.strict()` (`aws-intent.ts:81-104`). `readLifecycleDeployments` fails the whole read
  when one configured region's entry fails it (`aws-intent.ts:156-177`), so an unknown key turns AWS off. The parsed
  deployment is copied into every intent (`replaceIntent`'s `deployment`, `aws-ec2.ts:282`), and `buildLifecycleWork`
  serializes the whole intent (`aws-intent.ts:328-337`).
- Infra: one strict `LifecycleDeploymentSchema` (`infra/app-computers/lib/lifecycle/deployment.ts:84-97`) is imported by the
  lifecycle intent (`intent.ts:27`, parsed by the helper at `helper.ts:57`), the helper settings (`contract.ts:16`), the
  preparation and recovery contracts (`preparation-contract.ts:12`, `recovery-contract.ts:42`), the release manifest
  (`release-manifest.ts:24`) and the identity config (`identity.ts:31`). The helper refuses an intent with an unknown key.

**Schema rule (both sides, in the same order; `app-intent-contract.test.ts` pins the parity):**
- `reverseSnapshotStateMachineVersionArn: z.string().max(300).optional()`.
- When present it must be `arn:aws:states:<region>:<accountId>:stateMachine:ezil-<namespace>-reverse-snapshot:<version ≥ 1>`.
- That check is its **own** `superRefine` step, outside the four-key image tuple (`aws-intent.ts:106-117`). Inside the tuple,
  every deployment without the new key would fail `incomplete_image_deployment`. A deployment with the key and no image
  tuple parses, and so does one with the tuple and no key. `SourceLifecycleDeploymentSchema` (an `.extend` of the inner
  type, `aws-intent.ts:134-148`) still parses every pinned source fixture.

**Rollout order (pinned; no strict parser ever sees the key before it accepts it):**
1. **Infra first** (release step 4, §8). `deployment.ts` accepts the optional key, and every Lambda and stack that parses a
   deployment is deployed with it: the lifecycle helper, the preparation and recovery helpers, and the stacks that read
   `EZIL_LIFECYCLE_CONFIG`. If that deploy publishes a new lifecycle state machine version, the version reaches the
   deployment through the ordinary promote: `stateMachineVersionArn` is already in its tuple (`rebase_manifest.py:9-10`).
2. **App second** (release step 6). `aws-intent.ts` accepts the key. Until the env carries it, every intent is unchanged
   byte for byte.
3. **Env last** (release step 7). The region's entry in `EZIL_AWS_LIFECYCLE_DEPLOYMENTS` (the staging app secret) gains
   the key. From then on lifecycle intents carry it, and the step-1 helpers accept them.
- **Rollback.** Remove the key from the env **before** rolling the app back past step 2 or infra back past step 1. An old
  strict app turns AWS off on the key, and an old helper refuses every intent.
- **Expected side effect.** Pool hosts match the current deployment by exact JSON (`compatibleDeployment`,
  `ready-pool.ts:58-60`). Step 3 therefore makes every warm spare launched before it incompatible. The planner retires
  them as obsolete and refills once, so opens in that window are cold. Run step 3 at a quiet time. It needs no code
  change (`ready-pool.ts` is lane H's).
- Until step 3, `advanceReverseSnapshots` starts nothing and committed rows show as `snapshot_missing`. Step 3 comes
  before canary2 acceptance, so T3's row gets its snapshot.

**What does not change (evidence; lane O edits none of these):**
- **`deploy/aws/mum/json-tool.py` (lane H).** A promote deep-copies the deployment. It removes only promote-tuple keys
  that are missing from the new pair, then applies the pair (`json-tool.py:528-534`), so every other key, this one
  included, is kept as it is. Its literal-replacement list (`:543`) is for version ARNs that change with a release, and
  this machine's version does not. `deployment_tuple` checks only the four tuple keys (`rebase_manifest.py:69-78`). A
  promote's deployment comparison covers only the `public_deployment` keys (`rebase_release.py:516-519`,
  `rebase_app.py:47-50`), which do not include the new key. **So no promote needs to carry it**, and the file stays H's,
  unchanged.
- **`release-manifest.ts` and the app's strict mirror `aws-rebase-release.ts`.** The field is not a release field: lane
  O's own deploy versions the reverse-snapshot machine, not the AMI release. The release schemas
  (`rebase-release.schema.json`, `rebase-source-release.schema.json`, `additionalProperties: false`) describe release
  records, not the deployment, and never see the key.
- `LIFECYCLE_OPERATIONS` and the placement lifecycle machine (§7.1).

**IAM (lane O, `app-caller.ts`).** The app caller gets, for the reverse-snapshot machine, exactly what it has for the
lifecycle machine (`app-caller.ts:93-131`):
- `states:StartExecution` on the unqualified machine. The caller enforces the version.
- `states:DescribeExecution` and `states:GetExecutionHistory` on that machine's `computer-*` executions.
- The machine and its version in the `kms:EncryptionContext:aws:states:stateMachineArn` list of the history key it
  encrypts with.

The registration passes that version to `AppCaller`; today `bin/lifecycle.ts:28` passes only `stateMachineVersionArn`.
`iam-exact.test.ts` and the IAM snapshots change in the same commit.

---

## 8. Live proofs (T0 hypotheses, R5-8) and acceptance

| ID | Hypothesis | Status at S0 | Who proves, and how |
|---|---|---|---|
| a | canary2's history shape | **Settled at T0** (STATUS 07:36:43Z): forward migration committed 10-22 with a format-2 system head, so begin sees `headKind: 'migrated'`. The `none` shape is untested until T5. | W/A at T3; T5 for `none` (incl. the `freshProvision` context replacement, §4.4) |
| b | The volume's lower digest equals the baked lower | open | H: the marker's `lowerImageDigest` equals the manifest's; console `guard_result ok` at the export boot |
| b2 | The promoted lower has `/usr/bin/python3` and `/usr/bin/git`, which the codec needs (`workspace-snapshot-script.ts:1,103`) | open | H: a static check of the lower at bake time, before H ships |
| c | The export boot enrolls as an ordinary STARTING/MOUNTING row and never reaches RUNNING | code-confirmed (`placement.ts:1408`) | A: enroll log line; the EC2 tag `ezil:generation` = N+1; the row stays MOUNTING until `releaseExportBoot` |
| d | Wake path for a STOPPED Free row | code: cold replace (`aws-ec2.ts:498-500`) | A: lifecycle operation `replace`; the volume is `available` before the claim |
| e | Idle stop vs poll cadence; capture time for the real workspace and for 512 MiB | open | H: status timestamps; no idle stop while `capturing` or `ready` within the hold |
| e2 | Host → Worker → R2 throughput ≥ 0.5 MiB/s (§5.4) | open | H+W: bytes per pull and per pass on the T3 move; below the floor → §5.4 changes first |
| f | Caps, epochs and usage never touch the export boot | design (§5.2) | A: `ezil_billing_compute_epochs` and `ezil_compute_usage` have 0 rows for the computer from the move start |
| g | canary2's DO resolves the store to `r2` (pin or `EZIL_WORKSPACE_STORE`), and its `wctx.prefix` equals the P derivation (§4.1: `${computerId}/branches/main`, `SANDBOX_WORKSPACE_S3_PREFIX` unset) | open | W: a read-only DO probe before T2; `s3` → v1 refuses `store_unsupported` and this contract changes first |
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
2. AMI bake and promote-canary (H): the export op (§2) and **[r5]** the host halves of the AMI train (§2.8).
3. Worker deploy (W). The routes stay unused until the app calls them.
4. Lane O infra (O, plus a founder IAM step): the snapshot executor, the app-caller grants and **[r5]** `deployment.ts`
   accepting the optional field in every infra parser (§7.2 step 1).
5. **Apply 0012 on staging** (`billing-staging-schema.mjs plan`, then `apply --yes --target aws-preview --expect-system-id <digits>`).
6. App deploy with the user and open triggers (A+U). Only held `files_on_aws` placements are affected; founder-owned accounts get no open trigger.
   **[r5]** This app's `aws-intent.ts` accepts the field (§7.2 step 2). The C3 app half (§2.8) ships here or later, never
   before step 2's AMI.
7. **[r5]** The deployment env value gains `reverseSnapshotStateMachineVersionArn`, only once step 6 is live (§7.2 step 3).
8. canary2 acceptance.
9. DLM and the retention purge runbook (O).

**[r5]** No cron step: v1 has no cron trigger (§9).

---

## 9. Out of scope for v1

- The S3 and migrating workspace stores (`store_unsupported`).
- Anything outside `/workspace` (D-4).
- Automatic retries after any failure (the open trigger never re-creates after `failed_*`).
- **[r5] A cron trigger.** No scheduled scan creates reverse rows in v1. r4's `'cron'` started-by value, its §5.9 bullet
  and its release step ("Cron trigger") are withdrawn. The 0012 CHECK still admits `'cron'` (0012 is unchanged), the store
  still accepts it, and no v1 caller passes it. Lane A's trigger tests assert that only `'user'` and `'open'` are written.

## 10. Changes in r2 (review of `dc362e53`)

1. Export-boot placement path pinned with **no new edges**. The receipts get an export-boot mode, keyed on `readByExportBoot` (any state except `committed`, same volume), instead of a whole-function skip. It suppresses the MOUNTING-time usage open and RUNNING. The release reuses the existing enrollment-host-retire chain, which lands STOPPED/`INSTANCE_LOST` at N+1/E+1 (§5.2).
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

## 11. Changes in r3 (S0 verifier's contract gaps and blind spots)

Each row names the section that closes the gap. Where the lead's decision could not be pinned as worded, the row says so
and gives the closest workable rule.

| Gap | Section(s) | Resolution |
|---|---|---|
| **G1** BLOCKER: progress ownership during a move | §5.10, §5.3 (waiting answer), §6.4, §1.1 | `computer.progress` gets a `moving` view while a reverse row is in flight: `operation: 'moving'`, new stage `moving`, phases `export_boot`/`exporting`/`importing`/`checking`/`committing`, `expectedSeconds`, `budgetSeconds = 9300`. It never says `opening`. No export-boot placement state gives `needsOperator` or the opening budget, and no opening record is stamped. `move` is an additive, optional object, so old shells return null for the unknown stage. The reverse waiting answer is `computer_moving` with `computeMoving` (never `computer_migrating`, whose 10-minute shell clock would fail every move). Lane A owns `progress.ts`; lane U owns the rendering. §1.1 gives every file one lane. |
| **G2** MAJOR: claim composition | §5.1.1, §5.1.2, §5.5 | **The decision as worded is unworkable.** `placement.test.ts:505-518` fails CI if any file other than `admission.ts` and `placement.ts` names `mintAdmissionTicket` (R-PL F3). Closest workable rule: the same steps, in one transaction, in a new `admitExportBoot` in `admission.ts` (lane A): admission lock → computer lock → counters → `decideAdmission` with `user_hours_cap` and `user_egress_cap` removed → mint → `leasePlacement(replace)` → `recordExportBoot` over the same `tx`. Capacity limits apply. `user_has_aws_computer` passes for the same computer (the counter excludes it). The refusal table is pinned; the try-later codes are exactly `kill_switch` and `boot_unavailable`. The new final code is `boot_refused`. The boot keeps the placement's instance type. |
| **G3** MAJOR: move vs a running hold session | §5.9, §6.2, §6.3 | `computer.move.start`/`retry` return `move_computer_running` (a value, like `switchConfiguration`) while the placement is RUNNING/LEASED/STARTING/MOUNTING/DRAINING/STOPPING or has a job. The copy says stop first; [Stop and move my files] stops, waits for `stopped`, then starts once. The closed refusal union is pinned. The next-open trigger fires only from STOPPED and is unaffected. |
| **G4** MAJOR: lane O store reads and the snapshot operation | §3.4, §3.2, §7.1, §1.1 | Shipped in r3: `listUnsnapshotted`, `listRetentionExpired`, and `recordSnapshot` as a CAS on `aws_snapshot_id IS NULL` (replay-safe), with PG tests. `reverse_snapshot` is pinned: a separate machine; strict intent; idempotency key = execution name `computer-<moveId>`. EC2 `CreateSnapshot` has no client token, so inside the execution the helper creates once and dedupes by the `ezil:reverse-move` tag. The id reaches the app through the execution receipt; the sweep's snapshot step (lane O) starts it, called first by lane A's driver. **Lane A is the only writer of the store after r3.** |
| minor: P | §4.1 | `P = ${computerId}/branches/main`, with evidence; v1 never imports under a deployment-wide `SANDBOX_WORKSPACE_S3_PREFIX`. |
| minor: flip walk | §5.6 step 3 | STOPPED → RETIRING → RETIRED → DELETE, as `flipPlacementToAws`. The new Cloudflare row has `generation 1`, `lease_epoch 0`, store `r2` and state `STOPPED`, the same as `pinCloudflarePlacement`'s. |
| minor: `operator_cleared` | §5.5.1, §3.2, §7.1 | Runbook SQL, not a store method: `operator_released`, `clear_commit_sent`, `operator_cleared` and `operator_snapshot`. Each is guarded and bumps `updated_at`. The store's PG suite runs the blocks verbatim from this file. |
| minor: clocks | §3.1, §3.4, §5.4, §6.1 | The store has no app clock: `import_progress.first/last` are PostgreSQL's, and rows carry DB-computed `ages`. Every deadline compares DB now with a DB-written anchor. `booting` is anchored on its own `state_entered_at`; `claimedAt` is informational. 24 h visibility uses `ages.stateEntered`. |
| minor: sweep position | §5.4 | `advanceReverseMoves` runs **after `drain()`** in both handler paths, does nothing after handler start + 150 s, and has its own 90 s budget, so the worst case is 240 s. The snapshot step runs first in that budget. |
| minor: too-large copy | §6.2, §6.3, §6.4 | "537 MB" is `MOVE_LIMIT_BYTES` (536,870,912) in the shell's own MB unit; "512 MB" appears nowhere. A cross-file test pins the constant against `EXPORT_MAX_BYTES`. |
| minor: export path digest | §2.2 | The sha256 is over the exact body bytes the Worker sends. The edge hashes before parsing and never re-serializes; it checks the closed key set and refuses duplicate keys. |
| fold-in: open-overlay copy | §6.4 | The overlay copy per phase and per outcome. The open loop treats `computeMoving` as a move (no 10-minute or 600 s clock), re-asks at most every 30 s, and never auto-opens the AWS computer after a failure. |
| r3 review: production has no 0012 | §3.4, §5.9, §6.1, §6.2, §6.3 | The sweep and the snapshot step probe first and never throw out of the handler. Start/retry answer `move_unsupported`. `moveAvailable` (false with no 0012 or the kill switch on) gates every move action, so production users see no button that cannot work. |
| r3 review: the EC2 client token | §7.1 | Checked against the SDK on disk: `CreateSnapshotRequest` has no `ClientToken` (`models_2.d.ts:1969`, client-ec2 3.1140.0). The idempotency key stays the execution name, with the tag as the EC2 dedupe. |
| blind spot: CAS `state` predicate (m3a survived) | §5.5.1, store PG test | A new PG test changes `state` by hand without bumping `updated_at`; the stale writer must lose. With the `state =` predicate removed, that test fails. |
| blind spot: `billing-test-db.sh` now applies 0012 for every PG suite | — | r3 ran the three table-enumerating suites against a DB built by `billing-test-db.sh` (journal 0000–0007 and 0012): `feedback/ingest.pg` 4/4, `rebase.pg` 15/15, `ready-pool.pg` 167/167, 0 skipped. Each filters by table name, so 0012 does not disturb them. |

## 12. Changes in r4 (review of r3, `4abd237a`)

Each row names the section that closes the finding. "Proposed" means the reviewer's proposed fix, adopted unless the row
says otherwise.

| Finding | Section(s) | Resolution |
|---|---|---|
| **major** (A+U): start/retry ran the placement checks before the holding-row check, so a stale card's click mid-move answered `move_computer_running`, `move_computer_unsettled` or `move_paused` | §5.9, §6.2 | The holding-row check is now step 2, right after `move_unsupported`. start returns `{ok: true, move}` for the holding row in every state, with the kill switch on or off; retry answers `move_in_progress`. The placement checks run only when no row holds. **Deviation from the proposed order:** `move_unavailable` comes before `move_computer_running`/`move_computer_unsettled`. Otherwise the "stop first" copy would promise a move that cannot start. [Stop and move my files] calls start again before stopping. A stop answered `computer_moving`/`computer_move_needs_attention` shows the move card, not "couldn't confirm the stop". Lane A tests every in-flight state and the kill switch mid-move. |
| **major** (A): image-rebase reservations and reverse moves did not exclude each other, and `ImageJobConflictError` was unmapped | §5.2.1, §5.1.1 step 4, §5.4, §5.5, §5.9, §1.1 | `aws-rebase-store.ts` `reserve` calls `reverseMoveHolds` after its migrations check, under the same computer lock. Lane A owns that one edit and `rebase.pg`. `admitExportBoot` maps the error to `cas_conflict` (wait); `requested` at the deadline → `computer_busy`; start/retry → `move_computer_unsettled`. In `booting` … `flipping` a reservation is impossible, with the argument written down; lane A tests it. |
| **major** (A): lane A could not implement the summary fields; `billing.ts` was unowned and no computer was chosen | §6.1.1, §1.1 | `billing.ts` (summary reads, `userPlacement`) moves to lane A. The move computer, first match: the holding row; then the `aws-ec2` placement; then the newest visible terminal row. No new store read: `readByComputer` per live computer. The new pure `reverseMove` builder input is pinned, and so are `retry` (incl. `after_aws_session` from `leaseEpoch`), `openBlocked`, `moveOnOpen` and `moveAvailable`. |
| **major** (O+A): one spent snapshot execution per row could stop every later D21 snapshot | §3.2, §3.4, §7, §7.1 | **Store, shipped in r4:** `markSnapshotSpent` (CAS, idempotent, first reason wins) and `listUnsnapshotted`'s spent filter (`{includeSpent}` for the `snapshot_missing` listing). The PG test proves that 3 spent rows plus 1 new row give `[new]`. Two mutants (filter removed; CAS without `last_error IS NULL`) each fail it. A committed row's `last_error` is never shown. **r4 is the last S0 edit to the store; lane A is its only writer from r4 on** (§11's "after r3" is superseded). |
| minor (U): the Billing tab's copy of `standingCopy` keeps the region; `billing.js` was unowned | §6.2, §1.1 | `tabs/billing.js` and `billing-test.mjs` move to lane U. Both copies of `standingCopy('files_on_aws')` drop "(India)" to the same pinned sentence; the cross-tab equality test stays. The Billing tab shows only that banner, for files-held and during a move. **Accepted as is:** the provider label "AWS (India) · files kept" and the System tab's "AWS (India)" are round-4 provider labels, not move copy. |
| minor (A+U): `computer_move_needs_attention` was a thrown `PRECONDITION_FAILED` | §5.3, §6.2, §6.4, §1.1 | A **reverse blocked provider** answers as a value: `errorCode: 'preconditions_unmet'`, `retryable: false`, and the dispatch flag `computeMoveNeedsAttention`. The shell reads the flag before `classifyFailure`; `boot-phases.*` and `code.js` stay read-only. Old shells get the generic deterministic copy with no silent re-ask (disclosed). `computer.delete` is refused during a move or while open-blocked, as for `computer_migrating` today. |
| minor (A): the `requested` deadline outcome could not be decided from the row | §5.1.1, §5.4, §5.5 | One rule, decided from the deadline pass only. If this pass's placement read was not claimable (not STOPPED, a job, or `ImageJobConflictError`) → `computer_busy`. Otherwise this pass's claim was refused → `boot_unavailable`. All three sections say the same. |
| minor (A): fleet-wide `duplicate_placement` and deployment-wide `region_not_configured` were per-move final failures | §5.1.1, §5.5 | They now wait like capacity refusals, end as `boot_unavailable` (try later) at the deadline, and log `[reverse-move] anomaly`. `boot_refused` keeps only `user_has_aws_computer`, `computer_not_owned` and `computer_deleted`. The `operator_cleared` runbook list is unchanged. |
| minor (U+A): the moving view passed the export boot's `lifecycleState` through | §5.10, §6.4 | `lifecycleState: null` in the moving view; the real state is `move.placementState` (diagnostics only). The Computer tab during a move is pinned: chip "Moving files…", `busy` true, no Open/Stop/Start, move card only. |
| minor (U): overlay rules keyed partly on `stage`, which terminal rows do not set from the move | §5.10, §6.4 | Whenever `move.outcome` is set, the outcome is keyed on `move.outcome` + `move.openBlocked` only. The open-blocked card shows if and only if both `failed_needs_operator` and `openBlocked` hold (or the open answered `computeMoveNeedsAttention`). A lane U test feeds each outcome with each stage. |
| fold-in: `billing-test-db.sh` applies 0012 for every PG suite | — | r4 re-ran the suites against its own DB (`billing-test-db.sh`, journal 0000–0007 and 0012), the three table-enumerating ones among them: `feedback/ingest.pg` 4/4, `rebase.pg` 15/15, `ready-pool.pg` 167/167. The same run passed all 8 PG files, 239/239, 0 skipped. |

r4 saw the review's findings only up to the tenth; §12.1 (r5) dispositions all 28.

### 12.1 r5: every finding of the r3 review, and every r4 verifier gap **[r5]**

Numbers are the review's own order (1-based; the first ten are r4's rows above). **already** = fixed at `6c405fee` (r4),
**fixed** = fixed in r5, **accepted** = kept with the reason given. Store and test changes are r5's commits on this branch.

| # | Finding (severity, lane) | Disposition | Section(s) | Note |
|---|---|---|---|---|
| 1 | §5.9 order: placement checks before the holding row (major, A+U) | already | §5.9, §6.2 | r4 row 1. Its recorded deviation stands: `move_unavailable` before `move_computer_running`/`move_computer_unsettled`. |
| 2 | Image-rebase reservations vs reverse moves; `ImageJobConflictError` unmapped (major, A) | already | §5.2.1, §5.1.1 step 4, §5.9 | r4 row 2. |
| 3 | Summary fields not implementable; `billing.ts` unowned; no move computer (major, A) | already | §6.1.1, §1.1 | r4 row 3. r5 moves the carrier to `reverseMove` (#12). |
| 4 | One spent snapshot execution starves later D21 snapshots (major, O+A) | already | §3.4, §7.1 | r4 row 4 (store `markSnapshotSpent`). |
| 5 | Billing tab's `standingCopy` keeps the region; `billing.js` unowned (minor, U) | already | §6.2, §1.1 | r4 row 5. |
| 6 | `computer_move_needs_attention` thrown as a tRPC error (minor, A+U) | already | §5.3, §6.2 | r4 row 6 (blocked provider, a value). |
| 7 | `requested` deadline outcome not decidable from the row (minor, A) | already | §5.1.1, §5.4, §5.5 | r4 row 7. r5 adds the open epoch and `move_capacity` to the same rule. |
| 8 | Fleet-wide `duplicate_placement`/`region_not_configured` were final (minor, A) | already | §5.1.1, §5.5 | r4 row 8. |
| 9 | Moving view passed the export boot's `lifecycleState` (minor, U+A) | already | §5.10, §6.4 | r4 row 9. |
| 10 | Overlay keyed terminal outcomes on `stage` (minor, U) | already | §5.10, §6.4 | r4 row 10. r5 updates its example: `boot_unsettled` is now open blocked. |
| 11 | Try-later copy promises minutes for monthly caps (minor, U) | fixed | §6.3 | Every try-later sentence is time-neutral ("Try again later."). The vocabulary is not split: one code, one honest sentence. |
| 12 | Old cached shells render the now non-null summary move; [Try again] calls `switchTo` (minor, U+A) | fixed | §6.1, §6.1.1, §6.2, §6.4 | The move rides the new key `summary.computer.reverseMove`; `computer.move` stays null, so the dormant card never renders. |
| 13 | `snapshot_missing` alert has no caller (minor, O) | fixed | §7, §1.1 | `advanceReverseSnapshots` runs the listing once per pass and logs one line; lane O tests it. |
| 14 | Billing start gate runs before the reverse waiting answer (major, A+U) | fixed | §5.3, §5.5, §6.1.1, §6.3, §6.4 | All four open routes answer `routed.reverse` right after `routeComputer`. `holdOpenable` drives the retry and copy of a computer the hold cannot open (`workspace_too_large` → `retry: 'no'`, Upgrade only; no [Open my AWS computer]). |
| 15 | Compensation's "settled" misses the generation rollback (major, A) | fixed | §5.7, §5.1.2, §5.5 | Settled = STOPPED, no job, the claim's volume, epoch ≥ E+1, generation N or N+1. A refused replace runs `settleReplacementGeneration` first. The flip stays strict at N+1/E+1. |
| 16 | `reverseSnapshotStateMachineVersionArn` in strict schemas; release order (major, O) | fixed | §7.2, §1.1, §8 | Lead decision: lane O owns it end to end; infra accepts, then the app, then the env; rollback removes the key first. **Narrowed, with reason:** `release-manifest.ts` and `aws-rebase-release.ts` leave lane O's list, because the field is not a release field. |
| 17 | Same as #1 (major, A+U) | already | §5.9 | **Accepted deviation from its proposed order** (`move_not_held` before the holding row): r4 checks the holding row first. A holding row with the same owner is the user's own move, and showing it is right even if the standing changed meanwhile (for example a resubscribe while `failed_needs_operator`). Another owner's row answers `move_not_held` from that same step. |
| 18 | Same as #4 (major, O+A) | already | §3.4, §7.1 | — |
| 19 | Same as #3 (minor, A) | already | §6.1.1, §1.1 | — |
| 20 | The reverse waiting provider's `kind` is unpinned (minor, A) | fixed | §5.3 | Both reverse providers are `kind: 'aws-ec2'` with a `reverse` marker; the delete refusal relies on it. |
| 21 | Same as #8 (minor, A) | already | §5.1.1, §5.5 | — |
| 22 | "Open works" for `boot_unsettled` is false (minor, A+U) | fixed | §5.3, §5.5, §5.5.1, §5.7, §5.10, §6.1.1, §6.3, §6.4 | `boot_unsettled` is open blocked, with its own copy; the release runbook settles the placement first. `abort_unconfirmed` is written only after the placement settled, so its "Open works" is true. |
| 23 | Same as #9 (minor, U) | already | §5.10, §6.4 | — |
| 24 | The volume's region is never recorded (minor, O+A) | fixed | §3.1, §5.1.1 step 8, §7.1; store | `export_boot.region`, required and kept (store r5, unit and PG tests; a mutant without the keep-check fails). The snapshot intent's region and deployment come from it. |
| 25 | A stale open epoch would be billed across the move (minor, A) | fixed | §5.1.1, §5.4, §5.5 | With metering active, an open epoch makes the placement not claimable (wait; `computer_busy` at the deadline). |
| 26 | Throughput arithmetic overstated chunks per pass (minor, A) | fixed | §5.4, §5.1.1 step 5b, §3.4 | Concurrent per-row drive, `claimStale(10)` with active rows first (lane A's store change), at most 3 moves past `requested`. At least 20 chunks per row per pass at 0.5 MiB/s: about 26 min worst case against 60. |
| 27 | `listRetentionExpired` has no purge marker (minor, O+A) | fixed | §7, §3.1, §3.4; store | Runbook `operator_purged` sets `retain_until = NULL` (0012 unchanged). `listUnsnapshotted` skips purged rows; PG test and mutant. |
| 28 | The §5.1.2 parity test only holds when the wake builds a replace (minor, A) | fixed | §5.1.2 | Fixture: STOPPED with `INSTANCE_LOST`, non-pool deployment; a second case with `wakeMode: 'replace'`. |

| r4 verifier gap | Disposition | Section(s) | Note |
|---|---|---|---|
| AMI train (C3, F11, `pool_desktop_not_ready`) had no owner (MAJOR) | fixed | §2.8, §1.1, §8 | Lane H owns the host files and the pool/C3 app files no other lane owns; the seams with A (`aws-receipts.ts`, `placement.ts`, the `pool-replenish` route) are pinned. F11's file set is provisional and diagnosis comes first; a cause outside it changes §2.8 first. |
| Deployment field: strict parsers and unowned files (MAJOR) | fixed | §7.2, §1.1, §8 | As #16. Every infra parser imports one `deployment.ts`; the pool refill after the env change is expected and disclosed. |
| Lane O IAM: no file named; does a promote need `json-tool.py`? (MINOR) | fixed | §7.2, §1.1 | `app-caller.ts`, its tests and snapshots, and the registration in `bin/lifecycle.ts` and `computer-lifecycle.ts` are O's. No promote needs to carry the key (evidence in §7.2), so `json-tool.py` stays H's, unchanged. |
| §5.5 `commit{verifyOnly}` `other` lacked `worker_conflict` (MINOR) | fixed | §5.5 | Same note as `begin` and `pull`. |
| Cron still in v1 (MINOR) | fixed | D-5, §3.1, §3.2, §5.9, §5.9.1, §8, §9 | Moved to §9. The 0012 CHECK keeps `'cron'` (digest registered); no v1 code writes it. |
| §5.2 actor routes unowned (MINOR) | fixed | §1.1, §5.2 | Lane A owns those route and handler files and their tests. |
| Clock rule not mutation-proven: C4, C5, C6 survived (TEST GAP, blocking) | fixed | store PG test | Faked app clock (2001) around `recordImportProgress`, `advance('flipping')` and `finish`. C4, C5 and C6 each fail it (assertion failures, run in r5). |
| `listRetentionExpired` boundary unpinned: R1b survived (TEST GAP) | fixed | store PG test | A committed row expiring 1 minute from now must not be listed; R1b fails it (run in r5). |

**r4 verifier blind spots, noted (not findings):**
- The SDK drift guard needs `computer.move` to be a nested router: pinned in §5.9.
- **Accepted:** the System tab (`system.describe`) still describes the export boot's placement during a move. It is a
  diagnostics view, not move copy, and no lane owns it in Phase B; the Computer tab and the overlay carry the move (§6.4).
- `billing-placement.pg`, `ai-credit-outbox.pg`, `processor-v2.pg`, `compute-access.pg` and the shell, Worker and SDK
  suites are outside this store change; r5's gates are listed in its handoff.

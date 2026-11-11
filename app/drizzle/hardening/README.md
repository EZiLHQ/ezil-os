# Pending reviewed migrations: 0022, 0023, 0024 and 0025

These four files add the EZiL MCP delegation replay ledger (`0022_delegation_replay.sql`), the
editor-bridge session tables (`0023_agent_sessions.sql`), the MCP control rows
(`0024_control_operations.sql`) and the editor-bridge protocol 2 state (`0025_editor_controls.sql`: nullable
`ADD COLUMN`s only, for the editor's catalog, each session's runtime model, which sessions OS created, and the
delivery state of a create or configure). See `docs/MCP-SESSION-CONTROLS.md`. All four are written in the
production migration grammar (`docs/production-migrations.md`, "Adding a reviewed migration"): approved
types, unique and plain indexes, RLS on, grants revoked from `public`, `anon` and `authenticated`. They have
no defaults, keys, checks or foreign keys: the application supplies every id, time and status
(`app/src/server/agent-session/store.ts`, `control-sync.ts`, `control-store.ts`,
`app/src/server/api/delegation-store.ts`).

## Status

**Not applied anywhere, and not yet executable by the production engine.**

| Runner | Status |
| --- | --- |
| Drizzle (`drizzle-kit migrate`) | Registered in `meta/_journal.json` as `hardening/0022_delegation_replay` to `hardening/0025_editor_controls`. |
| Production engine (`.github/scripts/production-migrations.mjs`) | Listed in `.github/production-migrations.json` as `snapshot` sources, which the engine never executes. **Registering a snapshot applies nothing.** |

The production engine needs each forward migration as a `migrations[]` entry (source `kind: "migration"`) with
`before` and `after` catalog digests. These must be *observed* on a disposable database that carries
production's schema metadata, using the same PostgreSQL major version, roles and extensions. They cannot be
guessed, and they cannot be derived from a local rehearsal.

## Deployment gate (read first)

A journal entry or a `snapshot` source is **not** a live apply. As committed, `migrations[]` in
`.github/production-migrations.json` is EMPTY and 0022–0025 are `snapshot` sources, so the production engine
executes none of them. Until the chain below is executable AND applied to the target, do not deploy this
code and do not set any flag: the new procedures and the sync passes read and write tables and columns that
would not exist.

Gate checklist, in order (the release owner; nothing here is done by the code branch):
1. `plan` against the target is clean (no drift from the reviewed baseline).
2. The observed `before`/`after` digests for 0022–0025 exist, captured on a disposable database restored from
   the target's schema metadata (`capture-migration-digests.mjs`, below). The digests in this branch's tests
   are local rehearsal digests and are not usable.
3. The manifest has the four sources as `kind: "migration"` and four `migrations[]` entries; `validate` passes.
4. The authorized apply path has run on the target, and `plan` shows nothing pending.
5. Only then: deploy, then the flags below.

## Deploy order and flags

1. Apply the migrations through the production engine (below) BEFORE deploying this code: the new
   `agentSession.models/settings/create/configure/control` and `computer.start` procedures read and write the
   new tables and columns (ordinary procedures, owner-scoped; the MCP flags gate only the delegated path), and
   fail on a missing table or column.
2. Deploy the code. With every flag unset nothing changes for the editor bridge: protocol 1 runs the exact
   statements it always did (the only addition on that path is the in-transaction computer ownership lock).
3. `EZIL_EDITOR_BRIDGE=enabled` (already how the bridge is turned on) lets the editor sync; then set
   `EZIL_EDITOR_BRIDGE_CONTROLS=enabled` (only after 0025 is applied) so OS answers sync protocol 2 and acts on
   it. Turn it off and a window that already upgraded keeps syncing, handled and answered as protocol 1.
4. The MCP's own `SESSION_TOOLS` / `SESSION_CONTROLS` and `EZIL_DELEGATION_*` / `EZIL_OS_BRIDGE_URL` stay off
   until the release owner enables them.

The deploy order is a human step, not an enforced one.

## Proven locally

Proven by `app/src/server/agent-session/migrations.pg.test.ts` on throwaway databases:

- All four files pass the engine's `additiveSQL` grammar.
- The Drizzle migrator applies the whole journal, including all four files, to a clean database. A second run
  is a no-op. RLS is on, there are no grants to the public roles, and 0025's 17 columns are nullable with no
  default.
- The engine's real `applySQL` transaction applies all four as a four-entry chain:
  - it uses digests observed on a local rehearsal database (they prove the files and the chain, not the
    production digests);
  - a second run is a no-op;
  - a drifted catalog is refused with nothing created.

## For the release owner, to make them executable

First run the read-only `node .github/scripts/production-migrations.mjs plan` against staging, then
production. The baseline was captured on 2026-09-29, and 0019–0021 are also snapshot sources. If any of
0022–0025 (or 0019–0021) was applied out of band, the live catalog has drifted from the expected digest and
the chain cannot proceed until that is reconciled through review. `plan` shows this in one call.

Capture tool (does the steps below; it changes no file and no database other than the disposable one you point it at):

    DISPOSABLE_DATABASE_URL=postgres://... node app/drizzle/hardening/capture-migration-digests.mjs --i-confirm-disposable --out candidate.json

It refuses (exit 2) unless the database's catalog digest is the manifest's expected one, so a drifted target is
found before anything runs. `--rehearsal` skips only that check, for a local throwaway database, and labels its
output as not usable. Its output is exactly the `sources` kind flips and the `migrations[]` entries. A test
(`migrations.pg.test.ts`) feeds that output to the real engine and checks it applies to the same final digest.

Or by hand, on a disposable database restored from the target's schema metadata, never the target itself:

1. Record `before` for 0022: the catalog digest from the engine's `catalogSQL(['public'])`. It must equal the
   manifest's current expected digest (`initialCatalog.digest`, or the last applied `after`).
2. Execute `0022_delegation_replay.sql` and record `after`. That value is also 0023's `before`.
3. Execute `0023_agent_sessions.sql` and record its `after` (0024's `before`).
4. Execute `0024_control_operations.sql` and record its `after` (0025's `before`).
5. Execute `0025_editor_controls.sql` and record its `after`.
6. In `.github/production-migrations.json`:
   - change all four sources to `"kind": "migration"`;
   - append, in order, `{ "id", "path", "sha256", "before", "after" }` for `0022-delegation-replay`,
     `0023-agent-sessions`, `0024-control-operations` and `0025-editor-controls`.
7. Run `node .github/scripts/production-migrations.mjs validate`.

Production then applies them only through the authorized apply path. Account for the reviewed `ensure_rls`
event trigger in the observed catalog: it also enables RLS, which these files already request. Hand back the
staging `before`/`after` digests for all four steps: they are the release input; nothing in this branch
contains them.

## U6 source handoff: guarded executable registration

`prepare-migration-manifest.mjs` converts the capture tool's reviewed non-rehearsal
observations into a complete executable manifest candidate. It makes no database
connection and does not replace the active manifest:

    node app/drizzle/hardening/prepare-migration-manifest.mjs capture.json reviewed-manifest.json --reviewed-observations

It refuses rehearsal data, partial chains, a stale baseline, changed SQL, broken
catalog links and duplicate registration. It preserves the current manifest's
other sources, baseline, event-trigger approvals and workflow approvals. The
production engine still enforces SQL checksums, additive grammar, catalog drift,
transactional application and authorized workflow execution. A JSON observation
is not itself proof of provenance: the coordinator must review its capture origin.

No target-derived observations were provided to this source-only session. Thus
0022–0025 remain snapshots in the active manifest; fabricated local test digests
must never be promoted. The local tests exercise an executable four-entry chain,
including replay/no-op and drift refusal. The remaining release input is the
reviewed target-schema capture, not more SQL implementation.

Run the PostgreSQL suites with `--fileParallelism=false` when they share a single
throwaway database. The delegation refusal test temporarily renames the replay
table; concurrent suites would correctly fail authentication during that interval.

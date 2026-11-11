# R2: protocol downgrade must not renew an old effort observation

Source-only; no SQL execution, fixture approval or target application. 0026 remains an unapplied proposal. Existing 0022–25, production engine/manifest and earlier guard bytes remain unchanged.

Concrete schema revision: add nullable `ezil_agent_sessions.effort_observed_at timestamptz` to 0026, alongside its two previously proposed values. Only protocol-3 snapshots/create/configure readbacks write it. The reader requires `effort_observed_at = model_at AND effort_observed_at >= seen_at`. Missing witness (including pre-column schema), later legacy model/configure observation or later protocol-1 session observation produces null effort, never an inferred default. A later heartbeat negotiating protocol 3 cannot renew either observation. Fresh joint protocol-3 observations restore readback. Legacy model-only freshness/control semantics stay unchanged, and legacy SQL never needs to name the new column.

The timestamp uses the same database clock value as the model observation, in the same owner-locked sync transaction. Existing owner/attempt/replay/idempotency fences are unchanged. Original raw values can remain stored but cannot be presented as fresh effort without their witness. No user/model text is filtered.

## Real PostgreSQL tests prepared for root

Four new cases in `app/src/server/agent-session/control.pg.test.ts`, under `protocol3 observed effort PostgreSQL regression`, use real PostgreSQL, signed editor sync and delegated tRPC routes/stores. Only editor/model input and start collaborators are synthetic:

1. Protocol 3 A/high → protocol-2 B model snapshot → protocol-3 heartbeat without sessions: effort unknown until B/low joint observation.
2. Protocol 3 → protocol-1 session snapshot → protocol-3 heartbeat: effort unknown until joint observation.
3. Protocol 3 → protocol-2 model-only configure with real delivered/applied report → protocol-3 heartbeat: model remains fresh, effort unknown until joint observation.
4. Protocol-3 NEW create and configure persist/read effective settings, then send/completion roundtrip persists and exposes operation selected_effort.

Root may run, only against its explicitly disposable local fixture, from app:

```
node node_modules/vitest/vitest.mjs run src/server/agent-session/control.pg.test.ts -t 'protocol3 observed effort PostgreSQL regression'
```

Supply the separately controlled DELEGATION_TEST_DATABASE_URL; none was inspected or used here. For the prior 76 cases plus these four, run control.pg.test.ts and chain.pg.test.ts together on that fixture. A prior partial two-column 0026 fixture now refuses setup explicitly; no automatic repair is provided.

## Actual source validation

- App typecheck `node node_modules/typescript/bin/tsc --noEmit --incremental false`: passed.
- With DELEGATION_TEST_DATABASE_URL unset, `effort-contract.test.ts` passed 4/4; `control.pg.test.ts` collected all 74 cases and SKIPPED them (70 previous plus 4 new). These are not database passes. The six existing chain cases were not rerun.
- Unchanged production engine additiveSQL accepts the revised 0026 source. An initial equivalent `timestamp with time zone` spelling was rejected by its restricted grammar; changed to the already-approved `timestamptz` spelling. No parser weakening or SQL execution.

Root's real PG17 execution and native persistence tests remain required before source acceptance is upgraded to staging readiness. No build, flags, deployment or approval record was created.

# 0026 session effort — source proposal only

Adds two nullable observed values: `public.ezil_agent_sessions.effort text` and `public.ezil_agent_operations.selected_effort text`. Existing 0025 requested/effective control effort columns are reused. Existing model_at timestamps session model/effort together. Null means no observation, never a guessed default. No data backfill, index, constraint, table rebuild or drop.

The source Drizzle journal includes 0026 after 0025. This does not register a production application or approve a schema target. 0022–25, production migration engine/manifest and the previous reviewed guard remain unchanged. Old migration ACK is void. Root/C need a fresh staging capture and reviewed guard for this additional migration before separate user-authorized application. Do not append it to or reuse the old four-migration guard without new review.

Compatibility: readers use to_jsonb(row) for absent-column-safe observed-effort reads. Writes naming these columns require negotiated protocol 3 AND the separate effort flag; schema must precede activation. Rollback disables effort controls after drain/reconciliation and retains both nullable columns and historical records. No automatic destructive rollback.

Validated with the unchanged production engine additiveSQL source grammar; no database execution or target equivalence claim. Disposable fixture tests are skipped without separately authorized local fixture input.


## Independent-review R2 revision (still unapplied)

The proposal now adds a THIRD nullable column: `ezil_agent_sessions.effort_observed_at timestamptz`. A protocol-3 joint observation writes this timestamp with model_at. Readers expose effort only when effort_observed_at equals model_at and is at least seen_at. A legacy model snapshot/configure updates model_at without renewing effort_observed_at; a protocol-1 snapshot advances seen_at. Both invalidate the old effort witness without requiring legacy writers to know the new columns. The stored effort may remain for history, but the public readback is null/unknown until a genuine protocol-3 observation.

This is necessary because using model_at alone falsely renewed an older effort value during protocol-2 refresh. Model-only freshness is preserved. No default is inferred and no backfill occurs. Reads use to_jsonb for absent-column safety; only gated protocol-3 writes name the new column. The original two-column 0026 checksum is superseded as an UNAPPLIED proposal, not represented as an applied migration. Root must refresh its reviewed capture/guard proposal before any activation. 0022–25 and the old guard remain untouched.

Disposable test fixtures containing only an earlier partial 0026 now refuse setup with an explicit error. Root must explicitly recreate or separately prepare its fixture; this helper does not silently alter it.

# 0026 session effort — source proposal only

Adds two nullable observed values: `public.ezil_agent_sessions.effort text` and `public.ezil_agent_operations.selected_effort text`. Existing 0025 requested/effective control effort columns are reused. Existing model_at timestamps session model/effort together. Null means no observation, never a guessed default. No data backfill, index, constraint, table rebuild or drop.

The source Drizzle journal includes 0026 after 0025. This does not register a production application or approve a schema target. 0022–25, production migration engine/manifest and the previous reviewed guard remain unchanged. Old migration ACK is void. Root/C need a fresh staging capture and reviewed guard for this additional migration before separate user-authorized application. Do not append it to or reuse the old four-migration guard without new review.

Compatibility: readers use to_jsonb(row) for absent-column-safe observed-effort reads. Writes naming these columns require negotiated protocol 3 AND the separate effort flag; schema must precede activation. Rollback disables effort controls after drain/reconciliation and retains both nullable columns and historical records. No automatic destructive rollback.

Validated with the unchanged production engine additiveSQL source grammar; no database execution or target equivalence claim. Disposable fixture tests are skipped without separately authorized local fixture input.

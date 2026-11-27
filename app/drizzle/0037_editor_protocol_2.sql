-- EZiL MCP session controls over editor bridge protocol 2 (docs/EDITOR-BRIDGE-PROTOCOL-2.md,
-- docs/MCP-SESSION-CONTROLS.md): the editor's reported model catalog, each session's runtime model,
-- which sessions OS itself created, and the delivery state of a create or configure.
-- Written in the production migration grammar (docs/production-migrations.md): only nullable
-- ADD COLUMN statements, no defaults, keys or checks. The app supplies and validates every value
-- (app/src/server/agent-session/store.ts and control-store.ts). Existing rows keep NULL, which the
-- app reads as "not reported" / "not created by OS" / "not delivered": protocol 1 behaviour is unchanged.
--   ezil_editor_bridge_owner: protocol the current owner syncs with, its latest catalog and when OS
--     received it (OS's own clock, never the editor's). Reset whenever ownership changes.
--   ezil_agent_sessions: the model the editor read in that session's own input and when OS read it;
--     its request count; created_by_os / created_control_id are set ONLY from an applied create report
--     for a session that did not exist before (they alone allow `reveal`).
--   ezil_control_operations: attempt_id / delivered_epoch fence the editor's report like a send's;
--     expires_at bounds how long a create or configure may wait; effective_* is what the editor read
--     back after the change (never copied from the request).
ALTER TABLE public.ezil_editor_bridge_owner ADD COLUMN protocol integer;
--> statement-breakpoint
ALTER TABLE public.ezil_editor_bridge_owner ADD COLUMN catalog jsonb;
--> statement-breakpoint
ALTER TABLE public.ezil_editor_bridge_owner ADD COLUMN catalog_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ADD COLUMN model text;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ADD COLUMN model_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ADD COLUMN request_count integer;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ADD COLUMN created_by_os boolean;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ADD COLUMN created_control_id uuid;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN attempt_id uuid;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN delivered_epoch bigint;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN delivered_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN not_before timestamptz;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN attempts integer;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN effective_model text;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN effective_effort text;
--> statement-breakpoint
ALTER TABLE public.ezil_control_operations ADD COLUMN effective_at timestamptz

-- Protocol 3 observations only. Requested/effective control effort already exists in 0024/0025.
-- Nullable for older editors; model_at timestamps the joint session model/effort snapshot.
ALTER TABLE public.ezil_agent_sessions ADD COLUMN effort text;
--> statement-breakpoint
ALTER TABLE public.ezil_agent_operations ADD COLUMN selected_effort text;

--> statement-breakpoint
ALTER TABLE public.ezil_agent_sessions ADD COLUMN effort_observed_at timestamptz;

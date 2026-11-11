/**
 * Shared setup for the Postgres tests (delegation, agent sessions, chain) on a
 * THROWAWAY database: Supabase's auth.users and ezil_computers reduced to the
 * columns the code reads, then the reviewed migrations exactly as committed
 * (app/drizzle/hardening/*.sql, split on Drizzle's statement breakpoints, the
 * way `drizzle-kit migrate` runs them). Applied once per database under an
 * advisory lock, so test files can share it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type postgres from 'postgres';

export const HARDENING_MIGRATIONS = ['0022_delegation_replay', '0023_agent_sessions', '0024_control_operations', '0025_editor_controls', '0026_session_effort'] as const;

export function migrationStatements(name: string): string[] {
    const sql = readFileSync(path.resolve(__dirname, '../../../drizzle/hardening', `${name}.sql`), 'utf8');
    return sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);
}

export async function ensureTestSchema(client: ReturnType<typeof postgres>): Promise<void> {
    await client.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(724170001)`;
        await tx.unsafe(`
            DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            CREATE SCHEMA IF NOT EXISTS auth;
            CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT now(),
                raw_app_meta_data jsonb, email_confirmed_at timestamptz, phone_confirmed_at timestamptz, banned_until timestamptz,
                deleted_at timestamptz, is_anonymous boolean NOT NULL DEFAULT false);
            ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb;
            CREATE TABLE IF NOT EXISTS public.ezil_computers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id uuid NOT NULL REFERENCES auth.users(id), name text NOT NULL DEFAULT 'Computer', slot smallint NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(), last_opened_at timestamptz, deleted_at timestamptz, metadata jsonb);`);
        const marker = { '0022_delegation_replay': 'public.ezil_delegation_replay', '0023_agent_sessions': 'public.ezil_agent_operations',
            '0024_control_operations': 'public.ezil_control_operations' };
        for (const name of HARDENING_MIGRATIONS) {
            // 0025 only adds columns, so its marker is one of them.
            const [row] = name === '0026_session_effort'
                ? await tx`SELECT count(*)::int AS effort_columns FROM information_schema.columns WHERE table_schema = 'public'
                    AND ((table_name = 'ezil_agent_sessions' AND column_name IN ('effort', 'effort_observed_at'))
                    OR (table_name = 'ezil_agent_operations' AND column_name = 'selected_effort'))`
                : name === '0025_editor_controls'
                ? await tx`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'ezil_control_operations' AND column_name = 'attempt_id') AS present`
                : await tx`SELECT to_regclass(${marker[name]}) IS NOT NULL AS present`;
            if (name === '0026_session_effort') {
                if (row!.effort_columns === 3) continue;
                if (row!.effort_columns !== 0) throw new Error('Disposable fixture has an earlier partial 0026 proposal; recreate the fixture explicitly.');
            } else if (row!.present) continue;
            for (const statement of migrationStatements(name)) await tx.unsafe(statement);
        }
    });
}

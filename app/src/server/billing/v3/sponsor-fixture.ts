/**
 * Test-only: a synthetic H compatibility fixture for a bare, disposable Postgres (no Supabase image, no full migration journal). It creates the
 * roles and `auth` objects the sponsor code touches and takes `ezil_billing_trials` and `ezil_billing_trial_identities` VERBATIM from drizzle/0021,
 * then applies the separate sponsor SQL once. Never point it at a real database.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const APP = resolve(__dirname, '../../../..');
export const SPONSOR_SQL_FILE = resolve(APP, 'migrations/sponsor/0001_sponsor_attribution.sql');

export async function bootstrapSponsorFixture(url: string, options: { applySponsor?: boolean } = {}): Promise<void> {
    const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
    try {
        const [trials] = await sql`select to_regclass('public.ezil_billing_trials') as t`;
        if (!trials?.t) {
            const m0021 = readFileSync(resolve(APP, 'drizzle/0021_standard_trial.sql'), 'utf8');
            const table = (name: string) => {
                const match = m0021.match(new RegExp(`CREATE TABLE "${name}" \\([\\s\\S]*?\\n\\);`));
                if (!match) throw new Error(`0021 DDL for ${name} not found`);
                return match[0];
            };
            await sql.unsafe(`do $$ begin
                if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
                if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
                create schema if not exists auth;
                create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz,
                    raw_app_meta_data jsonb not null default '{}', created_at timestamptz not null default now(), deleted_at timestamptz);
                create or replace function auth.role() returns text language sql stable as $f$ select current_setting('request.jwt.claim.role', true) $f$;
                ${table('ezil_billing_trials')}
                alter table public.ezil_billing_trials enable row level security;
                alter table public.ezil_billing_trials add constraint ezil_billing_trials_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;
                ${table('ezil_billing_trial_identities')}
                alter table public.ezil_billing_trial_identities add constraint ezil_billing_trial_identities_trial_id_fkey foreign key (trial_id) references public.ezil_billing_trials(id) on delete cascade;`);
        }
        const [present] = await sql`select to_regclass('public.ezil_sponsor_attributions') as t`;
        if (options.applySponsor !== false && !present?.t) await sql.unsafe(readFileSync(SPONSOR_SQL_FILE, 'utf8').replaceAll('--> statement-breakpoint', ''));
    } finally { await sql.end(); }
}

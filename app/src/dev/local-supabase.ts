import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import { ENV_HEADER, isLocalApiUrl, isLocalDatabaseUrl, LOCAL_PROJECT } from './environment';

export class LocalWebError extends Error {}

const statusSchema = z.object({
    API_URL: z.string().refine(isLocalApiUrl),
    DB_URL: z.string().refine(isLocalDatabaseUrl),
    ANON_KEY: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    SERVICE_ROLE_KEY: z.string().regex(/^[A-Za-z0-9_.-]+$/),
});
export type LocalStatus = z.infer<typeof statusSchema>;

export function isLocalAuthConfigured(settings: unknown): boolean {
    return z.object({ disable_signup: z.literal(true), external: z.object({ email: z.literal(true) }) })
        .safeParse(settings).success;
}

/** Accept only status from the pinned, dedicated local CLI project, never app env. */
export function parseLocalStatus(value: unknown): LocalStatus {
    const parsed = statusSchema.safeParse(value);
    if (!parsed.success) throw new LocalWebError('supabase_status: invalid dedicated local target or keys');
    return parsed.data;
}

export function localEnvironment(status: LocalStatus): string {
    const checked = parseLocalStatus(status);
    if (/[\r\n$'"\\]/.test(checked.DB_URL)) throw new LocalWebError('DB_URL: invalid environment encoding');
    return ENV_HEADER + [
        'EZIL_LOCAL_WEB=1',
        `SUPABASE_DATABASE_URL=${checked.DB_URL}`,
        `NEXT_PUBLIC_SUPABASE_URL=${checked.API_URL}`,
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${checked.ANON_KEY}`,
        'EZIL_OS_ACCESS_MODE=invite',
        '',
    ].join('\n');
}

export async function privateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalWebError('local_state: expected a private directory');
    await chmod(directory, 0o700);
}

export async function readPrivateFile(file: string): Promise<string | null> {
    try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalWebError('local_file: expected a regular file');
        return await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** Exclusive creation; even files bearing our header are never overwritten. */
export async function writePrivateFileOnce(file: string, contents: string): Promise<void> {
    const existing = await readPrivateFile(file);
    if (existing !== null) {
        if (existing !== contents) throw new LocalWebError('local_file: already exists with different contents; preserve or move it before retrying');
        await chmod(file, 0o600);
        return;
    }
    await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
}

const accountSchema = z.tuple([
    z.object({ email: z.literal('local-a@ezil.test'), password: z.string().min(16) }).strict(),
    z.object({ email: z.literal('local-b@ezil.test'), password: z.string().min(16) }).strict(),
]);
export type LocalAccounts = z.infer<typeof accountSchema>;

export async function localAccounts(file: string): Promise<LocalAccounts> {
    const existing = await readPrivateFile(file);
    if (existing !== null) {
        let value: unknown;
        try { value = JSON.parse(existing); } catch { throw new LocalWebError('accounts.json: invalid local account file'); }
        const parsed = accountSchema.safeParse(value);
        if (!parsed.success) throw new LocalWebError('accounts.json: invalid local account file');
        await chmod(file, 0o600);
        return parsed.data;
    }
    const accounts: LocalAccounts = [
        { email: 'local-a@ezil.test', password: `Aa1!${randomBytes(24).toString('hex')}` },
        { email: 'local-b@ezil.test', password: `Aa1!${randomBytes(24).toString('hex')}` },
    ];
    await writePrivateFileOnce(file, JSON.stringify(accounts, null, 2) + '\n');
    return accounts;
}

export const MIGRATIONS = ['0000_massive_mole_man.sql', '0001_telemetry.sql', '0002_os_access.sql'] as const;
export type Migration = { name: string; hash: string; sql: string };

export async function loadMigrations(directory: string): Promise<Migration[]> {
    return Promise.all(MIGRATIONS.map(async (name) => {
        const sql = await readFile(path.join(directory, name), 'utf8');
        return { name, sql, hash: createHash('sha256').update(sql).digest('hex') };
    }));
}

export function pendingMigrations(migrations: Migration[], applied: { name: string; hash: string }[]): Migration[] {
    // Refuse changed, reordered, or unknown history; do not guess a baseline.
    for (const [index, row] of applied.entries()) {
        if (migrations[index]?.name !== row.name || migrations[index]?.hash !== row.hash) {
            throw new LocalWebError('local_migrations: history differs from checked-in migrations');
        }
    }
    return migrations.slice(applied.length);
}

export function localDatabase(status: LocalStatus): Sql {
    return postgres(parseLocalStatus(status).DB_URL, { max: 1, connect_timeout: 5, idle_timeout: 2, onnotice: () => {} });
}

export async function migrateLocalDatabase(sql: Sql, migrations: Migration[]): Promise<number> {
    return sql.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(55321, 1)`;
        await transaction`create schema if not exists ezil_local_dev`;
        await transaction`revoke all on schema ezil_local_dev from public, anon, authenticated`;
        await transaction`create table if not exists ezil_local_dev.migrations (
            name text primary key, hash text not null, applied_at timestamptz not null default now()
        )`;
        const applied = await transaction<{ name: string; hash: string }[]>`select name, hash from ezil_local_dev.migrations order by name`;
        const pending = pendingMigrations(migrations, applied);
        for (const migration of pending) {
            await transaction.unsafe(migration.sql);
            await transaction`insert into ezil_local_dev.migrations (name, hash) values (${migration.name}, ${migration.hash})`;
        }
        return pending.length;
    });
}

/** Local Auth's real admin API creates confirmed users; SQL only grants OS access. */
export async function seedLocalAccounts(sql: Sql, status: LocalStatus, accounts: LocalAccounts): Promise<void> {
    const checked = parseLocalStatus(status);
    const auth = createClient(checked.API_URL, checked.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }) },
    });
    const passwordVerifier = createClient(checked.API_URL, checked.ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }) },
    });
    for (const account of accounts) {
        const [existing] = await sql<{ id: string }[]>`select id from auth.users where email = ${account.email}`;
        const result = existing
            ? await auth.auth.admin.getUserById(existing.id)
            : await auth.auth.admin.createUser({
                email: account.email, password: account.password, email_confirm: true,
                app_metadata: { local_web_project: LOCAL_PROJECT },
            });
        const user = result.data.user;
        if (result.error || !user || user.app_metadata.local_web_project !== LOCAL_PROJECT) {
            throw new LocalWebError('local_accounts: could not create or verify setup-owned Auth users');
        }
        // A lost/replaced handoff file must not produce a false "ready" result.
        // Use a separate anon client so sign-in cannot replace admin authority.
        const login = await passwordVerifier.auth.signInWithPassword(account);
        try {
            if (login.error || login.data.user?.id !== user.id) {
                throw new LocalWebError('local_accounts: password verification failed; restore accounts.json or check local Auth settings; existing passwords were not reset');
            }
        } finally {
            await passwordVerifier.auth.signOut({ scope: 'local' });
        }
        // No password update on rerun; no pre-created computer or bypass of the invite gate.
        await sql`insert into public.ezil_os_access (email, user_id, invited_by)
            values (${account.email}, ${user.id}, 'local-dev-seed')
            on conflict (email) do update set user_id = excluded.user_id, invited_by = excluded.invited_by, revoked_at = null`;
    }
}

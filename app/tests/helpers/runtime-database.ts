import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

/** Unique committed local DB, so tests can exercise real concurrent locks.
 * Unlike the rollback-only schema suites, no outer transaction is mocked. */
export async function runtimeTestDatabase() {
    const raw = process.env.EZIL_TEST_DATABASE_URL;
    if (!raw) throw new Error('EZIL_TEST_DATABASE_URL is required');
    const url = new URL(raw);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Test database must be loopback');
    const name = `ezil_intents_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(raw, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 6, prepare: false, connect_timeout: 5, onnotice: () => {} });
    let created = false;
    const close = async () => {
        await sql.end({ timeout: 5 });
        if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.end({ timeout: 5 });
    };
    try {
        await admin.unsafe(`CREATE DATABASE ${name}`);
        created = true;
        await sql.unsafe(`CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
                SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
            CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
                SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
            END $$;
            GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;`);
        const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { tag: string }[] };
        await sql.begin(async tx => {
            for (const { tag } of journal.entries) {
                const source = await readFile(new URL(`../../drizzle/${tag}.sql`, import.meta.url), 'utf8');
                for (const statement of source.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement);
            }
        });
        return { sql, url: url.toString(), close };
    } catch (error) { await close(); throw error; }
}

/**
 * 0022 (delegation replay), 0023 (agent sessions), 0024 (control operations) and 0025 (editor controls) through BOTH supported runners, on throwaway
 * databases created inside the DELEGATION_TEST_DATABASE_URL server (never a shared one):
 *
 *  - Drizzle: `drizzle-orm`'s migrator (what `drizzle-kit migrate` runs) applies the whole journal,
 *    including `hardening/0022_*` to `hardening/0025_*`, to a clean database with Supabase's auth
 *    schema stubbed.
 *  - Production: the real engine (.github/scripts/production-migrations.mjs) validates all three files
 *    with its additive grammar, then its `applySQL` transaction applies them as a four-entry catalog
 *    chain. The before/after digests here are observed on a local rehearsal database, so they prove
 *    the files and the chain, NOT the production digests: those must be observed by the release
 *    owner on a database with production's schema metadata (app/drizzle/hardening/README.md).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env.DELEGATION_TEST_DATABASE_URL;
const APP = path.resolve(__dirname, '../../..');
const ROOT = path.resolve(APP, '..');
const FILES = ['0022_delegation_replay', '0023_agent_sessions', '0024_control_operations', '0025_editor_controls'].map((name) => `app/drizzle/hardening/${name}.sql`);
const hex = (n: string) => n.repeat(64).slice(0, 64);

type Engine = {
    additiveSQL(sql: string, schemas: string[]): string;
    catalogSQL(schemas: string[]): string;
    applySQL(loaded: { manifest: Record<string, unknown>; files: Map<string, { sql: string }> }): string;
    hash(content: string | Buffer): string;
};

describe.skipIf(!URL_)('0022/0023 through the Drizzle migrator and the production migration engine', () => {
    let admin: ReturnType<typeof postgres>;
    let engine: Engine;
    const created: string[] = [];
    const database = async (name: string) => {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
        await admin.unsafe(`CREATE DATABASE ${name}`);
        created.push(name);
        const url = new URL(URL_!);
        url.pathname = `/${name}`;
        return postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    };
    const digest = async (db: ReturnType<typeof postgres>) =>
        String((await db.unsafe(`SELECT digest FROM (${engine.catalogSQL(['public'])}) c`))[0]!.digest);

    beforeAll(async () => {
        admin = postgres(URL_!, { max: 1, prepare: false, onnotice: () => {} });
        engine = await import(/* @vite-ignore */ path.join(ROOT, '.github/scripts/production-migrations.mjs')) as Engine;
    });
    afterAll(async () => {
        for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
        await admin?.end();
    });

    it('all four files pass the production additive grammar; the old IF NOT EXISTS / key / default shape does not', () => {
        for (const file of FILES) expect(() => engine.additiveSQL(readFileSync(path.join(ROOT, file), 'utf8'), ['public'])).not.toThrow();
        expect(() => engine.additiveSQL('CREATE TABLE IF NOT EXISTS public.x (a uuid NOT NULL);', ['public'])).toThrow(/outside owned schemas/);
        expect(() => engine.additiveSQL('CREATE TABLE public.x (a uuid PRIMARY KEY);', ['public'])).toThrow();
        expect(() => engine.additiveSQL('CREATE TABLE public.x (a uuid NOT NULL DEFAULT gen_random_uuid());', ['public'])).toThrow();
    });

    it('drizzle-kit migrate (drizzle-orm migrator) applies the whole journal, including all four, to a clean database', async () => {
        const db = await database('ezil_mig_drizzle');
        try {
            await db.unsafe(`
                DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                CREATE SCHEMA auth;
                CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, phone text, email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
                    raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now(), deleted_at timestamptz,
                    banned_until timestamptz, is_anonymous boolean DEFAULT false);
                CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'select null::uuid';
                CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'select null::text';
                CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS 'select null::jsonb';`);
            await migrate(drizzle(db), { migrationsFolder: path.join(APP, 'drizzle') });
            const journal = JSON.parse(readFileSync(path.join(APP, 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
            expect(journal.entries.slice(-4).map((e) => e.tag)).toEqual(['hardening/0022_delegation_replay', 'hardening/0023_agent_sessions', 'hardening/0024_control_operations', 'hardening/0025_editor_controls']);
            const [applied] = await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
            expect(applied!.n).toBe(journal.entries.length);
            const tables = await db`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname IN ('ezil_delegation_replay', 'ezil_editor_bridge_owner', 'ezil_agent_sessions',
                    'ezil_agent_operations', 'ezil_agent_events', 'ezil_control_operations') ORDER BY c.relname`;
            expect(tables.map((t) => [t.relname, t.relrowsecurity])).toEqual([
                ['ezil_agent_events', true], ['ezil_agent_operations', true], ['ezil_agent_sessions', true],
                ['ezil_control_operations', true], ['ezil_delegation_replay', true], ['ezil_editor_bridge_owner', true]]);
            const grants = await db`SELECT count(*)::int AS n FROM information_schema.role_table_grants
                WHERE grantee IN ('anon', 'authenticated', 'PUBLIC') AND (table_name LIKE 'ezil_agent_%' OR table_name = 'ezil_control_operations')`;
            expect(grants[0]!.n).toBe(0);
            // 0025 only adds nullable columns: nothing existing is rewritten, nothing gets a default.
            const added = await db`SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
                WHERE table_schema = 'public' AND column_name IN ('protocol', 'catalog', 'catalog_at', 'model', 'model_at', 'request_count',
                    'created_by_os', 'created_control_id', 'attempt_id', 'delivered_epoch', 'delivered_at', 'expires_at', 'not_before', 'attempts',
                    'effective_model', 'effective_effort', 'effective_at') AND table_name IN ('ezil_editor_bridge_owner', 'ezil_agent_sessions', 'ezil_control_operations')`;
            expect(added.length).toBe(17);
            expect(added.every((c) => c.is_nullable === 'YES' && c.column_default === null)).toBe(true);
            // Running it again applies nothing new.
            await migrate(drizzle(db), { migrationsFolder: path.join(APP, 'drizzle') });
            expect((await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n).toBe(journal.entries.length);
        } finally {
            await db.end();
        }
    });

    it('the production engine applies all four as a reviewed chain (rehearsal digests), is idempotent, and refuses drift', async () => {
        const files = new Map(FILES.map((file) => [file, { sql: readFileSync(path.join(ROOT, file), 'utf8') }]));
        // Rehearsal database: observe the catalog before and after each file.
        const rehearsal = await database('ezil_mig_rehearsal');
        const before = await digest(rehearsal);
        await rehearsal.unsafe(files.get(FILES[0]!)!.sql);
        const middle = await digest(rehearsal);
        await rehearsal.unsafe(files.get(FILES[1]!)!.sql);
        const third = await digest(rehearsal);
        await rehearsal.unsafe(files.get(FILES[2]!)!.sql);
        const fourth = await digest(rehearsal);
        await rehearsal.unsafe(files.get(FILES[3]!)!.sql);
        const after = await digest(rehearsal);
        await rehearsal.end();
        expect(new Set([before, middle, third, fourth, after]).size).toBe(5);
        const manifest = {
            version: 1, repository: 'EZiLHQ/ezil-os', project: 'btgqfmnzycdecmeyqubx', schemas: ['public'], sources: [],
            initialCatalog: { digest: before, capturedAt: '2026-11-07T00:00:00.000Z', objects: 1, sourceDigest: hex('a') },
            migrations: [
                { id: '0022-delegation-replay', path: FILES[0], sha256: engine.hash(files.get(FILES[0]!)!.sql), before, after: middle },
                { id: '0023-agent-sessions', path: FILES[1], sha256: engine.hash(files.get(FILES[1]!)!.sql), before: middle, after: third },
                { id: '0024-control-operations', path: FILES[2], sha256: engine.hash(files.get(FILES[2]!)!.sql), before: third, after: fourth },
                { id: '0025-editor-controls', path: FILES[3], sha256: engine.hash(files.get(FILES[3]!)!.sql), before: fourth, after },
            ],
            trustedWorkflowRuns: [], reviewedEventTriggers: [],
        };
        const apply = engine.applySQL({ manifest, files });

        const target = await database('ezil_mig_target');
        try {
            await target.unsafe(apply);
            expect(await digest(target)).toBe(after);
            const journal = await target`SELECT id, ordinal, before_catalog, after_catalog FROM ezil_ci.journal ORDER BY ordinal`;
            expect(journal.map((j) => [j.id, j.ordinal, [before, middle, third, fourth].includes(String(j.before_catalog))])).toEqual([
                ['0022-delegation-replay', 1, true], ['0023-agent-sessions', 2, true], ['0024-control-operations', 3, true], ['0025-editor-controls', 4, true]]);
            await target.unsafe(apply);
            expect((await target`SELECT count(*)::int AS n FROM ezil_ci.journal`)[0]!.n).toBe(4);
        } finally {
            await target.end();
        }

        // A database whose catalog differs from the reviewed baseline is refused, and nothing is created.
        const drifted = await database('ezil_mig_drift');
        try {
            await drifted.unsafe('CREATE TABLE public.unreviewed (a integer)');
            await expect(drifted.unsafe(apply)).rejects.toThrow(/Initial catalog mismatch/);
            await drifted.unsafe('ROLLBACK');
            expect((await drifted`SELECT to_regclass('public.ezil_agent_operations') IS NULL AS absent`)[0]!.absent).toBe(true);
        } finally {
            await drifted.end();
        }
    });
    it('the release owner\'s capture tool refuses without confirmation or on a drifted baseline, and its rehearsal output is a chain the engine applies to the same final digest', async () => {
        const tool = path.join(APP, 'drizzle/hardening/capture-migration-digests.mjs');
        const url = (name: string) => { const u = new URL(URL_!); u.pathname = `/${name}`; return u.toString(); };
        const run = (name: string, extra: string[]) => execFileSync('node', [tool, ...extra], { env: { ...process.env, DISPOSABLE_DATABASE_URL: url(name) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const capture = await database('ezil_mig_capture');
        await capture.end();
        expect(() => run('ezil_mig_capture', [])).toThrow(/--i-confirm-disposable/);
        // An empty database is not the reviewed baseline: refused (exit 2) before anything is executed.
        try { run('ezil_mig_capture', ['--i-confirm-disposable']); throw new Error('expected a refusal'); } catch (error) {
            expect((error as { status?: number }).status).toBe(2);
            expect(String((error as { stderr?: string }).stderr)).toMatch(/drifted from the reviewed baseline/);
        }
        const observed = JSON.parse(run('ezil_mig_capture', ['--i-confirm-disposable', '--rehearsal'])) as {
            rehearsal: boolean; baseline: string; sources: { path: string; kind: string }[];
            migrations: { id: string; path: string; sha256: string; before: string; after: string }[];
        };
        expect(observed.rehearsal).toBe(true);
        expect(observed.migrations.map((m) => m.id)).toEqual(['0022-delegation-replay', '0023-agent-sessions', '0024-control-operations', '0025-editor-controls']);
        expect(observed.sources.every((x) => x.kind === 'migration')).toBe(true);
        observed.migrations.forEach((m, i) => {
            expect(m.sha256).toBe(engine.hash(readFileSync(path.join(ROOT, m.path), 'utf8')));
            if (i > 0) expect(m.before).toBe(observed.migrations[i - 1]!.after);
        });
        // The same chain, handed to the real engine, applies to a clean database and ends on the tool's last digest.
        const files = new Map(observed.migrations.map((m) => [m.path, { sql: readFileSync(path.join(ROOT, m.path), 'utf8') }]));
        const manifest = {
            version: 1, repository: 'EZiLHQ/ezil-os', project: 'btgqfmnzycdecmeyqubx', schemas: ['public'], sources: [],
            initialCatalog: { digest: observed.baseline, capturedAt: '2026-11-08T00:00:00.000Z', objects: 1, sourceDigest: hex('a') },
            migrations: observed.migrations, trustedWorkflowRuns: [], reviewedEventTriggers: [],
        };
        const target = await database('ezil_mig_capture_target');
        try {
            await target.unsafe(engine.applySQL({ manifest, files }));
            expect(await digest(target)).toBe(observed.migrations.at(-1)!.after);
        } finally {
            await target.end();
        }
    });
});

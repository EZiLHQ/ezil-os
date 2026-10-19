/**
 * The C-2 placement SQL (docs/aws-computers/sql/0001_compute_placement.sql.txt)
 * must stay inside the hosted migration grammar, parsed by the engine's OWN
 * `additiveSQL` — not a re-implementation of it — so the founder's
 * registration step cannot be the first time it is checked.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const SQL_PATH = path.join(REPO, 'docs/aws-computers/sql/0001_compute_placement.sql.txt');
const POOL_SQL_PATH = path.join(REPO, 'docs/aws-computers/sql/0002_ready_pool.sql.txt');
const ENGINE = pathToFileURL(path.join(REPO, '.github/scripts/production-migrations.mjs')).href;

type Engine = { additiveSQL: (sql: string, schemas: string[]) => string };

async function engine(): Promise<Engine> {
    return (await import(/* @vite-ignore */ ENGINE)) as Engine;
}

const sql = readFileSync(SQL_PATH, 'utf8');
const poolSql = readFileSync(POOL_SQL_PATH, 'utf8');

describe('offline ready-pool SQL registration contract', () => {
    // Intentionally an acceptance assertion, not a stripped-down SQL copy or an
    // expected failure. Currently blocked on hosted grammar support; see README.
    it('parses 0002 with the engine additiveSQL before founder registration', async () => {
        const { additiveSQL } = await engine();
        expect(additiveSQL(poolSql, ['public'])).toBe(poolSql);
    });

    it('revokes client roles, enables RLS without policies, and stays unregistered', () => {
        for (const table of ['ezil_compute_pool_hosts', 'ezil_compute_writer_leases']) {
            expect(poolSql).toContain(`REVOKE ALL ON TABLE public.${table} FROM public, anon, authenticated;`);
            expect(poolSql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
        }
        expect(poolSql).not.toMatch(/CREATE\s+POLICY/i);
        expect(POOL_SQL_PATH.endsWith('.sql')).toBe(false);
    });
});

describe('placement SQL is inside the hosted additive grammar', () => {
    it('parses with the engine additiveSQL for the manifest schema', async () => {
        const { additiveSQL } = await engine();
        expect(additiveSQL(sql, ['public'])).toBe(sql);
    });

    it('declares exactly the C-2 columns, in order', () => {
        const columns = (table: string) => {
            const body = sql.match(new RegExp(`CREATE TABLE public\\.${table} \\(([^;]*)\\);`))?.[1] ?? '';
            return body
                .split(',')
                .map((line) => line.trim().split(/\s+/).slice(0, 2).join(' '))
                .filter(Boolean);
        };
        expect(columns('ezil_computer_placements')).toEqual([
            'computer_id uuid', 'owner_user_id uuid', 'provider text', 'workspace_store text', 'generation bigint', 'lease_epoch bigint',
            'state text', 'region text', 'zone_id text', 'instance_id text', 'instance_type text', 'volume_id text',
            'fs_uuid uuid', 'tunnel_id text', 'enroll_nonce_hash text', 'enroll_expires_at timestamptz', 'enroll_consumed_hash text',
            'lease_until timestamptz', 'presence_at timestamptz', 'fence_token uuid', 'lifecycle_job_id uuid',
            'lifecycle_digest text', 'last_error text', 'updated_at timestamptz', 'reconciled_at timestamptz',
        ]);
        expect(columns('ezil_compute_usage')).toEqual([
            'computer_id uuid', 'user_id uuid', 'instance_id text', 'instance_type text', 'started_at timestamptz',
            'stopped_at timestamptz', 'egress_bytes bigint', 'observed_by text', 'updated_at timestamptz',
        ]);
    });

    it('revokes client roles and enables RLS on both tables', () => {
        for (const table of ['ezil_computer_placements', 'ezil_compute_usage']) {
            expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM public, anon, authenticated;`);
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
        }
    });

    it('the grammar check is not vacuous: a column DEFAULT is refused', async () => {
        // UNIQUE indexes become legal once the narrow unique-index grammar lands, so probe
        // with a column DEFAULT, which every grammar version refuses.
        const { additiveSQL } = await engine();
        const withDefault = sql.replace('updated_at timestamptz NOT NULL', 'updated_at timestamptz NOT NULL DEFAULT now()');
        expect(withDefault).not.toBe(sql);
        expect(() => additiveSQL(withDefault, ['public'])).toThrow();
    });

    it('is not a *.sql file, so the unregistered copy stays out of the migration inventory', () => {
        expect(SQL_PATH.endsWith('.sql')).toBe(false);
    });
});

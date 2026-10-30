/**
 * C-2 "Every write goes through one module": no source file other than
 * `placement.ts` may name either placement table — reads included, so the
 * whole statement surface stays reviewable in one file.
 *
 * Driven by `git ls-files` (tracked plus untracked, unignored) over the WHOLE
 * repository, so a writer added under `infra/`, `deploy/`, `worker/` or any
 * new directory is caught. `docs/` and test files are exempt. The one reviewed
 * schema applier may name the tables for DDL, locks and catalog inspection only.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const WRITER = 'app/src/server/lib/compute/placement.ts';
const TABLES = /ezil_computer_placements|ezil_compute_usage/;
// Applies the exact reviewed DDL, takes locks and inspects pg_catalog; it never
// reads or writes placement/usage rows. Do not exempt the deploy directory.
const DDL_ONLY = ['deploy/aws/mum/rebase_schema.py'];
const ROW_ACCESS = new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY|FROM|JOIN)\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?(?:${TABLES.source})\b`, 'i');
const CODE = /\.(ts|tsx|js|mjs|cjs|sql|py|rs|go|sh|swift|json|ya?ml|toml|tf|hcl|asl)$/;

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\0')
    .filter(Boolean)
    .filter((f) => CODE.test(f) && !f.startsWith('docs/') && !/\.test\.(ts|tsx|mjs|js)$/.test(f));

describe('placement tables have exactly one writer module', () => {
    it('scans a real tree (guards a vacuous pass)', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(files).toContain(WRITER);
        expect(files.some((f) => f.startsWith('worker/'))).toBe(true);
    });

    it('the writer itself names both tables', () => {
        const text = readFileSync(path.join(REPO, WRITER), 'utf8');
        expect(text).toMatch(/ezil_computer_placements/);
        expect(text).toMatch(/ezil_compute_usage/);
    });

    it('the reviewed schema applier only names tables for schema operations', () => {
        for (const file of DDL_ONLY) {
            expect(files).toContain(file);
            const source = readFileSync(path.join(REPO, file), 'utf8');
            expect(source).toMatch(TABLES);
            expect(source).not.toMatch(ROW_ACCESS);
        }
    });

    it('the DDL exception rejects row reads and writes on either table', () => {
        for (const table of ['ezil_computer_placements', 'ezil_compute_usage']) {
            for (const operation of ['INSERT INTO', 'UPDATE', 'DELETE FROM', 'MERGE INTO', 'TRUNCATE', 'TRUNCATE TABLE', 'COPY', 'SELECT * FROM', 'JOIN']) {
                for (const name of [table, `public.${table}`, `"public"."${table}"`])
                    expect(`${operation}\n${name}`).toMatch(ROW_ACCESS);
            }
        }
    });

    it('no file outside the writer and reviewed DDL applier names either table', () => {
        const offenders = files.filter((f) => f !== WRITER && !DDL_ONLY.includes(f)).filter((f) => {
            try {
                return TABLES.test(readFileSync(path.join(REPO, f), 'utf8'));
            } catch {
                return false; // deleted in the working tree but still in the index
            }
        });
        // P8 demand reads placements to avoid double-counting leased hosts. It cannot write them.
        const demandPath = 'app/src/server/lib/compute/ready-pool.ts';
        expect(offenders.filter(p => p !== demandPath)).toEqual([]);
        expect(readFileSync(path.join(REPO, demandPath), 'utf8')).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM) public\.ezil_computer_(?:placements|usage)/i);
    });
});

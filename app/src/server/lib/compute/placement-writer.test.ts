/**
 * C-2 "Every write goes through one module": no source file other than
 * `placement.ts` may write either placement table. Table references outside
 * that module require an exact, reviewed read-only or schema-only inventory.
 *
 * Driven by `git ls-files` (tracked plus untracked, unignored) over the WHOLE
 * repository, so a writer added under `infra/`, `deploy/`, `worker/` or any
 * new directory is caught. `docs/` and test files are exempt. The reviewed
 * schema tools may name the tables for DDL, locks and catalog inspection only.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const WRITER = 'app/src/server/lib/compute/placement.ts';
const TABLES = /ezil_computer_placements|ezil_compute_usage/;
// These exact schema tools inspect the catalog without accessing placement or
// usage rows. The native batch also verifies existing placement prerequisites.
const DDL_ONLY = [
    'deploy/aws/mum/rebase_schema.py', 'app/scripts/billing-production-native.mjs',
    // Installs a placement transition trigger; its function writes only the assignment clock.
    'app/drizzle/0034_assignment_migration_clock.sql',
];
const READ_ONLY = [
    'app/src/server/lib/compute/ready-pool.ts', // Demand reads avoid double-counting leased hosts.
    'app/src/server/lib/compute/assignment-host-recovery.ts', // Rechecks the owned session after provider observation.
];
const TARGET = String.raw`\s+(?:ONLY\s+)?(?:"?\w+"?\s*\.\s*)?"?(?:${TABLES.source})\b`;
const WRITE_OPERATIONS = String.raw`INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY`;
const ROW_WRITE = new RegExp(String.raw`\b(?:${WRITE_OPERATIONS})${TARGET}`, 'i');
const ROW_ACCESS = new RegExp(String.raw`\b(?:${WRITE_OPERATIONS}|FROM|JOIN)${TARGET}`, 'i');
const CODE = /\.(ts|tsx|js|mjs|cjs|sql|py|rs|go|sh|swift|json|ya?ml|toml|tf|hcl|asl)$/;

function violatesInventory(file: string, source: string): boolean {
    if (!TABLES.test(source) || file === WRITER) return false;
    if (DDL_ONLY.includes(file)) return ROW_ACCESS.test(source);
    if (READ_ONLY.includes(file)) return ROW_WRITE.test(source);
    return true;
}

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

    it('the reviewed schema tools only name tables for schema operations', () => {
        for (const file of DDL_ONLY) {
            expect(files).toContain(file);
            const source = readFileSync(path.join(REPO, file), 'utf8');
            expect(source).toMatch(TABLES);
            expect(source).not.toMatch(ROW_ACCESS);
        }
    });

    it('the reviewed readers access rows without writing either protected table', () => {
        for (const file of READ_ONLY) {
            expect(files).toContain(file);
            const source = readFileSync(path.join(REPO, file), 'utf8');
            expect(source).toMatch(ROW_ACCESS);
            expect(violatesInventory(file, source), file).toBe(false);
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

    it('every exact exception still rejects a rogue row writer', () => {
        for (const file of [...DDL_ONLY, ...READ_ONLY]) {
            const source = readFileSync(path.join(REPO, file), 'utf8');
            expect(violatesInventory(file, source), file).toBe(false);
            for (const table of ['ezil_computer_placements', 'ezil_compute_usage']) {
                for (const operation of ['INSERT INTO', 'UPDATE', 'DELETE FROM', 'MERGE INTO', 'TRUNCATE', 'TRUNCATE TABLE', 'COPY']) {
                    for (const name of [table, `public.${table}`, `"public"."${table}"`, `ONLY public.${table}`]) {
                        expect(violatesInventory(file, `${source}\n${operation}\n${name}`), `${file}: ${operation} ${name}`).toBe(true);
                    }
                }
            }
        }
    });

    it('does not extend an exception to a neighboring module, migration or deployment tool', () => {
        for (const file of ['app/src/server/lib/compute/assignment-host-recovery-copy.ts',
            'app/drizzle/0035_rogue_writer.sql']) {
            for (const table of ['ezil_computer_placements', 'ezil_compute_usage']) {
                expect(violatesInventory(file, `SELECT * FROM public.${table}`)).toBe(true);
                expect(violatesInventory(file, `UPDATE public.${table} SET state = 'RUNNING'`)).toBe(true);
            }
        }
    });

    it('no file violates the writer and exact reader/schema inventory', () => {
        const offenders = files.filter((f) => {
            try {
                return violatesInventory(f, readFileSync(path.join(REPO, f), 'utf8'));
            } catch {
                return false; // deleted in the working tree but still in the index
            }
        });
        expect(offenders).toEqual([]);
    });
});

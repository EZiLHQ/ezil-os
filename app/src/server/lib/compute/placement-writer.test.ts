/**
 * C-2 "Every write goes through one module": no source file other than
 * `placement.ts` may name either placement table — reads included, so the
 * whole statement surface stays reviewable in one file.
 *
 * Driven by `git ls-files` (tracked plus untracked, unignored) over the WHOLE
 * repository, so a writer added under `infra/`, `deploy/`, `worker/` or any
 * new directory is caught. Only `docs/` and test files are exempt.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const WRITER = 'app/src/server/lib/compute/placement.ts';
const TABLES = /ezil_computer_placements|ezil_compute_usage/;
const CODE = /\.(ts|tsx|js|mjs|cjs|sql|py|rs|go|sh|swift|json|ya?ml|toml|tf|hcl|asl)$/;

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' })
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

    it('no other file names either table', () => {
        const offenders = files.filter((f) => f !== WRITER).filter((f) => {
            try {
                return TABLES.test(readFileSync(path.join(REPO, f), 'utf8'));
            } catch {
                return false; // deleted in the working tree but still in the index
            }
        });
        expect(offenders).toEqual([]);
    });
});

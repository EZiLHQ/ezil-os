/**
 * C-2 "Every write goes through one module": no source file other than
 * `placement.ts` may name either placement table — reads included, so the
 * whole statement surface stays reviewable in one file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['app/src', 'worker/src', 'local/src', 'sdk/src', 'mcp', 'shell', 'native', 'tools'];
const WRITER = 'app/src/server/lib/compute/placement.ts';
const TABLES = /ezil_computer_placements|ezil_compute_usage/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'target', '.git']);

function sources(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) sources(full, out);
        else if (/\.(ts|tsx|js|mjs|cjs|sql|py|rs|go|sh)$/.test(name) && !/\.test\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
    }
    return out;
}

describe('placement tables have exactly one writer module', () => {
    const files = ROOTS.flatMap((r) => sources(path.join(REPO, r)));

    it('scans a real tree (guards a vacuous pass)', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain(path.join(REPO, WRITER));
    });

    it('the writer itself names both tables', () => {
        const text = readFileSync(path.join(REPO, WRITER), 'utf8');
        expect(text).toMatch(/ezil_computer_placements/);
        expect(text).toMatch(/ezil_compute_usage/);
    });

    it('no other source file names either table', () => {
        const offenders = files
            .filter((f) => path.relative(REPO, f) !== WRITER)
            .filter((f) => TABLES.test(readFileSync(f, 'utf8')))
            .map((f) => path.relative(REPO, f));
        expect(offenders).toEqual([]);
    });
});

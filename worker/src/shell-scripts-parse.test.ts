/**
 * Every shipped shell script must actually parse.
 *
 * This exists because a script that cannot parse shipped to production and
 * broke the app preview outright. Two apostrophes were added inside a
 * single-quoted `bash -c '...'` block — in COMMENTS — which terminated the
 * quote early:
 *
 *     start-devserver.sh: line 293: unexpected EOF while looking for matching
 *
 * The container built fine (the Dockerfile only COPYs these files), the image
 * pushed fine, `tsc --noEmit` was clean and 482 unit tests passed. Nothing in
 * the repo had ever run `bash -n`. The only symptom was, inside a live
 * container, the dev server silently failing to launch and `/preview/`
 * answering `The container is not listening in the TCP address 10.0.0.1:3002`.
 *
 * `bash -n` is a parse-only check: it never executes the script, so this is
 * safe to run against launchers that would otherwise start long-lived
 * processes.
 *
 * This is deliberately a whole-directory sweep rather than a list of files.
 * A list goes stale the moment someone adds a script and forgets to add it
 * here — which is the same failure mode as the bug it is guarding against.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
    join(import.meta.dir, '..', 'scripts'),
    join(import.meta.dir, '..', 'bootstrap'),
    join(import.meta.dir, '..', '..', 'shell'),
];

function shellScriptsIn (dir: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return []; // directory may not exist in every checkout
    }
    return entries
        .filter((name) => name.endsWith('.sh'))
        .map((name) => join(dir, name))
        .filter((path) => statSync(path).isFile());
}

const SCRIPTS = ROOTS.flatMap(shellScriptsIn).sort();

describe('every shipped shell script parses', () => {
    it('finds scripts to check (guards against a vacuous pass)', () => {
        // Without this, a bad path would make the suite below iterate zero
        // files and report green — the exact shape of a test that cannot fail.
        expect(SCRIPTS.length).toBeGreaterThan(3);
    });

    for (const script of SCRIPTS) {
        const label = script.split('/').slice(-2).join('/');
        it(`${label} parses under \`bash -n\``, () => {
            const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
            const detail = (result.stderr || '').trim();
            expect(`${label}: ${result.status} ${detail}`).toBe(`${label}: 0 `);
        });
    }
});

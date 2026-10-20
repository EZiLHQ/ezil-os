/** Static image contract: opencode must be baked in, outside user save quotas. */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Join Docker continuations so a cache cleanup in a later layer cannot pass.
// Drop comments so documentation cannot stand in for an actual instruction.
const instructions = readFileSync(join(import.meta.dir, '..', 'Dockerfile'), 'utf8')
    .replace(/^\s*#.*$/gm, '')
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

function installRun (): string {
    const matches = instructions.filter((line) => /^RUN\s/.test(line) && /\bopencode-ai\b/.test(line));
    expect(matches).toHaveLength(1);
    return matches[0]!;
}

describe('worker/Dockerfile preinstalls opencode', () => {
    it('installs the exact pinned opencode-ai version globally under /usr/local', () => {
        const run = installRun();
        expect(run).toMatch(/^RUN npm install\s[^;&]*\bopencode-ai@1\.19\.0(?=\s|$)/);
        expect(run).toMatch(/\s--global(?=\s|$)/);
        expect(run).toMatch(/\s--prefix \/usr\/local(?=\s|$)/);
    });

    it('installs in the final stage before the npm inventory and image manifest', () => {
        const installIndex = instructions.indexOf(installRun());
        const finalStageIndex = instructions.findLastIndex((line) => /^FROM\s/.test(line));
        const inventoryIndex = instructions.findIndex((line) => /^RUN\s/.test(line)
            && line.includes('> /etc/ezil-image-npm-global.txt'));
        const manifestIndex = instructions.findIndex((line) => /^RUN python3 .*\/ezil-image-manifest\.py\b/.test(line));
        expect(finalStageIndex).toBeGreaterThanOrEqual(0);
        expect(installIndex).toBeGreaterThan(finalStageIndex);
        expect(inventoryIndex).toBeGreaterThan(installIndex);
        expect(manifestIndex).toBeGreaterThan(inventoryIndex);
        expect(instructions[inventoryIndex]).toContain('/usr/local/lib/node_modules/*');
    });

    it('cleans the npm cache after installation in the same RUN', () => {
        const run = installRun();
        expect(run).toMatch(/&&\s+npm cache clean --force(?=\s|$)/);
        expect(run.indexOf('npm cache clean --force')).toBeGreaterThan(run.indexOf('opencode-ai@'));
    });

    it('checks the executable and PATH in login and non-login shells during the build', () => {
        const run = installRun();
        expect(run).toContain('&& test -x /usr/local/bin/opencode');
        for (const mode of ['-c', '-lc']) {
            expect(run).toContain(`&& bash ${mode} 'test "$(command -v opencode)" = /usr/local/bin/opencode'`);
        }
    });
});

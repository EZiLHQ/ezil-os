/**
 * AWS computers keep the browser profile on the retained data volume (R15,
 * docs/AWS-COMPUTERS.md). `start-neko.sh` wiped `$CHROME_PROFILE_DIR` on every
 * boot; with `EZIL_PERSISTENT_PROFILES=1` it must keep it, and without the flag
 * (Cloudflare, local mode) the wipe must stay exactly as before.
 *
 * Executes the REAL block from `scripts/start-neko.sh` (extracted between its
 * own anchors, so the test fails if the block disappears or changes shape)
 * against a temp profile dir.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const START_NEKO = join(import.meta.dir, '..', 'scripts', 'start-neko.sh');

function profileBlock (): string {
    const src = readFileSync(START_NEKO, 'utf8');
    const start = src.indexOf('if [ "${EZIL_PERSISTENT_PROFILES:-0}" = 1 ]; then');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfi\n', start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end + 4);
    expect(block).toContain('rm -rf "$CHROME_PROFILE_DIR"');
    // The block is immediately followed by the (re)creation of the directory.
    expect(src.slice(end + 4, end + 4 + 60)).toContain('mkdir -p "$CHROME_PROFILE_DIR"');
    return block;
}

function run (persistent: string | undefined): { kept: boolean; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-persistent-profiles-'));
    try {
        const profile = join(dir, 'chrome');
        mkdirSync(profile);
        writeFileSync(join(profile, 'Local State'), '{}');
        const script = `log() { echo "LOG $*"; }\nCHROME_PROFILE_DIR=${JSON.stringify(profile)}\n${profileBlock()}`;
        const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
        if (persistent !== undefined) env.EZIL_PERSISTENT_PROFILES = persistent;
        const r = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
        expect(r.status).toBe(0);
        return { kept: existsSync(join(profile, 'Local State')), log: r.stdout };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('start-neko.sh persistent browser profile (AWS, R15)', () => {
    it('keeps the profile when EZIL_PERSISTENT_PROFILES=1', () => {
        const r = run('1');
        expect(r.kept).toBe(true);
        expect(r.log).toContain('browser profile: persistent');
    });
    it('still wipes it by default (Cloudflare and local mode unchanged)', () => {
        expect(run(undefined).kept).toBe(false);
    });
    it('treats any other value as the default wipe', () => {
        expect(run('0').kept).toBe(false);
        expect(run('true').kept).toBe(false);
    });
});

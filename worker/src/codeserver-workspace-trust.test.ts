/**
 * code-server must open the workspace ALREADY TRUSTED.
 *
 * Measured in production on container image v8 (2026-08-03), against a real
 * browser session. With `folder=` on the bridge URL — which is what ships now
 * — code-server inherits VS Code's Workspace Trust and opens in Restricted
 * Mode. The observed consequence is not cosmetic:
 *
 *   Ctrl+`  ->  `.xterm: 0`, panel reads "Drag a view here to display.",
 *               status bar reads "Restricted Mode", and a MODAL appears:
 *               "Do you trust the authors of the files in this folder?
 *                Creating a terminal process requires executing code"
 *               [Manage] [Cancel] [Trust Folder & Continue]
 *
 *   click "Trust Folder & Continue" -> Restricted Mode clears but the terminal
 *   still does not open (VS Code cancels the action that raised the prompt);
 *   a SECOND Ctrl+` is needed, and only then does `.xterm: 1` / `TERMINAL bash`
 *   / a real `root@…:/workspace` prompt appear.
 *
 * The grant is stored under `--user-data-dir`, which is under /tmp and is
 * recreated on every container start, so the prompt returns every session.
 *
 * These tests EXECUTE the real seeding code out of the two launchers rather
 * than grepping them for strings: a source-string assertion passes just as
 * happily against a script that never runs the block it is asserting on.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dir, '..', 'scripts');
const START_NEKO = join(SCRIPTS, 'start-neko.sh');
const START_CODESERVER = join(SCRIPTS, 'start-codeserver.sh');

const tmp = (): string => mkdtempSync(join(tmpdir(), 'cs-trust-'));

/**
 * Pull `seed_codeserver_user_settings` out of start-neko.sh by brace-matching
 * from its definition, so the test runs the shipped implementation verbatim.
 * start-neko.sh is a 1200-line launcher that cannot be sourced wholesale.
 */
function extractSeedFunction (): string {
    const src = readFileSync(START_NEKO, 'utf8');
    const start = src.indexOf('seed_codeserver_user_settings() {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    expect(i).toBeLessThan(src.length);
    return `seed_codeserver_user_settings() ${src.slice(open, i + 1)}`;
}

function runSeedFn (userDataDir: string): { code: number | null; stderr: string } {
    const script = `set -uo pipefail\n${extractSeedFunction()}\nseed_codeserver_user_settings "$1"\n`;
    const r = spawnSync('bash', ['-c', script, 'bash', userDataDir], { encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr };
}

const settingsPath = (dir: string): string => join(dir, 'User', 'settings.json');

describe('start-neko.sh seeds code-server settings that disable workspace trust', () => {
    it('is the function the launcher actually calls, not a dead definition', () => {
        const src = readFileSync(START_NEKO, 'utf8');
        // definition + a real call site, and the call must precede the launch
        const def = src.indexOf('seed_codeserver_user_settings() {');
        const call = src.indexOf('if seed_codeserver_user_settings "$CODE_SERVER_USER_DATA_DIR"');
        const launch = src.indexOf('supervise_app codeserver');
        expect(def).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(def);
        expect(launch).toBeGreaterThan(call);
    });

    it('writes settings.json with workspace trust disabled', () => {
        const dir = tmp();
        const { code, stderr } = runSeedFn(dir);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        expect(existsSync(settingsPath(dir))).toBe(true);
        const parsed = JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as Record<string, unknown>;
        // Must be valid JSON — code-server silently ignores a settings file it
        // cannot parse, which would restore Restricted Mode with no error.
        expect(parsed['security.workspace.trust.enabled']).toBe(false);
    });

    it('creates the User/ subdirectory when the user-data-dir does not exist yet', () => {
        // /tmp/code-server-data is recreated on every container start, so the
        // common case is a path with nothing under it at all.
        const dir = join(tmp(), 'not', 'yet', 'there');
        const { code } = runSeedFn(dir);
        expect(code).toBe(0);
        expect(existsSync(settingsPath(dir))).toBe(true);
    });

    it('never clobbers settings the user already has', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'User'), { recursive: true });
        writeFileSync(settingsPath(dir), '{"editor.fontSize": 42}');
        const { code } = runSeedFn(dir);
        expect(code).toBe(0);
        expect(readFileSync(settingsPath(dir), 'utf8')).toBe('{"editor.fontSize": 42}');
    });
});

/**
 * The seeding block out of start-codeserver.sh, run verbatim.
 *
 * The whole script is deliberately NOT invoked here: it keys off a hardcoded
 * `/tmp/code-server.pid` and a real listener on :8443, both process-wide state
 * this suite does not own. Driving it made this test pass or fail depending on
 * whether an earlier run had left a pid file behind — a flaky test is worse
 * than no test, so the block is extracted and executed against a temp dir.
 */
function extractCodeserverSeedBlock (): string {
    const src = readFileSync(START_CODESERVER, 'utf8');
    const start = src.indexOf('if [ ! -s "$USER_DATA_DIR/User/settings.json" ]; then');
    expect(start).toBeGreaterThan(-1);
    const heredocEnd = src.indexOf('CODESERVER_SETTINGS_JSON\n', src.indexOf('<<', start));
    expect(heredocEnd).toBeGreaterThan(start);
    const fi = src.indexOf('\nfi\n', heredocEnd);
    expect(fi).toBeGreaterThan(heredocEnd);
    return src.slice(start, fi + 4);
}

describe('start-codeserver.sh seeds the same settings before it launches', () => {
    it('writes the trust-disabling settings.json when run', () => {
        const dir = tmp();
        const script = `set -euo pipefail\nUSER_DATA_DIR="$1"\n${extractCodeserverSeedBlock()}\n`;
        const r = spawnSync('bash', ['-c', script, 'bash', dir], { encoding: 'utf8' });
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        expect(existsSync(settingsPath(dir))).toBe(true);
        const parsed = JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as Record<string, unknown>;
        expect(parsed['security.workspace.trust.enabled']).toBe(false);
    });

    it('does not clobber existing settings', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'User'), { recursive: true });
        writeFileSync(settingsPath(dir), '{"editor.fontSize": 7}');
        const script = `set -euo pipefail\nUSER_DATA_DIR="$1"\n${extractCodeserverSeedBlock()}\n`;
        const r = spawnSync('bash', ['-c', script, 'bash', dir], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(readFileSync(settingsPath(dir), 'utf8')).toBe('{"editor.fontSize": 7}');
    });

    it('seeds after the already-running fast path and before the launch', () => {
        // Order is the whole point: seeding after `nohup code-server` would be
        // read by nothing, and seeding before the fast-path `exit 0` would
        // rewrite settings under a code-server that is already serving them.
        const src = readFileSync(START_CODESERVER, 'utf8');
        const fastPath = src.indexOf('echo already-running');
        const seed = src.indexOf('if [ ! -s "$USER_DATA_DIR/User/settings.json" ]; then');
        const launch = src.indexOf('nohup code-server');
        expect(fastPath).toBeGreaterThan(-1);
        expect(seed).toBeGreaterThan(fastPath);
        expect(launch).toBeGreaterThan(seed);
    });

    it('passes the seeded user-data-dir to code-server, so the settings are the ones it reads', () => {
        // A seeded file in a directory the binary is never pointed at is worth
        // nothing — this is the seam that silently breaks if someone re-hardcodes
        // the path on one line and not the other.
        const src = readFileSync(START_CODESERVER, 'utf8');
        expect(src).toContain('--user-data-dir="$USER_DATA_DIR"');
        expect(src).not.toContain('--user-data-dir=/tmp/code-server-data');
        const neko = readFileSync(START_NEKO, 'utf8');
        expect(neko).toContain('--user-data-dir="$CODE_SERVER_USER_DATA_DIR"');
        expect(neko).not.toContain('--user-data-dir=/tmp/code-server-data');
    });
});

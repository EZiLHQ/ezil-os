import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// D4 (round 5): the web container log must survive weeks of traffic and every deploy recreate.
const STAGING = path.resolve(__dirname, '..', '..', '..', '..', '..', 'deploy', 'aws', 'os-staging');
const read = (file: string) => readFileSync(path.join(STAGING, file), 'utf8');

describe('os-staging compose logging (D4)', () => {
    // Narrow, dependency-free check of the exact block (no YAML library: none is a declared app dependency).
    const compose = read('compose.yaml');
    // A service's block: its lines up to the next top-level key or service (line scan, no backtracking regex).
    const service = (name: string) => {
        const lines = compose.split('\n');
        const start = lines.indexOf(`  ${name}:`);
        expect(start).toBeGreaterThanOrEqual(0);
        const end = lines.findIndex((line, i) => i > start && /^ {0,2}\S/.test(line));
        return lines.slice(start + 1, end < 0 ? undefined : end);
    };
    it('web defines the shared json-file anchor at 50 MB x 5 files', () => {
        const web = service('web');
        const at = web.indexOf('    logging: &logging');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(web.slice(at + 1, at + 3)).toEqual(['      driver: json-file', "      options: {max-size: '50m', max-file: '5'}"]);
        expect(compose.match(/&logging\b/g)).toHaveLength(1);
    });
    it('caddy reuses the same anchor', () => {
        expect(service('caddy')).toContain('    logging: *logging');
    });
});

describe('os-staging install keeps the outgoing web log (D4)', () => {
    const installer = read('install-host.sh');
    const lines = installer.split('\n');
    const recreate = lines.findIndex(l => /docker compose .*up -d --force-recreate/.test(l));
    const snapshotCall = lines.findIndex(l => l.trim() === 'snapshot_web_log');
    it('install-host.sh passes bash -n', () => {
        const result = spawnSync('bash', ['-n', path.join(STAGING, 'install-host.sh')], { encoding: 'utf8' });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
    it('snapshots the running web container before the force-recreate', () => {
        expect(recreate).toBeGreaterThan(0);
        expect(snapshotCall).toBeGreaterThan(0);
        expect(snapshotCall).toBeLessThan(recreate);
    });
    it('writes gzip snapshots with timestamps under /var/log/<slug> and prunes after 7 days', () => {
        const body = installer.slice(installer.indexOf('snapshot_web_log() {'), installer.indexOf('\n}\n', installer.indexOf('snapshot_web_log() {')));
        // The environment's own names (main's production mode): ezil-os-staging or ezil-os-production.
        expect(installer).toMatch(/^ {4}staging\) slug=ezil-os-staging /m);
        expect(installer).toMatch(/^ {4}production\) slug=ezil-os-production /m);
        expect(body).toContain('/var/log/$slug');
        expect(body).toContain('$slug-web-1');
        expect(body).toMatch(/docker logs --timestamps "\$container" 2>&1 \| gzip/);
        expect(body).toMatch(/web-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.log\.gz/);
        expect(body).toMatch(/-mmin \+10080 -delete/);
    });
});

/**
 * Runs the REAL snapshot_web_log function from install-host.sh under the installer's own `set -euo pipefail`
 * and `umask 077`, with a fake `docker` on PATH and staging's `slug`. Only the log directory path is rewritten to a
 * temp directory.
 * The function must never block the install: `AFTER` must print and bash must exit 0 in every case.
 */
describe('install-host.sh snapshot_web_log behaviour (D4)', () => {
    const LOG_DIR = '/var/log/$slug';
    const installer = read('install-host.sh');
    const start = installer.indexOf('snapshot_web_log() {');
    const fn = installer.slice(start, installer.indexOf('\n}\n', start) + 3);
    let root: string, bin: string, logs: string;
    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'ezil-d4-snapshot-'));
        bin = path.join(root, 'bin'); mkdirSync(bin);
        logs = path.join(root, 'logs');
    });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const docker = (body: string) => {
        const fake = path.join(bin, 'docker');
        writeFileSync(fake, `#!/usr/bin/env bash\n${body}\n`); chmodSync(fake, 0o755);
    };
    const run = (dir = logs) => spawnSync('bash', ['-c', `set -euo pipefail\numask 077\nslug=ezil-os-staging\n${fn.split(LOG_DIR).join(dir)}snapshot_web_log\necho AFTER\n`],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const snapshots = () => existsSync(logs) ? readdirSync(logs).filter(n => /^web-.*\.log\.gz$/.test(n)).sort() : [];
    const expectContinued = (result: ReturnType<typeof run>) => {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('AFTER');
    };

    it('writes a private gzip snapshot of stdout+stderr with timestamps, atomically', () => {
        docker('case $1 in container) exit 0;; logs) [[ $2 == --timestamps && $3 == ezil-os-staging-web-1 ]] || exit 9;'
            + ' echo "2026-10-29T12:00:00Z out"; echo "2026-10-29T12:00:01Z err" >&2;; esac');
        expectContinued(run());
        const [snap, ...more] = snapshots();
        expect(more).toEqual([]);
        expect(snap).toMatch(/^web-\d{8}T\d{6}Z\.log\.gz$/);
        expect(gunzipSync(readFileSync(path.join(logs, snap!))).toString()).toBe('2026-10-29T12:00:00Z out\n2026-10-29T12:00:01Z err\n');
        expect(statSync(path.join(logs, snap!)).mode & 0o777).toBe(0o600);
        expect(statSync(logs).mode & 0o777).toBe(0o700);
        expect(readdirSync(logs).filter(n => n.endsWith('.partial'))).toEqual([]);
    });
    it('first install (no web container) continues without a snapshot', () => {
        docker('exit 1');
        expectContinued(run());
        expect(snapshots()).toEqual([]);
    });
    it('a docker logs failure never blocks the install and leaves no file (no truncated snapshot kept)', () => {
        docker('case $1 in container) exit 0;; logs) echo partial; exit 3;; esac');
        const result = run();
        expectContinued(result);
        expect(result.stderr).toContain('Web log snapshot skipped');
        expect(readdirSync(logs)).toEqual([]);
    });
    it('a log path that is a regular file never blocks the install', () => {
        docker('case $1 in container) exit 0;; logs) echo line;; esac');
        writeFileSync(logs, 'not a directory');
        expectContinued(run());
    });
    it('a log directory that cannot be created (prune finds nothing) never blocks the install', () => {
        docker('case $1 in container) exit 0;; logs) echo line;; esac');
        writeFileSync(logs, 'not a directory');
        expectContinued(run(path.join(logs, 'sub')));
    });
    it('prunes only web snapshots older than 7 days', () => {
        docker('case $1 in container) exit 0;; logs) echo line;; esac');
        mkdirSync(logs, { mode: 0o700 });
        const old = 'web-20261020T000000Z.log.gz', recent = 'web-20261027T000000Z.log.gz', other = 'keep-me.txt';
        for (const name of [old, recent, other]) writeFileSync(path.join(logs, name), 'x');
        const days = (n: number) => (Date.now() - n * 86_400_000) / 1000;
        utimesSync(path.join(logs, old), days(8), days(8));
        utimesSync(path.join(logs, other), days(8), days(8));
        utimesSync(path.join(logs, recent), days(6), days(6));
        expectContinued(run());
        const names = readdirSync(logs);
        expect(names).not.toContain(old);
        expect(names).toContain(recent);
        expect(names).toContain(other);
        expect(snapshots()).toHaveLength(2);
    });
});

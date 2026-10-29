import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// D4 (round 5): the web container log must survive weeks of traffic and every deploy recreate.
const STAGING = path.resolve(__dirname, '..', '..', '..', '..', '..', 'deploy', 'aws', 'os-staging');
const read = (file: string) => readFileSync(path.join(STAGING, file), 'utf8');
// js-yaml is resolved from the app's installed tree (a lockfile dependency of the ESLint toolchain).
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
type Service = { logging?: { driver?: string; options?: Record<string, unknown> } };

describe('os-staging compose logging (D4)', () => {
    const compose = yaml.load(read('compose.yaml')) as { services: Record<string, Service> };
    it.each(['web', 'caddy'])('%s keeps json-file logs at 50 MB x 5 files', service => {
        expect(compose.services[service]?.logging).toEqual({ driver: 'json-file', options: { 'max-size': '50m', 'max-file': '5' } });
    });
});

describe('os-staging install keeps the outgoing web log (D4)', () => {
    const installer = read('install-host.sh');
    const lines = installer.split('\n');
    const recreate = lines.findIndex(l => /docker compose .*up -d --force-recreate/.test(l));
    const snapshotCall = lines.findIndex(l => l.trim() === 'snapshot_web_log');
    it('snapshots the running web container before the force-recreate', () => {
        expect(recreate).toBeGreaterThan(0);
        expect(snapshotCall).toBeGreaterThan(0);
        expect(snapshotCall).toBeLessThan(recreate);
    });
    it('writes gzip snapshots with timestamps under /var/log/ezil-os-staging and prunes after 7 days', () => {
        const body = installer.slice(installer.indexOf('snapshot_web_log() {'), installer.indexOf('\n}\n', installer.indexOf('snapshot_web_log() {')));
        expect(body).toContain('/var/log/ezil-os-staging');
        expect(body).toContain('ezil-os-staging-web-1');
        expect(body).toMatch(/docker logs --timestamps "\$container" 2>&1 \| gzip/);
        expect(body).toMatch(/web-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.log\.gz/);
        expect(body).toMatch(/-mmin \+10080 -delete/);
    });
});

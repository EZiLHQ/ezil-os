import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDevelopmentEnvironment, formatDiagnostics, isLocalDockerEndpoint, LOCAL_API_URL } from './environment';
import {
    isLocalAuthConfigured, localAccounts, localEnvironment, parseLocalStatus, pendingMigrations,
    privateDirectory, writePrivateFileOnce, type Migration,
} from './local-supabase';

const status = {
    API_URL: LOCAL_API_URL,
    DB_URL: 'postgresql://postgres:local-password@127.0.0.1:55322/postgres',
    ANON_KEY: 'local-anon-key', SERVICE_ROLE_KEY: 'private-service-key',
};
const valid = {
    SUPABASE_DATABASE_URL: status.DB_URL,
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
};
const directories: string[] = [];
async function temporaryDirectory() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ezil-local-web-test-'));
    directories.push(directory);
    return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('development configuration diagnostics', () => {
    it('requires password login without reopening public signup in real Auth settings', () => {
        expect(isLocalAuthConfigured({ disable_signup: true, external: { email: true } })).toBe(true);
        expect(isLocalAuthConfigured({ disable_signup: true, external: { email: false } })).toBe(false);
        expect(isLocalAuthConfigured({ disable_signup: false, external: { email: true } })).toBe(false);
        expect(isLocalAuthConfigured({ error: 'unavailable' })).toBe(false);
    });

    it('names missing and blank configuration without values', () => {
        expect(checkDevelopmentEnvironment({ NEXT_PUBLIC_SUPABASE_ANON_KEY: '  ' })).toEqual([
            { name: 'SUPABASE_DATABASE_URL', code: 'missing' },
            { name: 'NEXT_PUBLIC_SUPABASE_URL', code: 'missing' },
            { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', code: 'missing' },
        ]);
        expect(checkDevelopmentEnvironment(valid, true)).toEqual([]);
    });

    it('does not echo secrets from invalid URLs, enums, or optional settings', () => {
        const secret = 'private-unprintable-value';
        const diagnostics = formatDiagnostics(checkDevelopmentEnvironment({
            ...valid, SUPABASE_DATABASE_URL: secret, NEXT_PUBLIC_SUPABASE_URL: secret,
            EZIL_OS_ACCESS_MODE: secret, CRON_SECRET: secret, NODE_ENV: secret,
        }));
        expect(diagnostics).not.toContain(secret);
        for (const name of ['SUPABASE_DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'EZIL_OS_ACCESS_MODE', 'CRON_SECRET', 'NODE_ENV']) {
            expect(diagnostics).toContain(`${name}: invalid`);
        }
    });

    it('rejects inherited cloud providers and open access in the managed local setup', () => {
        const issues = checkDevelopmentEnvironment({
            ...valid, CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example.test',
            CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'must-not-print', EZIL_OS_ACCESS_MODE: 'open',
        }, true);
        expect(issues).toContainEqual({ name: 'CLOUDFLARE_GUACAMOLE_WORKER_URL', code: 'must_be_unset' });
        expect(issues).toContainEqual({ name: 'CLOUDFLARE_GUACAMOLE_HMAC_SECRET', code: 'must_be_unset' });
        expect(issues).toContainEqual({ name: 'EZIL_OS_ACCESS_MODE', code: 'local_only' });
    });

    it('preserves support for explicitly configured non-local development', () => {
        const configured = { ...valid, SUPABASE_DATABASE_URL: 'postgresql://user:password@db.example.test/postgres', NEXT_PUBLIC_SUPABASE_URL: 'https://auth.example.test' };
        expect(checkDevelopmentEnvironment(configured)).toEqual([]);
        expect(checkDevelopmentEnvironment(configured, true)).toHaveLength(2);
        expect(checkDevelopmentEnvironment({ ...valid, CRON_SECRET: '' })).toContainEqual({ name: 'CRON_SECRET', code: 'invalid' });
    });
});

describe('local mutation boundaries', () => {
    it('requires a local Docker socket before starting or stopping containers', () => {
        expect(isLocalDockerEndpoint('unix:///var/run/docker.sock')).toBe(true);
        expect(isLocalDockerEndpoint('npipe:////./pipe/docker_engine')).toBe(true);
        for (const endpoint of ['ssh://cloud-host', 'tcp://cloud-host:2376', 'https://cloud-host', '']) {
            expect(isLocalDockerEndpoint(endpoint)).toBe(false);
        }
    });

    it.each([
        'https://project.supabase.co', 'http://localhost:55321', 'http://127.1:55321',
        'http://2130706433:55321', 'http://127.0.0.1:55321@remote.test',
        'http://127.0.0.1:55321/redirect', 'http://127.0.0.1:54321',
    ])('rejects API targets outside the dedicated project: %s', (API_URL) => {
        expect(() => parseLocalStatus({ ...status, API_URL })).toThrow('supabase_status');
    });

    it.each([
        'postgresql://postgres:secret@db.example.test:55322/postgres',
        'postgresql://postgres:secret@127.0.0.1:54322/postgres',
        'postgresql://postgres:secret@127.0.0.1:55322/other',
        'postgresql://postgres:secret@127.0.0.1:55322/postgres?host=remote.test',
        'postgresql://postgres:secret@127.1:55322/postgres',
    ])('rejects non-local or ambiguous database targets: %s', (DB_URL) => {
        expect(() => parseLocalStatus({ ...status, DB_URL })).toThrow('supabase_status');
    });

    it('keeps the service key and cloud credentials out of app configuration', () => {
        const contents = localEnvironment(status);
        expect(contents).toContain('EZIL_OS_ACCESS_MODE=invite');
        expect(contents).not.toContain(status.SERVICE_ROLE_KEY);
        expect(contents).not.toContain('CLOUDFLARE');
        expect(contents).not.toContain('CRON_SECRET');
        expect(() => localEnvironment({ ...status, DB_URL: status.DB_URL.replace('local-password', '$EXPAND_ME') })).toThrow('DB_URL');
    });
});

describe('repeatable setup state', () => {
    it('preserves existing environment files, even a modified generated file', async () => {
        const file = path.join(await temporaryDirectory(), '.env.local');
        await writePrivateFileOnce(file, 'user-owned-contents');
        await expect(writePrivateFileOnce(file, localEnvironment(status))).rejects.toThrow('already exists');
        expect(await readFile(file, 'utf8')).toBe('user-owned-contents');
        const generated = path.join(await temporaryDirectory(), '.env.local');
        await writePrivateFileOnce(generated, localEnvironment(status));
        await expect(writePrivateFileOnce(generated, localEnvironment({ ...status, ANON_KEY: 'changed' }))).rejects.toThrow('already exists');
    });

    it('retains both passwords on rerun and uses private file permissions', async () => {
        const directory = await temporaryDirectory();
        await privateDirectory(directory);
        const file = path.join(directory, 'accounts.json');
        const accounts = await localAccounts(file);
        expect(await localAccounts(file)).toEqual(accounts);
        expect(accounts[0].password).not.toBe(accounts[1].password);
        if (process.platform !== 'win32') {
            expect((await stat(file)).mode & 0o777).toBe(0o600);
            expect((await stat(directory)).mode & 0o777).toBe(0o700);
        }
    });

    it.skipIf(process.platform === 'win32')('refuses symlinked environment files', async () => {
        const directory = await temporaryDirectory();
        const original = path.join(directory, 'original');
        const alias = path.join(directory, '.env.local');
        await writePrivateFileOnce(original, 'preserve');
        await symlink(original, alias);
        await expect(writePrivateFileOnce(alias, 'replace')).rejects.toThrow('regular file');
        expect(await readFile(original, 'utf8')).toBe('preserve');
    });

    it('applies only the unapplied suffix and refuses changed or unknown migration history', () => {
        const migrations: Migration[] = [
            { name: '0000.sql', hash: 'first', sql: 'create table first_table (id int)' },
            { name: '0001.sql', hash: 'second', sql: 'create table second_table (id int)' },
        ];
        expect(pendingMigrations(migrations, [])).toEqual(migrations);
        expect(pendingMigrations(migrations, migrations.slice(0, 1))).toEqual(migrations.slice(1));
        expect(pendingMigrations(migrations, migrations)).toEqual([]);
        expect(() => pendingMigrations(migrations, [{ name: '0000.sql', hash: 'changed' }])).toThrow('history differs');
        expect(() => pendingMigrations(migrations, [{ name: 'unknown.sql', hash: 'first' }])).toThrow('history differs');
        expect(() => pendingMigrations(migrations, [migrations[1]])).toThrow('history differs');
    });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseReticleOrigins, parseReticlePaths, persistentReticleToken, prepareReticleProject, requireReticleMounts } from '../src/reticle-adapter.js';

test('uses explicitly approved mounts without broadening them to their parent directories', () => {
    assert.deepEqual(parseReticlePaths('/workspace/projects', '/data/reticle'), {
        project: '/workspace/projects', privateData: '/data/reticle', mounts: ['/workspace/projects', '/data/reticle'],
    });
    assert.deepEqual(parseReticlePaths().mounts, ['/project', '/data']);
    for (const [project, data] of [['/workspace/../etc', '/data/state'], ['/workspace/projects', '/data'],
        ['/workspace/projects', undefined], [undefined, '/data/reticle']]) {
        assert.throws(() => parseReticlePaths(project, data), /invalid_reticle_paths/);
    }
    const parentMounts = '1 0 1:1 / /workspace rw - ext4 /dev/test rw\n2 0 1:1 / /data rw - ext4 /dev/test rw';
    assert.throws(() => requireReticleMounts(parentMounts, parseReticlePaths('/workspace/projects', '/data/reticle').mounts),
        /reticle_mount_required/);
});

test('initializes only the selected project state and refuses escaping state links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezil-reticle-project-'));
    try {
        await prepareReticleProject(root);
        const state = join(root, '.reticle');
        assert.ok((await stat(state)).isDirectory());
        await writeFile(join(state, 'existing'), 'preserved');
        await prepareReticleProject(root);
        assert.equal(await readFile(join(state, 'existing'), 'utf8'), 'preserved');
        await rm(state, { recursive: true });
        await symlink(join(root, 'outside'), state);
        await assert.rejects(prepareReticleProject(root), { message: 'reticle_project_unavailable' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('requires exact approved origins and rejects credential-bearing or wildcard URLs', () => {
    assert.deepEqual(parseReticleOrigins('["https://i-example.apps.ezil.org","http://127.0.0.1:5301"]'),
        ['https://i-example.apps.ezil.org', 'http://127.0.0.1:5301']);
    for (const value of [undefined, '[]', '["*"]', '["https://*.example"]', '["http://example.com"]', '["https://a.example/path"]',
        '["https://user:password@a.example"]', '["https://a.example","https://a.example"]']) {
        assert.throws(() => parseReticleOrigins(value), /invalid_reticle_origins/);
    }
});

test('the adapter cannot start on its empty image directories or temporary filesystems', () => {
    const table = '1 0 1:1 / /project rw - ext4 /dev/test rw\n2 0 1:1 / /data rw - ext4 /dev/test rw';
    assert.doesNotThrow(() => requireReticleMounts(table));
    for (const invalid of ['', table.split('\n')[0]!, table.replace('/data rw', '/data ro'),
        table.replaceAll('ext4', 'tmpfs'), table.replaceAll('ext4', 'overlay')]) {
        assert.throws(() => requireReticleMounts(invalid), /reticle_mount_required/);
    }
});

test('persists one private pairing token across concurrent starts and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezil-reticle-token-'));
    const dir = join(root, 'private');
    try {
        const tokens = await Promise.all(Array.from({ length: 8 }, () => persistentReticleToken(dir)));
        assert.equal(new Set(tokens).size, 1);
        assert.match(tokens[0]!, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(await persistentReticleToken(dir), tokens[0]);
        const file = join(dir, 'pairing-token');
        assert.equal((await stat(file)).mode & 0o077, 0);
        assert.equal((await readFile(file, 'utf8')).trim(), tokens[0]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('unwritable, permissive, malformed or symlinked token storage fails closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezil-reticle-token-'));
    const dir = join(root, 'private');
    try {
        await mkdir(dir, { mode: 0o700 });
        const file = join(dir, 'pairing-token');
        await writeFile(file, 'sensitive bad token', { mode: 0o600 });
        await assert.rejects(persistentReticleToken(dir), { message: 'pairing_token_unavailable' });
        await rm(file);
        await symlink(join(root, 'outside'), file);
        await assert.rejects(persistentReticleToken(dir), { message: 'pairing_token_unavailable' });
        await rm(file);
        await chmod(dir, 0o755);
        await assert.rejects(persistentReticleToken(dir), { message: 'pairing_token_unavailable' });
        await chmod(dir, 0o700);
        await assert.rejects(persistentReticleToken('/dev/null/private'), { message: 'pairing_token_unavailable' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

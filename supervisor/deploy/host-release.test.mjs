import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, inventory, limits, parseRelease, required } from './host-release.mjs';

const fixture = () => ({ schemaVersion: 1, sourceCommit: 'a'.repeat(40), nodeMajor: 24,
    files: [...required, 'node_modules/zod/index.js'].sort().map(path => ({ path, bytes: 3, sha256: hash(Buffer.from('abc')) })) });
const parse = (value, digest) => { const bytes = Buffer.from(JSON.stringify(value)); return parseRelease(bytes, digest ?? hash(bytes)); };
test('release binds exact bytes, required entrypoints, locked dependencies and pinned SSM documents', () => {
    const value = fixture(); assert.deepEqual(parse(value), value);
    assert.throws(() => parse(value, '0'.repeat(64)), { message: 'host_release_invalid' });
    for (const path of required) assert.throws(() => parse({ ...value, files: value.files.filter(f => f.path !== path) }));
});
test('versions, unknown data, duplicate/unsorted files and resource limits fail with redacted errors', () => {
    for (const change of [v => { v.schemaVersion = 2; }, v => { v.nodeMajor = 25; }, v => { v.secret = 'sensitive-sentinel'; },
        v => { v.sourceCommit = 'main'; }, v => { v.files.reverse(); }, v => { v.files.push(v.files[0]); },
        v => { v.files[0].bytes = limits.file + 1; }, v => { v.files[0].bytes = -1; },
        v => { v.files[0].bytes = 0.5; }, v => { v.files[0].sha256 = 'tag'; }, v => { v.files[0].mode = '777'; }]) {
        const value = fixture(); change(value); assert.throws(() => parse(value), { message: 'host_release_invalid' });
    }
    assert.throws(() => parseRelease(Buffer.alloc(limits.manifest + 1), 'a'.repeat(64)), { message: 'host_release_invalid' });
});
test('publisher files, paths outside the release, alternate separators and native modules are rejected', () => {
    for (const path of ['/etc/control.key', '../secret', 'dist/../../secret', 'dist//x', 'dist/./x', 'dist/x\\y',
        'dist/x\n', '.env', 'node_modules/x/native.node', 'deploy/extra.service', 'node_modules/x/secret value']) {
        const value = fixture(); value.files[0].path = path; value.files.sort((a, b) => a.path.localeCompare(b.path));
        assert.throws(() => parse(value), { message: 'host_release_invalid' });
    }
});
test('inventory hashes regular files and rejects symbolic and hard links without following them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezil-release-'));
    try {
        await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/host.js'), 'abc');
        assert.deepEqual(await inventory(root), [{ path: 'dist/host.js', bytes: 3, sha256: hash(Buffer.from('abc')) }]);
        await symlink('host.js', join(root, 'dist/linked.js'));
        await assert.rejects(inventory(root), { message: 'host_release_invalid' });
        await rm(join(root, 'dist/linked.js')); await link(join(root, 'dist/host.js'), join(root, 'dist/hard.js'));
        await assert.rejects(inventory(root), { message: 'host_release_invalid' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

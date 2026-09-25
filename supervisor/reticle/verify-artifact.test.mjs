import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyArtifact } from './verify-artifact.mjs';

test('artifact hashes bind bytes and internal links; native modules and escaping links are rejected', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ezil-artifact-'));
    const root = join(parent, 'artifact');
    try {
        await mkdir(join(root, 'dist'), { recursive: true });
        await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@reticlehq/server', version: '3.2.0' }));
        for (const path of ['LICENSE', 'LICENSE-ENTERPRISE', 'dist/index.js']) await writeFile(join(root, path), 'fixture');
        await symlink('dist/index.js', join(root, 'internal'));
        const before = await verifyArtifact(root);
        assert.equal(before.links, 1);
        assert.deepEqual(await verifyArtifact(root), before);
        await writeFile(join(root, 'dist/index.js'), 'changed');
        assert.notEqual((await verifyArtifact(root)).treeDigest, before.treeDigest);
        await writeFile(join(root, 'unsafe.node'), 'native');
        await assert.rejects(verifyArtifact(root), /artifact_unsupported/);
        await rm(join(root, 'unsafe.node'));
        await writeFile(join(parent, 'outside'), 'private');
        await symlink('../outside', join(root, 'escape'));
        await assert.rejects(verifyArtifact(root), /artifact_escaping_link/);
    } finally { await rm(parent, { recursive: true, force: true }); }
});

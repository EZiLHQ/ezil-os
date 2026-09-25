import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitMountedDataVolume, verifyDataVolumeEvidence } from '../src/data-volume.js';

const identity = { computerId: '11111111-1111-4111-8111-111111111111', volumeId: 'vol-0123456789abcdef0' };
const marker = JSON.stringify({ schemaVersion: 1, ...identity });
const mount = (point = '/srv/ezil-data', options = 'rw', filesystem = 'ext4', root = '/') =>
    `80 23 259:2 ${root} ${point} ${options},relatime - ${filesystem} /dev/nvme1n1 ${options}\n`;

test('accepts matching read-write ext4 or XFS evidence', () => {
    for (const fs of ['ext4', 'xfs']) assert.deepEqual(
        verifyDataVolumeEvidence('/srv/ezil-data', identity, mount('/srv/ezil-data', 'rw', fs), marker), { ok: true });
});

test('a directory, bind of another directory, wrong filesystem or read-only mount never admits apps', () => {
    for (const [table, code] of [
        ['', 'data_mount_missing'],
        [mount('/srv/elsewhere'), 'data_mount_missing'],
        [mount() + mount(), 'data_mount_missing'],
        [mount('/srv/ezil-data', 'ro'), 'data_mount_readonly'],
        [mount('/srv/ezil-data', 'rw', 'overlay'), 'data_mount_unsupported'],
        [mount('/srv/ezil-data', 'rw', 'ext4', '/some-directory'), 'data_mount_unsupported'],
    ]) assert.deepEqual(verifyDataVolumeEvidence('/srv/ezil-data', identity, table!, marker), { ok: false, code });
});

test('computer and volume identity must both match; malformed markers contain no authority', () => {
    for (const changed of [
        { ...identity, computerId: '22222222-2222-4222-8222-222222222222' },
        { ...identity, volumeId: 'vol-1123456789abcdef0' },
    ]) assert.deepEqual(verifyDataVolumeEvidence('/srv/ezil-data', identity, mount(), JSON.stringify({ schemaVersion: 1, ...changed })),
        { ok: false, code: 'data_volume_mismatch' });
    for (const invalid of ['secret input value', '{}', JSON.stringify({ schemaVersion: 2, ...identity }),
        JSON.stringify({ schemaVersion: 1, ...identity, approved: true })]) {
        const result = verifyDataVolumeEvidence('/srv/ezil-data', identity, mount(), invalid);
        assert.deepEqual(result, { ok: false, code: 'data_marker_invalid' });
        assert.ok(!JSON.stringify(result).includes('secret input value'));
    }
});

test('the filesystem reader rejects marker symlinks, oversized evidence and missing mount tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezil-volume-test-'));
    const point = join(root, 'data');
    const table = join(root, 'mountinfo');
    const markerPath = join(point, '.ezil-volume.json');
    try {
        await mkdir(point);
        await writeFile(table, mount(point));
        await writeFile(markerPath, marker);
        assert.deepEqual(await admitMountedDataVolume(point, identity, table), { ok: true });
        await rm(markerPath);
        await writeFile(join(root, 'outside-marker'), marker);
        await symlink(join(root, 'outside-marker'), markerPath);
        assert.deepEqual(await admitMountedDataVolume(point, identity, table), { ok: false, code: 'data_marker_invalid' });
        await rm(markerPath);
        await writeFile(markerPath, 'x'.repeat(2049));
        assert.deepEqual(await admitMountedDataVolume(point, identity, table), { ok: false, code: 'data_marker_invalid' });
        await rm(table);
        assert.deepEqual(await admitMountedDataVolume(point, identity, table), { ok: false, code: 'mountinfo_unavailable' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

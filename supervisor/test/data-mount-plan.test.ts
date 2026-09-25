import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_BYTES, DATA_MOUNT, DataMountPlanSchema, decideDataMount, formatIdentity, resolveDataDevice, type BlockDevice } from '../src/data-mount-plan.js';
import { mountComputerDataVolume } from '../src/data-mount.js';

function fixture() {
    const plan = DataMountPlanSchema.parse({ schemaVersion: 1, computerId: '11111111-1111-4111-8111-111111111111',
        volumeId: 'vol-11111111111111111', filesystemUuid: '22222222-2222-4222-8222-222222222222', mode: 'initialize' });
    const base = { size: DATA_BYTES, type: 'disk', ro: false, fstype: null, uuid: null, pkname: null, mountpoints: [null] };
    const disk: BlockDevice = { ...base, name: '/dev/nvme1n1', kname: '/dev/nvme1n1', serial: plan.volumeId.replace('-', ''), 'maj:min': '259:3' };
    const inventory = { blockdevices: [
        { ...base, name: '/dev/nvme0n1', kname: '/dev/nvme0n1', serial: 'vol00000000000000000', 'maj:min': '259:0' },
        { ...base, name: '/dev/nvme0n1p1', kname: '/dev/nvme0n1p1', serial: null, type: 'part', pkname: '/dev/nvme0n1', 'maj:min': '259:1', mountpoints: ['/'] }, disk] };
    const evidence = { mountInfo: '', marker: null as string | null, attempt: null as unknown };
    const mounted = () => { disk.fstype = 'ext4'; disk.uuid = plan.filesystemUuid; disk.mountpoints = [DATA_MOUNT];
        evidence.mountInfo = `80 23 259:3 / ${DATA_MOUNT} rw,nosuid,nodev,relatime - ext4 /dev/nvme1n1 rw\n`; };
    const marker = () => JSON.stringify({ schemaVersion: 1, computerId: plan.computerId, volumeId: plan.volumeId });
    return { plan, disk, inventory, evidence, mounted, marker };
}
test('resolves the exact full EBS serial independently of NVMe enumeration', () => {
    const f = fixture(); assert.deepEqual(resolveDataDevice(f.plan, f.inventory), f.disk);
    f.disk.name = '/dev/nvme9n1'; f.disk.kname = f.disk.name;
    assert.equal(resolveDataDevice(f.plan, f.inventory).name, '/dev/nvme9n1');
});
test('requires one root, one complete target and no partitions, aliases or other mount', () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [f => { f.inventory.blockdevices[1]!.mountpoints = [null]; },
        f => { f.disk.mountpoints = ['/']; }, f => { f.disk.serial = 'vol00000000000000000'; },
        f => { f.inventory.blockdevices.push({ ...f.disk, name: '/dev/nvme2n1', kname: '/dev/nvme2n1', 'maj:min': '259:4' }); },
        f => { f.inventory.blockdevices.push({ ...f.disk, serial: null, name: '/dev/nvme1n1p1', kname: '/dev/nvme1n1p1', pkname: f.disk.name, 'maj:min': '259:5' }); },
        f => { f.disk.ro = true; }, f => { f.disk.size = DATA_BYTES - 1; }, f => { f.disk.mountpoints = ['/other']; },
        f => { f.inventory.blockdevices[0]!.mountpoints = [DATA_MOUNT]; }, f => { f.disk.name = '/dev/root'; },
        f => { f.disk.type = 'part'; }, f => { f.disk.pkname = '/dev/nvme0n1'; }];
    for (const change of changes) { const f = fixture(); change(f); assert.throws(() => resolveDataDevice(f.plan, f.inventory)); }
});
test('only explicit first use of an unattempted blank disk selects initialization', () => {
    const f = fixture(); assert.equal(decideDataMount(f.plan, f.disk, f.evidence), 'initialize');
    f.plan.mode = 'mount'; assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence));
    f.plan.mode = 'initialize'; f.evidence.attempt = formatIdentity(f.plan);
    assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence));
});
test('an interrupted successful format is observed without a second format', () => {
    const f = fixture(); f.disk.fstype = 'ext4'; f.disk.uuid = f.plan.filesystemUuid; f.evidence.attempt = formatIdentity(f.plan);
    assert.equal(decideDataMount(f.plan, f.disk, f.evidence), 'mount');
    f.mounted(); assert.equal(decideDataMount(f.plan, f.disk, f.evidence), 'mark');
    f.evidence.marker = f.marker(); assert.equal(decideDataMount(f.plan, f.disk, f.evidence), 'ready');
});
test('replacement mounts an identified existing filesystem without format authority or an old root journal', () => {
    const f = fixture(); f.plan.mode = 'mount'; f.disk.fstype = 'ext4'; f.disk.uuid = f.plan.filesystemUuid;
    assert.equal(decideDataMount(f.plan, f.disk, f.evidence), 'mount');
    f.mounted(); assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence));
    f.evidence.marker = f.marker(); assert.equal(decideDataMount(f.plan, f.disk, f.evidence), 'ready');
});
test('an existing unmarked filesystem cannot be adopted without this exact recorded format attempt', () => {
    const f = fixture(); f.mounted(); assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence));
    f.evidence.attempt = { ...formatIdentity(f.plan), filesystemUuid: '33333333-3333-4333-8333-333333333333' };
    assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence));
});
test('wrong disk, root bind, stacked or read-only mounts never report ready', () => {
    for (const replace of [(s: string) => s.replace('259:3', '259:9'), (s: string) => s.replace(' / ', ' /folder '),
        (s: string) => s + s, (s: string) => s.replace('rw,nosuid,nodev', 'ro,nosuid,nodev'),
        (s: string) => s.replace('nosuid,', ''), (s: string) => s.replace('nodev,', ''), (s: string) => s.replace(' - ext4 ', ' - xfs ')]) {
        const f = fixture(); f.mounted(); f.evidence.marker = f.marker(); f.evidence.mountInfo = replace(f.evidence.mountInfo);
        assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence));
    }
});
test('wrong filesystem, UUID or identity marker never reinitializes existing data', () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [f => { f.disk.fstype = 'xfs'; }, f => { f.disk.uuid = null; },
        f => { f.evidence.marker = '{}'; }, f => { f.evidence.marker = f.marker().replace(f.plan.computerId, '33333333-3333-4333-8333-333333333333'); }];
    for (const change of changes) { const f = fixture(); f.mounted(); f.evidence.marker = f.marker(); change(f); assert.throws(() => decideDataMount(f.plan, f.disk, f.evidence)); }
});
test('plans reject arbitrary devices, mount roots, unknown fields and formatting options', () => {
    const f = fixture();
    for (const extra of [{ device: '/dev/root' }, { mountPoint: '/tmp' }, { force: true }, { schemaVersion: 2 }, { mode: 'format' }])
        assert.equal(DataMountPlanSchema.safeParse({ ...f.plan, ...extra }).success, false);
});
test('non-Linux and unprivileged processes fail before touching disk', async () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0) await assert.rejects(mountComputerDataVolume('/untrusted'), /^Error: data_mount_unconfirmed$/);
});
test('direct and symlinked entrypoints reject missing authority instead of silently exiting successfully', () => {
    const root = mkdtempSync(join(tmpdir(), 'ezil-mount-entry-'));
    const source = fileURLToPath(new URL('../src/data-mount.ts', import.meta.url));
    const alias = join(root, 'code');
    try {
        symlinkSync(dirname(source), alias, process.platform === 'win32' ? 'junction' : 'dir');
        for (const entry of [source, join(alias, 'data-mount.ts')]) {
            assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', entry], { encoding: 'utf8', stdio: 'pipe' }),
                (e: unknown) => { const error = e as { status: number; stdout: string; stderr: string };
                    return error.status === 1 && error.stdout === '' && error.stderr === 'data_mount_unconfirmed\n'; });
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

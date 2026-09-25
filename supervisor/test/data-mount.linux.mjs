import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, writeFile, unlink, rename, chmod, symlink, link, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { acquireHostLock } from '../dist/host-lock.js';
import { DATA_BYTES, DATA_MOUNT, resolveDataDevice, formatIdentity } from '../dist/data-mount-plan.js';

// Destructive fixture setup is restricted to a disposable QEMU VM, a fixed
// test NVMe serial, a separate root disk, and the explicit initialize phase.
// Never use a privileged container, EC2 host, real data volume or shared VM.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const phase = process.argv[2];
assert.ok(['initialize', 'verify', 'replacement'].includes(phase));
assert.equal(process.argv.length, 3);
const exec = promisify(execFile);
const command = (file, args, timeout = 15000) => exec(file, args, { timeout, maxBuffer: 1048576,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } });
assert.equal((await command('/usr/bin/systemd-detect-virt', ['--vm'])).stdout.trim(), 'qemu');
const plan = { schemaVersion: 1, computerId: '11111111-1111-4111-8111-111111111111',
    volumeId: 'vol-11111111111111111', filesystemUuid: '22222222-2222-4222-8222-222222222222', mode: 'mount' };
const config = '/etc/ezil-supervisor/data-volume.json';
const attempt = `/var/lib/ezil-bootstrap/${plan.volumeId}.json`;
const marker = `${DATA_MOUNT}/.ezil-volume.json`, savedMarker = `${DATA_MOUNT}/marker-test-backup.json`;
const cli = new URL('../dist/data-mount.js', import.meta.url).pathname;
const absent = path => assert.rejects(stat(path), { code: 'ENOENT' });
const inventory = async () => JSON.parse((await command('/usr/bin/lsblk',
    ['--json', '--list', '--bytes', '--paths', '--output', 'NAME,KNAME,TYPE,SIZE,RO,FSTYPE,UUID,PKNAME,SERIAL,MOUNTPOINTS,MAJ:MIN'])).stdout);
const device = resolveDataDevice(plan, await inventory());
async function durable(path, bytes, exclusive = false) {
    const file = await open(path, exclusive ? 'wx' : 'w', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
const setPlan = (changes = {}) => durable(config, JSON.stringify({ ...plan, ...changes }));
const mount = () => command(process.execPath, [cli, config], 930000);
async function denied() {
    await assert.rejects(mount(), error => error.code === 1 && error.stdout === '' && error.stderr === 'data_mount_unconfirmed\n');
}
async function ready() {
    assert.deepEqual(JSON.parse((await mount()).stdout), { state: 'mounted', computerId: plan.computerId,
        volumeId: plan.volumeId, filesystemUuid: plan.filesystemUuid });
}
async function assertBlank() {
    await assert.rejects(command('/usr/sbin/blkid', ['--probe', '--output', 'export', device.name]), error => error.code === 2);
}

if (phase === 'initialize') {
    assert.equal(device.fstype, null); assert.equal(device.uuid, null);
    assert.ok(device.mountpoints.every(p => p === null));
    await absent(attempt); await absent(config);
    await mkdir('/etc/ezil-supervisor', { mode: 0o700 });
    await setPlan(); await denied(); await assertBlank(); await absent(attempt);
    console.log('PASS retained mode refuses a blank disk without formatting');

    await setPlan({ mode: 'initialize' });
    await mkdir('/var/lib/ezil-bootstrap', { mode: 0o700, recursive: true });
    await durable(attempt, JSON.stringify(formatIdentity(plan)), true);
    await denied(); await assertBlank();
    assert.deepEqual(JSON.parse(await readFile(attempt)), formatIdentity(plan));
    await unlink(attempt); // This is a simulated attempt on the known blank fixture only.
    console.log('PASS ambiguous prior format attempt is preserved and never retried');

    const lock = await acquireHostLock('data-mount');
    try { await denied(); await assertBlank(); await absent(attempt); }
    finally { await lock.release(); }
    console.log('PASS concurrent bootstrap is fenced by the real host flock');

    // A signature-free disk can still contain data. Plant a fixture byte near
    // the end, then restore only that byte after the initializer rejects it.
    const disk = await open(device.name, 'r+');
    try {
        const previous = Buffer.alloc(1); await disk.read(previous, 0, 1, DATA_BYTES - 4096);
        assert.equal(previous[0], 0);
        await disk.write(Buffer.from([123]), 0, 1, DATA_BYTES - 4096); await disk.sync();
        await denied(); await assertBlank(); await absent(attempt);
        await disk.write(Buffer.from([0]), 0, 1, DATA_BYTES - 4096); await disk.sync();
    } finally { await disk.close(); }
    console.log('PASS signature-free nonzero media is not formatted');

    await ready();
    assert.deepEqual(JSON.parse(await readFile(attempt)), formatIdentity(plan));
    assert.deepEqual(JSON.parse(await readFile(marker)), { schemaVersion: 1, computerId: plan.computerId, volumeId: plan.volumeId });
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
    await setPlan(); await ready();
    console.log('PASS first initialization records durable identity and then mounts without format authority');

    await mkdir(`${DATA_MOUNT}/Projects/demo/.git`, { recursive: true, mode: 0o700 });
    await mkdir(`${DATA_MOUNT}/Documents`, { mode: 0o700 });
    await durable(`${DATA_MOUNT}/Projects/demo/.git/config`, 'persistent-git-fixture\n', true);
    await durable(`${DATA_MOUNT}/Documents/original`, 'durable-computer-fixture\n', true);
    await rename(`${DATA_MOUNT}/Documents/original`, `${DATA_MOUNT}/Documents/renamed`);
    await durable(`${DATA_MOUNT}/Documents/deleted`, 'remove-me', true); await unlink(`${DATA_MOUNT}/Documents/deleted`);
    // Kill after COMMIT with another transaction still open: WAL recovery must
    // retain committed data and discard the unfinished change.
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        import { writeFileSync } from 'node:fs';
        const db = new DatabaseSync('${DATA_MOUNT}/Documents/state.sqlite');
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE state(value TEXT); BEGIN; INSERT INTO state VALUES ('committed'); COMMIT; BEGIN; INSERT INTO state VALUES ('uncommitted');");
        writeFileSync('${DATA_MOUNT}/Documents/transaction-open', 'ready');
        setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    const closed = new Promise(resolve => child.once('exit', resolve));
    try {
        let observed = false;
        for (let n = 0; n < 100; n++) {
            try { observed = (await readFile(`${DATA_MOUNT}/Documents/transaction-open`, 'utf8')) === 'ready'; } catch { /* wait */ }
            if (observed) break; await delay(50);
        }
        assert.equal(observed, true);
    } finally { child.kill('SIGKILL'); await closed; }
    await command('/usr/bin/sync', []);
}

if (phase === 'replacement') {
    await absent(config); await absent(attempt);
    await mkdir('/etc/ezil-supervisor', { mode: 0o700 });
    await setPlan(); await ready(); await absent(attempt);
    console.log('PASS a new root mounts retained data without an initialization journal or format authority');
} else { await setPlan(); await ready(); }

assert.equal(await readFile(`${DATA_MOUNT}/Projects/demo/.git/config`, 'utf8'), 'persistent-git-fixture\n');
assert.equal(await readFile(`${DATA_MOUNT}/Documents/renamed`, 'utf8'), 'durable-computer-fixture\n');
await absent(`${DATA_MOUNT}/Documents/original`); await absent(`${DATA_MOUNT}/Documents/deleted`);
const db = new DatabaseSync(`${DATA_MOUNT}/Documents/state.sqlite`);
assert.deepEqual(db.prepare('SELECT value FROM state').all().map(row => row.value), ['committed']); db.close();
console.log('PASS .git, rename, deletion and committed SQLite state survive; an interrupted transaction does not');

const validMarker = await readFile(marker);
for (const changed of [{ filesystemUuid: '33333333-3333-4333-8333-333333333333' }, { volumeId: 'vol-99999999999999999' }]) {
    await setPlan(changed); await denied(); assert.deepEqual(await readFile(marker), validMarker);
}
await setPlan();
await rename(marker, savedMarker);
try {
    await denied();
    await symlink(savedMarker, marker); await denied(); await unlink(marker);
    await link(savedMarker, marker); await denied(); await unlink(marker);
    await command('/usr/bin/mkfifo', ['--mode=600', marker]); await denied(); await unlink(marker);
    await durable(marker, JSON.stringify({ ...JSON.parse(validMarker), computerId: '33333333-3333-4333-8333-333333333333' }), true);
    await denied(); await unlink(marker);
    await durable(marker, validMarker, true); await chmod(marker, 0o644); await denied(); await unlink(marker);
} finally {
    try { await unlink(marker); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(savedMarker, marker);
}
await ready();
console.log('PASS wrong volume/UUID and missing, foreign, linked, FIFO or public markers block readiness with redacted errors');

// Use the shipped mount unit and the supervisor unit's dependency ordering.
// Substitute only Docker and the host process with a readiness probe: this is
// mount admission evidence, not an authenticated running-supervisor test.
const mountUnit = '/etc/systemd/system/ezil-data-mount.service';
const probeUnit = '/run/systemd/system/ezil-supervisor.service';
await absent(probeUnit);
await writeFile(mountUnit, await readFile(new URL('../deploy/ezil-data-mount.service', import.meta.url)));
const template = await readFile(new URL('../deploy/ezil-supervisor.service', import.meta.url), 'utf8');
const probe = template.replaceAll('docker.service ', '').replace('ExecStart=/usr/local/bin/node /opt/ezil-supervisor/dist/host.js /etc/ezil-supervisor/config.json',
    'ExecStart=/usr/bin/touch /run/ezil-data-readiness-probe').replace('Restart=on-failure', 'Restart=no');
assert.notEqual(template, probe); await writeFile(probeUnit, probe);
const ctl = args => command('/usr/bin/systemctl', ['--no-pager', ...args], 60000);
try {
    await ctl(['daemon-reload']); await ctl(['stop', 'ezil-supervisor.service', 'ezil-data-mount.service']);
    await setPlan({ filesystemUuid: '33333333-3333-4333-8333-333333333333' });
    await assert.rejects(ctl(['start', 'ezil-supervisor.service'])); await absent('/run/ezil-data-readiness-probe');
    await setPlan(); await ctl(['reset-failed', 'ezil-data-mount.service']);
    await ctl(['start', 'ezil-supervisor.service']);
    // Type=simple reports start before the child performs its first write.
    for (let n = 0; n < 100; n++) {
        try { await stat('/run/ezil-data-readiness-probe'); break; }
        catch (e) { if (e.code !== 'ENOENT') throw e; await delay(20); }
    }
    assert.ok(await stat('/run/ezil-data-readiness-probe'));
    console.log('PASS systemd refuses the dependent service on mount failure and admits it only after mount verification');
} finally {
    await setPlan(); await ctl(['stop', 'ezil-supervisor.service']);
    await unlink(probeUnit); await ctl(['daemon-reload']);
    try { await unlink('/run/ezil-data-readiness-probe'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await ctl(['enable', 'ezil-data-mount.service']);
await command('/usr/bin/sync', []);
console.log(`PASS data-volume ${phase}; next verify after an actual VM reboot or a fresh root with the same retained data disk`);

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, open, readFile, realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Docker } from '../dist/docker.js';
import { parseHostConfig } from '../dist/host-config.js';
import { signControlRequest } from '../dist/control-auth.js';
import { canonicalJson } from '../dist/control-protocol.js';
import { resolveDataDevice } from '../dist/data-mount-plan.js';

// Only the dedicated QEMU fixture from DATA-VOLUME.md is eligible. This tests
// the actual shipped host and Docker daemon, without application images or
// cloud credentials. No formatting, privileged test containers or test service
// substitutes. Reticle/browser/EC2 acceptance remains separate.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const phase = process.argv[2];
assert.ok(['setup', 'verify'].includes(phase)); assert.equal(process.argv.length, 3);
const execute = promisify(execFile);
const run = (file, args, timeout = 15000) => execute(file, args, { timeout, maxBuffer: 1048576,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
const ctl = (...args) => run('/usr/bin/systemctl', ['--no-pager', ...args], 90000);
assert.equal((await run('/usr/bin/systemd-detect-virt', ['--vm'])).stdout.trim(), 'qemu');
assert.equal(await realpath('/opt/ezil-supervisor'), await realpath(new URL('..', import.meta.url)));
const mountPlan = { schemaVersion: 1, computerId: '11111111-1111-4111-8111-111111111111',
    volumeId: 'vol-11111111111111111', filesystemUuid: '22222222-2222-4222-8222-222222222222', mode: 'mount' };
const directory = '/etc/ezil-supervisor';
const planPath = `${directory}/data-volume.json`, configPath = `${directory}/config.json`;
const recordPath = `${directory}/retained-host-test.json`;
const dataRoot = '/srv/ezil-data', unit = 'ezil-supervisor.service', mountUnit = 'ezil-data-mount.service';
assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')), mountPlan);
const inventory = JSON.parse((await run('/usr/bin/lsblk', ['--json', '--list', '--bytes', '--paths', '--output',
    'NAME,KNAME,TYPE,SIZE,RO,FSTYPE,UUID,PKNAME,SERIAL,MOUNTPOINTS,MAJ:MIN'])).stdout);
const disk = resolveDataDevice(mountPlan, inventory);
assert.equal(disk.uuid, mountPlan.filesystemUuid); assert.equal(disk.fstype, 'ext4');
const docker = new Docker();
assert.deepEqual(await docker.call('GET', '/containers/json?all=true'), [], 'requires a dedicated empty Docker daemon');
const absent = path => assert.rejects(stat(path), { code: 'ENOENT' });
async function durable(path, value, exclusive = false) {
    const file = await open(path, exclusive ? 'wx' : 'w', 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const config = parseHostConfig({ schemaVersion: 1, configurationRevision: 1,
    computerId: mountPlan.computerId, computerGeneration: 1, volumeId: mountPlan.volumeId, dataRoot,
    stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts',
    controlPort: 24818, memoryBudgetMiB: 2048, suspended: false, approvedInstallations: [] });
const configurationDigest = digest(canonicalJson(config));
let secret, record;
if (phase === 'setup') {
    await absent(configPath); await absent(`${directory}/control.key`); await absent(recordPath);
    await absent('/run/systemd/system/ezil-supervisor.service'); // refuse the old readiness probe
    secret = randomBytes(32);
    await durable(`${directory}/control.key`, secret, true);
    await durable(configPath, JSON.stringify(config), true);
    record = { bootId, configurationDigest,
        gitDigest: digest(await readFile(`${dataRoot}/Projects/demo/.git/config`)),
        documentDigest: digest(await readFile(`${dataRoot}/Documents/renamed`)) };
    await durable(recordPath, JSON.stringify(record), true);
    for (const name of [unit, mountUnit]) {
        await copyFile(new URL(`../deploy/${name}`, import.meta.url), `/etc/systemd/system/${name}`);
    }
    await ctl('daemon-reload'); await ctl('enable', unit, mountUnit); await ctl('start', unit);
} else {
    record = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.notEqual(bootId, record.bootId, 'verify requires an actual VM reboot');
    assert.equal(configurationDigest, record.configurationDigest);
    secret = await readFile(`${directory}/control.key`);
    assert.equal((await ctl('is-active', unit)).stdout.trim(), 'active', 'boot must start the real host automatically');
}
assert.equal(secret.length, 32);
const request = changes => ({ schemaVersion: 1, requestId: randomUUID(), computerId: mountPlan.computerId,
    computerGeneration: 1, operation: 'configuration', ...changes });
function signed(value) {
    const body = Buffer.from(JSON.stringify(value));
    return { method: 'POST', body, headers: { 'content-type': 'application/json',
        ...signControlRequest('POST', '/v1/control', body, secret) }, signal: AbortSignal.timeout(2000) };
}
const send = value => fetch('http://127.0.0.1:24818/v1/control', value);
async function ready() {
    for (let n = 0; n < 100; n++) {
        try {
            const response = await send(signed(request()));
            if (response.status === 200) {
                assert.deepEqual(await response.json(), { computerId: mountPlan.computerId,
                    computerGeneration: 1, configurationRevision: 1, configurationDigest });
                return;
            }
            await response.body?.cancel();
        } catch (error) { if (error instanceof assert.AssertionError) throw error; }
        await delay(100);
    }
    throw new Error('loaded_host_not_ready');
}
async function notServing() {
    assert.equal((await ctl('show', unit, '--property=MainPID', '--value')).stdout.trim(), '0');
    await assert.rejects(send(signed(request())));
}
async function stop() {
    await ctl('stop', unit); await notServing();
    const journal = (await run('/usr/bin/journalctl', ['-u', unit, '-n', '30', '--output=cat', '--no-pager'])).stdout;
    assert(journal.includes('{"event":"host_stopped"}'), 'clean shutdown actually completed');
}
try {
    await ready();
    const pid = (await ctl('show', unit, '--property=MainPID', '--value')).stdout.trim();
    assert.match(pid, /^[1-9][0-9]*$/);
    const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    assert.deepEqual(cmdline, ['/usr/local/bin/node', '/opt/ezil-supervisor/dist/host.js', configPath]);
    const journal = (await run('/usr/bin/journalctl', ['-u', unit, '-n', '30', '--output=cat', '--no-pager'])).stdout;
    assert(journal.includes('{"event":"host_ready"}'));
    console.log('PASS real systemd host runs through the installed symlink and acknowledges its exact configuration');

    const unsigned = await send({ method: 'POST', body: JSON.stringify(request()), headers: { 'content-type': 'application/json' } });
    assert.equal(unsigned.status, 401); await unsigned.body?.cancel();
    const foreign = await send(signed(request({ computerId: randomUUID() })));
    assert.equal(foreign.status, 403); await foreign.body?.cancel();
    const replay = signed(request());
    const first = await send(replay); assert.equal(first.status, 200); await first.body?.cancel();
    await stop(); await ctl('start', unit); await ready();
    const duplicate = await send({ ...replay, signal: AbortSignal.timeout(2000) });
    assert.equal(duplicate.status, 401); assert.equal((await duplicate.json()).code, 'replayed_request');
    await assert.rejects(run('/usr/local/bin/node', ['/opt/ezil-supervisor/dist/host.js', configPath]),
        error => error.code === 1 && error.stdout === '{"event":"host_already_running"}\n');
    console.log('PASS unsigned and cross-computer requests, replay after service restart and a duplicate host are refused');

    assert.equal(digest(await readFile(`${dataRoot}/Projects/demo/.git/config`)), record.gitDigest);
    assert.equal(digest(await readFile(`${dataRoot}/Documents/renamed`)), record.documentDigest);
    await absent(`${dataRoot}/Documents/original`); await absent(`${dataRoot}/Documents/deleted`);
    const db = new DatabaseSync(`${dataRoot}/Documents/state.sqlite`, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT value FROM state').all().map(row => row.value), ['committed']); }
    finally { db.close(); }
    assert.deepEqual(await docker.call('GET', '/containers/json?all=true'), [], 'boot and configuration reads do not allocate applications');
    console.log('PASS existing .git, rename, deletion and committed SQLite state remain intact; metadata reads start no apps');

    await stop(); await ctl('stop', mountUnit);
    try {
        await durable(planPath, JSON.stringify({ ...mountPlan, filesystemUuid: randomUUID() }));
        await assert.rejects(ctl('start', unit)); await notServing();
        assert.equal((await ctl('show', mountUnit, '--property=Result', '--value')).stdout.trim(), 'exit-code');
    } finally {
        await durable(planPath, JSON.stringify(mountPlan));
        await ctl('reset-failed', mountUnit); await ctl('start', unit); await ready();
    }
    console.log('PASS wrong filesystem identity blocks the actual service; restored authority allows authenticated startup');
    await stop();
    console.log(`PASS retained-host ${phase}; host stopped, disk retained; no application or AWS acceptance claimed`);
} finally { secret.fill(0); await ctl('stop', unit); }

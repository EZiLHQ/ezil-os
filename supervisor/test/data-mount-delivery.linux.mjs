import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { readFile, writeFile, readdir, unlink, stat, mkdir, open, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../dist/control-protocol.js';
import { receiveDataMount } from '../dist/data-mount-receiver.js';
import { acquireHostLock } from '../dist/host-lock.js';
import { resolveDataDevice, formatIdentity } from '../dist/data-mount-plan.js';
import { mountComputerDataVolume } from '../dist/data-mount.js';
import { prepareHostConfiguration } from '../dist/prepare.js';

// Only a disposable QEMU VM with its own fixed test disk. Real Linux block I/O,
// locks and systemd; local IMDS/S3 fixtures. This is not AWS/SSM acceptance.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const phase = process.argv[2];
assert.ok(['initialize', 'retained', 'verify'].includes(phase)); assert.equal(process.argv.length, 3);
const exec = promisify(execFile);
const command = (file, args, timeout = 15000) => exec(file, args, { timeout, maxBuffer: 1048576,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } });
assert.equal((await command('/usr/bin/systemd-detect-virt', ['--vm'])).stdout.trim(), 'qemu');
const plan = { schemaVersion: 1, computerId: '11111111-1111-4111-8111-111111111111',
    volumeId: 'vol-11111111111111111', filesystemUuid: '22222222-2222-4222-8222-222222222222', mode: 'mount' };
const PLAN = '/etc/ezil-supervisor/data-volume.json', AUTH = '/etc/ezil-supervisor/data-mount-authorization.json',
    HOST = '/etc/ezil-supervisor/provisioning.json', ATTEMPT = `/var/lib/ezil-bootstrap/${plan.volumeId}.json`;
const absent = path => assert.rejects(stat(path), { code: 'ENOENT' });
const inventory = async () => JSON.parse((await command('/usr/bin/lsblk',
    ['--json', '--list', '--bytes', '--paths', '--output', 'NAME,KNAME,TYPE,SIZE,RO,FSTYPE,UUID,PKNAME,SERIAL,MOUNTPOINTS,MAJ:MIN'])).stdout);
const device = resolveDataDevice(plan, await inventory());
const bootId = () => readFile('/proc/sys/kernel/random/boot_id', 'utf8');
const state = '/var/lib/ezil-bootstrap/mount-delivery-acceptance.json';
const readState = async () => JSON.parse(await readFile(state, 'utf8'));
async function assertSaved() {
    assert.equal(await readFile('/srv/ezil-data/Documents/mount-delivery', 'utf8'), 'durable-delivery-fixture\n');
    assert.equal(await readFile('/srv/ezil-data/Projects/mount-delivery/.git/config', 'utf8'), 'retained-git\n');
    await absent('/srv/ezil-data/Documents/deleted-by-delivery-test');
    const db = new DatabaseSync('/srv/ezil-data/Documents/delivery.sqlite');
    assert.deepEqual(db.prepare('SELECT value FROM state').all().map(row => row.value), ['committed']); db.close();
}
if (phase === 'verify') {
    const saved = await readState(); assert.notEqual(await bootId(), saved.bootId, 'must actually reboot the VM');
    assert.equal((await command('/usr/bin/systemctl', ['is-active', 'ezil-data-mount.service'])).stdout.trim(), 'active');
    assert.deepEqual(JSON.parse(await readFile(PLAN)), plan); await absent(AUTH);
    await assertSaved();
    console.log('PASS reboot mounts retained state with no delivery or initialization authority');
    process.exit(0);
}

// No real application containers or foreign host authority may be present.
assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
await command('/usr/bin/systemctl', ['stop', 'ezil-supervisor.service', 'ezil-data-mount.service']);
await command('/usr/bin/systemctl', ['disable', 'ezil-supervisor.service']);
await absent(AUTH); await absent(HOST); await absent(state); await absent(ATTEMPT);
assert.deepEqual(JSON.parse(await readFile(PLAN)), plan);
if (phase === 'initialize') {
    assert.equal(device.fstype, null); assert.equal(device.uuid, null); assert.ok(device.mountpoints.every(p => p === null));
} else { assert.equal(device.fstype, 'ext4'); assert.equal(device.uuid, plan.filesystemUuid); }
await unlink(PLAN); // Only the inspected fixture's mount-only controller file.
const host = { schemaVersion: 1, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot', bucket: 'ezil-pilot-config',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    scope: { computerId: plan.computerId, computerGeneration: phase === 'initialize' ? 1 : 2, fenceToken: randomUUID(),
        providerInstanceId: 'i-11111111111111111', dataVolumeId: plan.volumeId } };
await writeFile(HOST, JSON.stringify(host), { flag: 'wx', mode: 0o600 });
const candidateConfig = '/etc/ezil-supervisor/mount-delivery-candidate.json';
const activeConfig = '/etc/ezil-supervisor/mount-delivery-active.json';
const configuration = { schemaVersion: 1, computerId: plan.computerId, computerGeneration: host.scope.computerGeneration,
    configurationRevision: 1, volumeId: plan.volumeId, suspended: false, preparedInstallations: [], approvedInstallations: [],
    dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts',
    controlPort: 8181, memoryBudgetMiB: 3072 };
await absent(activeConfig); await writeFile(candidateConfig, canonicalJson(configuration), { flag: 'wx', mode: 0o600 });
if (phase === 'initialize') {
    await assert.rejects(prepareHostConfiguration(candidateConfig, activeConfig), /data_mount_missing|data_marker_invalid/);
    await absent(activeConfig);
}
let desired, bytes, approval;
async function authorize(mode = 'mount', changes = {}) {
    bytes = Buffer.from(canonicalJson({ ...plan, mode }));
    const now = Math.floor(Date.now() / 1000), digest = createHash('sha256').update(bytes).digest('hex');
    approval = { schemaVersion: 1, authorizationId: randomUUID(), scope: host.scope, filesystemUuid: plan.filesystemUuid,
        mode, digest, issuedAt: now, expiresAt: now + 900, ...changes };
    desired = { schemaVersion: 1, authorizationId: approval.authorizationId, scope: host.scope, digest,
        object: { bucket: host.bucket, key: `pilot/computers/${plan.computerId}/generations/${host.scope.computerGeneration}/data-mounts/${approval.authorizationId}.json`,
            versionId: 'version-1', sha256: digest, bytes: bytes.length } };
    await writeFile(AUTH, JSON.stringify(approval), { mode: 0o600 });
}
let fault = '', calls = 0;
const server = createServer((req, res) => {
    if (req.url === '/latest/api/token') { assert.equal(req.method, 'PUT'); return res.end('local-imds-token'); }
    assert.equal(req.headers['x-aws-ec2-metadata-token'], 'local-imds-token');
    if (req.url === '/latest/dynamic/instance-identity/document') return res.end(JSON.stringify({ accountId: host.accountId,
        region: host.region, instanceId: fault === 'identity' ? 'i-22222222222222222' : host.scope.providerInstanceId }));
    if (req.url === '/latest/meta-data/iam/security-credentials/') return res.end('ComputerRole');
    res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'vm-fixture-key',
        Token: 'vm-fixture-session', Expiration: new Date(Date.now() + 3600000).toISOString() }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const options = {
    metadataRequest: (input, callback) => {
        assert.equal(input.hostname, '169.254.169.254');
        return request({ ...input, hostname: '127.0.0.1', port: server.address().port }, callback);
    },
    requestHandler: { handle: async req => {
        calls++; assert.equal(req.hostname, 's3.us-east-1.amazonaws.com', 'no registry, arbitrary URL or additional AWS call');
        assert.equal(req.method, 'GET'); assert.equal(req.query.versionId, 'version-1');
        assert.equal(req.headers['x-amz-expected-bucket-owner'], host.accountId);
        if (fault === 'fence') await writeFile(AUTH, JSON.stringify({ ...approval, scope: { ...host.scope, fenceToken: randomUUID() } }));
        return { response: { statusCode: 200, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length),
            'x-amz-version-id': fault === 'version' ? 'other-version' : 'version-1', 'x-amz-server-side-encryption': 'aws:kms',
            'x-amz-server-side-encryption-aws-kms-key-id': host.kmsKeyArn,
            'x-amz-checksum-sha256': Buffer.from(desired.digest, 'hex').toString('base64') },
            body: Readable.from([fault === 'content' ? Buffer.alloc(bytes.length) : bytes]) } };
    } },
};
try {
    await assert.rejects(receiveDataMount({}, options), /data_mount_delivery_unavailable/); await absent(PLAN);
    await authorize('mount', { expiresAt: Math.floor(Date.now() / 1000) });
    await assert.rejects(receiveDataMount(desired, options), /data_mount_delivery_invalid/); await absent(PLAN);
    await authorize();
    await assert.rejects(receiveDataMount({ ...desired, scope: { ...host.scope, computerGeneration: 9 } }, options), /data_mount_delivery_invalid/);
    assert.equal(calls, 0);
    for (const value of ['identity', 'version', 'content', 'fence']) {
        fault = value; await assert.rejects(receiveDataMount(desired, options), /data_mount_delivery_(unavailable|fenced)/);
        await absent(PLAN); await absent(ATTEMPT); await authorize();
    }
    fault = '';
    console.log('PASS missing/expired authority, wrong writer, IMDS, version, content and authority replacement fail before disk delivery');
    const signal = AbortSignal.abort();
    await assert.rejects(receiveDataMount(desired, { ...options, signal }), /data_mount_delivery_cancelled/); await absent(PLAN);
    const lock = await acquireHostLock('data-mount-delivery');
    try { await assert.rejects(receiveDataMount(desired, options), /data-mount-delivery_already_running/); }
    finally { await lock.release(); }
    if (phase === 'initialize') {
        await assert.rejects(receiveDataMount(desired, options), /data_mount_unconfirmed/);
        assert.deepEqual(JSON.parse(await readFile(PLAN)), plan); await absent(ATTEMPT);
        await authorize('initialize');
        // Revoke just after the real durable attempt journal is created. The
        // injected authority guard must still prevent mkfs, leaving ambiguity.
        const guarded = '/run/ezil-supervisor/guarded-initialize.json';
        await writeFile(guarded, bytes, { mode: 0o600, flag: 'wx' });
        try {
            await assert.rejects(mountComputerDataVolume(guarded, AbortSignal.timeout(900000), async () => {
                let attempted = false;
                try { await stat(ATTEMPT); attempted = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (attempted) throw new Error('simulated_authority_revoked');
            }), /simulated_authority_revoked/);
        } finally { await unlink(guarded); }
        const before = await readFile(ATTEMPT);
        await assert.rejects(receiveDataMount(desired, options), /data_mount_unconfirmed/);
        assert.deepEqual(await readFile(ATTEMPT), before);
        assert.equal(resolveDataDevice(plan, await inventory()).fstype, null);
        await unlink(ATTEMPT); // Simulated attempt on verified blank fixture only.
        console.log('PASS mount-only denial and late authority revocation prevent formatting; uncertain attempts are preserved');
    }
    const receipt = await receiveDataMount(desired, options);
    assert.equal(receipt.state, 'mounted'); assert.equal(receipt.digest, desired.digest);
    assert.deepEqual(receipt.scope, host.scope); assert.deepEqual(JSON.parse(await readFile(PLAN)), plan);
    if (phase === 'retained') await absent(ATTEMPT);
    else assert.deepEqual(JSON.parse(await readFile(ATTEMPT)), formatIdentity(plan));
    const marker = await readFile('/srv/ezil-data/.ezil-volume.json');
    assert.deepEqual(await receiveDataMount(desired, options), receipt);
    assert.deepEqual(await readFile('/srv/ezil-data/.ezil-volume.json'), marker);
    await writeFile(PLAN, JSON.stringify({ ...plan, filesystemUuid: '33333333-3333-4333-8333-333333333333' }));
    await assert.rejects(receiveDataMount(desired, options), /data_mount_plan_conflict/);
    await writeFile(PLAN, canonicalJson(plan));
    assert.deepEqual((await readdir('/run/ezil-supervisor')).filter(name => /^data-mount-.*\.json$/.test(name)), []);
    console.log(`PASS ${phase} delivery, idempotent retry, permanent mount-only plan, conflict denial and temporary-file cleanup`);
    const prepared = await prepareHostConfiguration(candidateConfig, activeConfig);
    assert.equal(prepared.configurationDigest, createHash('sha256').update(canonicalJson(configuration)).digest('hex'));
    assert.deepEqual(prepared.preparedImages, []);
    assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
    console.log('PASS real configuration preparation follows mount delivery and starts no applications');
    await mkdir('/srv/ezil-data/Documents', { recursive: true, mode: 0o700 });
    await mkdir('/srv/ezil-data/Projects/mount-delivery/.git', { recursive: true, mode: 0o700 });
    async function persist(path, content) {
        const file = await open(path, 'wx', 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    }
    await persist('/srv/ezil-data/Documents/delivery-original', 'durable-delivery-fixture\n');
    await rename('/srv/ezil-data/Documents/delivery-original', '/srv/ezil-data/Documents/mount-delivery');
    await persist('/srv/ezil-data/Projects/mount-delivery/.git/config', 'retained-git\n');
    await persist('/srv/ezil-data/Documents/deleted-by-delivery-test', 'delete'); await unlink('/srv/ezil-data/Documents/deleted-by-delivery-test');
    const db = new DatabaseSync('/srv/ezil-data/Documents/delivery.sqlite');
    db.exec("PRAGMA synchronous=FULL; CREATE TABLE state(value TEXT); BEGIN; INSERT INTO state VALUES ('committed'); COMMIT;"); db.close();
    await assertSaved();
    await unlink(AUTH); // Reboot must not need fresh authority or any network.
    await writeFile('/etc/systemd/system/ezil-data-mount.service', await readFile(new URL('../deploy/ezil-data-mount.service', import.meta.url)));
    await command('/usr/bin/systemctl', ['daemon-reload']);
    await command('/usr/bin/systemctl', ['enable', 'ezil-data-mount.service']);
    await writeFile(state, JSON.stringify({ bootId: await bootId() }), { mode: 0o600, flag: 'wx' });
    await command('/usr/bin/sync', []);
    console.log('PASS data saved; reboot this VM, then run verify');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

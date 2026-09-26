import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, lstat, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapControlHost } from '../dist/control-bootstrap.js';
import { canonicalJson } from '../dist/control-protocol.js';
import { receiveConfiguration } from '../dist/configuration-receiver.js';
import { receiveDataMount } from '../dist/data-mount-receiver.js';
import { MountOperationStore, ensureDurableDirectory } from '../dist/mount-operation-store.js';
import { ControlStore } from '../dist/control-store.js';
import { observeSupervisor, stopSupervisor } from '../dist/supervisor-start.js';
import { controlSecretIdentity } from '../dist/control-bootstrap-contract.js';
import { observeComputerDataVolume } from '../dist/data-mount.js';

// Dedicated overlay of the retained host-installation QEMU fixture only. Real
// mount/preparation/systemd/signed HTTP; IMDS/S3/Secrets Manager are local wire
// fixtures. This is not AWS IAM, control-plane issuance or tunnel acceptance.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const phase = process.argv[2]; assert.ok(['run', 'verify'].includes(phase)); assert.equal(process.argv.length, 3);
const exec = promisify(execFile), command = (file, args, timeout = 90000) => exec(file, args, {
    timeout, maxBuffer: 1048576, env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
const ctl = (...args) => command('/usr/bin/systemctl', ['--no-pager', ...args]);
assert.equal((await command('/usr/bin/systemd-detect-virt', ['--vm'])).stdout.trim(), 'qemu');
assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
const root = '/etc/ezil-supervisor', saved = '/var/lib/ezil-first-start-acceptance.json';
const plan = { schemaVersion: 1, computerId: '55555555-5555-4555-8555-555555555555', volumeId: 'vol-33333333333333333',
    filesystemUuid: '44444444-4444-4444-8444-444444444444', mode: 'mount' };
assert.deepEqual(JSON.parse(await readFile(`${root}/data-volume.json`)), plan);
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = path => assert.rejects(lstat(path), { code: 'ENOENT' });
async function protectedFile(path, value) { await writeFile(path, canonicalJson(value), { flag: 'wx', mode: 0o600 }); }
let host, configuration, delivery, authorization, binding, mountRecords;
if (phase === 'run') {
    await absent(saved);
    await ctl('stop', 'ezil-supervisor.service'); await ctl('disable', 'ezil-supervisor.service');
    // Preserve the exact known VM-only prior fixture. No source/user secrets.
    for (const name of ['control.key', 'config.json']) await rename(`${root}/${name}`, `${root}/${name}.before-first-start`);
    host = { schemaVersion: 1, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot', bucket: 'ezil-first-start-test',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
        scope: { computerId: plan.computerId, computerGeneration: 1, fenceToken: randomUUID(), providerInstanceId: 'i-33333333333333333', dataVolumeId: plan.volumeId } };
    await protectedFile(`${root}/provisioning.json`, host);
    configuration = { schemaVersion: 1, computerId: plan.computerId, computerGeneration: 1, configurationRevision: 2, volumeId: plan.volumeId,
        dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts',
        controlPort: 8181, memoryBudgetMiB: 3072, suspended: false, preparedInstallations: [], approvedInstallations: [] };
    const bytes = Buffer.from(canonicalJson(configuration)), id = randomUUID(), digest = hash(bytes), mountId = randomUUID(), now = Math.floor(Date.now() / 1000);
    delivery = { schemaVersion: 1, operation: 'prepare', configurationId: id, scope: host.scope, revision: 2, digest,
        object: { bucket: host.bucket, key: `pilot/computers/${plan.computerId}/generations/1/configurations/${id}.json`, versionId: 'config-version', sha256: digest, bytes: bytes.length } };
    const mountBytes = Buffer.from(canonicalJson(plan)), mountDigest = hash(mountBytes);
    mountRecords = { provisioning: host, authorization: { schemaVersion: 1, authorizationId: mountId, scope: host.scope,
        filesystemUuid: plan.filesystemUuid, mode: 'mount', digest: mountDigest, issuedAt: now, expiresAt: now + 900 },
        delivery: { schemaVersion: 1, authorizationId: mountId, scope: host.scope, digest: mountDigest, object: { bucket: host.bucket,
            key: `pilot/computers/${plan.computerId}/generations/1/data-mounts/${mountId}.json`, versionId: 'mount-version', sha256: mountDigest, bytes: mountBytes.length } } };
    authorization = { schemaVersion: 1, authorizationId: randomUUID(), mountAuthorizationId: mountId, configuration: delivery,
        controlDomain: 'control.example.com', secretVersionId: randomUUID(), issuedAt: now, expiresAt: now + 300 };
    binding = { schemaVersion: 1, scope: host.scope, origin: controlSecretIdentity(host, authorization).origin, keyHex: randomBytes(32).toString('hex') };
    await protectedFile(`${root}/data-mount-authorization.json`, mountRecords.authorization);
    await protectedFile(`${root}/control-start-authorization.json`, authorization);
} else {
    const previous = JSON.parse(await readFile(saved)); assert.notEqual(previous.bootId, bootId);
    ({ host, configuration, delivery, authorization, binding, mountRecords } = previous);
    assert.equal((await observeSupervisor(AbortSignal.timeout(5000))).stopped, true);
    // A new controller-issued grant is required after reboot; the previous
    // attempt cannot wake a stopped service. This is a local issuer fixture.
    authorization = { ...authorization, authorizationId: randomUUID(), issuedAt: Math.floor(Date.now()/1000), expiresAt: Math.floor(Date.now()/1000)+300 };
    await writeFile(`${root}/control-start-authorization.json`, canonicalJson(authorization));
}

const server = createServer((req, res) => {
    if (req.url === '/latest/api/token') return res.end('fixture-token');
    if (req.url === '/latest/dynamic/instance-identity/document') return res.end(JSON.stringify({ accountId: host.accountId, region: host.region, instanceId: host.scope.providerInstanceId }));
    if (req.url === '/latest/meta-data/iam/security-credentials/') return res.end('FixtureRole');
    res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'fixture-only', Token: 'fixture-only', Expiration: new Date(Date.now()+3600000).toISOString() }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let onFetch, fetched = 0;
const options = { privateValidation: true,
    metadataRequest: (o, cb) => request({ ...o, hostname: '127.0.0.1', port: server.address().port }, cb),
    requestHandler: { handle: async req => {
        assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /);
        if (req.hostname === 's3.us-east-1.amazonaws.com') {
            const mount = req.query.versionId === 'mount-version', bytes = Buffer.from(canonicalJson(mount ? plan : configuration));
            assert.equal(req.query.versionId, mount ? 'mount-version' : 'config-version');
            return { response: { statusCode: 200, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length),
                'x-amz-version-id': req.query.versionId, 'x-amz-server-side-encryption': 'aws:kms',
                'x-amz-server-side-encryption-aws-kms-key-id': host.kmsKeyArn, 'x-amz-checksum-sha256': Buffer.from(hash(bytes), 'hex').toString('base64') }, body: Readable.from([bytes]) } };
        }
        assert.equal(req.hostname, 'secretsmanager.us-east-1.amazonaws.com'); fetched++; await onFetch?.();
        const { name } = controlSecretIdentity(host, authorization);
        const body = typeof req.body === 'string' ? req.body : Buffer.from(req.body).toString();
        assert.deepEqual(JSON.parse(body), { SecretId: name, VersionId: authorization.secretVersionId, VersionStage: 'AWSCURRENT' });
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify({
            Name: name, ARN: `arn:aws:secretsmanager:us-east-1:${host.accountId}:secret:${name}-ABC123`, VersionId: authorization.secretVersionId,
            VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(binding) })]) } };
    } } };
const call = () => bootstrapControlHost({ schemaVersion: 1, authorizationId: authorization.authorizationId }, options);
const denied = () => assert.rejects(call(), /^Error: control_bootstrap_unconfirmed$/);
const stopped = async () => assert.equal((await observeSupervisor(AbortSignal.timeout(5000))).stopped, true);
try {
    if (phase === 'run') {
        await ensureDurableDirectory('/var/lib/ezil-mount-deliveries');
        const mounts = new MountOperationStore('/var/lib/ezil-mount-deliveries', mountRecords.authorization.authorizationId);
        await mounts.saveRecords(mountRecords); await mounts.mark('dispatched'); await mounts.mark('begun');
        const receipt = await receiveDataMount(mountRecords.delivery, options); // Actual retained device, UUID and marker.
        await mounts.saveReceipt(receipt);
        await observeComputerDataVolume(`${root}/data-volume.json`);
        await command('/usr/bin/umount', ['/srv/ezil-data']);
        await assert.rejects(observeComputerDataVolume(`${root}/data-volume.json`), /data_mount_unconfirmed/);
        assert.equal((await readFile('/proc/self/mountinfo', 'utf8')).split('\n').some(line => line.split(' ')[4] === '/srv/ezil-data'), false);
        await receiveDataMount(mountRecords.delivery, options);
        console.log('PASS read-only device observation confirms the mounted UUID and never remounts a missing disk');
        const store = new ControlStore(configuration.stateDirectory, plan.computerId, 1);
        try {
            assert.equal(store.dispatchDelivery(delivery, Date.now()+900000), true); assert.equal(store.beginDelivery(delivery), true);
            await receiveConfiguration(delivery, options); store.finishDelivery(delivery, true);
        } finally { store.close(); }
        await rename(`${mounts.path}/receipt.json`, `${mounts.path}/receipt.saved`);
        try { await denied(); assert.equal(fetched, 0); await absent(`${root}/control.key`); } finally { await rename(`${mounts.path}/receipt.saved`, `${mounts.path}/receipt.json`); }
        await writeFile(`${root}/control-start-authorization.json`, canonicalJson({ ...authorization, expiresAt: authorization.issuedAt }));
        try { await denied(); assert.equal(fetched, 0); } finally { await writeFile(`${root}/control-start-authorization.json`, canonicalJson(authorization)); }
        onFetch = () => writeFile(`${root}/control-start-authorization.json`, canonicalJson({ ...authorization, authorizationId: randomUUID() }));
        try { await denied(); await absent(`${root}/control.key`); } finally { onFetch = undefined; await writeFile(`${root}/control-start-authorization.json`, canonicalJson(authorization)); }
        await stopped(); console.log('PASS missing mount receipt, expired grant and in-flight authority replacement deny before key installation/start');
        await writeFile(`${root}/key-target`, Buffer.alloc(32), { flag: 'wx', mode: 0o600 });
        await symlink('key-target', `${root}/control.key`);
        try { await denied(); } finally { await unlink(`${root}/control.key`); }
        for (const [bytes, mode] of [[Buffer.alloc(31), 0o600], [Buffer.alloc(32), 0o600], [Buffer.from(binding.keyHex, 'hex'), 0o644]]) {
            await writeFile(`${root}/control.key`, bytes, { flag: 'wx', mode });
            await chmod(`${root}/control.key`, mode);
            try { await denied(); assert.deepEqual(await readFile(`${root}/control.key`), bytes); } finally { await unlink(`${root}/control.key`); }
        }
        await stopped(); console.log('PASS linked, partial, conflicting and world-readable keys are not overwritten');
        // Fail after systemd accepts activation; the receiver must observe and
        // stop it, not claim readiness from the start acknowledgement.
        const drop = '/run/systemd/system/ezil-supervisor.service.d'; await mkdir(drop, { mode: 0o755 });
        await writeFile(`${drop}/first-start-test.conf`, '[Service]\nExecStart=\nExecStart=/usr/bin/false\nRestart=no\n'); await ctl('daemon-reload');
        try {
            await denied(); await stopped();
            assert.deepEqual(JSON.parse(await readFile(`/var/lib/ezil-supervisor-starts/${authorization.authorizationId}.json`)), authorization);
            assert.deepEqual(await readFile(`${root}/control.key`), Buffer.from(binding.keyHex, 'hex'));
            assert.equal((await ctl('show', 'ezil-supervisor.service', '--property=ExecMainStatus', '--value')).stdout.trim(), '1');
        } finally { await unlink(`${drop}/first-start-test.conf`); await ctl('daemon-reload'); await ctl('reset-failed', 'ezil-supervisor.service'); }
        await denied(); await stopped(); // Same consumed attempt cannot start the now healthy unit.
        authorization = { ...authorization, authorizationId: randomUUID() };
        await writeFile(`${root}/control-start-authorization.json`, canonicalJson(authorization));
        console.log('PASS actual post-exec failure and consumed-attempt replay never report/start a ready supervisor');
        await writeFile(`${drop}/first-start-test.conf`, '[Service]\nExecStartPre=/usr/bin/sleep 1\n'); await ctl('daemon-reload');
        let changed;
        onFetch = () => { changed = new Promise(resolve => setTimeout(() => resolve(writeFile(`${root}/control-start-authorization.json`,
            canonicalJson({ ...authorization, authorizationId: randomUUID() }))), 200)); };
        try { await denied(); await changed; await stopped(); }
        finally {
            onFetch = undefined; await unlink(`${drop}/first-start-test.conf`); await ctl('daemon-reload');
            authorization = { ...authorization, authorizationId: randomUUID() };
            await writeFile(`${root}/control-start-authorization.json`, canonicalJson(authorization));
        }
        console.log('PASS authority replacement during actual service activation cancels and observes the unit stopped');
    }
    const result = await call(); assert.equal(result.state, 'started'); assert.equal(result.descriptor.configurationDigest, delivery.digest);
    const pid = (await ctl('show', 'ezil-supervisor.service', '--property=MainPID', '--value')).stdout.trim(); assert.notEqual(pid, '0');
    assert.deepEqual(await call(), result); assert.equal((await ctl('show', 'ezil-supervisor.service', '--property=MainPID', '--value')).stdout.trim(), pid);
    assert.deepEqual(await readFile(`${root}/control.key`), Buffer.from(binding.keyHex, 'hex')); assert.equal((await lstat(`${root}/control.key`)).mode & 0o777, 0o600);
    assert.equal(await readFile('/srv/ezil-data/Documents/renamed', 'utf8'), 'persisted operation\n');
    await absent('/srv/ezil-data/Documents/deleted'); assert.equal(await readFile('/srv/ezil-data/Projects/ssm-test/.git/config', 'utf8'), 'git state\n');
    const db = new DatabaseSync('/srv/ezil-data/Projects/ssm-test/state.sqlite');
    try { assert.deepEqual(db.prepare('SELECT value FROM state').all().map(r => r.value), ['committed']); } finally { db.close(); }
    assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
    console.log(`PASS ${phase}: real signed configuration, same-PID retry, protected raw key and retained files/SQLite; no apps started`);
    await stopSupervisor(); await denied(); await stopped();
    if (phase === 'run') await protectedFile(saved, { bootId, host, configuration, delivery, authorization, binding, mountRecords });
    console.log('PASS consumed startup cannot wake a stopped service; computer remains disabled for automatic boot');
} finally { await stopSupervisor(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

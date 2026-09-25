import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { open, mkdir, writeFile, readFile, rm, chown, rename, chmod, symlink, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Docker } from '../dist/docker.js';
import { DockerComputerDriver } from '../dist/docker-driver.js';
import { signControlRequest } from '../dist/control-auth.js';
import { canonicalJson } from '../dist/control-protocol.js';
import { prepareHostConfiguration } from '../dist/prepare.js';
import { acquireHostLock } from '../dist/host-lock.js';
import { verifyPreparationPull } from './prepare-pull.linux.mjs';
import { verifyConfigurationReceiver } from './configuration-receiver.linux.mjs';

const root = process.env.EZIL_TEST_ROOT, image = process.env.EZIL_TEST_IMAGE;
assert.match(root ?? '', /^\/run\/ezil-driver-test-[a-f0-9-]{36}$/);
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const docker = new Docker();
const reticle = process.env.EZIL_TEST_RETICLE === '1';
const computerId = randomUUID(), installationId = randomUUID(), projectId = randomUUID();
const secret = randomBytes(32), volumeId = 'vol-0123456789abcdef0';
const children = new Set();
let activeHost;
let mounted = false;
const run = (bin, args) => execFileSync(bin, args, { stdio: 'pipe', timeout: 30_000 });
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const plan = { releaseId: randomUUID(), policyDigest: `sha256:${'a'.repeat(64)}`, image,
    services: [{ name: 'daemon', internalPort: 4400, hostPort: 24400,
        process: reticle ? { kind: 'reticle-daemon-v1', projectId, privateDirectory: 'state' }
            : { kind: 'node', entrypoint: 'main.mjs', args: [] },
        health: { path: '/status', status: 200 }, dependsOn: [] }],
    privateDirectories: [{ name: 'state', containerPath: '/data/reticle' }],
    projectGrants: [{ projectId, containerPath: '/workspace/projects', access: 'read-write' }],
    allowedOrigins: ['https://i-test.apps.ezil.org'],
    resources: { cpu: 0.5, memoryMiB: 768, temporaryMiB: 32, maxRuntimeSeconds: 120 } };
const config = { schemaVersion: 1, computerId, computerGeneration: 1, volumeId,
    dataRoot: `${root}/disk`, stateDirectory: `${root}/state`, stagingRoot: `${root}/stage`,
    controlPort: 24818, memoryBudgetMiB: 2048, suspended: false,
    approvedInstallations: [{ installationId, plan }] };
const configPath = `${root}/config/config.json`;
const inputPath = `${root}/config/desired.json`;
let configurationRevision = 1;
const command = (generation = 1, desired = 'running', requested = plan) => ({ schemaVersion: 1,
    requestId: randomUUID(), computerId, computerGeneration: 1, installationId,
    generation, operation: 'reconcile', desired, plan: requested });

async function until(check, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await delay(100); }
    throw new Error('host_acceptance_condition_timeout');
}
function launch(privateValidation = true) {
    const child = spawn('/usr/local/bin/node', ['/code/dist/host.js', configPath,
        ...(privateValidation ? ['--private-validation'] : [])], {
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, output: '', exit: undefined };
    children.add(record);
    child.stdout.on('data', chunk => { record.output += chunk; });
    child.stderr.on('data', chunk => { record.output += chunk; });
    child.on('exit', (code, signal) => { record.exit = { code, signal }; });
    return record;
}
async function ready(record) {
    await until(() => {
        if (record.exit) throw new Error(`host_exited_before_ready: ${record.output}`);
        return record.output.includes('host_ready_private_validation');
    });
    activeHost = record;
}
async function stopped(record, signal = 'SIGTERM') {
    record.child.kill(signal);
    await until(() => record.exit, 40_000);
    if (signal === 'SIGTERM') { assert.equal(record.exit.code, 0); assert(record.output.includes('host_stopped')); }
    else assert.equal(record.exit.signal, signal);
}
function signed(value) {
    const body = Buffer.from(JSON.stringify(value));
    return { method: 'POST', body, headers: { 'content-type': 'application/json',
        ...signControlRequest('POST', '/v1/control', body, secret) } };
}
const send = request => fetch('http://127.0.0.1:24818/v1/control', request);
async function submit(value, expected = value.desired === 'running' ? 'running' : 'stopped') {
    const before = activeHost.output.length;
    assert.equal((await send(signed(value))).status, 202);
    const event = JSON.stringify({ event: 'host_command_settled', installationId: value.installationId,
        generation: value.generation, state: expected });
    await until(() => activeHost.output.slice(before).includes(event));
}
async function owned() {
    const filters = encodeURIComponent(JSON.stringify({ label: [`org.ezil.computer.id=${computerId}`] }));
    const rows = await docker.call('GET', `/containers/json?all=true&filters=${filters}`);
    return Promise.all(rows.map(row => docker.call('GET', `/containers/${row.Id}/json`)));
}
async function serving() {
    try {
        const headers = {};
        if (reticle) {
            const token = (await readFile(`${root}/disk/Applications/${installationId}/state/pairing-token`, 'utf8')).trim();
            headers.Authorization = `Bearer ${token}`;
        }
        const response = await fetch('http://127.0.0.1:24400/status', { headers, signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        return response.status === 200;
    } catch { return false; }
}
async function saveConfig(value) {
    await writeFile(`${configPath}.next`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${configPath}.next`, configPath);
}
async function reload(record, value, expected = 'host_configuration_reloaded') {
    const before = record.output.length;
    await saveConfig({ ...value, configurationRevision: ++configurationRevision });
    record.child.kill('SIGHUP');
    await until(() => record.output.slice(before).includes(expected));
}

try {
    await mkdir(`${root}/disk`); await mkdir(`${root}/config`, { mode: 0o700 });
    const disk = await open(`${root}/disk.img`, 'wx');
    await disk.truncate(64 * 1024 * 1024); await disk.close();
    run('/usr/sbin/mkfs.ext4', ['-q', '-F', `${root}/disk.img`]);
    run('/bin/mount', ['-o', 'loop', `${root}/disk.img`, `${root}/disk`]); mounted = true;
    await writeFile(`${root}/disk/.ezil-volume.json`, JSON.stringify({ schemaVersion: 1, computerId, volumeId }), { mode: 0o600 });
    await mkdir(`${root}/disk/Projects`); await mkdir(`${root}/disk/Projects/${projectId}`);
    await chown(`${root}/disk/Projects/${projectId}`, 1000, 1000);
    await writeFile(`${root}/config/control.key`, secret, { mode: 0o600 });
    await verifyPreparationPull(root, config);
    const preparedOnly = { ...config, approvedInstallations: [], preparedInstallations: [{ installationId,
        releaseId: plan.releaseId, policyDigest: plan.policyDigest, image, privateDirectories: plan.privateDirectories }] };
    await writeFile(inputPath, JSON.stringify(preparedOnly), { mode: 0o600 });
    const prepared = await prepareHostConfiguration(inputPath, configPath, { privateValidation: true });
    assert.equal(prepared.configurationRevision, 1);
    assert.deepEqual(prepared.preparedImages, [{ reference: image, contentId: image }]);
    const cliReceipt = JSON.parse(run('/usr/local/bin/node', ['/code/dist/prepare.js', inputPath, configPath, '--private-validation']).toString());
    assert.equal(cliReceipt.event, 'host_prepared'); assert.equal(cliReceipt.configurationRevision, 1);
    assert.equal((await owned()).length, 0, 'preparation never creates or starts an application');
    const installationHost = launch(); await ready(installationHost);
    assert.equal((await send(signed(command()))).status, 403, 'prepared image does not authorize execution or project access');
    await stopped(installationHost);
    const stateDir = await stat(`${root}/disk/Applications/${installationId}/state`);
    assert.equal(stateDir.uid, 1000); assert.equal(stateDir.mode & 0o777, 0o700);
    const activeDigest = fingerprint(await readFile(configPath));
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(prepareHostConfiguration(inputPath, configPath, { privateValidation: true, signal: cancelled.signal }), /preparation_cancelled/);
    const preparationLock = await acquireHostLock('preparation');
    try { await assert.rejects(prepareHostConfiguration(inputPath, configPath, { privateValidation: true }), /preparation_already_running/); }
    finally { await preparationLock.release(); }
    await rename(`${root}/disk/.ezil-volume.json`, `${root}/disk/held-marker`);
    try { await assert.rejects(prepareHostConfiguration(inputPath, configPath, { privateValidation: true }), /data_marker_invalid/); }
    finally { await rename(`${root}/disk/held-marker`, `${root}/disk/.ezil-volume.json`); }
    const missing = structuredClone(config); missing.configurationRevision = 2;
    missing.approvedInstallations[0].plan.image = `sha256:${'0'.repeat(64)}`;
    await writeFile(inputPath, JSON.stringify(missing), { mode: 0o600 });
    await assert.rejects(prepareHostConfiguration(inputPath, configPath, { privateValidation: true }), /docker_operation_failed/);
    assert.equal(fingerprint(await readFile(configPath)), activeDigest, 'failure keeps the active approval file intact');
    await writeFile(inputPath, JSON.stringify({ ...config, configurationRevision: 2, suspended: true }), { mode: 0o600 });
    await prepareHostConfiguration(inputPath, configPath, { privateValidation: true });
    await writeFile(inputPath, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(prepareHostConfiguration(inputPath, configPath, { privateValidation: true }), /configuration_revision_conflict/);
    configurationRevision = 3;
    await writeFile(inputPath, JSON.stringify({ ...config, configurationRevision }), { mode: 0o600 });
    await prepareHostConfiguration(inputPath, configPath, { privateValidation: true });
    const production = launch(false);
    await until(() => production.exit);
    assert.equal(production.exit.code, 1);
    assert(production.output.includes('production_image_or_origin_required'));

    let host = launch(); await ready(host);
    const descriptor = { schemaVersion: 1, requestId: randomUUID(), computerId, computerGeneration: 1, operation: 'configuration' };
    const loaded = await (await send(signed(descriptor))).json();
    assert.equal(loaded.configurationRevision, configurationRevision);
    assert.equal(loaded.configurationDigest, fingerprint(Buffer.from(canonicalJson({ ...config, configurationRevision, preparedInstallations: [] }))));
    assert.equal((await send({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(descriptor) })).status, 401);
    configurationRevision = await verifyConfigurationReceiver({ root, config, revision: configurationRevision, process: host.child,
        observe: async () => {
            const response = await send(signed({ ...descriptor, requestId: randomUUID() }));
            return response.status === 200 ? response.json() : {};
        }, until, owned });
    const duplicate = launch(); await until(() => duplicate.exit);
    assert.equal(duplicate.exit.code, 1);
    assert(duplicate.output.includes('host_already_running'));
    assert.equal(host.exit, undefined, 'the real first process still owns the lock');
    const wrongInstallation = { ...command(), installationId: randomUUID() };
    assert.equal((await send(signed(wrongInstallation))).status, 403);
    await submit(command()); await until(serving);
    const first = (await owned())[0];
    assert(first.State.Running);
    const expiry = first.Config.Labels['org.ezil.computer.expires'];
    const dataFile = `${root}/disk/Applications/${installationId}/state/${reticle ? 'pairing-token' : 'value'}`;
    if (!reticle) {
        const saved = await fetch('http://127.0.0.1:24400/save', { method: 'POST', body: 'survives-host-restart' });
        assert.equal(saved.status, 200);
    }
    const savedDigest = fingerprint(await readFile(dataFile));
    const observation = signed({ schemaVersion: 1, requestId: randomUUID(), computerId, computerGeneration: 1,
        installationId, operation: 'observe' });
    assert.equal((await send(observation)).status, 200);
    await stopped(host, 'SIGKILL');
    assert.equal((await owned())[0].State.Running, true, 'process crash is not presented as a container stop');
    host = launch(); await ready(host);
    assert.equal((await owned())[0].Id, first.Id);
    assert.equal(await serving(), false, 'boot/observation does not reconnect app routing');
    const replay = await send(observation);
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).code, 'replayed_request', 'nonce reservation survives actual process death');
    await submit(command()); await until(serving);
    assert.equal((await owned())[0].Id, first.Id);
    assert.equal((await owned())[0].Config.Labels['org.ezil.computer.expires'], expiry);
    assert.equal(fingerprint(await readFile(dataFile)), savedDigest);
    await stopped(host);
    assert.equal((await owned())[0].State.Running, false, 'SIGTERM waits for observed Docker stop');
    host = launch(); await ready(host);
    assert.equal((await owned())[0].State.Running, false, 'host boot does not start a stopped app');
    await submit(command()); await until(serving);
    assert.notEqual((await owned())[0].Id, first.Id);
    assert.equal((await owned())[0].Config.Labels['org.ezil.computer.expires'], expiry, 'same-command recreation cannot renew the deadline');
    assert.equal(fingerprint(await readFile(dataFile)), savedDigest);

    await reload(host, { ...config, suspended: true });
    assert.equal((await (await send(signed(descriptor))).json()).configurationRevision, configurationRevision);
    assert.equal((await owned())[0].State.Running, false);
    assert.equal((await send(signed(command()))).status, 403);
    await submit(command(2, 'stopped'));
    await until(async () => (await owned()).length === 0);
    const short = structuredClone(plan); short.resources.maxRuntimeSeconds = reticle ? 8 : 4;
    const shortConfig = { ...config, approvedInstallations: [{ installationId, plan: short }] };
    await reload(host, shortConfig);
    await submit(command(3, 'running', short)); await until(serving);
    const shortId = (await owned())[0].Id;
    // No controller requests while the host independently enforces expiry.
    await until(async () => !(await owned())[0].State.Running, 15_000);
    const before = host.output.length;
    await submit(command(3, 'running', short), 'failed');
    await until(() => host.output.slice(before).includes('computer_reconcile_failed'));
    assert.equal((await owned())[0].Id, shortId);
    assert.equal((await owned())[0].State.Running, false);
    await docker.call('DELETE', `/containers/${shortId}`);
    const retryStart = host.output.length;
    await submit(command(3, 'running', short), 'failed');
    await until(() => host.output.slice(retryStart).includes('computer_reconcile_failed'));
    assert.equal((await owned()).length, 0, 'deleting a container cannot reset its durable runtime allowance');

    await reload(host, config);
    await submit(command(4)); await until(serving);
    assert.equal((await owned())[0].State.Running, true);
    const beforeStale = host.output.length;
    await saveConfig({ ...config, configurationRevision: 1 });
    host.child.kill('SIGHUP');
    await until(() => host.output.slice(beforeStale).includes('host_configuration_reload_failed'));
    assert((await owned()).every(item => !item.State.Running));
    await reload(host, config);
    await submit(command(4)); await until(serving);
    await stopped(host, 'SIGKILL');
    await saveConfig({ ...config, configurationRevision: 1 });
    const staleBoot = launch(); await until(() => staleBoot.exit);
    assert.equal(staleBoot.exit.code, 1);
    assert((await owned()).every(item => !item.State.Running), 'stale boot file stops prior owned containers');
    await saveConfig({ ...config, configurationRevision: ++configurationRevision });
    host = launch(); await ready(host);
    await submit(command(4)); await until(serving);
    await reload(host, { ...config, unexpected: 'sensitive-error-sentinel' }, 'host_configuration_reload_failed');
    assert((await owned()).every(item => !item.State.Running), 'invalid authority reload stops or removes owned apps');
    assert(!host.output.includes('sensitive-error-sentinel'));
    await delay(1200);
    assert.equal((await send(signed(command(4)))).status, 503, 'expiry sweeps cannot reopen invalid authority');
    await stopped(host);
    await saveConfig(config);
    await chmod(configPath, 0o644);
    const permissive = launch(); await until(() => permissive.exit);
    assert.equal(permissive.exit.code, 1);
    assert(permissive.output.includes('host_configuration_unavailable'));
    await chmod(configPath, 0o600);
    await rename(`${root}/config/control.key`, `${root}/config/held.key`);
    await symlink('held.key', `${root}/config/control.key`);
    const linked = launch(); await until(() => linked.exit);
    assert.equal(linked.exit.code, 1);
    assert(linked.output.includes('host_file_unavailable'));
    for (const record of children) assert(!record.output.includes(secret.toString('hex')));
    process.stdout.write(`PASS: actual ${reticle ? 'Reticle' : 'Node'} preparation and host process, kernel locks, atomic approval files, cancelled/failed preparation, stale revision denial, SIGKILL/replay recovery, SIGTERM stop, persisted data, retained deadlines, independent expiry, fail-closed reload and secret files\n`);
} finally {
    for (const record of children) {
        if (!record.exit) { record.child.kill('SIGKILL'); await until(() => record.exit); }
    }
    for (const container of await owned()) await docker.call('DELETE', `/containers/${container.Id}?force=true`);
    const cleanup = new DockerComputerDriver({ computerId, computerGeneration: 1, volume: { computerId, volumeId },
        dataRoot: config.dataRoot, stagingRoot: config.stagingRoot, memoryBudgetMiB: 2048, approvePlan: () => false,
        reserveDeadline: () => { throw new Error('cleanup_must_not_start'); } });
    const cmd = command(100, 'stopped');
    await cleanup.reconcile({ installationId, generation: 100, desired: 'stopped', command: cmd, observed: 'unknown' }, () => true);
    const filters = encodeURIComponent(JSON.stringify({ label: [`org.ezil.computer.id=${computerId}`] }));
    for (const network of await docker.call('GET', `/networks?filters=${filters}`)) await docker.call('DELETE', `/networks/${network.Id}`);
    if (mounted) run('/bin/umount', [`${root}/disk`]);
    await rm(`${root}/disk.img`, { force: true });
    await rm(`${root}/config`, { recursive: true }); await rm(`${root}/state`, { recursive: true });
}

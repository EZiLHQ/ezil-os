import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { open, mkdir, writeFile, readFile, rm, chown, readdir } from 'node:fs/promises';
import { Docker } from '../dist/docker.js';
import { DockerComputerDriver } from '../dist/docker-driver.js';
import { ControlStore } from '../dist/control-store.js';
import { createControlService } from '../dist/control-server.js';
import { signControlRequest } from '../dist/control-auth.js';

const root = process.env.EZIL_TEST_ROOT;
const image = process.env.EZIL_TEST_IMAGE;
assert.match(root ?? '', /^\/run\/ezil-driver-test-[a-f0-9-]{36}$/);
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const docker = new Docker();
const computerId = randomUUID(), installationId = randomUUID(), secondId = randomUUID(), projectId = randomUUID();
const volume = { computerId, volumeId: 'vol-0123456789abcdef0' };
const secret = randomBytes(32);
let approved = true;
const options = { computerId, computerGeneration: 1, volume, dataRoot: `${root}/disk`,
    stagingRoot: `${root}/stage`, memoryBudgetMiB: 2048,
    approvePlan: plan => approved && plan.image === image,
    reserveDeadline: (cmd, proposed) => store.reserveRuntimeDeadline(cmd, proposed) };
let driver = new DockerComputerDriver(options);
let service, store, mounted = false;
const run = (bin, args) => execFileSync(bin, args, { stdio: 'pipe', timeout: 30_000 });
const reticle = process.env.EZIL_TEST_RETICLE === '1';
const plan = { releaseId: randomUUID(), policyDigest: `sha256:${'a'.repeat(64)}`, image,
    services: [{ name: 'daemon', internalPort: 4400, hostPort: 24400,
        process: reticle ? { kind: 'reticle-daemon-v1', projectId, privateDirectory: 'state' }
            : { kind: 'node', entrypoint: 'main.mjs', args: [] },
        health: { path: '/status', status: 200 }, dependsOn: [] }],
    privateDirectories: [{ name: 'state', containerPath: '/data/reticle' }],
    projectGrants: [{ projectId, containerPath: '/workspace/projects', access: 'read-write' }],
    allowedOrigins: ['https://i-test.apps.ezil.org'],
    resources: { cpu: 0.5, memoryMiB: 768, temporaryMiB: 32, maxRuntimeSeconds: 600 } };
const command = (id = installationId, generation = 1, desired = 'running', config = plan) => ({
    schemaVersion: 1, requestId: randomUUID(), computerId, computerGeneration: 1,
    installationId: id, generation, operation: 'reconcile', desired, plan: config,
});
async function post(cmd) {
    const body = Buffer.from(JSON.stringify(cmd));
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/control`, {
        method: 'POST', headers: { 'content-type': 'application/json',
            ...signControlRequest('POST', '/v1/control', body, secret) }, body,
    });
    assert.equal(response.status, 202);
    return response.json();
}
async function owned() {
    const filter = encodeURIComponent(JSON.stringify({ label: [`org.ezil.computer.id=${computerId}`] }));
    const rows = await docker.call('GET', `/containers/json?all=true&filters=${filter}`);
    return Promise.all(rows.map(row => docker.call('GET', `/containers/${row.Id}/json`)));
}
async function startService() {
    service = createControlService({ computerId, computerGeneration: 1, secret, store, driver,
        approvePlan: options.approvePlan });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
}
async function closeService() {
    await service.drain();
    await new Promise(resolve => service.server.close(resolve));
}

try {
    await mkdir(`${root}/disk`); await mkdir(`${root}/stage`); await mkdir(`${root}/control`, { mode: 0o700 });
    const file = await open(`${root}/disk.img`, 'wx');
    await file.truncate(64 * 1024 * 1024); await file.close();
    run('/usr/sbin/mkfs.ext4', ['-q', '-F', `${root}/disk.img`]);
    run('/bin/mount', ['-o', 'loop', `${root}/disk.img`, `${root}/disk`]); mounted = true;
    await writeFile(`${root}/disk/.ezil-volume.json`, JSON.stringify({ schemaVersion: 1, ...volume }), { mode: 0o600 });
    await mkdir(`${root}/disk/Projects`); await mkdir(`${root}/disk/Projects/${projectId}`);
    await chown(`${root}/disk/Projects/${projectId}`, 1000, 1000);
    store = new ControlStore(`${root}/control`, computerId, 1);
    await startService();

    assert.equal((await driver.observe(installationId)).state, 'stopped');
    assert.equal((await owned()).length, 0, 'observation cannot start an app');
    const foreign = await docker.call('POST', '/containers/create', { Image: image,
        Entrypoint: ['/usr/local/bin/node', '-e', 'setInterval(()=>{},1000)'], Cmd: [], User: '1000:1000',
        Labels: { 'org.ezil.computer.id': computerId, 'org.ezil.computer.generation': '2',
            'org.ezil.computer.installation': randomUUID() },
        HostConfig: { Init: true, NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'], Memory: 134217728, PidsLimit: 64 },
    });
    await docker.call('POST', `/containers/${foreign.Id}/start`);
    await post(command()); await service.drain();
    assert.equal(store.get(installationId).observed, 'failed', 'another running computer generation blocks admission');
    assert.equal((await owned()).length, 1);
    assert.equal((await owned())[0].State.Running, true, 'foreign generation is never stopped implicitly');
    await docker.call('DELETE', `/containers/${foreign.Id}?force=true`);
    await Promise.all([post(command()), post(command())]);
    await service.drain();
    assert.equal(store.get(installationId).observed, 'running');
    let containers = await owned();
    assert.equal(containers.length, 1, 'concurrent signed launches deduplicate');
    const first = containers[0];
    assert.equal(first.Image, image);
    assert.equal(first.Config.User, '1000:1000');
    assert.equal(first.HostConfig.ReadonlyRootfs, true);
    assert.equal(first.HostConfig.Privileged, false);
    assert.deepEqual(first.HostConfig.CapDrop, ['ALL']);
    assert.equal(Object.keys(first.HostConfig.PortBindings ?? {}).length, 0);
    assert.equal(first.Config.Labels['org.ezil.computer.host-port'], '24400');
    assert(first.Mounts.every(mount => mount.Source.startsWith(`${root}/stage/`)));
    assert(!JSON.stringify(first.Config.Env).includes(secret.toString('hex')));
    const { Id: execId } = await docker.call('POST', `/containers/${first.Id}/exec`, {
        AttachStdout: false, AttachStderr: false, Cmd: ['/usr/local/bin/node', '-e',
            `Promise.all(['http://169.254.169.254/latest/meta-data/','http://1.1.1.1/'].map(async url=>{
                try { await fetch(url,{signal:AbortSignal.timeout(500)});process.exitCode=31; } catch {} }))`],
    });
    await docker.call('POST', `/exec/${execId}/start`, { Detach: true });
    let execution;
    for (let attempt = 0; attempt < 100; attempt++) {
        execution = await docker.call('GET', `/exec/${execId}/json`);
        if (!execution.Running) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(execution.ExitCode, 0, 'metadata and public network remain unreachable');

    const saved = `${root}/disk/Applications/${installationId}/state`;
    let token;
    if (reticle) {
        token = await readFile(`${saved}/pairing-token`, 'utf8');
        assert.equal((await fetch('http://127.0.0.1:24400/status')).status, 401);
        assert.equal((await fetch('http://127.0.0.1:24400/status', { headers: { Authorization: `Bearer ${token.trim()}` } })).status, 200);
    } else {
        const save = await fetch('http://127.0.0.1:24400/save', { method: 'POST', body: 'persisted-value' });
        assert.equal(save.status, 200);
        assert.equal(await readFile(`${saved}/value`, 'utf8'), 'persisted-value');
    }
    // New driver/service instance simulates a host process restart; it must
    // neither reset the durable replay ledger nor duplicate the container.
    await closeService();
    await driver.close();
    driver = new DockerComputerDriver(options);
    await startService();
    await post(command()); await service.drain();
    assert.equal((await owned())[0].Id, first.Id);
    await post(command(installationId, 2, 'stopped')); await service.drain();
    assert.equal((await driver.observe(installationId)).state, 'stopped');
    assert.equal((await owned()).length, 0);
    assert.equal((await readdir(`${root}/stage`)).length, 0, 'restart recovery releases old staged mounts');
    await post(command(installationId, 3)); await service.drain();
    assert.equal(store.get(installationId).observed, 'running');
    assert.notEqual((await owned())[0].Id, first.Id);
    if (reticle) assert((await readFile(`${saved}/pairing-token`, 'utf8')) === token, 'private token persists');
    else assert.equal(await (await fetch('http://127.0.0.1:24400/value')).text(), 'persisted-value');

    let socketClosed;
    if (!reticle) {
        const socket = new WebSocket('ws://127.0.0.1:24400/ws');
        const message = await new Promise((resolve, reject) => {
            socket.addEventListener('error', reject, { once: true });
            socket.addEventListener('open', () => socket.send('ping'), { once: true });
            socket.addEventListener('message', event => resolve(event.data), { once: true });
        });
        assert.equal(message, 'pong', 'real WebSocket passes through the loopback route');
        socketClosed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    }

    await post(command(secondId)); await service.drain();
    assert.equal(store.get(secondId).observed, 'failed', 'colliding persisted port fails before starting');
    assert.equal((await owned()).length, 1);
    const second = structuredClone(plan);
    second.services[0].hostPort = 24401;
    await post(command(secondId, 2, 'running', second)); await service.drain();
    assert.equal(store.get(secondId).observed, 'running');
    assert.equal((await owned()).length, 2);
    const third = structuredClone(plan); third.services[0].hostPort = 24402;
    const thirdId = randomUUID();
    await post(command(thirdId, 1, 'running', third)); await service.drain();
    assert.equal(store.get(thirdId).observed, 'failed', 'third app is denied by admission');
    assert.equal((await owned()).length, 2);
    approved = false;
    await post(command(secondId, 3, 'stopped', second));
    await post(command(installationId, 4, 'stopped')); await service.drain();
    if (socketClosed) await Promise.race([socketClosed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('websocket_not_revoked')), 2000); timer.unref();
    })]);
    assert.equal((await owned()).length, 0, 'revoked images can still be stopped and removed');
    assert.equal((await readdir(`${root}/stage`)).length, 0);

    approved = true;
    await renameMarker(false);
    await post(command(installationId, 5)); await service.drain();
    assert.equal(store.get(installationId).observed, 'failed', 'missing data evidence blocks launch');
    assert.equal((await owned()).length, 0);
    await renameMarker(true);
    // Cancel a real start after Docker has created its resources, including
    // a deliberately unhealthy Node service. The newer generation wins.
    const pending = structuredClone(plan);
    if (!reticle) pending.services[0].health.path = '/missing';
    await post(command(installationId, 6, 'running', pending));
    for (let attempt = 0; !(await owned()).length && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await owned()).length, 1);
    await post(command(installationId, 7, 'stopped', pending)); await service.drain();
    assert.equal(store.get(installationId).observed, 'stopped');
    assert.equal((await owned()).length, 0);
    if (!reticle) {
        const short = structuredClone(plan); short.resources.maxRuntimeSeconds = 3;
        await post(command(installationId, 8, 'running', short)); await service.drain();
        assert.equal(store.get(installationId).observed, 'running');
        const deadlineId = (await owned())[0].Id;
        await new Promise(resolve => setTimeout(resolve, 3100));
        await driver.expire();
        assert.equal((await driver.observe(installationId)).state, 'stopped');
        await post(command(installationId, 8, 'running', short)); await service.drain();
        assert.equal(store.get(installationId).observed, 'failed');
        assert.equal((await owned())[0].Id, deadlineId, 'retries cannot renew an expired runtime');
        assert.equal((await owned())[0].State.Running, false);
        await post(command(installationId, 9, 'stopped', short)); await service.drain();
    }
    run('/bin/umount', [`${root}/disk`]); mounted = false;
    await post(command(installationId, 10)); await service.drain();
    assert.equal(store.get(installationId).observed, 'failed', 'unmounted data filesystem blocks launch');
    assert.equal((await owned()).length, 0);
    process.stdout.write(`PASS: real ${reticle ? 'Reticle' : 'Node'} container via signed HTTP, launch deduplication, driver recovery, persisted state, ports, quotas, revocation, cancellation, missing disk\n`);
} finally {
    if (service) await closeService();
    await driver.close();
    const rows = await owned();
    for (const row of rows) await docker.call('DELETE', `/containers/${row.Id}?force=true`);
    // Use stopped reconciliation to reclaim only this run's staged slots.
    for (const id of [installationId, secondId]) {
        const cmd = command(id, 99, 'stopped');
        await driver.reconcile({ installationId: id, generation: 99, desired: 'stopped', command: cmd, observed: 'unknown' }, () => true);
    }
    const filters = encodeURIComponent(JSON.stringify({ label: [`org.ezil.computer.id=${computerId}`] }));
    for (const net of await docker.call('GET', `/networks?filters=${filters}`)) await docker.call('DELETE', `/networks/${net.Id}`);
    store?.close();
    if (mounted) run('/bin/umount', [`${root}/disk`]);
    await rm(`${root}/disk.img`, { force: true });
    await rm(`${root}/control`, { recursive: true });
}
async function renameMarker(restore) {
    const { rename } = await import('node:fs/promises');
    const marker = `${root}/disk/.ezil-volume.json`;
    await rename(restore ? `${marker}.held` : marker, restore ? marker : `${marker}.held`);
}

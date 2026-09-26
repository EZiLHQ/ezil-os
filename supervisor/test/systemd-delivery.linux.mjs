import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { manageDelivery, openDeliveryHost } from '../dist/delivery-operation.js';
import { SystemdDelivery } from '../dist/systemd-delivery.js';
import { deliveryKey } from '../dist/control-store.js';

// Run only in a disposable Linux VM/isolated machine with real systemd and
// cgroup v2. Do NOT boot privileged systemd containers in a shared Docker VM:
// systemd-binfmt can unregister the VM's cross-architecture interpreters.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const exec = promisify(execFile);
const ctl = args => exec('/usr/bin/systemctl', ['--no-pager', ...args], { timeout: 25000, maxBuffer: 8192 });
await ctl(['show', '--property=Version']);
const id = randomUUID().replaceAll('-', ''), prefix = `ezil-config-test-${id}`;
const root = `/var/lib/${prefix}`, unitFile = `/run/systemd/system/${prefix}@.service`;
const host = { schemaVersion: 1, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot', bucket: 'test-config-bucket',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc',
    scope: { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-0123456789abcdef0',
        dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() } };
const options = { privateValidation: true, provisioningPath: `${root}/provisioning.json`, stateDirectory: `${root}/state`, unitPrefix: prefix };
const driver = new SystemdDelivery(prefix), owned = [];
function value(revision = 1) {
    const configurationId = randomUUID();
    const reference = { schemaVersion: 1, operation: 'prepare', configurationId, scope: host.scope, revision, digest: 'a'.repeat(64),
        object: { bucket: host.bucket, key: `pilot/computers/${host.scope.computerId}/generations/1/configurations/${configurationId}.json`,
            versionId: 'version-1', sha256: 'a'.repeat(64), bytes: 100 } };
    owned.push(deliveryKey(reference)); return reference;
}
const call = (action, delivery, deadline) => manageDelivery({ schemaVersion: 1, action, delivery,
    ...(action === 'start' ? { deadline: deadline ?? Date.now() + 90000 } : {}) }, options);
async function until(check, milliseconds = 15000) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) { const result = await check(); if (result) return result; await delay(50); }
    throw new Error('systemd_delivery_acceptance_timeout');
}
await mkdir(root, { mode: 0o700 });
try {
    await writeFile(options.provisioningPath, JSON.stringify(host), { mode: 0o600 });
    const executor = new URL('../dist/delivery-executor.js', import.meta.url).href;
    const descriptor = new URL('../dist/configuration-delivery-contract.js', import.meta.url).href;
    const fixture = `import { executeDelivery } from ${JSON.stringify(executor)};
import { descriptor } from ${JSON.stringify(descriptor)};
import { appendFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const root=${JSON.stringify(root)};
executeDelivery(process.argv[2], { ...${JSON.stringify(options)}, receive: async (value, signal) => {
 await appendFile(root+'/starts',value.configurationId+'\\n');
 if(value.revision===2)throw new Error('sensitive-fixture-error');
 if(value.revision===3) {
   const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
   await writeFile(root+'/child',String(child.pid));
   await new Promise(()=>{});
 }
 if(value.revision===4) await new Promise((resolve,reject)=>{
   if(signal.aborted)return reject(new Error('deadline'));
   signal.addEventListener('abort',()=>reject(new Error('deadline')),{once:true});
 });
 if(value.revision===5) await new Promise(()=>{});
 return {schemaVersion:1,operation:value.operation,configurationId:value.configurationId,scope:value.scope,descriptor:descriptor(value)};
}}).catch(()=>{process.exitCode=1});`;
    await writeFile(`${root}/executor.mjs`, fixture, { mode: 0o600 });
    const template = await readFile(new URL('../deploy/ezil-configuration@.service', import.meta.url), 'utf8');
    const testUnit = template.replace('ExecStart=/usr/local/bin/node /opt/ezil-supervisor/dist/delivery-executor.js %i',
        `ExecStart=${process.execPath} ${root}/executor.mjs %i`);
    assert.notEqual(template, testUnit);
    await writeFile(unitFile, testUnit); await ctl(['daemon-reload']);
    const a = value();
    assert.equal((await call('observe', a)).status, 'absent');
    await assert.rejects(readFile(`${root}/starts`), { code: 'ENOENT' });
    await call('start', a);
    const succeeded = await until(async () => { const r = await call('observe', a); return r.status === 'succeeded' && r; });
    assert.equal(succeeded.result.descriptor.configurationDigest, a.digest);
    assert.equal((await driver.observe(deliveryKey(a))).quiescent, true);
    await call('start', a, Date.now() + 120000);
    assert.equal((await readFile(`${root}/starts`, 'utf8')).trim().split('\n').filter(x => x === a.configurationId).length, 1);
    console.log('PASS real systemd start, exact receipt, quiescence, no-wake observation and duplicate dispatch');

    const b = value(2); await call('start', b);
    await until(async () => (await call('observe', b)).status === 'failed');
    assert.equal((await call('observe', b)).result, undefined);
    console.log('PASS failed receiver never becomes a successful preparation');

    const c = value(3); await call('start', c);
    const pid = await until(async () => { try { return Number(await readFile(`${root}/child`, 'utf8')); } catch { return false; } });
    assert.equal((await call('observe', c)).status, 'running');
    assert.equal((await call('cancel', c)).status, 'cancelled');
    assert.equal((await driver.observe(deliveryKey(c))).quiescent, true);
    await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
    assert.equal((await call('start', c)).status, 'cancelled');
    console.log('PASS cancellation kills receiver and stubborn child; late dispatch stays cancelled');

    const d = value(); assert.equal((await call('cancel', d)).status, 'cancelled');
    assert.equal((await call('start', d)).status, 'cancelled');
    // Bypass the manager to simulate a previously queued service start arriving
    // after cancellation. The executor itself must enforce the persisted fence.
    await driver.start(deliveryKey(d));
    await until(async () => (await driver.observe(deliveryKey(d))).quiescent);
    assert.equal((await readFile(`${root}/starts`, 'utf8')).includes(d.configurationId), false);
    console.log('PASS cancel-before-start survives a late systemd activation');

    const e = value(4); await call('start', e, Date.now() + 1200);
    await until(async () => (await call('observe', e)).status === 'failed');
    assert.equal((await driver.observe(deliveryKey(e))).quiescent, true);
    console.log('PASS persisted execution deadline terminates waiting work');

    const f = value();
    const connection = await openDeliveryHost(options);
    try { connection.store.dispatchDelivery(f, Date.now() + 90000); }
    finally { connection.store.close(); }
    assert.equal((await call('start', f)).status, 'unknown');
    assert.equal((await readFile(`${root}/starts`, 'utf8')).includes(f.configurationId), false);
    console.log('PASS lost dispatch boundary remains unknown without a second start');

    const g = value(5); await call('start', g);
    await until(async () => (await readFile(`${root}/starts`, 'utf8')).includes(g.configurationId));
    // This case crashes the main receiver, which has no child processes.
    // Target it explicitly: killing an empty auxiliary set can return EINVAL
    // on systemd even when the main process was successfully killed.
    await ctl(['kill', '--kill-whom=main', '--signal=SIGKILL', driver.unit(deliveryKey(g))]);
    await until(async () => (await driver.observe(deliveryKey(g))).quiescent);
    await driver.start(deliveryKey(g));
    await until(async () => (await driver.observe(deliveryKey(g))).quiescent);
    assert.equal((await readFile(`${root}/starts`, 'utf8')).trim().split('\n').filter(x => x === g.configurationId).length, 1);
    console.log('PASS abrupt process loss and manual unit restart do not repeat receiver execution');

    await assert.rejects(call('cancel', { ...a, scope: { ...a.scope, fenceToken: randomUUID() } }), /delivery_operation_unavailable/);
    console.log('PASS forged provisioning fence cannot cancel a scoped operation');
    console.log('8 systemd delivery Linux checks passed; 0 failed');
} finally {
    for (const key of owned) await driver.stop(key);
    await ctl(['reset-failed', ...owned.map(key => driver.unit(key))]).catch(() => {});
    await unlink(unitFile); await ctl(['daemon-reload']);
    await rm(root, { recursive: true, force: true });
}

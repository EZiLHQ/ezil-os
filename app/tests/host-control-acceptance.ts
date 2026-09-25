/** Cross-package check against the actual built Node supervisor. Requires its
 * absolute checkout and plans emitted by test:db:runtime-api. No fake signing
 * verifier or duplicated host schema. This checks the protocol; its instrumented
 * driver does not claim Docker, EC2, browser, or marketplace acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHostControlClient, hostIntentDigest, type HostCommand, type HostScope } from '../src/server/app-platform/host-control-client';
import type { RuntimePlan } from '../src/server/app-platform/runtime-plan';

const root = process.env.EZIL_TEST_SUPERVISOR_ROOT;
const plansFile = process.env.EZIL_TEST_COMPILED_PLANS;
if (!root || !isAbsolute(root) || !plansFile || !isAbsolute(plansFile)) throw new Error('Absolute supervisor checkout and compiled plans paths are required');
const plans = JSON.parse(await readFile(plansFile, 'utf8')) as RuntimePlan[];
assert.equal(plans.length, 2);
const directory = await mkdtemp(join(tmpdir(), 'ezil-host-protocol-'));
const scope: HostScope = { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-test', fenceToken: randomUUID(), dataVolumeId: 'vol-test' };
const secret = randomBytes(32);
const script = `import {pathToFileURL} from 'node:url';
const root=process.argv[1];
const {ControlStore}=await import(pathToFileURL(root+'/dist/control-store.js'));
const {createControlService}=await import(pathToFileURL(root+'/dist/control-server.js'));
const {canonicalJson}=await import(pathToFileURL(root+'/dist/control-protocol.js'));
process.once('message', async init=>{
 const store=new ControlStore(init.directory,init.scope.computerId,init.scope.computerGeneration);
 const states=new Map();
 const service=createControlService({...init.scope,secret:Buffer.from(init.secret,'hex'),store,
   approvePlan: plan=>init.plans.some(p=>canonicalJson(p)===canonicalJson(plan)),
   driver:{observe:async id=>({state:states.get(id)??'unknown'}),reconcile:async intent=>{
     if(intent.desired==='running')store.reserveRuntimeDeadline(intent.command,Date.now()+intent.command.plan.resources.maxRuntimeSeconds*1000);
     states.set(intent.installationId,intent.desired);return intent.desired;
   }}});
 service.server.listen(0,'127.0.0.1',()=>process.send({port:service.server.address().port}));
 process.once('disconnect',async()=>{service.server.close();service.server.closeAllConnections();await service.drain();store.close();process.exit(0)});
});`;
const child = spawn('node', ['--input-type=module', '-e', script, `${root}/supervisor`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let diagnostics = '';
child.stderr!.on('data', chunk => { diagnostics += String(chunk); });
try {
    const ready = once(child, 'message');
    child.send({ directory, scope, secret: secret.toString('hex'), plans });
    const timer = setTimeout(() => child.kill(), 15000);
    let port: number;
    try { port = (await Promise.race([ready, once(child, 'exit').then(() => { throw new Error('Native supervisor exited before listening'); })]))[0].port; }
    finally { clearTimeout(timer); }
    const client = createHostControlClient({ ...scope, secret, origin: `http://127.0.0.1:${port}` }, { privateValidation: true });
    for (const plan of plans) {
        const installationId = randomUUID();
        const command: HostCommand = { schemaVersion: 1, requestId: randomUUID(), computerId: scope.computerId, computerGeneration: 1,
            installationId, operation: 'reconcile', generation: 1, desired: 'running', plan };
        assert.equal(await client.observe(installationId), null);
        await client.reconcile(command);
        let observed = await client.observe(installationId);
        for (let i=0; i<100 && !observed?.settled; i++) { await new Promise(r=>setTimeout(r,10)); observed=await client.observe(installationId); }
        assert.ok(observed?.settled); assert.equal(observed.state, 'running');
        assert.equal(observed.intentDigest, hostIntentDigest(command));
        assert.ok(observed.runtimeDeadlineMs);
        const expires = observed.runtimeDeadlineMs;
        await client.reconcile(command);
        assert.equal((await client.observe(installationId))!.runtimeDeadlineMs, expires);
        await client.reconcile({ ...command, requestId: randomUUID(), generation: 2, desired: 'stopped' });
        await assert.rejects(client.reconcile(command), /host_rejected/);
        assert.equal((await client.observe(installationId))!.generation, 2);
        console.log(`PASS actual supervisor accepts generated ${plan.services[0]!.process.kind} bytes, digest, scoped observation, replay deadline and newer Stop`);
    }
    const wrong = createHostControlClient({ ...scope, secret: randomBytes(32), origin: `http://127.0.0.1:${port}` }, { privateValidation: true });
    await assert.rejects(wrong.observe(randomUUID()), /host_rejected/);
    assert.ok(!diagnostics.includes(secret.toString('hex')));
    console.log('PASS wrong generation key rejected; 3 checks passed, 0 failed, 0 skipped');
} finally {
    const ended = once(child, 'exit');
    if (child.connected) child.disconnect();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    if (child.exitCode === null) await ended;
    clearTimeout(timer); await rm(directory, { recursive: true, force: true });
}

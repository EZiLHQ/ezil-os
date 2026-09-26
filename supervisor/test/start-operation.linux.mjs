import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { manageStartOperation } from '../dist/start-operation.js';
import { StartOperationStore, startedReceipt } from '../dist/start-operation-store.js';
import { canonicalJson } from '../dist/control-protocol.js';
import { observeSupervisor, stopSupervisor } from '../dist/supervisor-start.js';
import { observeComputerDataVolume } from '../dist/data-mount.js';

// Dedicated overlay of the successful first-start VM, with this revision
// installed offline. AWS transport is a local fixture; systemd, startup,
// cancellation, signed supervisor HTTP and persistent disk are real.
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
const phase = process.argv[2]; assert.ok(['run', 'verify'].includes(phase)); assert.equal(process.argv.length, 3);
const exec = promisify(execFile), command = (file, args) => exec(file, args, { timeout: 110000, maxBuffer: 1048576,
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
const ctl = (...args) => command('/usr/bin/systemctl', ['--no-pager', ...args]);
assert.equal((await command('/usr/bin/systemd-detect-virt', ['--vm'])).stdout.trim(), 'qemu');
assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
const root = '/etc/ezil-supervisor', evidencePath = '/var/lib/ezil-ssm-start-acceptance.json';
const previous = JSON.parse(await readFile('/var/lib/ezil-first-start-acceptance.json'));
const { host, binding } = previous, bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
assert.deepEqual(JSON.parse(await readFile(`${root}/provisioning.json`)), host);
assert.equal((await observeSupervisor(AbortSignal.timeout(5000))).stopped, true);
await observeComputerDataVolume(`${root}/data-volume.json`);
if (phase === 'run') await assert.rejects(lstat(evidencePath), { code: 'ENOENT' });
else assert.notEqual(JSON.parse(await readFile(evidencePath)).bootId, bootId);

const server = createServer((req, res) => {
    if (req.url === '/latest/api/token') return res.end('fixture-token');
    if (req.url === '/latest/dynamic/instance-identity/document') return res.end(JSON.stringify({ accountId: host.accountId, region: host.region, instanceId: host.scope.providerInstanceId }));
    if (req.url === '/latest/meta-data/iam/security-credentials/') return res.end('FixtureRole');
    res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'fixture-only', Token: 'fixture-only', Expiration: new Date(Date.now()+3600000).toISOString() }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const options = { privateValidation: true, metadataRequest: (o, cb) => request({ ...o, hostname: '127.0.0.1', port: server.address().port }, cb) };
const shim = '/run/ezil-start-executor-fixture.mjs', drop = '/run/systemd/system/ezil-start@.service.d';
const fixtureData = '/run/ezil-start-fixture.json';
await writeFile(fixtureData, JSON.stringify({ host, binding, port: server.address().port }), { mode: 0o600, flag: 'wx' });
// No production secret/IMDS interception: only this disposable template drop-in
// invokes the explicit private-validation transport of the real receiver.
await writeFile(shim, `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises'; import {request} from 'node:http'; import {Readable} from 'node:stream';
import {executeStartOperation} from '/opt/ezil-supervisor/current/dist/start-executor.js';
import {bootstrapControlHost} from '/opt/ezil-supervisor/current/dist/control-bootstrap.js';
const {host,binding,port}=JSON.parse(await readFile('${fixtureData}'));
await executeStartOperation(process.argv[2],{privateValidation:true,receive:(r,signal,checkAuthority)=>bootstrapControlHost({schemaVersion:1,authorizationId:r.authorization.authorizationId},
{privateValidation:true,signal,checkAuthority,metadataRequest:(o,cb)=>request({...o,hostname:'127.0.0.1',port},cb),requestHandler:{handle:async req=>{
 assert.equal(req.hostname,'secretsmanager.us-east-1.amazonaws.com'); assert.match(req.headers.authorization,/^AWS4-HMAC-SHA256 /);
 const name=host.namespace+'/computers/'+host.scope.computerId+'/generations/'+host.scope.computerGeneration+'/control';
 const input=JSON.parse(typeof req.body==='string'?req.body:Buffer.from(new Uint8Array(req.body)).toString());
 assert.deepEqual(input,{SecretId:name,VersionId:r.authorization.secretVersionId,VersionStage:'AWSCURRENT'});
 return {response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.1'},body:Readable.from([JSON.stringify({Name:name,
 ARN:'arn:aws:secretsmanager:us-east-1:'+host.accountId+':secret:'+name+'-ABC123',VersionId:r.authorization.secretVersionId,
 VersionStages:['AWSCURRENT'],SecretString:JSON.stringify(binding)})])}};
}}})});
`, { mode: 0o600, flag: 'wx' });
await mkdir(drop, { mode: 0o755, recursive: true });
await writeFile(`${drop}/validation.conf`, `[Service]\nExecStart=\nExecStart=/usr/local/bin/node ${shim} %i\n`, { flag: 'wx' });
await ctl('daemon-reload');
let current;
const operate = (action, r = current) => manageStartOperation({ schemaVersion: 1, action, records: r }, options);
async function fresh() {
    const old = JSON.parse(await readFile(`${root}/control-start-authorization.json`));
    if (Date.now()/1000 <= old.issuedAt+1) await delay(1100);
    const issuedAt = Math.floor(Date.now()/1000);
    current = { provisioning: host, authorization: { ...old, authorizationId: randomUUID(), issuedAt, expiresAt: issuedAt+300 } };
    return current;
}
async function until(fn) {
    const end = Date.now()+20000;
    while (Date.now()<end) { const value = await fn(); if (value) return value; await delay(100); }
    throw new Error('startup_fixture_deadline');
}
const stopped = async () => assert.equal((await observeSupervisor(AbortSignal.timeout(5000))).stopped, true);
const mainPid = async () => (await ctl('show', 'ezil-supervisor.service', '--property=MainPID', '--value')).stdout.trim();
try {
    if (phase === 'run') {
        await fresh(); assert.equal((await operate('observe')).status, 'absent'); await stopped();
        const expired = { ...current, authorization: { ...current.authorization, issuedAt: 1800000000-10000000, expiresAt: 1800000300-10000000 } };
        await assert.rejects(operate('start', expired), /start_operation_unavailable/); await stopped();
        await operate('cancel'); assert.equal((await operate('start')).status, 'cancelled'); await stopped();
        console.log('PASS absent observation, expired input and cancellation-before-start never wake the supervisor');
        await fresh(); const lost = new StartOperationStore(current.authorization.authorizationId);
        await lost.saveRecords(current); await lost.mark('dispatched');
        assert.equal((await operate('start')).status, 'unknown'); await stopped();
        assert.equal(await lost.flag('begun'), false);
        await operate('cancel'); console.log('PASS uncertain dispatch preserves its consumed allowance without starting another process');
    }
    await fresh(); await operate('start');
    const completed = await until(async () => { const value = await operate('observe'); return value.status === 'succeeded' ? value : null; });
    assert.deepEqual(completed.result, startedReceipt(current));
    const pid = await mainPid(); assert.notEqual(pid, '0');
    assert.equal((await operate('start')).status, 'succeeded'); assert.equal(await mainPid(), pid);
    const old = current;
    await stopSupervisor(); assert.equal((await operate('start')).status, 'succeeded'); await stopped();
    console.log('PASS actual systemd start returns the signed configuration receipt; replay preserves PID and cannot wake after stop');
    await fresh(); await operate('start'); await until(async () => (await operate('observe')).status === 'succeeded');
    const replacementPid = await mainPid(); assert.notEqual(replacementPid, '0');
    assert.equal((await operate('cancel', old)).status, 'cancelled'); assert.equal(await mainPid(), replacementPid);
    assert.equal((await operate('cancel')).status, 'cancelled'); await stopped();
    console.log('PASS newer authorization starts only after observed stop; stale cancellation cannot stop its supervisor');
    if (phase === 'run') {
        const supervisorDrop = '/run/systemd/system/ezil-supervisor.service.d'; await mkdir(supervisorDrop, { recursive: true });
        await writeFile(`${supervisorDrop}/startup-delay.conf`, '[Service]\nExecStartPre=/usr/bin/sleep 2\n', { flag: 'wx' }); await ctl('daemon-reload');
        try {
            await fresh(); await operate('start');
            await until(async () => { try { await lstat(`/var/lib/ezil-supervisor-starts/${current.authorization.authorizationId}.json`); return true; } catch { return false; } });
            assert.equal((await operate('cancel')).status, 'cancelled'); await stopped();
            assert.equal((await operate('start')).status, 'cancelled'); await stopped();
        } finally { await unlink(`${supervisorDrop}/startup-delay.conf`); await ctl('daemon-reload'); }
        console.log('PASS cancellation during real activation fences delayed work and confirms the supervisor stopped');
        await writeFile(evidencePath, JSON.stringify({ bootId }), { mode: 0o600, flag: 'wx' });
    }
    assert.equal(await readFile('/srv/ezil-data/Documents/renamed', 'utf8'), 'persisted operation\n');
    await assert.rejects(lstat('/srv/ezil-data/Documents/deleted'), { code: 'ENOENT' });
    assert.equal(await readFile('/srv/ezil-data/Projects/ssm-test/.git/config', 'utf8'), 'git state\n');
    const db = new DatabaseSync('/srv/ezil-data/Projects/ssm-test/state.sqlite');
    try { assert.deepEqual(db.prepare('SELECT value FROM state').all().map(r => r.value), ['committed']); } finally { db.close(); }
    assert.equal((await command('/usr/bin/docker', ['ps', '-aq'])).stdout.trim(), '');
    console.log(`PASS ${phase}: retained .git, rename, deletion and committed SQLite; no app containers`);
} finally {
    if (current) await operate('cancel').catch(() => {});
    await stopSupervisor(); await unlink(`${drop}/validation.conf`); await unlink(shim); await unlink(fixtureData); await ctl('daemon-reload');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

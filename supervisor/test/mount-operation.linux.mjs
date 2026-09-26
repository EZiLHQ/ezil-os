import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, unlink, rm, open, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../dist/control-protocol.js';
import { manageMountOperation } from '../dist/mount-operation.js';
import { MountOperationStore } from '../dist/mount-operation-store.js';
import { SystemdDelivery } from '../dist/systemd-delivery.js';
import { resolveDataDevice } from '../dist/data-mount-plan.js';

// Real systemd/process groups/block I/O in a disposable QEMU VM. IMDS/S3 are
// local fixtures; this cannot establish SSM IAM or cloud attachment behavior.
assert.equal(process.platform,'linux'); assert.equal(process.getuid(),0);
const phase=process.argv[2]; assert.ok(['run','verify'].includes(phase)); assert.equal(process.argv.length,3);
const exec=promisify(execFile), command=(file,args,timeout=20000)=>exec(file,args,{timeout,maxBuffer:1048576,env:{PATH:'/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C'}});
assert.equal((await command('/usr/bin/systemd-detect-virt',['--vm'])).stdout.trim(),'qemu');
const ctl=args=>command('/usr/bin/systemctl',['--no-pager',...args],30000);
const plan={schemaVersion:1,computerId:'55555555-5555-4555-8555-555555555555',volumeId:'vol-33333333333333333',
    filesystemUuid:'44444444-4444-4444-8444-444444444444',mode:'mount'};
const PLAN='/etc/ezil-supervisor/data-volume.json', AUTH='/etc/ezil-supervisor/data-mount-authorization.json',
    HOST='/etc/ezil-supervisor/provisioning.json', saved='/var/lib/ezil-bootstrap/ssm-mount-acceptance.json';
const absent=path=>assert.rejects(readFile(path),{code:'ENOENT'});
const boot=()=>readFile('/proc/sys/kernel/random/boot_id','utf8');
async function verifyFiles() {
    assert.equal(await readFile('/srv/ezil-data/Documents/renamed','utf8'),'persisted operation\n');
    await absent('/srv/ezil-data/Documents/deleted');
    assert.equal(await readFile('/srv/ezil-data/Projects/ssm-test/.git/config','utf8'),'git state\n');
    const db=new DatabaseSync('/srv/ezil-data/Projects/ssm-test/state.sqlite');
    assert.deepEqual(db.prepare('SELECT value FROM state').all().map(r=>r.value),['committed']); db.close();
}
if(phase==='verify') {
    const old=JSON.parse(await readFile(saved,'utf8')); assert.notEqual(await boot(),old.bootId);
    assert.equal((await ctl(['is-active','ezil-data-mount.service'])).stdout.trim(),'active');
    assert.deepEqual(JSON.parse(await readFile(PLAN,'utf8')),plan); await absent(AUTH); await absent(HOST); await verifyFiles();
    console.log('PASS actual reboot mounts retained files and committed SQLite without mount authority'); process.exit(0);
}
assert.equal((await command('/usr/bin/docker',['ps','-aq'])).stdout.trim(),'');
await ctl(['stop','ezil-supervisor.service','ezil-data-mount.service']); await ctl(['disable','ezil-supervisor.service']);
await absent(AUTH); await absent(HOST); await absent(saved);
const device=resolveDataDevice(plan,JSON.parse((await command('/usr/bin/lsblk',['--json','--list','--bytes','--paths','--output',
    'NAME,KNAME,TYPE,SIZE,RO,FSTYPE,UUID,PKNAME,SERIAL,MOUNTPOINTS,MAJ:MIN'])).stdout));
assert.equal(device.fstype,null); assert.equal(device.uuid,null); assert.ok(device.mountpoints.every(p=>p===null));
// This overlay starts with the earlier fixture's mount-only plan. Its disk is
// absent. Remove only that exact known fixture record before the new test.
assert.deepEqual(JSON.parse(await readFile(PLAN,'utf8')),{schemaVersion:1,computerId:'11111111-1111-4111-8111-111111111111',
    volumeId:'vol-11111111111111111',filesystemUuid:'22222222-2222-4222-8222-222222222222',mode:'mount'});
await unlink(PLAN);
const id=randomUUID().replaceAll('-',''),prefix=`ezil-mount-test-${id}`,root=`/var/lib/${prefix}`,unitFile=`/run/systemd/system/${prefix}@.service`;
const options={privateValidation:true,stateDirectory:`${root}/operations`,unitPrefix:prefix};
const driver=new SystemdDelivery(prefix,'mount'),owned=[],behaviors={}; let lastIssued=0, completed=false;
const provisioning={schemaVersion:1,accountId:'123456789012',region:'us-east-1',namespace:'pilot',bucket:'ezil-mount-test',
    kmsKeyArn:'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    scope:{computerId:plan.computerId,computerGeneration:1,fenceToken:randomUUID(),providerInstanceId:'i-33333333333333333',dataVolumeId:plan.volumeId}};
const server=createServer((req,res)=>{
    if(req.url==='/latest/api/token')return res.end('test-imds');
    assert.equal(req.headers['x-aws-ec2-metadata-token'],'test-imds');
    if(req.url==='/latest/dynamic/instance-identity/document')return res.end(JSON.stringify({accountId:provisioning.accountId,region:'us-east-1',instanceId:provisioning.scope.providerInstanceId}));
    if(req.url==='/latest/meta-data/iam/security-credentials/')return res.end('TestRole');
    res.end(JSON.stringify({Code:'Success',AccessKeyId:'ASIAABCDEFGHIJKLMNOP',SecretAccessKey:'local-fixture',Token:'local-fixture',Expiration:new Date(Date.now()+3600000).toISOString()}));
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
options.metadataRequest=(input,callback)=>request({...input,hostname:'127.0.0.1',port:server.address().port},callback);
const call=(action,records)=>manageMountOperation({schemaVersion:1,action,records},options);
async function until(check,milliseconds=20000) {
    const end=Date.now()+milliseconds; while(Date.now()<end){const value=await check();if(value)return value;await delay(250);}
    throw new Error('mount_operation_acceptance_timeout');
}
async function record(mode='mount',behavior='real',lifetime=900) {
    while(Math.floor(Date.now()/1000)<=lastIssued)await delay(50);
    const issuedAt=lastIssued=Math.floor(Date.now()/1000),authorizationId=randomUUID();
    const bytes=Buffer.from(canonicalJson({...plan,mode})),digest=createHash('sha256').update(bytes).digest('hex');
    const authorization={schemaVersion:1,authorizationId,scope:provisioning.scope,filesystemUuid:plan.filesystemUuid,mode,digest,issuedAt,expiresAt:issuedAt+lifetime};
    const delivery={schemaVersion:1,authorizationId,scope:provisioning.scope,digest,object:{bucket:provisioning.bucket,
        key:`pilot/computers/${plan.computerId}/generations/1/data-mounts/${authorizationId}.json`,versionId:'version-1',sha256:digest,bytes:bytes.length}};
    behaviors[authorizationId]=behavior;await writeFile(`${root}/behaviors.json`,JSON.stringify(behaviors),{mode:0o600});
    owned.push(`mount-${authorizationId}`);return {provisioning,authorization,delivery};
}
await mkdir(root,{mode:0o700});
try {
    const executor=new URL('../dist/mount-executor.js',import.meta.url).href,receiver=new URL('../dist/data-mount-receiver.js',import.meta.url).href;
    const fixture=`import {executeMountOperation} from ${JSON.stringify(executor)};
import {receiveDataMount} from ${JSON.stringify(receiver)};
import {readFile,appendFile,writeFile} from 'node:fs/promises';import {request} from 'node:http';import {Readable} from 'node:stream';import {spawn} from 'node:child_process';import {once} from 'node:events';
const root=${JSON.stringify(root)},port=${server.address().port};
executeMountOperation(process.argv[2],{...${JSON.stringify(options)},receive:async(r,signal,check)=>{
 await appendFile(root+'/starts',r.authorization.authorizationId+'\\n');
 const behavior=JSON.parse(await readFile(root+'/behaviors.json','utf8'))[r.authorization.authorizationId];
 if(behavior==='failed')throw new Error('PRIVATE_FIXTURE');
 if(behavior==='bad-receipt')return {};
 if(behavior==='hang'){const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.send("ready")'],{stdio:['ignore','ignore','ignore','ipc']});await once(child,'message');await writeFile(root+'/child',String(child.pid));await new Promise(()=>{});}
 if(behavior==='deadline')await new Promise((resolve,reject)=>{if(signal.aborted)return reject(new Error());signal.addEventListener('abort',()=>reject(new Error()),{once:true});});
 const a=r.authorization;const plan={computerId:a.scope.computerId,filesystemUuid:a.filesystemUuid,mode:a.mode,schemaVersion:1,volumeId:a.scope.dataVolumeId};const bytes=Buffer.from(JSON.stringify(plan));
 return receiveDataMount(r.delivery,{signal,checkAuthority:check,metadataRequest:(input,callback)=>request({...input,hostname:'127.0.0.1',port},callback),
 requestHandler:{handle:async req=>{if(req.method!=='GET'||req.query.versionId!=='version-1')throw new Error();return {response:{statusCode:200,headers:{'content-type':'application/json','content-length':String(bytes.length),'x-amz-version-id':'version-1','x-amz-server-side-encryption':'aws:kms','x-amz-server-side-encryption-aws-kms-key-id':r.provisioning.kmsKeyArn,'x-amz-checksum-sha256':Buffer.from(a.digest,'hex').toString('base64')},body:Readable.from([bytes])}};}}});
}}).catch(()=>{process.exitCode=1;});`;
    await writeFile(`${root}/executor.mjs`,fixture,{mode:0o600});
    const template=await readFile(new URL('../deploy/ezil-mount@.service',import.meta.url),'utf8');
    const unit=template.replace('ExecStart=/usr/local/bin/node /opt/ezil-supervisor/current/dist/mount-executor.js %i',`ExecStart=${process.execPath} ${root}/executor.mjs %i`);
    assert.notEqual(template,unit);await writeFile(unitFile,unit);await ctl(['daemon-reload']);
    const initial=await record('initialize');
    assert.equal((await call('observe',initial)).status,'absent');await absent(HOST);await absent(AUTH);await absent(PLAN);
    const wrong=structuredClone(initial);wrong.provisioning.accountId='999999999999';wrong.provisioning.kmsKeyArn=wrong.provisioning.kmsKeyArn.replace('123456789012','999999999999');
    await assert.rejects(call('start',wrong),/mount_operation_unavailable/);await absent(HOST);
    // Initialization independently scans all 50 GiB before formatting. Give it
    // the original grant's remaining time; do not replace that safety check
    // with the short deadline used for ordinary mount-only observations.
    await call('start',initial);const success=await until(async()=>{
        const r=await call('observe',initial);assert.notEqual(r.status,'failed');return r.status==='succeeded'&&r;
    },initial.authorization.expiresAt*1000-Date.now());
    assert.equal(success.result.filesystemUuid,plan.filesystemUuid);assert.deepEqual(JSON.parse(await readFile(PLAN,'utf8')),plan);
    assert.deepEqual(JSON.parse(await readFile(AUTH,'utf8')),initial.authorization);
    const journal=await readFile(`/var/lib/ezil-bootstrap/${plan.volumeId}.json`,'utf8');
    await call('start',initial);assert.equal((await readFile(`${root}/starts`,'utf8')).trim().split('\n').length,1);
    console.log('PASS controller records, IMDS binding, actual blank-disk initialization, exact receipt and one dispatch');
    const durable=async(path,value)=>{const f=await open(path,'w',0o600);try{await f.writeFile(value);await f.sync();}finally{await f.close();}};
    await mkdir('/srv/ezil-data/Projects/ssm-test/.git',{recursive:true});await mkdir('/srv/ezil-data/Documents');
    await durable('/srv/ezil-data/Projects/ssm-test/.git/config','git state\n');await durable('/srv/ezil-data/Documents/original','persisted operation\n');
    await rename('/srv/ezil-data/Documents/original','/srv/ezil-data/Documents/renamed');await durable('/srv/ezil-data/Documents/deleted','delete');await unlink('/srv/ezil-data/Documents/deleted');
    const db=new DatabaseSync('/srv/ezil-data/Projects/ssm-test/state.sqlite');db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE state(value text);BEGIN;INSERT INTO state VALUES ('committed');COMMIT");db.close();
    for(const behavior of ['real','failed','bad-receipt']) {
        const r=await record('mount',behavior);await call('start',r);
        const result=await until(async()=>{const v=await call('observe',r);return ['succeeded','failed'].includes(v.status)&&v;});
        assert.equal(result.status,behavior==='real'?'succeeded':'failed');if(behavior!=='real')assert.equal(result.result,undefined);
        assert.equal((await call('start',initial)).status,'cancelled');
    }
    assert.equal(await readFile(`/var/lib/ezil-bootstrap/${plan.volumeId}.json`,'utf8'),journal);await verifyFiles();
    console.log('PASS newer mount-only grants retain state, fence old authority and reject failed/forged receipts');
    const hanging=await record('mount','hang');await call('start',hanging);
    const pid=await until(async()=>{try{return Number(await readFile(`${root}/child`,'utf8'));}catch{return false;}});
    assert.equal((await call('cancel',hanging)).status,'cancelled');
    await until(()=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}});
    assert.equal((await call('start',hanging)).status,'cancelled');
    const cancelled=await record();assert.equal((await call('cancel',cancelled)).status,'cancelled');
    await driver.start(`mount-${cancelled.authorization.authorizationId}`);await until(async()=>(await driver.observe(`mount-${cancelled.authorization.authorizationId}`)).quiescent);
    assert.equal((await readFile(`${root}/starts`,'utf8')).includes(cancelled.authorization.authorizationId),false);
    console.log('PASS persistent cancellation stops the real process group and rejects late activation');
    const lost=await record(), store=new MountOperationStore(options.stateDirectory,lost.authorization.authorizationId);
    await store.saveRecords(lost);await store.mark('dispatched');assert.equal((await call('start',lost)).status,'unknown');
    assert.equal((await readFile(`${root}/starts`,'utf8')).includes(lost.authorization.authorizationId),false);
    const timed=await record('mount','deadline',2);await call('start',timed);
    await until(async()=>(await call('observe',timed)).status==='failed');await assert.rejects(call('start',timed),/mount_operation_unavailable/);
    assert.equal((await driver.observe(`mount-${timed.authorization.authorizationId}`)).quiescent,true);
    console.log('PASS lost dispatch is not retried; absolute expiry stops work and cannot be extended');
    await verifyFiles();await writeFile(saved,JSON.stringify({bootId:await boot(),plan}),{mode:0o600});
    await unlink(AUTH);await unlink(HOST);await ctl(['enable','ezil-data-mount.service']);
    completed=true;
    console.log('PASS persisted files, rename/deletion, git and SQLite prepared for reboot verification');
} finally {
    for(const key of owned)await driver.stop(key).catch(()=>{});
    await unlink(unitFile).catch(()=>{});await ctl(['daemon-reload']);
    if(completed)await rm(root,{recursive:true,force:true});
    else console.error(`Mount acceptance failed; operation evidence retained at ${root}`);
    server.close();await once(server,'close');
}

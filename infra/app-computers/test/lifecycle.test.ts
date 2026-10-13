import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { token } from '../lib/lifecycle/contract.js';
import type { LifecycleIntent } from '../lib/lifecycle/intent.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { runAsl, taskError } from './asl.js';
import { toLambdaError, MAX_THROTTLE_RETRIES } from '../lib/lifecycle/errors.js';
import { LifecycleIntentSchema, validateLifecycleReceipt } from '../lib/lifecycle/intent.js';
import { authorityFor } from '../lib/lifecycle/contract.js';

type Options={lose?:string;noEffect?:string;revokeAfter?:string;foreignDisk?:boolean;deleteDisk?:boolean;staleOldAfterLaunch?:boolean;
    fail?:{action:string;times:number;error:Error};applyBeforeFail?:boolean;extraDisk?:boolean;fixture?:ReturnType<typeof lifecycleFixture>};
async function run(operation:LifecycleIntent['operation'],options:Options={}){
    const f=options.fixture??lifecycleFixture(operation),helper=createLifecycleHelper(f.settings,f.deps),graph=lifecycleDefinition('helper',f.settings.features);
    if(options.foreignDisk)f.state.volumes[0]!.Tags=[];
    if(options.deleteDisk)f.state.instances[0]!.BlockDeviceMappings!.find(m=>m.DeviceName==='/dev/sdf')!.Ebs!.DeleteOnTermination=true;
    if(options.extraDisk)f.state.instances[0]!.BlockDeviceMappings!.push({DeviceName:'/dev/sdg',Ebs:{VolumeId:'vol-99999999999999999',Status:'attached',DeleteOnTermination:false}});
    if(options.staleOldAfterLaunch){const original=f.deps.instances;let stale=true;f.deps.instances=async selector=>{
        const rows=await original(selector);if(Array.isArray(selector)&&f.state.instances.length===2&&stale){stale=false;rows[0]!.instance.State={Name:'stopped'};}return rows;};}
    const calls:{action:string;parameters:any}[]=[];let lost=false,failures=0;
    for(const s of Object.values(graph.States) as any[])if(s.Type==='Task'&&s.Resource!=='helper')assert.equal(s.Retry,undefined,'EC2 tasks never retry automatically');
    const result=await runAsl(graph,{input:f.envelope,executionArn:f.executionArn,sleep:seconds=>{f.state.now+=seconds*1000;},
        invoke:async(resource,parameters)=>{
            if(resource==='helper'){try{return await helper(parameters);}catch(error){throw toLambdaError(error,'lifecycle_unconfirmed');}}
            const action=resource.split(':').at(-1)!;calls.push({action,parameters});
            if(options.fail?.action===action&&failures<options.fail.times&&!options.applyBeforeFail){failures++;throw options.fail.error;}
            const target=f.state.instances.find(i=>i.InstanceId===(parameters.InstanceIds?.[0]??parameters.InstanceId));
            if(action!==options.noEffect){
                if(action==='createVolume')f.state.volumes.push(f.volume());
                if(action==='runInstances')f.state.instances.push(f.instance('i-33333333333333333'));
                if(action==='startInstances')target!.State={Name:'running'};
                if(action==='stopInstances')target!.State={Name:'stopped'};
                if(action==='terminateInstances'){assert.equal(target!.State?.Name,'stopped');target!.State={Name:'terminated'};
                    const v=f.state.volumes[0]!;v.State='available';v.Attachments=[];target!.BlockDeviceMappings=[];}
                if(action==='createTags'){const v=f.state.volumes[0]!;v.Tags=[...v.Tags!.filter(t=>!parameters.Tags.some((n:any)=>n.Key===t.Key)),...parameters.Tags];}
                if(action==='attachVolume')f.attach(f.state.volumes[0]!,target!);
                if(action==='modifyInstanceAttribute')assert.equal(target!.State?.Name,'stopped');
            }
            if(options.applyBeforeFail&&options.fail?.action===action&&failures<options.fail.times){failures++;throw options.fail.error;}
            if(action===options.revokeAfter)f.state.authorized=false;
            if(action===options.lose&&!lost){lost=true;throw taskError('States.Timeout','Task timed out (lost response)');}
            return {};
        }});
    return {error:result.error,cause:result.cause,receipt:result.output,calls,f,visited:result.visited};
}
for(const operation of ['provision','start','stop','replace','retire'] as const)test(`${operation}: shipped Standard graph observes real operation sequence and retained data disk`,async()=>{
    const r=await run(operation);assert.equal(r.error,undefined);assert.ok(r.receipt);assert.equal(r.receipt.jobId,r.f.i.jobId);
    assert.equal(r.receipt.state,operation==='stop'?'stopped':operation==='retire'?'retired':'running');assert.equal(r.f.state.volumes.length,1);
    assert.equal(r.receipt.volumeId,r.f.state.volumes[0]!.VolumeId);assert.ok(r.f.state.authorityCalls>0);
    if(operation==='replace'){
        assert.deepEqual(r.calls.map(c=>c.action),['stopInstances','terminateInstances','runInstances','createTags','attachVolume']);
        assert.equal(r.f.state.instances[0]!.State?.Name,'terminated');
        // Retag moves only generation and fence; identity tags are creation-only.
        assert.deepEqual(r.calls.find(c=>c.action==='createTags')!.parameters.Tags.map((t:any)=>t.Key).sort(),['ezil:fence-token','ezil:generation']);
    }
    if(operation==='provision'){
        const allocation=r.calls.find(c=>c.action==='createVolume')!.parameters;assert.equal(allocation.Size,20);assert.equal(allocation.Encrypted,true);
        assert.equal(allocation.AvailabilityZoneId,'aps1-az1');assert.equal(allocation.AvailabilityZone,undefined);
        const launch=r.calls.find(c=>c.action==='runInstances')!.parameters;assert.equal(launch.MinCount,1);assert.equal(launch.MaxCount,1);
        assert.equal(launch.InstanceType,'m6i.large');assert.equal(launch.IamInstanceProfile,undefined);assert.equal(launch.Placement,undefined);
        assert.deepEqual(launch.MetadataOptions,{HttpEndpoint:'enabled',HttpTokens:'required',HttpPutResponseHopLimit:1,InstanceMetadataTags:'disabled'});
        assert.deepEqual(launch.HibernationOptions,{Configured:false});
        assert.equal(launch.BlockDeviceMappings[0].Ebs.VolumeSize,20);assert.equal(launch.BlockDeviceMappings[0].Ebs.Encrypted,true);
        assert.equal(launch.UserData,r.f.i.userData);assert.ok(launch.UserData);assert.equal(launch.ClientToken,token(r.f.digest,'instance'));
    }
});
for(const [operation,action]of [['provision','createVolume'],['provision','runInstances'],['provision','attachVolume'],['start','startInstances'],['stop','stopInstances'],['retire','terminateInstances']] as const)
    test(`lost ${action} reply is observed with no duplicate mutation`,async()=>{const r=await run(operation,{lose:action});assert.equal(r.error,undefined);assert.equal(r.calls.filter(c=>c.action===action).length,1);});
for(const [operation,action]of [['start','startInstances'],['stop','stopInstances'],['retire','terminateInstances']] as const)
    test(`uncertain ${action} never retries or frees the lifecycle reservation`,async()=>{const r=await run(operation,{lose:action,noEffect:action});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.receipt,undefined);assert.equal(r.calls.filter(c=>c.action===action).length,1);});
test('revocation after allocation never starts compute or reports completion',async()=>{const r=await run('provision',{revokeAfter:'createVolume'});assert.equal(r.error,'LifecycleUnconfirmed');assert.deepEqual(r.calls.map(c=>c.action),['createVolume']);assert.equal(r.f.state.volumes.length,1);});
test('cross-tenant or deletable disk prevents stop/terminate',async()=>{for(const options of [{foreignDisk:true},{deleteDisk:true}]){const r=await run('replace',options);assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);}});
test('helper failure codes are recorded on the terminal state, not discarded',async()=>{
    const r=await run('replace',{foreignDisk:true});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);
    // An uncertain (timed-out) StartInstances keeps the EC2 error AND the later
    // observation error: the observe Catch no longer overwrites lastError.
    const lost=await run('start',{lose:'startInstances',noEffect:'startInstances'});
    const ctl=JSON.parse(lost.cause!);assert.equal(ctl.lastError.Error,'States.Timeout');assert.match(ctl.observeError.Cause,/lifecycle_expired/);
});
test('immutable execution identity, deployment and redrive are enforced before effects',async()=>{
    for(const field of ['stateMachineVersionArn','name','input','redriveCount','stateMachineAliasArn']){
        const f=lifecycleFixture();(f.state.execution as Record<string,unknown>)[field]=field==='redriveCount'?1:'forged';
        await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'initial'}));assert.equal(f.state.authorityCalls,0);
    }
});
test('unsupported AMI/template cannot launch',async()=>{
    for(const kind of ['image','template']){
        const f=lifecycleFixture();f.state.volumes.push(f.volume());if(kind==='image')f.state.imageBad=true;if(kind==='template')f.state.templateBad=true;
        await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'initial'}));
    }
});
test('unobserved stop cannot be substituted by a caller-supplied phase or resource ID',async()=>{
    const f=lifecycleFixture('start'),helper=createLifecycleHelper(f.settings,f.deps);
    await assert.rejects(helper({executionArn:f.executionArn,phase:'initial',instanceId:'i-00000000000000000'}));
    const result=await helper({executionArn:f.executionArn,phase:'started'});assert.equal(result.decision,'wait');
});
test('authority is rechecked after provider reads, immediately before a mutation',async()=>{
    const f=lifecycleFixture('start'),original=f.deps.instances;
    f.deps.instances=async ids=>{const rows=await original(ids);f.state.authorized=false;return rows;};
    await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'initial'}),/authority_denied/);
});
test('slow reads cannot dispatch a mutation beyond the original deadline',async()=>{
    const f=lifecycleFixture('start'),original=f.deps.instances;
    f.deps.instances=async ids=>{const rows=await original(ids);f.state.now+=871000;return rows;};
    await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'initial'}),/expired/);
});
test('allocation retry preserves the exact token and approved parameters',async()=>{
    const f=lifecycleFixture(),helper=createLifecycleHelper(f.settings,f.deps);
    const first=await helper({executionArn:f.executionArn,phase:'initial'}),retry=await helper({executionArn:f.executionArn,phase:'volume'});
    assert.deepEqual(first,retry);f.state.volumes.push(f.volume());
    const run=await helper({executionArn:f.executionArn,phase:'volume'}),rerun=await helper({executionArn:f.executionArn,phase:'instance'});
    assert.deepEqual(run,rerun);
});
test('unexpected AMI data devices cannot silently allocate extra volumes',async()=>{
    const f=lifecycleFixture();f.state.volumes.push(f.volume());const original=f.deps.image;
    f.deps.image=async id=>({...await original(id),BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeSize:8}},{DeviceName:'/dev/sdg',Ebs:{VolumeSize:500}}]});
    await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'volume'}),/launch_invalid/);
});

test('a stale old-writer observation after launching replacement never repeats stop or termination',async()=>{
    const r=await run('replace',{staleOldAfterLaunch:true});assert.equal(r.error,undefined);
    assert.equal(r.calls.filter(c=>c.action==='stopInstances').length,1);assert.equal(r.calls.filter(c=>c.action==='terminateInstances').length,1);
});

// ── Item 7: error codes, fail-fast capacity, throttling backoff, observation retries ──
for(const [name,cause,code] of [
    ['Ec2.InsufficientInstanceCapacityException','We currently do not have sufficient m6i.large capacity in the Availability Zone you requested','InsufficientInstanceCapacity'],
    ['Ec2.Ec2Exception','You have requested more vCPU capacity than your current vCPU limit of 2 allows (Service: Ec2, Status Code: 400) VcpuLimitExceeded','VcpuLimitExceeded'],
] as const) test(`${code} fails fast to a refused terminal that carries the code`,async()=>{
    const r=await run('provision',{fail:{action:'runInstances',times:99,error:taskError(name,cause)}});
    assert.equal(r.error,'LifecycleRefused');assert.equal(r.cause,code);assert.equal(r.receipt,undefined);
    assert.equal(r.calls.filter(c=>c.action==='runInstances').length,1,'a capacity refusal is never reissued');
});
test('a generic capacity message without a code still fails fast',async()=>{
    const r=await run('provision',{fail:{action:'runInstances',times:99,error:taskError('Ec2.Ec2Exception','We currently do not have sufficient c6i.xlarge capacity')}});
    assert.equal(r.error,'LifecycleRefused');assert.equal(r.cause,'InsufficientCapacity');
});
test('throttled StartInstances is reissued after backoff and then succeeds',async()=>{
    const r=await run('start',{fail:{action:'startInstances',times:2,error:taskError('Ec2.RequestLimitExceededException','Request limit exceeded.')}});
    assert.equal(r.error,undefined);assert.equal(r.receipt.state,'running');
    assert.equal(r.calls.filter(c=>c.action==='startInstances').length,3);assert.ok(r.visited.includes('Backoff'));
});
test('persistent throttling is bounded and ends unconfirmed with its code',async()=>{
    const r=await run('stop',{fail:{action:'stopInstances',times:99,error:taskError('Ec2.Ec2Exception','Request limit exceeded.')}});
    assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_throttled/);
    assert.equal(r.calls.filter(c=>c.action==='stopInstances').length,MAX_THROTTLE_RETRIES+1);
});
for(const [name,cause] of [['Ec2.IncorrectInstanceStateException','The instance is not in a state from which it can be started.'],
    ['Ec2.Ec2Exception','You are not authorized to perform this operation. UnauthorizedOperation (Service: Ec2, Status Code: 403)']] as const)
test(`a definite EC2 rejection (${name}) fails fast with its code, never reissued and never waiting for expiry`,async()=>{
    const r=await run('start',{fail:{action:'startInstances',times:1,error:taskError(name,cause)},noEffect:'startInstances'});
    assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.filter(c=>c.action==='startInstances').length,1);
    assert.ok(r.cause!.startsWith(name+': '),r.cause);assert.ok(r.visited.includes('Rejected'));assert.ok(!r.visited.includes('Unconfirmed'));
    assert.ok(r.f.state.now-r.f.state.execution.startDate.getTime()<60000,'fails within a minute, not at the deadline');
});
test('a transient observation failure is retried, not treated as unconfirmed',async()=>{
    const f=lifecycleFixture('start'),original=f.deps.instances;let throws=2;
    f.deps.instances=async selector=>{if(throws-->0){const e=new Error('slow down');e.name='RequestLimitExceeded';throw e;}return original(selector);};
    const r=await run('start',{fixture:f});assert.equal(r.error,undefined);assert.equal(r.receipt.state,'running');
});

// ── Item 8: terminate guard ──
for(const operation of ['replace','retire'] as const) test(`${operation}: an unexpected attached disk blocks TerminateInstances`,async()=>{
    const r=await run(operation,{extraDisk:true});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_unexpected_disk/);
    assert.equal(r.calls.filter(c=>c.action==='terminateInstances').length,0);
});

// ── Items 1, 2, 5: zone, type and size come from configuration ──
test('premium type and size from the allowlist provision end to end',async()=>{
    const r=await run('provision',{fixture:lifecycleFixture('provision',{instanceType:'c6i.xlarge',dataVolumeGiB:50})});
    assert.equal(r.error,undefined);assert.equal(r.calls.find(c=>c.action==='runInstances')!.parameters.InstanceType,'c6i.xlarge');
    assert.equal(r.calls.find(c=>c.action==='createVolume')!.parameters.Size,50);
});
test('intent refuses types outside the deployment allowlist and sizes outside the range',()=>{
    const f=lifecycleFixture();
    assert.ok(LifecycleIntentSchema.safeParse(f.i).success);
    for(const bad of [{instanceType:'m7i.large'},{instanceType:'t3.large'},{dataVolumeGiB:19},{dataVolumeGiB:101},{dataVolumeGiB:null}])
        assert.equal(LifecycleIntentSchema.safeParse({...f.i,...bad}).success,false,JSON.stringify(bad));
    const narrow={...f.i,deployment:{...f.i.deployment,instanceTypes:['m6i.large']},instanceType:'c6i.xlarge'};
    assert.equal(LifecycleIntentSchema.safeParse(narrow).success,false);
    const start=lifecycleFixture('start');assert.equal(LifecycleIntentSchema.safeParse({...start.i,dataVolumeGiB:20}).success,false);
});
test('a grown data volume inside the range is accepted; outside the range or zone is refused',async()=>{
    for(const [mutate,ok] of [[(v:any)=>{v.Size=80;},true],[(v:any)=>{v.Size=101;},false],[(v:any)=>{v.Size=19;},false],
        [(v:any)=>{v.AvailabilityZoneId='aps1-az2';},false],[(v:any)=>{delete v.AvailabilityZoneId;},false]] as const){
        const f=lifecycleFixture('start');mutate(f.state.volumes[0]!);
        const r=await run('start',{fixture:f});
        if(ok)assert.equal(r.error,undefined);else{assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);}
    }
});
test('an instance with an instance profile, other type, metadata tags or wrong subnet is refused',async()=>{
    for(const mutate of [(i:any)=>{i.IamInstanceProfile={Arn:'arn:aws:iam::123456789012:instance-profile/x'};},(i:any)=>{i.InstanceType='m7i.large';},
        (i:any)=>{i.MetadataOptions.InstanceMetadataTags='enabled';},(i:any)=>{i.MetadataOptions.HttpPutResponseHopLimit=2;},
        (i:any)=>{i.SubnetId='subnet-22222222222222222';},(i:any)=>{i.Placement={AvailabilityZoneId:'aps1-az3'};}]){
        const f=lifecycleFixture('start');mutate(f.state.instances[0]!);
        const r=await run('start',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);
    }
});

// ── Contract follow-up: per-lease epoch and userData-only nonce delivery ──
test('leaseEpoch travels in the receipt and the authority body; a receipt for another epoch is refused',async()=>{
    const r=await run('start');assert.equal(r.receipt.leaseEpoch,r.f.i.leaseEpoch);
    assert.equal(authorityFor(r.f.i,r.f.digest).leaseEpoch,r.f.i.leaseEpoch);
    const work={document:r.f.envelope.document,digest:r.f.digest,createdAt:new Date()};
    assert.deepEqual(validateLifecycleReceipt(work,r.receipt),r.receipt);
    assert.throws(()=>validateLifecycleReceipt(work,{...r.receipt,leaseEpoch:r.f.i.leaseEpoch+1}),/lifecycle_conflict/);
    assert.equal(LifecycleIntentSchema.safeParse({...r.f.i,leaseEpoch:0}).success,false);
});
test('start-in-place writes the epoch nonce as userData while stopped, then starts (flag on)',async()=>{
    const f=lifecycleFixture('start',{userData:'bm9uY2UtZTM=',userDataNonce:true});
    const r=await run('start',{fixture:f});assert.equal(r.error,undefined);assert.equal(r.receipt.state,'running');
    assert.deepEqual(r.calls.map(c=>c.action),['modifyInstanceAttribute','startInstances']);
    assert.deepEqual(r.calls[0]!.parameters,{InstanceId:f.state.instances[0]!.InstanceId,UserData:{Value:'bm9uY2UtZTM='}});
});
test('nonce delivery to a stopped instance is refused while the flag is off, and the graph has no modify step',async()=>{
    const r=await run('start',{fixture:lifecycleFixture('start',{userData:'bm9uY2UtZTM='})});
    assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_userdata_disabled/);assert.deepEqual(r.calls,[]);
    assert.equal(lifecycleDefinition('helper').States.modifyInstanceAttribute,undefined);
    assert.ok(lifecycleDefinition('helper',{userDataNonce:true}).States.modifyInstanceAttribute);
});
test('userData is required on launches and absent on stop and retire',()=>{
    for(const op of ['provision','replace'] as const){const f=lifecycleFixture(op);assert.equal(LifecycleIntentSchema.safeParse({...f.i,userData:null}).success,false,op);}
    for(const op of ['stop','retire'] as const){const f=lifecycleFixture(op);assert.equal(LifecycleIntentSchema.safeParse({...f.i,userData:'bm9uY2U='}).success,false,op);}
    const f=lifecycleFixture('start');assert.equal(LifecycleIntentSchema.safeParse({...f.i,userData:'not base64!'}).success,false);
});

// ── Reviewer survivors: behaviour guards ──
test('second-writer guard: no RunInstances while the data volume is attached anywhere',async()=>{
    const f=lifecycleFixture('provision'),v=f.volume();v.State='in-use';
    v.Attachments=[{InstanceId:'i-99999999999999999',VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];f.state.volumes.push(v);
    const r=await run('provision',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');
    assert.equal(r.calls.filter(c=>c.action==='runInstances').length,0);assert.deepEqual(r.calls,[]);
});
test('a multi-attach data volume is refused before any mutation',async()=>{
    const f=lifecycleFixture('start');f.state.volumes[0]!.MultiAttachEnabled=true;
    const r=await run('start',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);assert.deepEqual(r.calls,[]);
});
test('replace waits for a stopping writer and never issues a second stop',async()=>{
    const f=lifecycleFixture('replace');f.state.instances[0]!.State={Name:'stopping'};
    const original=f.deps.instances;let reads=0;
    f.deps.instances=async selector=>{const rows=await original(selector);
        if(Array.isArray(selector)&&++reads===3)f.state.instances[0]!.State={Name:'stopped'};return rows;};
    const r=await run('replace',{fixture:f});assert.equal(r.error,undefined);
    assert.equal(r.calls.filter(c=>c.action==='stopInstances').length,0);assert.equal(r.calls[0]!.action,'terminateInstances');
});

// ── Uncertain provider errors are observed, never rejected ──
for(const [label,name,cause] of [
    ['5xx status only','Ec2.Ec2Exception','We encountered an error. (Service: Ec2, Status Code: 503, Request ID: r)'],
    ['InternalError','Ec2.InternalErrorException','An internal error has occurred'],
    ['ServiceUnavailable','Ec2.ServiceUnavailableException','Service is temporarily unable to handle the request'],
    ['transport: HTTP request','States.TaskFailed','Unable to execute HTTP request: Connection reset'],
    // Not States.TaskFailed: only the transport patterns can classify this one.
    ['transport: client exception','Ec2.SdkClientException','Unable to execute HTTP request: connection reset by peer'],
    ['transport: generic task failure without status','States.TaskFailed','The task failed'],
] as const) test(`uncertain EC2 error (${label}) is observed, not rejected`,async()=>{
    // The request DID take effect; only observation can learn that.
    const r=await run('start',{fail:{action:'startInstances',times:1,error:taskError(name,cause)},noEffect:undefined,applyBeforeFail:true});
    assert.equal(r.error,undefined,r.cause);assert.equal(r.receipt.state,'running');
    assert.ok(!r.visited.includes('Rejected'));assert.equal(r.calls.filter(c=>c.action==='startInstances').length,1);
});
test('a definite 4xx with a status code is still rejected',async()=>{
    const r=await run('start',{fail:{action:'startInstances',times:1,error:taskError('States.TaskFailed','Not authorized (Service: Ec2, Status Code: 403)')},noEffect:'startInstances'});
    assert.ok(r.visited.includes('Rejected'));
});

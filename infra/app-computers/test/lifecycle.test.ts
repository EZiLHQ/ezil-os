import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { token } from '../lib/lifecycle/contract.js';
import type { LifecycleIntent } from '../lib/lifecycle/intent.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { BURSTABLE_CREDITS, COMPUTER_TIERS, DEFAULT_STORAGE, INSTANCE_TYPES, StorageSchema, TIER_INSTANCE_TYPES, TierMapSchema, isBurstable } from '../lib/lifecycle/deployment.js';
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
        assert.equal(launch.BlockDeviceMappings[0].Ebs.VolumeSize,30);assert.equal(launch.BlockDeviceMappings[0].Ebs.Encrypted,true);
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
    f.deps.image=async id=>({...await original(id),BlockDeviceMappings:[{DeviceName:'/dev/sda1',Ebs:{VolumeSize:30}},{DeviceName:'/dev/sdg',Ebs:{VolumeSize:500}}]});
    await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'volume'}),/launch_invalid/);
});

test('storage defaults to a 30 GiB Ubuntu root and validates the root device allowlist',()=>{
    assert.deepEqual(StorageSchema.parse({dataMinGiB:20,dataMaxGiB:100}),DEFAULT_STORAGE);
    assert.equal(DEFAULT_STORAGE.rootDeviceName,'/dev/sda1');assert.equal(DEFAULT_STORAGE.rootGiB,30);
    for(const rootDeviceName of ['/dev/sda1','/dev/xvda'])assert.ok(StorageSchema.safeParse({...DEFAULT_STORAGE,rootDeviceName}).success);
    for(const rootDeviceName of ['/dev/sdf','/dev/nvme0n1','',null])assert.equal(StorageSchema.safeParse({...DEFAULT_STORAGE,rootDeviceName}).success,false);
});
test('RunInstances tags the primary ENI with the instance compute tags (boundary admits no untagged ENI)',async()=>{
    const r=await run('provision');
    assert.equal(r.error,undefined);
    const specs=r.calls.find(c=>c.action==='runInstances')!.parameters.TagSpecifications as {ResourceType:string;Tags:{Key:string;Value:string}[]}[];
    const eni=specs.find(t=>t.ResourceType==='network-interface'),instance=specs.find(t=>t.ResourceType==='instance');
    assert.ok(eni,'network-interface tag specification present');
    assert.deepEqual(eni!.Tags,instance!.Tags);
    for(const key of ['ezil:stage','ezil:managed-by'])assert.ok(eni!.Tags.some(t=>t.Key===key),key);
});
for(const rootDeviceName of ['/dev/sda1','/dev/xvda'] as const)
test(`configured ${rootDeviceName} image is accepted and its root mapping reaches RunInstances`,async()=>{
    const r=await run('provision',{fixture:lifecycleFixture('provision',{rootDeviceName})});
    assert.equal(r.error,undefined);
    assert.deepEqual(r.calls.find(c=>c.action==='runInstances')!.parameters.BlockDeviceMappings,[{
        DeviceName:rootDeviceName,Ebs:{VolumeType:'gp3',VolumeSize:30,Encrypted:true,KmsKeyId:r.f.i.deployment.dataKeyArn,DeleteOnTermination:true},
    }]);
});
for(const mismatch of ['image root','image mapping','whole xvda image','missing mapping','duplicate mapping','oversized snapshot','template mapping','unknown non-EBS mapping','second EBS beside ephemerals'] as const)
test(`Ubuntu launch refuses ${mismatch}`,async()=>{
    const f=lifecycleFixture();f.state.volumes.push(f.volume());
    const originalImage=f.deps.image,originalTemplate=f.deps.template;
    f.deps.image=async id=>{
        const image=(await originalImage(id))!;
        if(mismatch==='image root'||mismatch==='whole xvda image')image.RootDeviceName='/dev/xvda';
        if(mismatch==='image mapping'||mismatch==='whole xvda image')image.BlockDeviceMappings![0]!.DeviceName='/dev/xvda';
        if(mismatch==='missing mapping')image.BlockDeviceMappings=[];
        if(mismatch==='duplicate mapping')image.BlockDeviceMappings!.push({...image.BlockDeviceMappings![0]!});
        if(mismatch==='oversized snapshot')image.BlockDeviceMappings![0]!.Ebs!.VolumeSize=31;
        if(mismatch==='unknown non-EBS mapping')image.BlockDeviceMappings!.push({DeviceName:'/dev/sdb',VirtualName:'swap0'});
        if(mismatch==='second EBS beside ephemerals')image.BlockDeviceMappings!.push({DeviceName:'/dev/sdb',VirtualName:'ephemeral0'},{DeviceName:'/dev/sdf',Ebs:{VolumeSize:8}});
        return image;
    };
    if(mismatch==='template mapping')f.deps.template=async(id,version)=>{
        const template=(await originalTemplate(id,version))!;
        template.LaunchTemplateData!.BlockDeviceMappings![0]!.DeviceName='/dev/xvda';return template;
    };
    await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'volume'}),/lifecycle_launch_invalid/);
});
test('an AMI with Ubuntu instance-store placeholders (ephemeral0/1) still launches',async()=>{
    // Same path as the mismatch cases above (an existing volume makes phase 'volume' validate the launch).
    const f=lifecycleFixture();f.state.volumes.push(f.volume());
    const originalImage=f.deps.image;
    let validated=false;
    f.deps.image=async id=>{validated=true;const image=(await originalImage(id))!;
        image.BlockDeviceMappings!.push({DeviceName:'/dev/sdb',VirtualName:'ephemeral0'},{DeviceName:'/dev/sdc',VirtualName:'ephemeral1'});return image;};
    await assert.doesNotReject(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'volume'}));
    assert.ok(validated, 'the launch image was validated');
});
test('an observed instance with a different root device cannot start',async()=>{
    const f=lifecycleFixture('start');f.state.instances[0]!.RootDeviceName='/dev/xvda';
    const r=await run('start',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.deepEqual(r.calls,[]);
});
for(const operation of ['replace','retire'] as const)test(`${operation}: a different root device blocks termination`,async()=>{
    const f=lifecycleFixture(operation);f.state.instances[0]!.RootDeviceName='/dev/xvda';
    const r=await run(operation,{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');
    assert.match(r.cause!,/lifecycle_unexpected_disk/);assert.ok(!r.calls.some(c=>c.action==='terminateInstances'));
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
// ── Tiers (founder 2026-10-14): free = t3a/t3.medium with standard credits; plus = m6i.large ──
const TIERED=['t3a.medium','t3.medium','m6i.large','m6i.xlarge','m6i.2xlarge'] as const;
for(const [instanceType,operation] of [['t3a.medium','provision'],['t3.medium','provision'],['t3a.medium','replace']] as const)
    test(`free tier ${instanceType} ${operation}: RunInstances carries exactly CpuCredits=standard through the burstable state`,async()=>{
        const r=await run(operation,{fixture:lifecycleFixture(operation,{instanceType,instanceTypes:[...TIERED]})});
        assert.equal(r.error,undefined);const launches=r.calls.filter(c=>c.action==='runInstances');assert.equal(launches.length,1);
        assert.equal(launches[0]!.parameters.InstanceType,instanceType);
        assert.deepEqual(launches[0]!.parameters.CreditSpecification,{CpuCredits:'standard'});
        assert.ok(r.visited.includes('runBurstableInstances'));assert.ok(!r.visited.includes('runInstances'));
    });
for(const instanceType of ['m6i.large','m6i.xlarge','m6i.2xlarge'] as const)
test(`paid tier ${instanceType}: RunInstances carries no CreditSpecification`,async()=>{
    const r=await run('provision',{fixture:lifecycleFixture('provision',{instanceType,instanceTypes:[...TIERED]})});
    assert.equal(r.error,undefined);const launch=r.calls.find(c=>c.action==='runInstances')!;
    assert.equal(launch.parameters.InstanceType,instanceType);assert.ok(!('CreditSpecification' in launch.parameters));
    assert.ok(r.visited.includes('runInstances'));assert.ok(!r.visited.includes('runBurstableInstances'));
});
test('graph: only the burstable state forwards CreditSpecification, and both states call EC2 RunInstances',()=>{
    const g=lifecycleDefinition('helper') as any,plain=g.States.runInstances,burst=g.States.runBurstableInstances;
    assert.equal(plain.Resource,'arn:aws:states:::aws-sdk:ec2:runInstances');assert.equal(burst.Resource,'arn:aws:states:::aws-sdk:ec2:runInstances');
    assert.deepEqual(Object.keys(burst.Parameters),[...Object.keys(plain.Parameters),'CreditSpecification.$']);
    assert.equal(burst.Parameters['CreditSpecification.$'],'$.step.parameters.CreditSpecification');
    assert.ok(!Object.keys(plain.Parameters).includes('CreditSpecification.$'));
    assert.equal(burst.Next,'After-runBurstableInstances');assert.equal(g.States['After-runBurstableInstances'].Next,'Observe-instance');
});
test('tier map: free = t3a.medium then t3.medium (burstable), plus / compute4 / compute8 are non-burstable; all allowlisted; schema refuses bad maps',()=>{
    assert.deepEqual(TIER_INSTANCE_TYPES,{free:['t3a.medium','t3.medium'],plus:['m6i.large'],compute4:['m6i.xlarge'],compute8:['m6i.2xlarge']});
    for(const tier of COMPUTER_TIERS)for(const t of TIER_INSTANCE_TYPES[tier])assert.ok((INSTANCE_TYPES as readonly string[]).includes(t),t);
    assert.deepEqual(INSTANCE_TYPES.filter(isBurstable),['t3a.medium','t3.medium']);
    assert.ok(TIER_INSTANCE_TYPES.free.every(isBurstable));for(const tier of ['plus','compute4','compute8'] as const)assert.ok(!TIER_INSTANCE_TYPES[tier].some(isBurstable));
    for(const bad of [{...TIER_INSTANCE_TYPES,free:['t3a.large']},{...TIER_INSTANCE_TYPES,free:['t3a.medium','t3a.medium']},
        {...TIER_INSTANCE_TYPES,free:[]},{...TIER_INSTANCE_TYPES,compute4:[]},{...TIER_INSTANCE_TYPES,compute8:undefined},
        {...TIER_INSTANCE_TYPES,pro:['c6i.xlarge']}])
        assert.equal(TierMapSchema.safeParse(bad).success,false,JSON.stringify(bad));
    assert.deepEqual(BURSTABLE_CREDITS,{CpuCredits:'standard'});
});
test('tier change: replace relaunches the disposable root with the NEW type on the retained data volume (never ModifyInstanceAttribute)',async()=>{
    for(const [from,to] of [['t3a.medium','m6i.large'],['m6i.large','t3a.medium']] as const){
        const f=lifecycleFixture('replace',{instanceType:to,instanceTypes:[...TIERED]});
        f.state.instances[0]!.InstanceType=from;
        const r=await run('replace',{fixture:f});assert.equal(r.error,undefined,`${from}->${to}`);
        assert.deepEqual(r.calls.map(c=>c.action),['stopInstances','terminateInstances','runInstances','createTags','attachVolume']);
        const launch=r.calls.find(c=>c.action==='runInstances')!.parameters;assert.equal(launch.InstanceType,to);
        assert.equal('CreditSpecification' in launch,to==='t3a.medium');
        assert.equal(r.receipt.volumeId,f.state.volumes[0]!.VolumeId);assert.equal(r.receipt.generation,f.i.targetGeneration);
        assert.ok(!r.calls.some(c=>c.action==='modifyInstanceAttribute'));
    }
});
test('a free-tier type outside the deployment allowlist is refused by the intent',()=>{
    const f=lifecycleFixture();
    assert.equal(LifecycleIntentSchema.safeParse({...f.i,instanceType:'t3a.medium'}).success,false,'default deployment lists no burstable type');
    const tiered=lifecycleFixture('provision',{instanceType:'t3a.medium',instanceTypes:[...TIERED]});
    assert.ok(LifecycleIntentSchema.safeParse(tiered.i).success);
    assert.equal(LifecycleIntentSchema.safeParse({...tiered.i,instanceType:'t3a.large'}).success,false);
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
// C-6 (PR #200 review 4277908738): an uncertain ModifyInstanceAttribute may never have reached EC2;
// starting then would boot the previous epoch's nonce. Start only after a DEFINITE write.
for(const [why,noEffect] of [['did not land',true],['landed',false]] as const)
    test(`start-in-place: a lost userData write reply (${why}) is re-issued before any start`,async()=>{
        const f=lifecycleFixture('start',{userData:'bm9uY2UtZTM=',userDataNonce:true});
        const r=await run('start',{fixture:f,lose:'modifyInstanceAttribute',...(noEffect?{noEffect:'modifyInstanceAttribute'}:{})});
        assert.equal(r.error,undefined);assert.equal(r.receipt.state,'running');
        assert.deepEqual(r.calls.map(c=>c.action),['modifyInstanceAttribute','modifyInstanceAttribute','startInstances']);
        for(const c of r.calls.filter(c=>c.action==='modifyInstanceAttribute'))assert.deepEqual(c.parameters.UserData,{Value:'bm9uY2UtZTM='});
    });
test('start-in-place: a userData write that never gets a definite answer never starts the instance',async()=>{
    const f=lifecycleFixture('start',{userData:'bm9uY2UtZTM=',userDataNonce:true});
    const r=await run('start',{fixture:f,fail:{action:'modifyInstanceAttribute',times:100000,error:taskError('States.Timeout','Task timed out')}});
    assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.receipt,undefined);
    assert.ok(!r.calls.some(c=>c.action==='startInstances'),'never starts on an unconfirmed nonce');
    assert.ok(r.calls.filter(c=>c.action==='modifyInstanceAttribute').length>1,'the idempotent write is re-issued');
});
test('start-in-place: a definitely rejected userData write ends the run without a start',async()=>{
    const f=lifecycleFixture('start',{userData:'bm9uY2UtZTM=',userDataNonce:true});
    const r=await run('start',{fixture:f,fail:{action:'modifyInstanceAttribute',times:1,
        error:taskError('EC2.UnauthorizedOperation','You are not authorized (Service: Ec2, Status Code: 403, Request ID: x)')}});
    assert.equal(r.error,'LifecycleUnconfirmed');assert.deepEqual(r.calls.map(c=>c.action),['modifyInstanceAttribute']);
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
test('I6: only the data volume carries the namespace backup tag DLM targets; the root disk never does',async()=>{
    const r=await run('provision');assert.equal(r.error,undefined);
    const dataTags=r.calls.find(c=>c.action==='createVolume')!.parameters.TagSpecifications[0].Tags;
    assert.deepEqual(dataTags.filter((t:any)=>t.Key==='ezil:backup'),[{Key:'ezil:backup',Value:'pilot'}]);
    const launch=r.calls.find(c=>c.action==='runInstances')!.parameters;
    for(const spec of launch.TagSpecifications)assert.ok(!spec.Tags.some((t:any)=>t.Key==='ezil:backup'),spec.ResourceType);
});

// Codex 4277801516: replace after the app's instance_lost recovery, when EC2 no longer knows the
// previous instance (terminated and aged out: DescribeInstances by ID answers NotFound).
function lostPrevious(){
    const f=lifecycleFixture('replace');
    f.state.instances=[];
    const v=f.state.volumes[0]!;v.State='available';v.Attachments=[];
    return f;
}
test('replace with a vanished previous instance relaunches onto the free retained volume (nothing to stop or terminate)',async()=>{
    const r=await run('replace',{fixture:lostPrevious()});
    assert.equal(r.error,undefined,r.cause);assert.equal(r.receipt?.state,'running');
    assert.deepEqual(r.calls.map(c=>c.action),['runInstances','createTags','attachVolume']);
    assert.equal(r.receipt.volumeId,r.f.state.volumes[0]!.VolumeId);
});
test('replace with a vanished previous instance refuses a volume attached elsewhere',async()=>{
    const f=lostPrevious(),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:'i-99999999999999999',VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('replace',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);
});
test('replace with a vanished previous instance refuses a volume still claiming it',async()=>{
    const f=lostPrevious(),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:f.i.previousInstanceId!,VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('replace',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);assert.equal(r.calls.length,0);
});
test('replace with a vanished previous instance refuses a foreign or missing volume',async()=>{
    const foreign=lostPrevious();foreign.state.volumes[0]!.Tags=[];
    const a=await run('replace',{fixture:foreign});assert.equal(a.error,'LifecycleUnconfirmed');assert.equal(a.calls.length,0);
    const missing=lostPrevious();missing.state.volumes=[];
    const b=await run('replace',{fixture:missing});assert.equal(b.error,'LifecycleUnconfirmed');assert.equal(b.calls.length,0);
});
test('a previous instance that EXISTS but is not this computer still refuses the replace',async()=>{
    const f=lifecycleFixture('replace');f.state.instances[0]!.Tags=[];
    const r=await run('replace',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);
});
test('start: a vanished instance is still a failure (only replace, retire and stop may proceed without it)',async()=>{
    const f=lifecycleFixture('start');f.state.instances=[];
    const r=await run('start',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);
});

// Codex 4278276831: an instance terminated externally after the placement entered DRAINING/
// STOPPING. The stop completes as a LOST-instance stop (receipt `stopped` + `instanceLost`, the
// retained volume kept) so the app's next wake replaces onto the volume; refusals unchanged.
function lostStopFixture(visibleTerminated=false){
    const f=lifecycleFixture('stop');
    if(visibleTerminated)f.state.instances[0]!.State={Name:'terminated'};
    else f.state.instances=[];
    const v=f.state.volumes[0]!;v.State='available';v.Attachments=[];
    return f;
}
for(const visible of [false,true])test(`stop with a ${visible?'visibly terminated':'vanished'} instance completes as a lost-instance stop on the free, owned volume`,async()=>{
    const f=lostStopFixture(visible),volumeId=f.state.volumes[0]!.VolumeId;
    const r=await run('stop',{fixture:f});
    assert.equal(r.error,undefined,r.cause);assert.equal(r.receipt?.state,'stopped');assert.equal(r.receipt?.instanceLost,true);
    assert.deepEqual(r.calls.map(c=>c.action),[]);
    assert.equal(r.receipt.volumeId,volumeId);assert.equal(r.receipt.instanceId,f.i.providerInstanceId);
    assert.equal(r.f.state.volumes.length,1);
});
test('instanceLost is valid only on a stopped receipt',async()=>{
    const start=await run('start'),startWork={document:start.f.envelope.document,digest:start.f.digest,createdAt:new Date()};
    assert.throws(()=>validateLifecycleReceipt(startWork,{...start.receipt,instanceLost:true}),/lifecycle_conflict/);
    const stop=await run('stop',{fixture:lostStopFixture()}),stopWork={document:stop.f.envelope.document,digest:stop.f.digest,createdAt:new Date()};
    assert.deepEqual(validateLifecycleReceipt(stopWork,stop.receipt),stop.receipt);
});
test('a normal stop carries no instanceLost marker',async()=>{
    const r=await run('stop');assert.equal(r.error,undefined,r.cause);assert.equal(r.receipt?.state,'stopped');assert.equal(r.receipt?.instanceLost,undefined);
});
test('stop with a vanished instance refuses a volume attached elsewhere',async()=>{
    const f=lostStopFixture(),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:'i-99999999999999999',VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('stop',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);assert.equal(r.calls.length,0);
});
test('stop with a vanished instance refuses a volume still claiming it',async()=>{
    const f=lostStopFixture(),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:f.i.providerInstanceId!,VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('stop',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);assert.equal(r.calls.length,0);
});
test('stop with a vanished instance refuses a foreign or missing volume',async()=>{
    const foreign=lostStopFixture();foreign.state.volumes[0]!.Tags=[];
    const a=await run('stop',{fixture:foreign});assert.equal(a.error,'LifecycleUnconfirmed');assert.equal(a.calls.length,0);
    const missing=lostStopFixture();missing.state.volumes=[];
    const b=await run('stop',{fixture:missing});assert.equal(b.error,'LifecycleUnconfirmed');assert.equal(b.calls.length,0);
});
test('stop with a visibly terminated instance never completes while its volume is still attached',async()=>{
    const f=lostStopFixture(true),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:f.i.providerInstanceId!,VolumeId:v.VolumeId,State:'detaching',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('stop',{fixture:f});assert.notEqual(r.receipt?.state,'stopped');assert.equal(r.calls.length,0);
});
test('an instance that EXISTS but is not this computer still refuses the stop',async()=>{
    const f=lifecycleFixture('stop');f.state.instances[0]!.Tags=[];
    const r=await run('stop',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);
});

// Codex 4278130057: a computer whose instance was lost (instance_lost → STOPPED) and was then
// deleted retires with no instance to stop or terminate; the retained volume is kept (R11).
function lostRetire(){
    const f=lifecycleFixture('retire');
    f.state.instances=[];
    const v=f.state.volumes[0]!;v.State='available';v.Attachments=[];
    return f;
}
test('retire with a vanished instance succeeds on the free, owned retained volume (nothing to stop or terminate, volume kept)',async()=>{
    const f=lostRetire(),volumeId=f.state.volumes[0]!.VolumeId;
    const r=await run('retire',{fixture:f});
    assert.equal(r.error,undefined,r.cause);assert.equal(r.receipt?.state,'retired');
    assert.deepEqual(r.calls.map(c=>c.action),[]);
    assert.equal(r.receipt.volumeId,volumeId);assert.equal(r.receipt.instanceId,f.i.providerInstanceId);
    assert.equal(r.f.state.volumes.length,1);
});
test('retire with a vanished instance refuses a volume attached elsewhere',async()=>{
    const f=lostRetire(),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:'i-99999999999999999',VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('retire',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);assert.equal(r.calls.length,0);
});
test('retire with a vanished instance refuses a volume still claiming it',async()=>{
    const f=lostRetire(),v=f.state.volumes[0]!;v.State='in-use';
    v.Attachments=[{InstanceId:f.i.providerInstanceId!,VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
    const r=await run('retire',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.match(r.cause!,/lifecycle_volume_invalid/);assert.equal(r.calls.length,0);
});
test('retire with a vanished instance refuses a foreign or missing volume',async()=>{
    const foreign=lostRetire();foreign.state.volumes[0]!.Tags=[];
    const a=await run('retire',{fixture:foreign});assert.equal(a.error,'LifecycleUnconfirmed');assert.equal(a.calls.length,0);
    const missing=lostRetire();missing.state.volumes=[];
    const b=await run('retire',{fixture:missing});assert.equal(b.error,'LifecycleUnconfirmed');assert.equal(b.calls.length,0);
});
test('an instance that EXISTS but is not this computer still refuses the retire',async()=>{
    const f=lifecycleFixture('retire');f.state.instances[0]!.Tags=[];
    const r=await run('retire',{fixture:f});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);
});

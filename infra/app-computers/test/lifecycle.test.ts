import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { token } from '../lib/lifecycle/contract.js';
import type { LifecycleIntent } from '../lib/lifecycle/intent.js';
import { lifecycleFixture } from './lifecycle-fixture.js';

async function run(operation:LifecycleIntent['operation'],options:{lose?:string;noEffect?:string;revokeAfter?:string;foreignDisk?:boolean;deleteDisk?:boolean;staleOldAfterLaunch?:boolean}={}){
    const f=lifecycleFixture(operation),helper=createLifecycleHelper(f.settings,f.deps),graph=lifecycleDefinition('helper');
    if(options.foreignDisk)f.state.volumes[0]!.Tags=[];
    if(options.deleteDisk)f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.DeleteOnTermination=true;
    if(options.staleOldAfterLaunch){const original=f.deps.instances;let stale=true;f.deps.instances=async selector=>{
        const rows=await original(selector);if(Array.isArray(selector)&&f.state.instances.length===2&&stale){stale=false;rows[0]!.instance.State={Name:'stopped'};}return rows;};}
    const data:Record<string,any>={},calls:{action:string;parameters:any}[]=[];let lost=false,next=graph.StartAt;
    const at=(path:string):any=>path==='$$.Execution.Id'?f.executionArn:path.slice(2).split('.').reduce((o,k)=>o?.[k],data);
    for(let n=0;n<1000;n++){
        const s=graph.States[next];assert.ok(s,next);
        if(s.Type==='Fail')return {error:s.Error,calls,f};
        if(s.Type==='Pass')return {receipt:at(s.InputPath),calls,f};
        if(s.Type==='Choice'){next=s.Choices.find((c:any)=>at(c.Variable)===c.StringEquals)?.Next??s.Default;continue;}
        if(s.Type==='Wait'){f.state.now+=s.Seconds*1000;next=s.Next;continue;}
        assert.equal(s.Type,'Task');assert.equal(s.Retry,undefined);
        const parameters=Object.fromEntries(Object.entries(s.Parameters as Record<string,any>).map(([k,v])=>[k.endsWith('.$')?k.slice(0,-2):k,k.endsWith('.$')?at(v):v]));
        try{
            if(s.Resource==='helper')data.step=await helper(parameters);
            else{
                const action=s.Resource.split(':').at(-1)!;calls.push({action,parameters});
                const target=f.state.instances.find(i=>i.InstanceId===(parameters.InstanceIds?.[0]??parameters.InstanceId));
                if(action!==options.noEffect){
                    if(action==='createVolume')f.state.volumes.push(f.volume());
                    if(action==='runInstances')f.state.instances.push(f.instance('i-33333333333333333'));
                    if(action==='startInstances')target!.State={Name:'running'};
                    if(action==='stopInstances')target!.State={Name:'stopped'};
                    if(action==='terminateInstances'){assert.equal(target!.State?.Name,'stopped');target!.State={Name:'terminated'};
                        const v=f.state.volumes[0]!;v.State='available';v.Attachments=[];target!.BlockDeviceMappings=[];}
                    if(action==='createTags')f.state.volumes[0]!.Tags=parameters.Tags;
                    if(action==='attachVolume')f.attach(f.state.volumes[0]!,target!);
                    if(action==='modifyInstanceAttribute'){assert.equal(parameters.BlockDeviceMappings[0].Ebs.DeleteOnTermination,false);}
                }
                if(action===options.revokeAfter)f.state.authorized=false;
                if(action===options.lose&&!lost){lost=true;throw new Error('lost response');}
            }
            next=s.Next;
        }catch{next=s.Catch[0].Next;}
    }throw new Error('unbounded workflow');
}
for(const operation of ['provision','start','stop','replace','retire'] as const)test(`${operation}: shipped Standard graph observes real operation sequence and retained data disk`,async()=>{
    const r=await run(operation);assert.equal(r.error,undefined);assert.ok(r.receipt);assert.equal(r.receipt.jobId,r.f.i.jobId);
    assert.equal(r.receipt.state,operation==='stop'?'stopped':operation==='retire'?'retired':'running');assert.equal(r.f.state.volumes.length,1);
    assert.equal(r.receipt.volumeId,r.f.state.volumes[0]!.VolumeId);assert.ok(r.f.state.authorityCalls>0);
    if(operation==='replace'){
        assert.deepEqual(r.calls.map(c=>c.action),['stopInstances','terminateInstances','runInstances','createTags','attachVolume','modifyInstanceAttribute']);
        assert.equal(r.f.state.instances[0]!.State?.Name,'terminated');
    }
    if(operation==='provision'){
        const allocation=r.calls.find(c=>c.action==='createVolume')!.parameters;assert.equal(allocation.Size,50);assert.equal(allocation.Encrypted,true);
        const launch=r.calls.find(c=>c.action==='runInstances')!.parameters;assert.equal(launch.MinCount,1);assert.equal(launch.MaxCount,1);
        assert.equal(launch.MetadataOptions.HttpPutResponseHopLimit,1);assert.equal(launch.BlockDeviceMappings[0].Ebs.VolumeSize,30);
        assert.equal(launch.UserData,undefined);assert.equal(launch.ClientToken,token(r.f.digest,'instance'));
    }
});
for(const [operation,action]of [['provision','createVolume'],['provision','runInstances'],['provision','attachVolume'],['start','startInstances'],['stop','stopInstances'],['retire','terminateInstances']] as const)
    test(`lost ${action} reply is observed with no duplicate mutation`,async()=>{const r=await run(operation,{lose:action});assert.equal(r.error,undefined);assert.equal(r.calls.filter(c=>c.action===action).length,1);});
for(const [operation,action]of [['start','startInstances'],['stop','stopInstances'],['retire','terminateInstances']] as const)
    test(`uncertain ${action} never retries or frees the lifecycle reservation`,async()=>{const r=await run(operation,{lose:action,noEffect:action});assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.receipt,undefined);assert.equal(r.calls.filter(c=>c.action===action).length,1);});
test('revocation after allocation never starts compute or reports completion',async()=>{const r=await run('provision',{revokeAfter:'createVolume'});assert.equal(r.error,'LifecycleUnconfirmed');assert.deepEqual(r.calls.map(c=>c.action),['createVolume']);assert.equal(r.f.state.volumes.length,1);});
test('cross-tenant or deletable disk prevents stop/terminate',async()=>{for(const options of [{foreignDisk:true},{deleteDisk:true}]){const r=await run('replace',options);assert.equal(r.error,'LifecycleUnconfirmed');assert.equal(r.calls.length,0);}});
test('immutable execution identity, deployment and redrive are enforced before effects',async()=>{
    for(const field of ['stateMachineVersionArn','name','input','redriveCount','stateMachineAliasArn']){
        const f=lifecycleFixture();(f.state.execution as Record<string,unknown>)[field]=field==='redriveCount'?1:'forged';
        await assert.rejects(createLifecycleHelper(f.settings,f.deps)({executionArn:f.executionArn,phase:'initial'}));assert.equal(f.state.authorityCalls,0);
    }
});
test('unsupported AMI/template and out-of-scope writer profiles cannot launch',async()=>{
    for(const kind of ['image','template','profile']){
        const f=lifecycleFixture();f.state.volumes.push(f.volume());if(kind==='image')f.state.imageBad=true;if(kind==='template')f.state.templateBad=true;
        if(kind==='profile')f.settings.writerRolePathPrefix='ezil/another/computers';
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createHmac, createHash } from 'node:crypto';
import { EC2Client, CreateVolumeCommand, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand,
    AttachVolumeCommand, ModifyInstanceAttributeCommand, CreateTagsCommand } from '@aws-sdk/client-ec2';
import { awsDependencies } from '../lib/lifecycle/aws.js';
import { AUTHORITY_PATH, token } from '../lib/lifecycle/contract.js';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { computerRecoveryFixture } from './computer-recovery-fixture.js';
const credentials={accessKeyId:'ASIAABCDEFGHIJKLMNOP',secretAccessKey:'test-only',sessionToken:'test-only'};
const json=(value:unknown)=>({response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.0'},body:Readable.from([JSON.stringify(value)])}});
const xml=(action:string,value='')=>({response:{statusCode:200,headers:{'content-type':'text/xml'},body:Readable.from([`<${action}Response>${value}</${action}Response>`])}});

test('v2 authority signs only immutable job scope and rejects changed scope or malformed writer evidence',async()=>{
    const f=computerRecoveryFixture(),key='ab'.repeat(32);let mode='valid';
    const deps=awsDependencies(f.settings,{credentials,requestHandler:{async handle(){
        return json({ARN:f.settings.authoritySecretArn,SecretString:key,VersionStages:['AWSCURRENT']});
    }},fetcher:(async(url,init)=>{
        assert.equal(url,f.settings.authorityOrigin+AUTHORITY_PATH);assert.equal(init!.redirect,'error');
        const body=String(init!.body),scope=JSON.parse(body),headers=new Headers(init!.headers),timestamp=headers.get('x-ezil-workflow-timestamp')!;
        assert.deepEqual(scope,{schemaVersion:2,computerId:f.i.computerId,jobId:f.i.jobId,digest:f.digest});
        assert.equal(headers.get('x-ezil-workflow-signature'),createHmac('sha256',Buffer.from(key,'hex')).update([
            'ezil-lifecycle-authority-v1','POST',AUTHORITY_PATH,timestamp,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex'));
        if(mode==='revoked')return Response.json({code:'lifecycle_not_current'},{status:403});
        return Response.json({authorized:true,...scope,...(mode==='scope'?{digest:'b'.repeat(64)}:{}),
            writers:mode==='duplicate'?[...f.writers,...f.writers]:mode==='missing'?undefined:f.writers});
    }) as typeof fetch});
    assert.deepEqual(await deps.recoveryAuthority!(f.i,f.digest),{writers:f.writers});
    for(mode of ['scope','duplicate','missing'])await assert.rejects(deps.recoveryAuthority!(f.i,f.digest));
    mode='revoked';assert.equal(await deps.recoveryAuthority!(f.i,f.digest),null);
});

test('actual lifecycle read clients serialize bounded requests and sign the application authority protocol',async()=>{
    const f=lifecycleFixture(),calls:string[]=[],key='ab'.repeat(32);
    const deps=awsDependencies(f.settings,{credentials,requestHandler:{async handle(request:any){
        const body=typeof request.body==='string'?request.body:Buffer.from(request.body??[]).toString();
        const params=new URLSearchParams(body),action=request.headers['x-amz-target']?.split('.').at(-1)??params.get('Action');calls.push(action);
        assert.match(request.headers.authorization,/AWS4-HMAC-SHA256/);
        assert.ok(['ec2.us-east-1.amazonaws.com','states.us-east-1.amazonaws.com','secretsmanager.us-east-1.amazonaws.com'].includes(request.hostname));
        if(action==='DescribeExecution')return json({...f.state.execution,startDate:f.state.now/1000});
        if(action==='GetSecretValue')return json({ARN:f.settings.authoritySecretArn,SecretString:key,VersionStages:['AWSCURRENT']});
        if(action==='DescribeInstances'){assert.equal(params.get('Filter.1.Name'),'client-token');assert.equal(params.get('Filter.1.Value.1'),token(f.digest,'instance'));return xml(action,'<reservationSet/>');}
        if(action==='DescribeVolumes'){assert.equal(params.get('Filter.1.Name'),'tag:ezil:allocation');return xml(action,'<volumeSet/>');}
        if(action==='DescribeImages')return xml(action,'<imagesSet><item><imageId>'+f.i.deployment.amiId+'</imageId></item></imagesSet>');
        if(action==='DescribeLaunchTemplateVersions')return xml(action,'<launchTemplateVersionSet><item><launchTemplateId>'+f.i.deployment.launchTemplateId+'</launchTemplateId><versionNumber>1</versionNumber></item></launchTemplateVersionSet>');
        throw new Error('unexpected request');
    }},fetcher:(async(url,init)=>{
        assert.equal(url,f.settings.authorityOrigin+AUTHORITY_PATH);assert.equal(init!.redirect,'error');
        const headers=new Headers(init!.headers),timestamp=headers.get('x-ezil-workflow-timestamp')!,body=String(init!.body);
        const expected=createHmac('sha256',Buffer.from(key,'hex')).update(['ezil-lifecycle-authority-v1','POST',AUTHORITY_PATH,timestamp,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
        assert.equal(headers.get('x-ezil-workflow-signature'),expected);assert.equal(headers.has('authorization'),false);
        return Response.json({authorized:true,...JSON.parse(body)});
    }) as typeof fetch});
    assert.equal((await deps.execution(f.executionArn)).executionArn,f.executionArn);
    assert.equal(await deps.authority(f.i,f.digest),true);assert.deepEqual(await deps.instances({token:token(f.digest,'instance')}),[]);
    assert.deepEqual(await deps.volumes({token:token(f.digest,'volume')}),[]);
    assert.equal((await deps.image(f.i.deployment.amiId))?.ImageId,f.i.deployment.amiId);
    assert.equal((await deps.template(f.i.deployment.launchTemplateId,'1'))?.VersionNumber,1);
    assert.deepEqual(calls,['DescribeExecution','GetSecretValue','DescribeInstances','DescribeVolumes','DescribeImages','DescribeLaunchTemplateVersions']);
});
test('the actual EC2 SDK accepts allocation parameters and omits any invented StartInstances ClientToken',async()=>{
    const f=lifecycleFixture(),helper=createLifecycleHelper(f.settings,f.deps),requests:URLSearchParams[]=[];
    const client=new EC2Client({region:'us-east-1',credentials,maxAttempts:1,requestHandler:{async handle(r:any){
        const p=new URLSearchParams(typeof r.body==='string'?r.body:Buffer.from(r.body).toString());requests.push(p);return xml(p.get('Action')!);
    }}});
    try{
        const create=await helper({executionArn:f.executionArn,phase:'initial'});await client.send(new CreateVolumeCommand(create.parameters as any));
        f.state.volumes.push(f.volume());const launch=await helper({executionArn:f.executionArn,phase:'volume'});await client.send(new RunInstancesCommand(launch.parameters as any));
        const id='i-33333333333333333';await client.send(new StartInstancesCommand({InstanceIds:[id]}));
        await client.send(new StopInstancesCommand({InstanceIds:[id],Force:false,Hibernate:false,SkipOsShutdown:false}));
        await client.send(new TerminateInstancesCommand({InstanceIds:[id]}));
        await client.send(new AttachVolumeCommand({InstanceId:id,VolumeId:f.state.volumes[0]!.VolumeId,Device:'/dev/sdf'}));
        await client.send(new ModifyInstanceAttributeCommand({InstanceId:id,BlockDeviceMappings:[{DeviceName:'/dev/sdf',Ebs:{DeleteOnTermination:false}}]}));
        await client.send(new CreateTagsCommand({Resources:[f.state.volumes[0]!.VolumeId!],Tags:[{Key:'ezil:generation',Value:'1'}]}));
        assert.equal(requests[0]!.get('ClientToken'),token(f.digest,'volume'));assert.equal(requests[0]!.get('Encrypted'),'true');
        assert.equal(requests[1]!.get('LaunchTemplate.Version'),'1');assert.equal(requests[1]!.get('ClientToken'),token(f.digest,'instance'));
        assert.equal(requests[1]!.get('BlockDeviceMapping.1.Ebs.VolumeSize'),'30');
        assert.equal(requests[2]!.get('ClientToken'),null);assert.equal(requests[3]!.get('SkipOsShutdown'),'false');
        assert.equal(requests[6]!.get('BlockDeviceMapping.1.Ebs.DeleteOnTermination'),'false');
    }finally{client.destroy()}
});

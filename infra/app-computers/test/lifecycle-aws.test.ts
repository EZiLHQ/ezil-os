import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createHmac, createHash } from 'node:crypto';
import { EC2Client, CreateVolumeCommand, RunInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand,
    AttachVolumeCommand, CreateTagsCommand } from '@aws-sdk/client-ec2';
import { awsDependencies } from '../lib/lifecycle/aws.js';
import { AUTHORITY_PATH, token } from '../lib/lifecycle/contract.js';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
const credentials={accessKeyId:'ASIAABCDEFGHIJKLMNOP',secretAccessKey:'test-only',sessionToken:'test-only'};
const json=(value:unknown)=>({response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.0'},body:Readable.from([JSON.stringify(value)])}});
const xml=(action:string,value='')=>({response:{statusCode:200,headers:{'content-type':'text/xml'},body:Readable.from([`<${action}Response>${value}</${action}Response>`])}});

test('actual lifecycle read clients serialize bounded requests and sign the application authority protocol',async()=>{
    const f=lifecycleFixture(),calls:string[]=[],key='ab'.repeat(32);
    const deps=awsDependencies(f.settings,{credentials,requestHandler:{async handle(request:any){
        const body=typeof request.body==='string'?request.body:Buffer.from(request.body??[]).toString();
        const params=new URLSearchParams(body),action=request.headers['x-amz-target']?.split('.').at(-1)??params.get('Action');calls.push(action);
        assert.match(request.headers.authorization,/AWS4-HMAC-SHA256/);
        assert.ok(['ec2.ap-south-1.amazonaws.com','states.ap-south-1.amazonaws.com','secretsmanager.ap-south-1.amazonaws.com'].includes(request.hostname),request.hostname);
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
    const client=new EC2Client({region:'ap-south-1',credentials,maxAttempts:1,requestHandler:{async handle(r:any){
        const p=new URLSearchParams(typeof r.body==='string'?r.body:Buffer.from(r.body).toString());requests.push(p);return xml(p.get('Action')!);
    }}});
    try{
        const create=await helper({executionArn:f.executionArn,phase:'initial'});await client.send(new CreateVolumeCommand(create.parameters as any));
        f.state.volumes.push(f.volume());const launch=await helper({executionArn:f.executionArn,phase:'volume'});await client.send(new RunInstancesCommand(launch.parameters as any));
        const id='i-33333333333333333';await client.send(new StartInstancesCommand({InstanceIds:[id]}));
        await client.send(new StopInstancesCommand({InstanceIds:[id],Force:false,Hibernate:false,SkipOsShutdown:false}));
        await client.send(new TerminateInstancesCommand({InstanceIds:[id]}));
        await client.send(new AttachVolumeCommand({InstanceId:id,VolumeId:f.state.volumes[0]!.VolumeId,Device:'/dev/sdf'}));
        await client.send(new CreateTagsCommand({Resources:[f.state.volumes[0]!.VolumeId!],Tags:[{Key:'ezil:generation',Value:'1'}]}));
        assert.equal(requests[0]!.get('ClientToken'),token(f.digest,'volume'));assert.equal(requests[0]!.get('Encrypted'),'true');
        assert.equal(requests[1]!.get('LaunchTemplate.Version'),'1');assert.equal(requests[1]!.get('ClientToken'),token(f.digest,'instance'));
        assert.equal(requests[0]!.get('AvailabilityZoneId'),'aps1-az1');assert.equal(requests[0]!.get('AvailabilityZone'),null);
        assert.equal(requests[0]!.get('Size'),'20');
        assert.equal(requests[1]!.get('BlockDeviceMapping.1.DeviceName'),'/dev/sda1');
        assert.equal(requests[1]!.get('BlockDeviceMapping.1.Ebs.VolumeSize'),'30');assert.equal(requests[1]!.get('InstanceType'),'m6i.large');
        assert.equal(requests[1]!.get('MetadataOptions.InstanceMetadataTags'),'disabled');assert.equal(requests[1]!.get('HibernationOptions.Configured'),'false');
        assert.equal(requests[1]!.get('IamInstanceProfile.Arn'),null);
        assert.equal(requests[2]!.get('ClientToken'),null);assert.equal(requests[3]!.get('SkipOsShutdown'),'false');
    }finally{client.destroy()}
});
test('free tier: the actual EC2 SDK serializes the burstable launch with CreditSpecification.CpuCredits=standard',async()=>{
    const f=lifecycleFixture('provision',{instanceType:'t3a.medium',instanceTypes:['t3a.medium','t3.medium','m6i.large']});
    const helper=createLifecycleHelper(f.settings,f.deps),requests:URLSearchParams[]=[];
    const client=new EC2Client({region:'ap-south-1',credentials,maxAttempts:1,requestHandler:{async handle(r:any){
        const p=new URLSearchParams(typeof r.body==='string'?r.body:Buffer.from(r.body).toString());requests.push(p);return xml(p.get('Action')!);
    }}});
    try{
        await helper({executionArn:f.executionArn,phase:'initial'});f.state.volumes.push(f.volume());
        const launch=await helper({executionArn:f.executionArn,phase:'volume'});
        assert.equal(launch.decision,'runBurstableInstances');
        await client.send(new RunInstancesCommand(launch.parameters as any));
        assert.equal(requests[0]!.get('Action'),'RunInstances');assert.equal(requests[0]!.get('InstanceType'),'t3a.medium');
        assert.equal(requests[0]!.get('CreditSpecification.CpuCredits'),'standard');
    }finally{client.destroy()}
});

test('instances by ID: EC2 NotFound is an empty answer; other errors and the token query still throw',async()=>{
    const f=lifecycleFixture();
    const errorXml=(code:string)=>({response:{statusCode:400,headers:{'content-type':'text/xml'},body:Readable.from([
        `<Response><Errors><Error><Code>${code}</Code><Message>m</Message></Error></Errors><RequestID>r</RequestID></Response>`])}});
    let code='InvalidInstanceID.NotFound';
    const deps=awsDependencies(f.settings,{credentials,requestHandler:{async handle(){return errorXml(code);}},fetcher:fetch});
    assert.deepEqual(await deps.instances(['i-22222222222222222']),[]);
    await assert.rejects(deps.instances({token:token(f.digest,'instance')}));
    code='InvalidInstanceID.Malformed';await assert.rejects(deps.instances(['i-22222222222222222']));
    code='UnauthorizedOperation';await assert.rejects(deps.instances(['i-22222222222222222']));
});

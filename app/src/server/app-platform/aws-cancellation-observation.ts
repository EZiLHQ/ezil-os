import { DescribeExecutionCommand, paginateGetExecutionHistory, type SFNClient,
    type DescribeExecutionCommandOutput, type HistoryEvent } from '@aws-sdk/client-sfn';
import { DescribeInstancesCommand, DescribeVolumesCommand, type EC2Client, type Tag } from '@aws-sdk/client-ec2';
import { LifecycleError, type LifecycleWork } from './lifecycle-protocol';
import { parseComputerLifecycleWork, computerLifecycleAllocationToken } from './computer-lifecycle-work';
import type { CancellationAuthorityScope, CancellationReceipt } from './cancellation-authority-protocol';

const fail = (): never => { throw new LifecycleError('lifecycle_unconfirmed'); };
const tagged = (tags: Tag[] | undefined, expected: Record<string,string>) => Object.entries(expected).every(([key,value]) =>
    tags?.filter(t=>t.Key===key).length===1 && tags.find(t=>t.Key===key)?.Value===value);
const endings: Record<string,string> = { SUCCEEDED:'ExecutionSucceeded',FAILED:'ExecutionFailed',ABORTED:'ExecutionAborted',TIMED_OUT:'ExecutionTimedOut' };
export async function verifyCancelledSource(sfn: SFNClient, source: LifecycleWork, cancellationStoppedAt: Date, signal: AbortSignal) {
    const i = parseComputerLifecycleWork(source), version=i.deployment.stateMachineVersionArn,
        machine=version.slice(0,version.lastIndexOf(':')),name=`computer-${i.jobId}`,arn=machine.replace(':stateMachine:',':execution:')+':'+name;
    const e=await sfn.send(new DescribeExecutionCommand({executionArn:arn}),{abortSignal:signal});
    if (e.executionArn!==arn || e.stateMachineArn!==machine || e.stateMachineVersionArn!==version || e.stateMachineAliasArn
        || e.name!==name || e.redriveCount!==0 || !endings[e.status??'']
        || e.input!==JSON.stringify({schemaVersion:i.schemaVersion,document:source.document,digest:source.digest})
        || !e.startDate || !e.stopDate || !Number.isFinite(e.startDate.getTime()) || !Number.isFinite(e.stopDate.getTime())
        || e.startDate.getTime()<source.createdAt.getTime()-5000 || e.stopDate<e.startDate
        || e.stopDate>cancellationStoppedAt || e.stopDate.getTime()>Date.now()+5000) return fail();
    return e;
}

/** Independent proof, never merely trust a workflow's positive receipt. Token
 * inventories also prevent omission of discovered allocations. Missing recent
 * target IDs are uncertainty, not termination. */
export async function observeCancelledResources(o: {
    sfn: SFNClient; ec2: EC2Client; source: LifecycleWork; scope: CancellationAuthorityScope;
    receipt: CancellationReceipt['source']; execution: DescribeExecutionCommandOutput; signal: AbortSignal;
}) {
    const {sfn,ec2,source,scope,receipt,execution,signal}=o,i=parseComputerLifecycleWork(source),d=i.deployment,request={abortSignal:signal};
    const history: HistoryEvent[]=[];let pages=0,lastToken:string|undefined;
    for await (const page of paginateGetExecutionHistory({client:sfn,pageSize:1000,stopOnSameToken:true},
        {executionArn:receipt.sourceExecutionArn,includeExecutionData:false,reverseOrder:false},request)) {
        history.push(...page.events??[]);pages++;lastToken=page.nextToken;
        if(history.length>4000 || (pages>=4 && lastToken))return fail();
    }
    if(lastToken || !history.length || history[0]?.type!=='ExecutionStarted' || history.at(-1)?.type!==endings[execution.status!]
        || history.some((h,index)=>h.id!==index+1 || !h.timestamp || !Number.isFinite(h.timestamp.getTime())
            || h.timestamp.getTime()<execution.startDate!.getTime()-5000 || h.timestamp.getTime()>execution.stopDate!.getTime()+5000
            || h.type==='ExecutionRedriven'
            || (h.type==='TaskStateEntered' && !h.stateEnteredEventDetails?.name)))return fail();
    const entered=(name:string)=>history.some(h=>h.type==='TaskStateEntered'&&h.stateEnteredEventDetails?.name===name);
    const allocating=['provision','replace','recover'].includes(i.operation), originalId=i.schemaVersion===1?i.previousInstanceId??i.providerInstanceId:null;
    const target=receipt.instances.find(r=>r.instanceId!==originalId);
    if((allocating && entered('runInstances')!==Boolean(target)) || (!allocating && entered('runInstances'))
        || (i.operation==='provision'?entered('createVolume')!==(receipt.volumeId!==null):entered('createVolume'))
        || (scope.dataVolumeId!==null && scope.dataVolumeId!==receipt.volumeId))return fail();
    const tags=(generation:number,fence:string)=>({'ezil:managed-by':'app-computer-platform','ezil:stage':d.namespace,
        'ezil:computer-id':i.computerId,'ezil:generation':String(generation),'ezil:fence-token':fence});
    const [original,allocated,volumes]=await Promise.all([
        originalId?ec2.send(new DescribeInstancesCommand({InstanceIds:[originalId]}),request):null,
        allocating?ec2.send(new DescribeInstancesCommand({Filters:[{Name:'client-token',Values:[computerLifecycleAllocationToken(source,'instance')]}]}),request):null,
        i.operation==='provision'
            ?ec2.send(new DescribeVolumesCommand({Filters:[{Name:'tag:ezil:allocation',Values:[computerLifecycleAllocationToken(source,'volume')]}]}),request)
            :ec2.send(new DescribeVolumesCommand({VolumeIds:[i.dataVolumeId!]}),request),
    ]);
    const rows=(result:typeof original)=>result?.Reservations?.flatMap(r=>(r.Instances??[]).map(instance=>({instance,owner:r.OwnerId})))??[];
    const existing=rows(original),fresh=rows(allocated),all=[...existing,...fresh];
    if(original?.NextToken || allocated?.NextToken || volumes.NextToken || existing.length!==(originalId?1:0)
        || fresh.length!==(target?1:0) || all.length!==receipt.instances.length
        || new Set(all.map(r=>r.instance.InstanceId)).size!==all.length)return fail();
    for(const expected of receipt.instances){
        const row=all.find(r=>r.instance.InstanceId===expected.instanceId),instance=row?.instance;
        if(!instance || row.owner!==d.accountId || instance.State?.Name!=='terminated'
            || instance.Placement?.AvailabilityZone!==d.availabilityZone || !tagged(instance.Tags,tags(expected.generation,expected.fenceToken))
            || (expected.instanceId!==originalId && instance.ClientToken!==computerLifecycleAllocationToken(source,'instance')))return fail();
    }
    if(volumes.Volumes?.length!==(receipt.volumeId?1:0))return fail();
    if(receipt.volumeId){
        const v=volumes.Volumes![0]!,previous=i.schemaVersion===2?i.dataScope:i.previousGeneration?{generation:i.previousGeneration,fenceToken:i.previousFenceToken!}:null;
        if(v.VolumeId!==receipt.volumeId || v.State!=='available' || !Array.isArray(v.Attachments) || v.Attachments.length!==0
            || v.Encrypted!==true || v.KmsKeyId!==d.dataKeyArn || v.Size!==50 || v.VolumeType!=='gp3' || v.MultiAttachEnabled!==false
            || v.AvailabilityZone!==d.availabilityZone || (!tagged(v.Tags,tags(i.targetGeneration,i.fenceToken))
                && !(previous && tagged(v.Tags,tags(previous.generation,previous.fenceToken))))
            || (i.operation==='provision' && !tagged(v.Tags,{'ezil:allocation':computerLifecycleAllocationToken(source,'volume')})))return fail();
    }
    const historical=[] as CancellationAuthorityScope['writers'];
    for(const w of scope.writers){
        const r=receipt.instances.find(v=>v.instanceId===w.instanceId);
        if(r){if(r.generation!==w.generation || r.fenceToken!==w.fenceToken)return fail();continue;}
        if(w.generation>=i.targetGeneration || !w.fencedAt || !w.observedAt || w.observedState!=='stopped'
            || w.fenceToken===i.fenceToken || Date.parse(w.fencedAt)>source.createdAt.getTime()
            || Date.parse(w.observedAt)>Date.parse(w.fencedAt)+5000)return fail();
        historical.push(w);
    }
    // Only independently fenced historical identities may disappear from EC2's
    // retained history. Newly allocated/current writers never take this path.
    for(let offset=0;offset<historical.length;offset+=8)await Promise.all(historical.slice(offset,offset+8).map(async w=>{
        let result;
        try{result=await ec2.send(new DescribeInstancesCommand({InstanceIds:[w.instanceId]}),request);}
        catch(error){if(!signal.aborted && error instanceof Error && error.name==='InvalidInstanceID.NotFound')return;throw error;}
        const found=rows(result);if(result.NextToken || found.length>1)return fail();if(!found.length)return;
        const row=found[0]!;
        if(row.owner!==d.accountId || row.instance.InstanceId!==w.instanceId || row.instance.State?.Name!=='terminated'
            || row.instance.Placement?.AvailabilityZone!==d.availabilityZone || !tagged(row.instance.Tags,tags(w.generation,w.fenceToken)))return fail();
    }));
    if(signal.aborted)return fail();
}

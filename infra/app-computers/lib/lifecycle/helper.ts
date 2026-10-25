import type { Instance, Volume, Tag, RunInstancesRequest } from '@aws-sdk/client-ec2';
import { z } from 'zod';
import { EnvelopeSchema, SettingsSchema, equal, phases, afterAction, token, tagsFor, retagsFor, tagList, initialVolumeTags, poolTagsFor, claimTagsFor, poolLease,
    type Phase, type Action, type Settings } from './contract.js';
import { MAX_THROTTLE_RETRIES, NO_ERROR, RecordedErrorSchema, classifyProviderError, throttleDelaySeconds, toLambdaError } from './errors.js';
import { parseLifecycleWork, validateAdoptRecovery, type LifecycleIntent, type LifecycleReceipt } from './intent.js';
import { awsDependencies, type Dependencies } from './aws.js';
import { BURSTABLE_CREDITS, isBurstable, type SourceLifecycleDeployment } from './deployment.js';
import { assertPermitTime, parseLease } from './lease.js';
import { matchesLifecycleDeployment, verifyPreparation } from './preparation-evidence.js';
import { verifyMaintenance } from './maintenance-evidence.js';
import { strictJson } from './strict-json.js';
const eventSchema=z.object({executionArn:z.string().max(300),phase:z.enum(phases),
    lastError:RecordedErrorSchema.default(NO_ERROR),throttles:z.number().int().min(0).max(100).default(0)}).strict();
export const tagged=(actual:Tag[]|undefined,expected:Record<string,string>)=>Object.entries(expected).every(([k,v])=>
    actual?.filter(t=>t.Key===k).length===1&&actual.find(t=>t.Key===k)?.Value===v);
const fail=(code='lifecycle_unconfirmed'):never=>{throw new Error(code)};
// Preserve phase memory through stale Describe views; only attach observations poll faster.
const wait=(phase:Phase)=>({decision:'wait',phase,delaySeconds:phase==='attached'?1:2});
/** Only the throttled action is known not to have happened. Preserve earlier
 * progress when re-arming it; resetting to initial can repeat an attachment
 * if a later tag/termination request was rejected and Describe regresses. */
function beforeRejectedAction(i:LifecycleIntent,phase:Phase):Phase {
    if(i.adoptRecoverRelease&&phase==='stopped')return 'unpooled';
    switch(phase){
        case 'instance':return i.operation==='provision'?'volume':i.operation==='replace'?'terminated':'initial';
        case 'tagged':return i.operation==='replace'?'instance':'volume';
        case 'attached':return 'tagged';
        case 'claimed':return 'attached';
        case 'unpooled':return 'claimed';
        case 'terminated':return i.operation==='release'?'detached':i.operation==='pool-retire'?'initial':'stopped';
        case 'detached':return 'stopped';
        case 'started':return i.userData!==null?'userdata':'initial';
        default:return 'initial';
    }
}
const instanceId=(v:string|undefined):v is string=>/^i-[a-f0-9]{17}$/.test(v??'');
const volumeId=(v:string|undefined):v is string=>/^vol-[a-f0-9]{17}$/.test(v??'');
const DATA_DEVICE='/dev/sdf';
const dataSizeValid=(size:number|undefined,d:Settings['deployment'])=>
    Number.isInteger(size)&&size!>=d.storage.dataMinGiB&&size!<=d.storage.dataMaxGiB;

/** Reconstruct each operation from original Standard input, never caller IDs.
 * Uncertain operations retain their control-plane reservation. No mutations
 * occur in this helper; the fixed Standard graph owns every provider call. */
export function createLifecycleHelper(settings:Settings,deps:Dependencies) {
    const d=settings.deployment,version=d.stateMachineVersionArn,machine=version.slice(0,version.lastIndexOf(':'));
    return async(input:unknown):Promise<Record<string,unknown>>=>{
        const e=eventSchema.safeParse(input);if(!e.success)return fail('lifecycle_invalid');
        const event=e.data;
        if(!event.executionArn.startsWith(machine.replace(':stateMachine:',':execution:')+':computer-'))return fail('lifecycle_invalid');
        const execution=await deps.execution(event.executionArn);
        if(execution.executionArn!==event.executionArn||execution.stateMachineArn!==machine||execution.stateMachineVersionArn!==version
            ||execution.stateMachineAliasArn||execution.redriveCount!==0||execution.status!=='RUNNING'||!execution.input
            ||Buffer.byteLength(execution.input)>20000||!execution.startDate)return fail();
        const envelope=EnvelopeSchema.parse(strictJson(execution.input,20000));
        const work={...envelope,createdAt:execution.startDate},i=parseLifecycleWork(work);
        // Recovery never enters the pre-attach portion of adopt, even on an empty
        // Describe view or a throttled stop. Its deadline remains the normal bound.
        if(i.adoptRecoverRelease&&event.phase==='initial')event.phase='attached';
        if(!await matchesLifecycleDeployment(i,d,deps)||execution.name!==`computer-${i.jobId}`
            ||event.executionArn!==machine.replace(':stateMachine:',':execution:')+`:computer-${i.jobId}`)return fail('lifecycle_invalid');
        const now=deps.now(),started=execution.startDate.getTime();
        if(!Number.isFinite(started)||started>now+30000||now-started>900000)return fail('lifecycle_expired');
        if(!await deps.authority(i,envelope.digest))return fail('lifecycle_authority_denied');
        const maintenance = i.rebasePreparation && parseLease(i.userData!).ebsRestore;
        const action=async(name:Action,parameters:object)=>{
            if(i.adoptRecoverRelease&&['createVolume','createTags','attachVolume','runInstances','runBurstableInstances','startInstances'].includes(name))return fail('lifecycle_adopt_recovery_invalid');
            // A confirmed allocation may be invisible to Describe for several
            // polls. Keep its phase instead of resubmitting. Lost replies still
            // use the existing identical ClientToken/parameters retry contract.
            if(['createVolume','runInstances','runBurstableInstances'].includes(name)
                &&event.phase===afterAction[name]&&classifyProviderError(event.lastError).kind==='none')return wait(event.phase);
            // A disappearing launch result after retag/attach must not rewind
            // to instance and thereby re-arm a completed attach.
            if(['runInstances','runBurstableInstances'].includes(name)&&['tagged','attached'].includes(event.phase))return wait(event.phase);
            if (maintenance) {
                const current = await deps.volumes([i.dataVolumeId!]);
                if (current.length !== 1) return fail('restore_lineage_mismatch');
                await verifyMaintenance(i, current[0]!, deps, name === 'runInstances' || name === 'runBurstableInstances');
            }
            if (i.rebasePreparation && !maintenance && (name === 'runInstances' || name === 'runBurstableInstances')) {
                const lease = parseLease(i.userData!);
                const verified = await verifyPreparation(i.rebasePreparation, d.preparationStateMachineVersionArn!, deps);
                const p = verified.document, receipt = verified.receipt;
                if (!equal(p.deployment, d) || p.computerId !== i.computerId || p.sourceVolumeId !== i.dataVolumeId
                    || p.sourceInstanceId !== i.previousInstanceId || p.sourceGeneration !== i.previousGeneration
                    || p.sourceFenceToken !== i.previousFenceToken || p.fsUuid !== lease.fsUuid || p.sourceLeaseEpoch >= i.leaseEpoch
                    || lease.rebase?.snapshotId !== receipt.snapshotId || lease.rebase.fromDigest !== p.fromDigest || lease.rebase.toDigest !== p.toDigest
                    || Date.parse(lease.rebasePermit!.issuedAt) < verified.stoppedAt) return fail('snapshot_identity_mismatch');
                assertPermitTime(lease, deps.now());
            }
            // Reads can consume time. Recheck authority immediately before
            // returning a mutation and leave its 30-second task window intact.
            if(!await deps.authority(i,envelope.digest))return fail('lifecycle_authority_denied');
            if(deps.now()-started>870000)return fail('lifecycle_expired');
            return {decision:name,parameters};
        };
        // C-3: record the provider's answer to the previous task. Capacity and
        // quota refusals end the run with their code; throttling (a definite
        // no-effect rejection) re-arms the same step after a bounded backoff.
        const previous=classifyProviderError(event.lastError);
        if(previous.kind==='capacity')return {decision:'refused',code:previous.code};
        if(previous.kind==='throttled'){
            if(event.throttles>=MAX_THROTTLE_RETRIES)return fail('lifecycle_throttled');
            return {decision:'backoff',phase:beforeRejectedAction(i,event.phase),delaySeconds:throttleDelaySeconds(event.throttles)};
        }
        if(previous.kind==='failed')return {decision:'rejected',code:previous.code};
        if(i.adoptRecoverRelease)return observeAdoptRecovery(i,envelope.digest,event.phase,deps,action);
        if(['pool-provision','pool-retire','adopt','release'].includes(i.operation))return observePool(i,envelope.digest,event.phase,deps,action);
        const tags=tagsFor(i),phase=event.phase,newInstance=['provision','replace'].includes(i.operation);
        const volumes=await deps.volumes(i.dataVolumeId?[i.dataVolumeId]:{token:token(envelope.digest,'volume')});
        if(volumes.length>1)return fail('lifecycle_volume_ambiguous');
        const v=volumes[0];
        if(!v){
            if(i.operation!=='provision'||!['initial','volume'].includes(phase))return fail();
            return action('createVolume',{AvailabilityZoneId:d.zoneId,Size:i.dataVolumeGiB,VolumeType:'gp3',Iops:3000,Throughput:125,
                Encrypted:true,KmsKeyId:d.dataKeyArn,ClientToken:token(envelope.digest,'volume'),
                TagSpecifications:[{ResourceType:'volume',Tags:tagList(initialVolumeTags(i,envelope.digest))}]});
        }
        if(!volumeId(v.VolumeId)||v.VolumeType!=='gp3'||!dataSizeValid(v.Size,d)||v.Encrypted!==true||v.KmsKeyId!==d.dataKeyArn
            ||v.AvailabilityZoneId!==d.zoneId||v.MultiAttachEnabled!==false||!Array.isArray(v.Attachments))return fail('lifecycle_volume_invalid');
        const previousTags=i.operation==='replace'?tagsFor(i,i.previousGeneration!,i.previousFenceToken!):tags;
        if(!tagged(v.Tags,tags)&&!(i.operation==='replace'&&tagged(v.Tags,previousTags)))return fail('lifecycle_volume_invalid');
        if(i.dataVolumeId&&v.VolumeId!==i.dataVolumeId)return fail();
        if(i.operation==='provision'&&!tagged(v.Tags,initialVolumeTags(i,envelope.digest)))return fail();
        // Bind historical source identity to its retained deployment, including
        // a different approved subnet in the same AZ. Maintenance also proves
        // custody of the failed original volume before using its clone.
        const preparation = i.rebasePreparation ? (maintenance ? await verifyMaintenance(i, v, deps)
            : await verifyPreparation(i.rebasePreparation, d.preparationStateMachineVersionArn!, deps)) : undefined;
        if (preparation && (preparation.document.sourceInstanceId !== i.previousInstanceId
            || preparation.document.sourceGeneration !== i.previousGeneration || preparation.document.sourceFenceToken !== i.previousFenceToken))
            return fail('source_identity_mismatch');
        const sourceIntent = preparation ? { ...i, deployment: preparation.document.sourceDeployment } : i;
        const sourceId=i.previousInstanceId??i.providerInstanceId;
        const source=sourceId?await getInstance(sourceId,previousTags,sourceIntent,deps,['replace','retire','stop'].includes(i.operation)):undefined;
        // A replace whose previous instance EC2 no longer knows (the app's instance_lost recovery)
        // has nothing to stop or terminate. The volume must not claim an attachment to it; the
        // launch below still requires the volume `available` and unattached, and its tags were
        // checked above, so a foreign, attached or missing volume never gets a new instance.
        if(!source&&sourceId&&v.Attachments.some(a=>a.InstanceId===sourceId))return fail('lifecycle_volume_invalid');
        // A retire whose instance EC2 no longer knows (instance_lost, then the computer deleted) has
        // nothing to stop or terminate either. The retained volume (R11) is kept: it must be free,
        // unattached and this computer's (tags checked above); anything else stays a failure.
        if(!source&&sourceId&&i.operation==='retire'){
            if(v.State!=='available'||v.Attachments.length)return fail('lifecycle_volume_invalid');
            return success(i,envelope.digest,sourceId,v.VolumeId,'retired');
        }
        // A stop whose instance EC2 no longer knows (terminated externally while the stop was
        // pending) is a LOST-instance stop: nothing to stop, the volume is kept, and the receipt
        // says so (`instanceLost`) so the app's next wake REPLACES onto the volume. The volume
        // must be free, unattached and this computer's (tags checked above), or it is a failure.
        if(!source&&sourceId&&i.operation==='stop'){
            if(v.State!=='available'||v.Attachments.length)return fail('lifecycle_volume_invalid');
            return lostStop(i,envelope.digest,sourceId,v.VolumeId);
        }
        if (maintenance && source && source.State?.Name !== 'terminated') return fail('writer_not_fenced');
        if(source&&['stop','retire','replace'].includes(i.operation)){
            const status=source.State?.Name;
            if(status==='terminated'){
                // Still visible as terminated: the same lost-instance stop once the volume has
                // detached (wait while it does, as the retire below does).
                if(i.operation==='stop'){
                    if(v.State!=='available'||v.Attachments.length)return wait(phase);
                    return lostStop(i,envelope.digest,sourceId!,v.VolumeId);
                }
                if(i.operation==='retire'){
                    if(v.State!=='available'||v.Attachments.length)return wait(phase);
                    return success(i,envelope.digest,sourceId!,v.VolumeId,'retired');
                }
                if(v.Attachments.some(a=>a.InstanceId===sourceId))return wait(phase);
            }else{
                if(status==='shutting-down')return wait(phase);
                if(status==='stopped'){
                    if(i.operation==='stop'){
                        assertAttached(source,v,sourceId!);
                        return success(i,envelope.digest,sourceId!,v.VolumeId,'stopped');
                    }
                    if(!['initial','stopped'].includes(phase))return wait(phase);
                    assertAttached(source,v,sourceId!);
                    assertOnlyExpectedDisks(source,v,d.storage.rootDeviceName);
                    return action('terminateInstances',{InstanceIds:[sourceId]});
                }
                if(status==='stopping')return wait(phase);
                if(!['running','pending'].includes(status??''))return fail();
                if(phase!=='initial')return wait(phase);
                assertAttached(source,v,sourceId!);
                return action('stopInstances',{InstanceIds:[sourceId],Force:false,Hibernate:false,SkipOsShutdown:false});
            }
        }
        if(v.State==='creating'&&v.Attachments.length===0)return wait(phase);
        let target=source;
        if(newInstance){
            const found=await deps.instances({token:token(envelope.digest,'instance')});
            if(found.length>1)return fail('lifecycle_instance_ambiguous');
            target=found[0]?.instance;
            if(target){if(found[0]?.owner!==d.accountId||target.ClientToken!==token(envelope.digest,'instance'))return fail();assertIdentity(target,tags,i);}
            if(!target){
                if(v.State!=='available'||v.Attachments.length)return fail();
                // T3/T3a default to unlimited credits (surplus is billed): every
                // burstable launch goes through the state that forwards
                // CreditSpecification, and nothing else carries it.
                const launch=await launchParameters(i,envelope.digest,deps);
                return isBurstable(launch.InstanceType!)?action('runBurstableInstances',{...launch,CreditSpecification:{...BURSTABLE_CREDITS}})
                    :action('runInstances',launch);
            }
        }
        if(!target||!instanceId(target.InstanceId))return fail();
        assertEffectiveInstance(target,i);
        const targetId=target.InstanceId;
        if(newInstance){
            if(!['pending','running'].includes(target.State?.Name??''))return fail();
            if(!tagged(v.Tags,tags)){
                if(v.State!=='available'||v.Attachments.length)return fail();
                if(['tagged','attached'].includes(phase))return wait(phase);
                // Only generation and fence move; identity tags were set at creation.
                if(!tagged(v.Tags,{...tags,...{'ezil:generation':String(i.previousGeneration),'ezil:fence-token':i.previousFenceToken!}}))return fail('lifecycle_volume_invalid');
                return action('createTags',{Resources:[v.VolumeId],Tags:tagList(retagsFor(i))});
            }
            // §9: this branch is reached only after DescribeVolumes above has
            // observed BOTH target tag values. A CreateTags API response or
            // phase='tagged' alone can never authorize a target receipt.
            // AttachVolume can be acknowledged before DescribeVolumes lists
            // its attachment, even when the volume is already in-use.
            if(v.Attachments.length===0&&phase==='attached')return wait(phase);
            if(v.State==='available'&&v.Attachments.length===0){
                if(target.State?.Name!=='running')return wait(phase);
                return action('attachVolume',{Device:DATA_DEVICE,InstanceId:targetId,VolumeId:v.VolumeId});
            }
            if(v.Attachments.length!==1||v.Attachments[0]?.InstanceId!==targetId||v.Attachments[0]?.VolumeId!==v.VolumeId)return fail();
            if(v.Attachments[0]?.State==='attaching'||!target.BlockDeviceMappings?.some(m=>m.Ebs?.VolumeId===v.VolumeId))return wait(phase);
            // AttachVolume leaves DeleteOnTermination=false. The workflow has no
            // ModifyInstanceAttribute right, so anything else fails closed here.
            assertAttached(target,v,targetId);
            if(target.State?.Name!=='running')return wait(phase);
            return success(i,envelope.digest,targetId,v.VolumeId,'running');
        }
        if(v.Attachments.length===0&&['userdata','started'].includes(phase))return wait(phase);
        assertAttached(target,v,targetId);
        if(i.operation!=='start')return fail();
        if(target.State?.Name==='running')return success(i,envelope.digest,targetId,v.VolumeId,'running');
        if(target.State?.Name==='pending'||target.State?.Name==='stopping'||phase==='started')return wait(phase);
        if(target.State?.Name!=='stopped')return fail();
        if(i.userData!==null){
            // C-6: write this epoch's nonce while stopped, then start.
            if(!settings.features.userDataNonce)return fail('lifecycle_userdata_disabled');
            // Start only after a DEFINITE write. An uncertain ModifyInstanceAttribute (lost reply,
            // timeout, 5xx) may never have reached EC2, and a host booted on the previous epoch's
            // nonce looks like a same-instance reboot and reuses old credentials. The write is
            // idempotent, so an uncertain one is re-issued until EC2 answers it; each round costs a
            // 1 s Wait and the execution's 870 s window bounds them. A definite rejection already
            // ended the run above (Rejected).
            if(phase!=='userdata'||previous.kind!=='none')return action('modifyInstanceAttribute',{InstanceId:targetId,UserData:{Value:i.userData}});
        }
        return action('startInstances',{InstanceIds:[targetId]});
    };
}
function success(i:LifecycleIntent,digest:string,instanceId:string,volumeId:string|null,state:LifecycleReceipt['state']){
    return {decision:'success',receipt:{schemaVersion:1,jobId:i.jobId,digest,computerId:i.computerId,
        generation:i.targetGeneration,leaseEpoch:i.leaseEpoch,fenceToken:i.fenceToken,instanceId,volumeId,state} satisfies LifecycleReceipt};
}
type Dispatch = (name:Action,parameters:object)=>Promise<Record<string,unknown>>;
async function observeAdoptRecovery(i:LifecycleIntent,digest:string,phase:Phase,deps:Dependencies,action:Dispatch):Promise<Record<string,unknown>>{
    const source=validateAdoptRecovery(i),d=source.deployment,claim=claimTagsFor(i);
    const rows=await deps.instances([i.providerInstanceId!]),host=rows[0]?.instance;
    if(rows.length!==1||rows[0]?.owner!==d.accountId||!host||host.InstanceId!==i.providerInstanceId
        ||host.ImageId!==d.amiId||!tagged(host.Tags,{'ezil:pool-host':source.poolHostId!,
            'aws:ec2launchtemplate:id':d.launchTemplateId}))return fail('lifecycle_instance_invalid');
    if(['stopped','detached','terminated'].includes(phase))return observePool(i,digest,phase,deps,action);
    assertEffectiveInstance(host,source);
    const {['ezil:pool']:ignored,...identity}=poolTagsFor(source);
    if(!tagged(host.Tags,identity)||host.Tags?.some(t=>['ezil:computer-id','ezil:fence-token'].includes(t.Key??'')))return fail('lifecycle_instance_invalid');
    const claimed=tagged(host.Tags,claim);
    if(!matchingPresentTags(host.Tags,claim)||(!claimed&&host.Tags?.some(t=>Object.keys(claim).includes(t.Key??'')))
        ||(!claimed&&!tagged(host.Tags,{'ezil:pool':'1'}))
        ||(host.Tags?.some(t=>t.Key==='ezil:pool')&&!tagged(host.Tags,{'ezil:pool':'1'})))return fail('lifecycle_instance_invalid');
    const volumes=await deps.volumes([i.dataVolumeId!]),v=volumes[0];
    if(volumes.length!==1||!v||v.VolumeId!==i.dataVolumeId||!tagged(v.Tags,tagsFor(i))
        ||!matchingPresentTags(v.Tags,claim)||v.Encrypted!==true||v.KmsKeyId!==d.dataKeyArn||v.AvailabilityZoneId!==d.zoneId
        ||v.VolumeType!=='gp3'||!dataSizeValid(v.Size,d)||v.MultiAttachEnabled!==false||!Array.isArray(v.Attachments))return fail('lifecycle_volume_invalid');
    assertPoolDisks(host,d,v.VolumeId);
    if(v.Attachments.length===0)return wait(phase);
    assertAttached(host,v,host.InstanceId!);
    if(!claimed){
        if(host.State?.Name!=='running'&&host.State?.Name!=='stopped')return fail('lifecycle_instance_invalid');
        if(phase!=='attached')return wait(phase);
        return action('claimInstance',{Resources:[host.InstanceId],Tags:tagList(claim)});
    }
    if(host.Tags?.some(t=>t.Key==='ezil:pool')){
        if(phase==='attached')return fail('lifecycle_instance_invalid');
        if(phase==='unpooled')return wait(phase);
        return action('deleteTags',{Resources:[host.InstanceId],Tags:[{Key:'ezil:pool',Value:'1'}]});
    }
    if(phase!=='claimed'&&phase!=='unpooled')return fail('lifecycle_instance_invalid');
    // Release starts only after observing both claim and pool-tag removal.
    return observePool(i,digest,'initial',deps,action);
}
/** Pool steps share the execution/authority/error gates above. Only the graph
 * mutates EC2; a lost non-idempotent reply is observed until the deadline. */
async function observePool(i:LifecycleIntent,digest:string,phase:Phase,deps:Dependencies,action:Dispatch):Promise<Record<string,unknown>>{
    const d=i.deployment,claim=claimTagsFor(i);
    const rows=await deps.instances(i.operation==='pool-provision'?{token:token(digest,'instance')}:[i.providerInstanceId!]);
    if(rows.length>1)return fail('lifecycle_instance_ambiguous');
    const host=rows[0]?.instance;
    if(host){
        if(rows[0]?.owner!==d.accountId || (i.providerInstanceId!==null&&host.InstanceId!==i.providerInstanceId))return fail('lifecycle_instance_invalid');
        // Draining an older release must still prove platform launch provenance.
        // EC2 reports the template through this reserved tag, not an Instance
        // LaunchTemplate field. Its version may belong to a retained release.
        if(['release','pool-retire'].includes(i.operation)
            &&!tagged(host.Tags,{'aws:ec2launchtemplate:id':d.launchTemplateId}))return fail('lifecycle_instance_invalid');
        // EC2 removes networking and root mappings while terminating. Identity,
        // type and any reported placement must still match the reserved intent.
        const terminating=['release','pool-retire'].includes(i.operation)&&['shutting-down','terminated'].includes(host.State?.Name??'');
        if(terminating){
            assertIdentity(host,{},i);
            if(host.InstanceType!==i.instanceType)return fail('lifecycle_instance_invalid');
        }else{
            assertEffectiveInstance(host,i);
            if(!instanceId(host.InstanceId)||host.Placement?.AvailabilityZoneId!==d.zoneId)return fail('lifecycle_instance_invalid');
        }
    }
    if(i.operation==='pool-provision'){
        if(!host)return action('runInstances',await launchParameters(i,digest,deps));
        if(host.ClientToken!==token(digest,'instance')||!tagged(host.Tags,poolTagsFor(i))
            ||host.Tags?.some(t=>['ezil:computer','ezil:computer-id','ezil:fence'].includes(t.Key??'')))return fail('lifecycle_instance_invalid');
        if(host.State?.Name==='pending')return wait(phase);
        if(host.State?.Name!=='running')return fail('lifecycle_instance_invalid');
        assertPoolDisks(host,d);
        const done=success(i,digest,host.InstanceId!,null,'running');
        return {...done,receipt:{...done.receipt,poolHostId:i.poolHostId!,poolGeneration:i.poolGeneration!}};
    }
    if(i.operation==='pool-retire'){
        if(!host||!tagged(host.Tags,poolTagsFor(i))
            ||host.Tags?.some(t=>['ezil:computer','ezil:computer-id'].includes(t.Key??'')))return fail('lifecycle_instance_invalid');
        const status=host.State?.Name;
        if(status==='terminated'||status==='shutting-down'){
            assertRetiredDisks(host,d);
            if(status==='shutting-down')return wait(phase);
            const done=success(i,digest,host.InstanceId!,null,'retired');
            return {...done,receipt:{...done.receipt,poolHostId:i.poolHostId!,poolGeneration:i.poolGeneration!}};
        }
        assertPoolDisks(host,d);
        if(!['pending','running','stopping','stopped'].includes(status??''))return fail('lifecycle_instance_invalid');
        if(phase==='terminated')return wait(phase);
        return action('terminateInstances',{InstanceIds:[host.InstanceId]});
    }
    if(i.operation==='adopt'){
        if(!host||host.State?.Name!=='running')return fail('lifecycle_instance_invalid');
        const base=poolTagsFor(i),{['ezil:pool']:ignored,...identity}=base;
        if(!tagged(host.Tags,identity))return fail('lifecycle_instance_invalid');
        // A completed claim is the only acceptable replay of a non-pool host.
        const claimed=tagged(host.Tags,claim),hasClaim=host.Tags?.some(t=>['ezil:computer','ezil:generation','ezil:fence','ezil:computer-id'].includes(t.Key??''));
        if((hasClaim&&!claimed)||(!claimed&&!tagged(host.Tags,{'ezil:pool':'1'})))return fail('lifecycle_instance_invalid');
        if(host.Tags?.some(t=>t.Key==='ezil:pool')&&!tagged(host.Tags,{'ezil:pool':'1'}))return fail('lifecycle_instance_invalid');
    }else if(host){
        // Cold fallback hosts use the original identity keys. Adopted hosts
        // use the claim keys; mixed identities must agree on every alias.
        const adopted=host.Tags?.some(t=>['ezil:computer','ezil:fence'].includes(t.Key??''));
        const expected=adopted?{'ezil:managed-by':'app-computer-platform','ezil:stage':d.namespace,'ezil:namespace':d.namespace,...claim}:tagsFor(i);
        if(!tagged(host.Tags,expected)||!matchingPresentTags(host.Tags,{...tagsFor(i),...claim,'ezil:namespace':d.namespace})
            ||host.Tags?.some(t=>t.Key==='ezil:pool'))return fail('lifecycle_instance_invalid');
    }
    const volumes=await deps.volumes(i.dataVolumeId?[i.dataVolumeId]:{token:token(digest,'volume')});
    if(volumes.length>1)return fail('lifecycle_volume_ambiguous');
    const v=volumes[0];
    if(!v){
        if(i.operation!=='adopt'||i.dataVolumeId!==null||!['initial','volume'].includes(phase))return fail('lifecycle_volume_invalid');
        assertPoolDisks(host!,d);
        return action('createVolume',{AvailabilityZoneId:d.zoneId,Size:i.dataVolumeGiB,VolumeType:'gp3',Iops:3000,Throughput:125,
            Encrypted:true,KmsKeyId:d.dataKeyArn,ClientToken:token(digest,'volume'),
            TagSpecifications:[{ResourceType:'volume',Tags:tagList({...initialVolumeTags(i,digest),...claim})}]});
    }
    if(!volumeId(v.VolumeId)||(i.dataVolumeId!==null&&v.VolumeId!==i.dataVolumeId)||v.VolumeType!=='gp3'||!dataSizeValid(v.Size,d)
        ||v.Encrypted!==true||v.KmsKeyId!==d.dataKeyArn||v.AvailabilityZoneId!==d.zoneId||v.MultiAttachEnabled!==false||!Array.isArray(v.Attachments))return fail('lifecycle_volume_invalid');
    const ownership={'ezil:managed-by':'app-computer-platform','ezil:stage':d.namespace,'ezil:computer-id':i.computerId};
    if(!tagged(v.Tags,ownership))return fail('lifecycle_volume_invalid');
    if(i.operation==='adopt'){
        if(v.Tags?.some(t=>t.Key==='ezil:computer')&&!tagged(v.Tags,{'ezil:computer':i.computerId}))return fail('lifecycle_volume_invalid');
        if(i.dataVolumeId===null&&!tagged(v.Tags,{...initialVolumeTags(i,digest),...claim}))return fail('lifecycle_volume_invalid');
        // An old generation may move forward only on a free, owned volume.
        // Equal generations must already have this fence; newer ones never move back.
        const generation=v.Tags?.filter(t=>t.Key==='ezil:generation'),fence=v.Tags?.filter(t=>t.Key==='ezil:fence-token');
        const g=generation?.[0]?.Value;
        if(generation?.length!==1||!g||!/^\d+$/.test(g)||Number(g)<1||Number(g)>i.targetGeneration||fence?.length!==1
            ||!fence[0]?.Value||!/^[a-f0-9-]{36}$/.test(fence[0].Value)
            ||(Number(g)<i.targetGeneration&&fence[0].Value===i.fenceToken)
            ||(Number(g)===i.targetGeneration&&!tagged(v.Tags,{...tagsFor(i),...claim})))return fail('lifecycle_volume_invalid');
        assertPoolDisks(host!,d,v.VolumeId);
        if(v.State==='creating'&&v.Attachments.length===0)return wait(phase);
        if(!tagged(v.Tags,{...tagsFor(i),...claim})){
            if(v.State!=='available'||v.Attachments.length)return fail('lifecycle_volume_invalid');
            // Describe can regress after a later action. Never rewind the
            // phase: doing so could re-arm a completed non-idempotent attach.
            if(['tagged','attached','claimed','unpooled'].includes(phase))return wait(phase);
            return action('createTags',{Resources:[v.VolumeId],Tags:tagList({...retagsFor(i),...claim})});
        }
        // Preserve attach progress through empty or regressing volume views,
        // including observations after the host has been claimed.
        if(v.Attachments.length===0&&['attached','claimed','unpooled'].includes(phase))return wait(phase);
        if(v.State==='available'&&v.Attachments.length===0){
            // A claimed host must not reacquire a disk after it was released.
            if(tagged(host!.Tags,claim))return attachmentRejected('claimed_host_without_attachment');
            return action('attachVolume',{Device:DATA_DEVICE,InstanceId:host!.InstanceId,VolumeId:v.VolumeId});
        }
        if(v.Attachments.length!==1)return attachmentRejected('attachment_count');
        if(v.Attachments[0]?.InstanceId!==host!.InstanceId||v.Attachments[0]?.VolumeId!==v.VolumeId)return attachmentRejected('attachment_identity');
        if(v.Attachments[0]?.State==='attaching'||!host!.BlockDeviceMappings?.some(m=>m.Ebs?.VolumeId===v.VolumeId))return wait(phase);
        // DescribeInstances precedes DescribeVolumes: the exact host mapping may
        // still be attaching after the volume reports attached. Validate every
        // other attachment invariant before waiting; never repeat AttachVolume.
        if(host!.BlockDeviceMappings?.some(m=>m.Ebs?.VolumeId===v.VolumeId&&m.Ebs?.Status==='attaching')){
            assertAttachmentState(host!,v,host!.InstanceId!,'attaching');
            return wait(phase);
        }
        assertAttached(host!,v,host!.InstanceId!);
        if(!tagged(host!.Tags,claim)){
            if(['claimed','unpooled'].includes(phase))return wait(phase);
            return action('claimInstance',{Resources:[host!.InstanceId],Tags:tagList(claim)});
        }
        if(host!.Tags?.some(t=>t.Key==='ezil:pool')){
            if(phase==='unpooled')return wait(phase);
            return action('deleteTags',{Resources:[host!.InstanceId],Tags:[{Key:'ezil:pool',Value:'1'}]});
        }
        return success(i,digest,host!.InstanceId!,v.VolumeId,'running');
    }
    // A cold replacement updates the canonical generation/fence-token but
    // may retain claim aliases from an earlier pool epoch on the same disk.
    // Its current writer is proven by tagsFor; the computer alias must agree.
    const releaseVolumeTags=host?.Tags?.some(t=>t.Key==='ezil:computer')?claim:{'ezil:computer':i.computerId};
    if(!tagged(v.Tags,tagsFor(i))||!matchingPresentTags(v.Tags,releaseVolumeTags))return fail('lifecycle_volume_invalid');
    const free=v.State==='available'&&v.Attachments.length===0;
    if(v.Attachments.some(a=>a.InstanceId!==i.providerInstanceId||a.VolumeId!==v.VolumeId))return fail('lifecycle_attachment_invalid');
    // Detach can clear the attachment list before the volume becomes free.
    // No shutdown/termination or repeated detach is justified by that view.
    if(v.Attachments.length===0&&!free)return wait(phase);
    if(!host||host.State?.Name==='terminated'){
        if(!free)return fail('lifecycle_attachment_invalid');
        if(host)assertRetiredDisks(host,d);
        return success(i,digest,i.providerInstanceId!,v.VolumeId,'retired');
    }
    const status=host.State?.Name;
    if(status==='shutting-down'){
        assertRetiredDisks(host,d);
        if(!free)return fail('lifecycle_attachment_invalid');
        return wait(phase);
    }
    if((status==='stopping'||status==='stopped')&&!releaseDisksReady(host,d,v.VolumeId))return wait(phase);
    assertPoolDisks(host,d,v.VolumeId);
    if(status==='stopping')return wait(phase);
    if(status==='running'){
        assertAttached(host,v,host.InstanceId!);
        if(phase!=='initial')return wait(phase);
        return action('stopInstances',{InstanceIds:[host.InstanceId],Force:false,Hibernate:false,SkipOsShutdown:false});
    }
    if(status!=='stopped')return fail('lifecycle_instance_invalid');
    if(free){
        if(host.BlockDeviceMappings?.some(m=>m.DeviceName===DATA_DEVICE))return wait(phase);
        if(!['initial','stopped','detached'].includes(phase))return wait(phase);
        return action('terminateInstances',{InstanceIds:[host.InstanceId]});
    }
    if(v.Attachments.length!==1||v.Attachments[0]?.InstanceId!==host.InstanceId||v.Attachments[0]?.VolumeId!==v.VolumeId)return fail('lifecycle_attachment_invalid');
    if(v.Attachments[0]?.State==='detaching')return wait(phase);
    assertAttached(host,v,host.InstanceId!);
    if(!['initial','stopped'].includes(phase))return wait(phase);
    return action('detachVolume',{Device:DATA_DEVICE,InstanceId:host.InstanceId,VolumeId:v.VolumeId,Force:false});
}
/** A terminating host may have lost its root mapping, but never retain data. */
function assertRetiredDisks(host:Instance,d:Settings['deployment']){
    const maps=host.BlockDeviceMappings;
    if(!Array.isArray(maps)||maps.length>1||maps.some(m=>m.DeviceName!==d.storage.rootDeviceName))return unexpectedDisks(host,d.storage.rootDeviceName);
}
/** Optional legacy/claim aliases cannot contradict the current writer. */
function matchingPresentTags(actual:Tag[]|undefined,expected:Record<string,string>){
    return Object.entries(expected).every(([key,value])=>!actual?.some(t=>t.Key===key)||tagged(actual,{[key]:value}));
}
/** Pool hosts are root-only until adoption; never terminate unexpected disks. */
function assertPoolDisks(host:Instance,d:Settings['deployment'],dataVolumeId?:string){
    const maps=host.BlockDeviceMappings,root=maps?.filter(m=>m.DeviceName===d.storage.rootDeviceName);
    if(!Array.isArray(maps)||root?.length!==1||!volumeId(root[0]?.Ebs?.VolumeId)||root[0]?.Ebs?.DeleteOnTermination!==true
        ||root[0]?.Ebs?.Status!=='attached'||maps.some(m=>m.DeviceName!==d.storage.rootDeviceName
            &&!(dataVolumeId&&m.DeviceName===DATA_DEVICE&&m.Ebs?.VolumeId===dataVolumeId)))return unexpectedDisks(host,d.storage.rootDeviceName,dataVolumeId);
}
/** Stopping can expose incomplete mappings. Reject foreign disks first, then
 * observe in the same phase until the existing execution deadline. */
function releaseDisksReady(host:Instance,d:Settings['deployment'],dataVolumeId:string):boolean{
    const maps=host.BlockDeviceMappings,root=maps?.filter(m=>m.DeviceName===d.storage.rootDeviceName);
    if(!Array.isArray(maps)||root!.length>1||maps.some(m=>m.DeviceName!==d.storage.rootDeviceName
        &&(m.DeviceName!==DATA_DEVICE||(!!m.Ebs?.VolumeId&&m.Ebs.VolumeId!==dataVolumeId))))
        return unexpectedDisks(host,d.storage.rootDeviceName,dataVolumeId);
    if(maps.length===0&&host.State?.Name==='stopping')return false;
    if(root!.length!==1)return unexpectedDisks(host,d.storage.rootDeviceName,dataVolumeId);
    if(maps.some(m=>!m.Ebs?.VolumeId))return false;
    if(!volumeId(root![0]?.Ebs?.VolumeId)||root![0]?.Ebs?.DeleteOnTermination!==true
        ||root![0]?.Ebs?.VolumeId===dataVolumeId)return unexpectedDisks(host,d.storage.rootDeviceName,dataVolumeId);
    return root![0]?.Ebs?.Status==='attached'
        &&!maps.some(m=>m.Ebs?.Status==='attaching'||m.Ebs?.Status==='detaching');
}
/** IDs never enter the error or log; root identity is the reported root mapping. */
class UnexpectedDisksError extends Error {
    constructor(readonly disks: {device:string|null;status:string|null;matchesRoot:boolean;matchesData:boolean}[]) {
        super('lifecycle_unexpected_disk');
    }
}
function unexpectedDisks(host:Instance,rootDeviceName:string,dataVolumeId?:string):never{
    const maps=host.BlockDeviceMappings??[],rootId=maps.find(m=>m.DeviceName===rootDeviceName)?.Ebs?.VolumeId;
    throw new UnexpectedDisksError(maps.map(m=>({device:m.DeviceName??null,status:m.Ebs?.Status??null,
        matchesRoot:!!m.Ebs?.VolumeId&&m.Ebs.VolumeId===rootId,
        matchesData:!!dataVolumeId&&m.Ebs?.VolumeId===dataVolumeId})));
}
/** Preserve the code and sanitized disk evidence through the Lambda wrapper. */
export function lifecycleError(error:unknown){
    const failure=toLambdaError(error,'lifecycle_unconfirmed');
    if(error instanceof UnexpectedDisksError)failure.message+=' '+JSON.stringify({disks:error.disks});
    return failure;
}
/** A stop whose instance is gone: a `stopped` receipt marked `instanceLost`. */
function lostStop(i:LifecycleIntent,digest:string,instanceId:string,volumeId:string){
    const done=success(i,digest,instanceId,volumeId,'stopped');
    return {...done,receipt:{...done.receipt,instanceLost:true as const} satisfies LifecycleReceipt};
}
type InstanceIdentity = { deployment: Pick<SourceLifecycleDeployment, 'accountId' | 'subnetId' | 'zoneId'> };
function assertIdentity(instance:Instance,tags:Record<string,string>,i:InstanceIdentity){
    // The subnet is bound to the configured ZoneId; a reported ZoneId must agree.
    // EC2 clears SubnetId on a terminating (shutting-down) or terminated instance but keeps its id
    // and tags, so such a source is identified by those; a subnet that IS reported must still be
    // the configured one. Seen live: shutting-down with no SubnetId (2026-10-22 11:55Z).
    const terminated=instance.State?.Name==='terminated'||instance.State?.Name==='shutting-down';
    if(!instanceId(instance.InstanceId)||!tagged(instance.Tags,tags)
        ||(terminated?instance.SubnetId!==undefined&&instance.SubnetId!==i.deployment.subnetId:instance.SubnetId!==i.deployment.subnetId)
        ||(instance.Placement?.AvailabilityZoneId!==undefined&&instance.Placement.AvailabilityZoneId!==i.deployment.zoneId))return fail('lifecycle_instance_invalid');
}
/** Terminate guard: an instance carrying anything beyond its root disk and
 * this computer's data disk is never terminated; the extra disk may be data. */
export function assertOnlyExpectedDisks(instance:Instance,v:Volume,rootDeviceName:Settings['deployment']['storage']['rootDeviceName']){
    const mappings=instance.BlockDeviceMappings;
    if(!Array.isArray(mappings)||instance.RootDeviceName!==rootDeviceName
        ||mappings.filter(m=>m.DeviceName===rootDeviceName).length>1
        ||mappings.some(m=>m.DeviceName!==rootDeviceName&&!(m.DeviceName===DATA_DEVICE&&m.Ebs?.VolumeId===v.VolumeId)))return unexpectedDisks(instance,rootDeviceName,v.VolumeId);
}
/** `allowAbsent` (replace and retire only): EC2 no longer knowing the instance at all is an answer,
 * not a failure. Nothing else is relaxed: an instance that exists must still be exactly this one. */
async function getInstance(id:string,tags:Record<string,string>,i:InstanceIdentity,deps:Dependencies,allowAbsent=false){
    const rows=await deps.instances([id]);
    if(rows.length===0&&allowAbsent)return undefined;
    if(rows.length!==1||rows[0]?.owner!==i.deployment.accountId||rows[0].instance.InstanceId!==id)return fail();
    assertIdentity(rows[0].instance,tags,i);return rows[0].instance;
}
type AttachmentRejectionReason = 'claimed_host_without_attachment' | 'volume_state'
    | 'mapping_count' | 'mapping_device' | 'mapping_status' | 'mapping_deletion_policy'
    | 'attachment_count' | 'attachment_identity' | 'attachment_status' | 'attachment_device' | 'attachment_deletion_policy';
/** Log only constants at the rejection site, before error normalization loses origin. */
function attachmentRejected(reason:AttachmentRejectionReason):never{
    try { console.warn(JSON.stringify({event:'lifecycle_attachment_rejected',reason})); }
    catch { /* Diagnostics must not change the lifecycle decision or public error. */ }
    return fail('lifecycle_attachment_invalid');
}
export function assertAttached(instance:Instance,v:Volume,id:string){
    assertAttachmentState(instance,v,id,'attached');
}
function assertAttachmentState(instance:Instance,v:Volume,id:string,hostStatus:'attached'|'attaching'){
    const m=instance.BlockDeviceMappings?.filter(m=>m.Ebs?.VolumeId===v.VolumeId),a=v.Attachments?.[0];
    if(v.State!=='in-use')return attachmentRejected('volume_state');
    if(m?.length!==1)return attachmentRejected('mapping_count');
    if(m[0]?.DeviceName!==DATA_DEVICE)return attachmentRejected('mapping_device');
    if(m[0]?.Ebs?.Status!==hostStatus)return attachmentRejected('mapping_status');
    if(m[0]?.Ebs?.DeleteOnTermination!==false)return attachmentRejected('mapping_deletion_policy');
    if(v.Attachments?.length!==1)return attachmentRejected('attachment_count');
    if(a?.InstanceId!==id||a.VolumeId!==v.VolumeId)return attachmentRejected('attachment_identity');
    if(a.State!=='attached')return attachmentRejected('attachment_status');
    if(a.Device!==DATA_DEVICE)return attachmentRejected('attachment_device');
    if(a.DeleteOnTermination!==false)return attachmentRejected('attachment_deletion_policy');
}
function assertEffectiveInstance(v:Instance,i:LifecycleIntent){
    const d=i.deployment;
    // Only release and pool-retire drain an owned host from an older AMI.
    // Launch, start and adopt retain the deployment's exact image requirement.
    const draining=i.operation==='release'||i.operation==='pool-retire';
    if((!draining&&v.ImageId!==d.amiId)||v.InstanceType!==i.instanceType||!d.instanceTypes.includes(v.InstanceType)||v.Architecture!=='x86_64'||v.RootDeviceType!=='ebs'||v.SubnetId!==d.subnetId
        ||v.RootDeviceName!==d.storage.rootDeviceName
        ||v.IamInstanceProfile!==undefined||v.SecurityGroups?.length!==1||v.SecurityGroups[0]?.GroupId!==d.securityGroupId
        ||v.MetadataOptions?.HttpTokens!=='required'||v.MetadataOptions.HttpPutResponseHopLimit!==1
        ||v.MetadataOptions.InstanceMetadataTags!=='disabled'||v.HibernationOptions?.Configured===true)return fail('lifecycle_instance_invalid');
}
export async function launchParameters(i:LifecycleIntent,digest:string,deps:Pick<Dependencies, 'image' | 'template'>):Promise<RunInstancesRequest>{
    const d=i.deployment;
    const [image,template]=await Promise.all([deps.image(d.amiId),deps.template(d.launchTemplateId,d.launchTemplateVersion)]);
    const t=template?.LaunchTemplateData;
    // Exactly one EBS mapping (the root). Instance-store placeholders (`ephemeralN`, no Ebs) carry no
    // data and are inherited from Ubuntu parents by Image Builder AMIs; anything else is refused.
    const imageEbs=image?.BlockDeviceMappings?.filter(m=>m.Ebs)??[];
    const onlyEphemeralExtras=(image?.BlockDeviceMappings??[]).every(m=>m.Ebs||(/^ephemeral[0-9]+$/.test(m.VirtualName??'')&&m.NoDevice===undefined));
    if(image?.ImageId!==d.amiId||image.Architecture!=='x86_64'||image.RootDeviceType!=='ebs'||image.RootDeviceName!==d.storage.rootDeviceName
        ||image.State!=='available'||image.VirtualizationType!=='hvm'||imageEbs.length!==1||!onlyEphemeralExtras
        ||imageEbs[0]?.DeviceName!==d.storage.rootDeviceName||!imageEbs[0]?.Ebs?.VolumeSize
        ||imageEbs[0].Ebs.VolumeSize>d.storage.rootGiB||!t||template?.LaunchTemplateId!==d.launchTemplateId
        ||String(template.VersionNumber)!==d.launchTemplateVersion)return fail('lifecycle_launch_invalid');
    const allowed=['ImageId','InstanceType','SecurityGroupIds','EbsOptimized','Monitoring','MetadataOptions','BlockDeviceMappings','TagSpecifications',
        'InstanceInitiatedShutdownBehavior','HibernationOptions'];
    if(Object.keys(t).some(k=>!allowed.includes(k))||t.ImageId!==d.amiId||(t.InstanceType!==undefined&&!d.instanceTypes.includes(t.InstanceType as never))
        ||t.HibernationOptions?.Configured===true
        ||!equal(t.SecurityGroupIds,[d.securityGroupId])
        ||t.BlockDeviceMappings?.length!==1||t.BlockDeviceMappings[0]?.DeviceName!==d.storage.rootDeviceName)return fail('lifecycle_launch_invalid');
    return {LaunchTemplate:{LaunchTemplateId:d.launchTemplateId,Version:d.launchTemplateVersion},ImageId:d.amiId,
        InstanceType:i.instanceType,MinCount:1,MaxCount:1,ClientToken:token(digest,'instance'),UserData:i.operation==='pool-provision'?poolLease(i):i.userData!,
        SubnetId:d.subnetId,SecurityGroupIds:[d.securityGroupId],
        MetadataOptions:{HttpEndpoint:'enabled',HttpTokens:'required',HttpPutResponseHopLimit:1,InstanceMetadataTags:'disabled'},
        HibernationOptions:{Configured:false},
        EbsOptimized:true,Monitoring:{Enabled:false},
        // R3: the root disk is disposable (OS + pre-pulled image); the data disk is retained.
        BlockDeviceMappings:[{DeviceName:d.storage.rootDeviceName,Ebs:{VolumeType:'gp3',VolumeSize:d.storage.rootGiB,Encrypted:true,KmsKeyId:d.dataKeyArn,DeleteOnTermination:true}}],
        TagSpecifications:[{ResourceType:'instance',Tags:tagList(i.operation==='pool-provision'?poolTagsFor(i):tagsFor(i))},
            {ResourceType:'volume',Tags:tagList({...i.operation==='pool-provision'?poolTagsFor(i):tagsFor(i),'ezil:disk-kind':'root'})},
            // The boundary admits the primary ENI only with the compute request tags.
            {ResourceType:'network-interface',Tags:tagList(i.operation==='pool-provision'?poolTagsFor(i):tagsFor(i))}]};
}
let helper:ReturnType<typeof createLifecycleHelper>|undefined;
export async function handler(input:unknown){
    try {if(!helper){const settings=SettingsSchema.parse(JSON.parse(process.env.EZIL_LIFECYCLE_SETTINGS??''));helper=createLifecycleHelper(settings,awsDependencies(settings));}
        return await helper(input);
    }catch(error){throw lifecycleError(error)}
}

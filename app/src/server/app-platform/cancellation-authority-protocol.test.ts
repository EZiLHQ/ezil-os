import { createHash,randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { lifecycleFixture } from '../../../tests/fixtures/lifecycle';
import { computerRecoveryFixture } from '../../../tests/fixtures/computer-recovery';
import { validateCancellationReceipt } from './cancellation-authority-protocol';
import { type LifecycleWork } from './lifecycle-protocol';

const work=(input:unknown):LifecycleWork=>{const document=JSON.stringify(input);return {document,digest:createHash('sha256').update(document).digest('hex'),createdAt:new Date()}};
function fixture(v2=false){
    const source=v2?computerRecoveryFixture():lifecycleFixture('start'),i=source.intent,id=randomUUID();
    const cancellation=work({schemaVersion:1,operation:'cancel',cancellationId:id,computerId:i.computerId,
        source:{schemaVersion:i.schemaVersion,jobId:i.jobId,digest:source.work.digest,stateAtRequest:'running'},reason:'authority_revoked',requestedBy:null,
        workflowVersionArn:'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancel:1'});
    const version=i.deployment.stateMachineVersionArn;
    const receipt={schemaVersion:1,cancellationId:id,computerId:i.computerId,digest:cancellation.digest,
        source:{schemaVersion:i.schemaVersion,jobId:i.jobId,computerId:i.computerId,digest:source.work.digest,state:'fenced',volumeId:i.dataVolumeId,
            sourceExecutionArn:version.slice(0,version.lastIndexOf(':')).replace(':stateMachine:',':execution:')+`:computer-${i.jobId}`,
            instances:[{instanceId:'i-11111111111111111',generation:i.targetGeneration,fenceToken:i.fenceToken,state:'terminated'}]}};
    return {source:source.work,cancellation,receipt};
}
it('binds a separate cancellation digest to v1/v2 source cleanup receipts',()=>{
    for(const v2 of [false,true]){const f=fixture(v2);expect(validateCancellationReceipt(f.cancellation,f.source,f.receipt)).toEqual(f.receipt)}
});
it.each(['id','digest','computer','source-digest','source-job','source-computer','source-version','instance','fence','volume','execution','duplicate','extra'])('rejects %s without echoing input',kind=>{
    const f=fixture();const r=f.receipt;
    if(kind==='id')r.cancellationId=randomUUID();if(kind==='digest')r.digest='0'.repeat(64);if(kind==='computer')r.computerId=randomUUID();
    if(kind==='source-digest')r.source.digest='0'.repeat(64);if(kind==='source-job')r.source.jobId=randomUUID();if(kind==='source-computer')r.source.computerId=randomUUID();
    if(kind==='source-version')r.source.schemaVersion=2;if(kind==='instance')r.source.instances[0]!.instanceId='i-22222222222222222';
    if(kind==='fence')r.source.instances[0]!.fenceToken=randomUUID();if(kind==='volume')r.source.volumeId='vol-22222222222222222';
    if(kind==='execution')r.source.sourceExecutionArn+='other';if(kind==='duplicate')r.source.instances.push({...r.source.instances[0]!});
    if(kind==='extra')Object.assign(r,{key:'sensitive-sentinel'});
    expect(()=>validateCancellationReceipt(f.cancellation,f.source,r)).toThrow(/^lifecycle_conflict$/);
});

import { afterAction, phases, type Action } from './contract.js';
const fields:Record<Action,string[]>={
    createVolume:['AvailabilityZone','Size','VolumeType','Iops','Throughput','Encrypted','KmsKeyId','ClientToken','TagSpecifications'],
    runInstances:['LaunchTemplate','ImageId','InstanceType','MinCount','MaxCount','ClientToken','SubnetId','SecurityGroupIds','IamInstanceProfile',
        'Placement','MetadataOptions','EbsOptimized','Monitoring','BlockDeviceMappings','TagSpecifications'],
    attachVolume:['Device','InstanceId','VolumeId'],modifyInstanceAttribute:['InstanceId','BlockDeviceMappings'],createTags:['Resources','Tags'],
    startInstances:['InstanceIds'],stopInstances:['InstanceIds','Force','Hibernate','SkipOsShutdown'],terminateInstances:['InstanceIds'],
};
/** Fixed Standard EC2 tasks never retry. Each action advances to observation
 * even on a lost response. Only token-idempotent allocation can repeat. */
export function lifecycleDefinition(helperArn:string){
    const States:Record<string,any>={
        Decide:{Type:'Choice',Choices:[...Object.keys(fields).map(action=>({Variable:'$.step.decision',StringEquals:action,Next:action})),
            {Variable:'$.step.decision',StringEquals:'wait',Next:'Wait'},
            {Variable:'$.step.decision',StringEquals:'success',Next:'Succeeded'}],Default:'Unconfirmed'},
        Wait:{Type:'Wait',Seconds:5,Next:'Resume'},
        Resume:{Type:'Choice',Choices:phases.map(phase=>({Variable:'$.step.phase',StringEquals:phase,Next:'Observe-'+phase})),Default:'Unconfirmed'},
        Succeeded:{Type:'Pass',InputPath:'$.step.receipt',End:true},
        Unconfirmed:{Type:'Fail',Error:'LifecycleUnconfirmed',Cause:'Provider effects remain reserved until reconciliation'},
    };
    for(const phase of phases) States['Observe-'+phase]={Type:'Task',Resource:helperArn,TimeoutSeconds:60,
        Parameters:{'executionArn.$':'$$.Execution.Id',phase},ResultPath:'$.step',Next:'Decide',
        Catch:[{ErrorEquals:['States.ALL'],ResultPath:null,Next:'Unconfirmed'}]};
    for(const [name,keys]of Object.entries(fields)) {
        const next='After-'+name;
        States[name]={Type:'Task',Resource:`arn:aws:states:::aws-sdk:ec2:${name}`,TimeoutSeconds:30,
            Parameters:Object.fromEntries(keys.map(key=>[key+'.$','$.step.parameters.'+key])),ResultPath:null,Next:next,
            Catch:[{ErrorEquals:['States.ALL'],ResultPath:null,Next:next}]};
        States[next]={Type:'Wait',Seconds:5,Next:'Observe-'+afterAction[name as Action]};
    }
    return {Comment:'Bounded EC2 lifecycle; provider receipts do not certify mounted storage or installed apps',StartAt:'Observe-initial',TimeoutSeconds:960,States};
}

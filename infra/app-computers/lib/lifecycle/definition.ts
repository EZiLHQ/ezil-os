import { afterAction, ec2Api, phases, type Action } from './contract.js';
import { NO_ERROR, RETRYABLE_ERROR } from './errors.js';
const RUN_FIELDS=['LaunchTemplate','ImageId','InstanceType','MinCount','MaxCount','ClientToken','SubnetId','SecurityGroupIds',
    'MetadataOptions','HibernationOptions','EbsOptimized','Monitoring','BlockDeviceMappings','TagSpecifications','UserData'];
const fields:Record<Exclude<Action,'modifyInstanceAttribute'>,string[]>={
    createVolume:['AvailabilityZoneId','Size','VolumeType','Iops','Throughput','Encrypted','KmsKeyId','ClientToken','TagSpecifications'],
    runInstances:RUN_FIELDS,
    // T-family launches: the same API plus the (standard) credit option.
    runBurstableInstances:[...RUN_FIELDS,'CreditSpecification'],
    attachVolume:['Device','InstanceId','VolumeId'],detachVolume:['Device','InstanceId','VolumeId','Force'],
    createTags:['Resources','Tags'],claimInstance:['Resources','Tags'],deleteTags:['Resources','Tags'],
    startInstances:['InstanceIds'],stopInstances:['InstanceIds','Force','Hibernate','SkipOsShutdown'],terminateInstances:['InstanceIds'],
};
/** Observation is read-only, so transient helper failures retry. Only the
 * helper's dedicated retryable error and Lambda service faults qualify. */
export const observationRetry=[{ErrorEquals:[RETRYABLE_ERROR,'Lambda.ServiceException','Lambda.AWSLambdaException',
    'Lambda.SdkClientException','Lambda.TooManyRequestsException'],IntervalSeconds:2,MaxAttempts:3,BackoffRate:2,JitterStrategy:'FULL'}];
/** The cause every failure terminal records: the last EC2 task error and the
 * last observation error, kept in separate fields so neither overwrites the other. */
export const recordedCause='States.JsonToString($.ctl)';
/** Fixed Standard EC2 tasks never retry automatically. Each action advances
 * to observation even on a lost response, with the error recorded at
 * `$.ctl.lastError`. The helper decides: capacity/quota -> Refused with the
 * code; throttling -> bounded backoff and re-arm; anything else -> observe. */
export function lifecycleDefinition(helperArn:string,features:{userDataNonce?:boolean}={}){
    // C-6: the userData-only ModifyInstanceAttribute step exists only behind the flag.
    const all:Record<string,string[]>={...fields,...(features.userDataNonce?{modifyInstanceAttribute:['InstanceId','UserData']}:{})};
    const States:Record<string,any>={
        Init:{Type:'Pass',Result:{lastError:NO_ERROR,observeError:NO_ERROR,throttles:0},ResultPath:'$.ctl',Next:'Observe-initial'},
        Decide:{Type:'Choice',Choices:[...Object.keys(all).map(action=>({Variable:'$.step.decision',StringEquals:action,Next:action})),
            {Variable:'$.step.decision',StringEquals:'wait',Next:'Wait'},
            {Variable:'$.step.decision',StringEquals:'backoff',Next:'Backoff'},
            {Variable:'$.step.decision',StringEquals:'refused',Next:'Refused'},
            {Variable:'$.step.decision',StringEquals:'rejected',Next:'Rejected'},
            {Variable:'$.step.decision',StringEquals:'success',Next:'Succeeded'}],Default:'Unconfirmed'},
        Wait:{Type:'Wait',SecondsPath:'$.step.delaySeconds',Next:'Resume'},
        Backoff:{Type:'Wait',SecondsPath:'$.step.delaySeconds',Next:'Rearm'},
        Rearm:{Type:'Pass',Parameters:{lastError:NO_ERROR,'observeError.$':'$.ctl.observeError','throttles.$':'States.MathAdd($.ctl.throttles, 1)'},ResultPath:'$.ctl',Next:'Resume'},
        Resume:{Type:'Choice',Choices:phases.map(phase=>({Variable:'$.step.phase',StringEquals:phase,Next:'Observe-'+phase})),Default:'Unconfirmed'},
        Succeeded:{Type:'Pass',InputPath:'$.step.receipt',End:true},
        Refused:{Type:'Fail',Error:'LifecycleRefused',CausePath:'$.step.code'},
        // A definite EC2 rejection: unconfirmed-style terminal carrying the code.
        Rejected:{Type:'Fail',Error:'LifecycleUnconfirmed',CausePath:'$.step.code'},
        Unconfirmed:{Type:'Fail',Error:'LifecycleUnconfirmed',CausePath:recordedCause},
    };
    for(const phase of phases) States['Observe-'+phase]={Type:'Task',Resource:helperArn,TimeoutSeconds:60,
        Parameters:{'executionArn.$':'$$.Execution.Id',phase,'lastError.$':'$.ctl.lastError','throttles.$':'$.ctl.throttles'},
        ResultPath:'$.step',Next:'Decide',Retry:observationRetry,
        Catch:[{ErrorEquals:['States.ALL'],ResultPath:'$.ctl.observeError',Next:'Unconfirmed'}]};
    for(const [name,keys]of Object.entries(all)) {
        const next='After-'+name;
        States[name]={Type:'Task',Resource:`arn:aws:states:::aws-sdk:ec2:${ec2Api(name as Action)}`,TimeoutSeconds:30,
            Parameters:Object.fromEntries(keys.map(key=>[key+'.$','$.step.parameters.'+key])),
            // A confirmed action can be observed immediately; the observer's
            // fixed phase still records the attempt before any Describe call.
            ResultSelector:NO_ERROR,ResultPath:'$.ctl.lastError',Next:'Observe-'+afterAction[name as Action],
            Catch:[{ErrorEquals:['States.ALL'],ResultPath:'$.ctl.lastError',Next:next}]};
        // Keep the existing delay and phase on caught errors, including lost
        // allocation replies that may lead to an identical tokenized retry.
        States[next]={Type:'Wait',Seconds:1,Next:'Observe-'+afterAction[name as Action]};
    }
    return {Comment:'Bounded EC2 lifecycle; provider receipts do not certify mounted storage or installed apps',StartAt:'Init',TimeoutSeconds:960,States};
}

import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { WorkloadDeploySchema, applyWorkloadIdentity, workloadStackName, workloadSynthesizer } from '../lib/workload-identity.js';
import { z } from 'zod';
import { ComputerLifecycle, RetainedLifecycleSourceSchema } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
import { AppCaller, AppCallerConfigSchema } from '../lib/app-caller.js';
try {
    const path=process.env.EZIL_LIFECYCLE_CONFIG;if(!path)throw new Error();
    const bytes=readFileSync(path);if(bytes.length>16384)throw new Error();
    const config=z.object({settings:SettingsSchema,authorityKeyArn:z.string(),notificationsEnabled:z.boolean().default(false),alertTopicArn:z.string().optional(),
        recoveryVersionArn:z.string().optional(),recoveryEnabled:z.boolean().default(false),
        retainedLifecycleSource:RetainedLifecycleSourceSchema.optional(),
        retainedRecoveryObserverVersionLogicalId:z.string().regex(/^RecoveryObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/).optional(),
        // Exact previous observer version logical ids kept invokable through the promotion window (image-to-image rollouts).
        transitionObserverVersions:z.object({lifecycle:z.string().regex(/^LifecycleObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/).optional(),
            preparation:z.string().regex(/^LifecyclePreparationObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/).optional(),
            recovery:z.string().regex(/^RecoveryObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/).optional()}).strict().optional(),
        // Exact previous state-machine version ARNs whose execution histories stay readable (exact prior history-key
        // context rows for the lifecycle observer, app caller, preparation and recovery) through the same window.
        transitionStateMachineVersions:z.object({lifecycle:z.string().regex(/^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/).optional(),
            preparation:z.string().regex(/^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/).optional(),
            recovery:z.string().regex(/^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/).optional()}).strict().optional(),
        appCaller:AppCallerConfigSchema.default({}),deploy:WorkloadDeploySchema.optional(),
        // null omits the reservation: a new account's whole Lambda pool is 10, and any reservation then breaks the 10-unreserved minimum.
        lambdaReservedConcurrency:z.number().int().min(1).max(100).nullable().default(2)}).strict().parse(JSON.parse(bytes.toString()));
    const app=new App(),d=config.settings.deployment;
    // With `deploy`, the stack deploys under the I5 identity: roles under the
    // workload path with the boundary, assets in the identity bucket, no bootstrap.
    const stack=new Stack(app,workloadStackName(d.namespace,'lifecycle'),{env:{account:d.accountId,region:d.region},terminationProtection:true,
        ...(config.deploy?{synthesizer:workloadSynthesizer(config.deploy)}:{})});
    if(config.deploy)applyWorkloadIdentity(stack,d.accountId,d.namespace);
    const lifecycle=new ComputerLifecycle(stack,'Lifecycle',{...config,...(config.retainedLifecycleSource?{retainedSource:config.retainedLifecycleSource}:{}),
        ...(config.transitionStateMachineVersions?{transitionStateMachineVersions:config.transitionStateMachineVersions}:{})});
    if(config.recoveryEnabled&&!config.recoveryVersionArn)throw new Error();
    const recovery=config.recoveryVersionArn?new ComputerLifecycleRecovery(stack,'Recovery',{
        settings:{lifecycle:config.settings,recoveryVersionArn:config.recoveryVersionArn},
        sourceHistoryKey:lifecycle.historyKey,enabled:config.recoveryEnabled,
        ...(config.retainedRecoveryObserverVersionLogicalId ? {retainedObserverVersionLogicalId:config.retainedRecoveryObserverVersionLogicalId}:{}),
        ...(config.transitionObserverVersions?.recovery ? {transitionObserverVersionLogicalId:config.transitionObserverVersions.recovery}:{}),
        ...(config.transitionStateMachineVersions ? {transitionStateMachineVersions:config.transitionStateMachineVersions}:{})}):undefined;
    // appCaller includes optional ec2CallerRoleArns; an absent/empty list keeps OIDC-only trust.
    if(config.appCaller.enabled)new AppCaller(stack,'AppCaller',{config:config.appCaller,ec2CallerRoleArns:config.appCaller.ec2CallerRoleArns,region:d.region,versionArns:[d.stateMachineVersionArn],historyKeyArn:lifecycle.historyKey.keyArn,...(config.retainedLifecycleSource?{retainedLifecycleVersionArn:config.retainedLifecycleSource.stateMachineVersionArn}:{}),
        ...(config.transitionStateMachineVersions?{transitionStateMachineVersions:config.transitionStateMachineVersions}:{})});
}catch(cause){throw new Error("EZIL_LIFECYCLE_CONFIG is missing or invalid; supply reviewed references without credentials",{cause})}

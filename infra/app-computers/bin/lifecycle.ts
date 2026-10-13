import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { WorkloadDeploySchema, applyWorkloadIdentity, workloadStackName, workloadSynthesizer } from '../lib/workload-identity.js';
import { z } from 'zod';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
import { AppCaller, AppCallerConfigSchema } from '../lib/app-caller.js';
try {
    const path=process.env.EZIL_LIFECYCLE_CONFIG;if(!path)throw new Error();
    const bytes=readFileSync(path);if(bytes.length>16384)throw new Error();
    const config=z.object({settings:SettingsSchema,authorityKeyArn:z.string(),notificationsEnabled:z.boolean().default(false),
        recoveryVersionArn:z.string().optional(),recoveryEnabled:z.boolean().default(false),appCaller:AppCallerConfigSchema.default({}),deploy:WorkloadDeploySchema.optional()}).strict().parse(JSON.parse(bytes.toString()));
    const app=new App(),d=config.settings.deployment;
    // With `deploy`, the stack deploys under the I5 identity: roles under the
    // workload path with the boundary, assets in the identity bucket, no bootstrap.
    const stack=new Stack(app,workloadStackName(d.namespace,'lifecycle'),{env:{account:d.accountId,region:d.region},terminationProtection:true,
        ...(config.deploy?{synthesizer:workloadSynthesizer(config.deploy)}:{})});
    if(config.deploy)applyWorkloadIdentity(stack,d.accountId,d.namespace);
    const lifecycle=new ComputerLifecycle(stack,'Lifecycle',config);
    if(config.recoveryEnabled&&!config.recoveryVersionArn)throw new Error();
    if(config.recoveryVersionArn)new ComputerLifecycleRecovery(stack,'Recovery',{
        settings:{lifecycle:config.settings,recoveryVersionArn:config.recoveryVersionArn},
        sourceHistoryKey:lifecycle.historyKey,enabled:config.recoveryEnabled});
    if(config.appCaller.enabled)new AppCaller(stack,'AppCaller',{config:config.appCaller,region:d.region,versionArns:[d.stateMachineVersionArn]});
}catch(cause){throw new Error("EZIL_LIFECYCLE_CONFIG is missing or invalid; supply reviewed references without credentials",{cause})}

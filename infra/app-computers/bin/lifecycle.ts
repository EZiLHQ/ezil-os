import { readFileSync } from 'node:fs';
import { App, Stack, CfnOutput, aws_kms as kms } from 'aws-cdk-lib';
import { z } from 'zod';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { ComputerCancellation } from '../lib/computer-cancellation.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
try {
    const path=process.env.EZIL_LIFECYCLE_CONFIG;if(!path)throw new Error();
    const bytes=readFileSync(path);if(bytes.length>16384)throw new Error();
    const config=z.object({settings:SettingsSchema,authorityKeyArn:z.string(),notificationsEnabled:z.boolean().default(false),
        recoveryVersionArn:z.string().optional(),recoveryEnabled:z.boolean().default(false),
        cancellation:z.object({versionArn:z.string(),secretArn:z.string(),authorityKeyArn:z.string()}).strict().optional()}).strict().parse(JSON.parse(bytes.toString()));
    const app=new App(),d=config.settings.deployment;
    const stack=new Stack(app,`ezil-lifecycle-${d.namespace}`,{env:{account:d.accountId,region:d.region},terminationProtection:true});
    const lifecycle=new ComputerLifecycle(stack,'Lifecycle',config);
    if(config.recoveryEnabled&&!config.recoveryVersionArn)throw new Error();
    if(config.recoveryVersionArn)new ComputerLifecycleRecovery(stack,'Recovery',{
        settings:{lifecycle:config.settings,recoveryVersionArn:config.recoveryVersionArn},
        sourceHistoryKey:lifecycle.historyKey,enabled:config.recoveryEnabled});
    if(config.cancellation){
        const c=config.cancellation;
        if(!new RegExp(`^arn:aws:kms:us-east-1:${d.accountId}:key/[a-f0-9-]{36}$`).test(c.authorityKeyArn))throw new Error();
        const cancellation=new ComputerCancellation(stack,'Cancellation',{settings:{lifecycle:config.settings,
            cancellationVersionArn:c.versionArn,cancellationSecretArn:c.secretArn},sourceHistoryKey:lifecycle.historyKey,
            authorityKey:kms.Key.fromKeyArn(stack,'CancellationAuthorityKey',c.authorityKeyArn)});
        new CfnOutput(stack,'CancellationVersionArn',{value:cancellation.version.ref});
        new CfnOutput(stack,'CancellationHistoryKeyArn',{value:cancellation.historyKey.keyArn});
    }
}catch{throw new Error('EZIL_LIFECYCLE_CONFIG is missing or invalid; supply reviewed references without credentials')}

import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { z } from 'zod';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { SettingsSchema } from '../lib/lifecycle/contract.js';
try {
    const path=process.env.EZIL_LIFECYCLE_CONFIG;if(!path)throw new Error();
    const bytes=readFileSync(path);if(bytes.length>16384)throw new Error();
    const config=z.object({settings:SettingsSchema,authorityKeyArn:z.string(),notificationsEnabled:z.boolean().default(false)}).strict().parse(JSON.parse(bytes.toString()));
    const app=new App(),d=config.settings.deployment;
    const stack=new Stack(app,`ezil-lifecycle-${d.namespace}`,{env:{account:d.accountId,region:d.region},terminationProtection:true});
    new ComputerLifecycle(stack,'Lifecycle',config);
}catch{throw new Error('EZIL_LIFECYCLE_CONFIG is missing or invalid; supply reviewed references without credentials')}

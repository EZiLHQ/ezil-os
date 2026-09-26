import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { z } from 'zod';
import { ComputerStartDelivery } from '../lib/computer-start-delivery.js';
import { SettingsSchema } from '../lib/start/contract.js';

// A reviewed deployment file contains ARNs/references, never key values.
// Separate entrypoint so foundation synth does not provision a workflow.
try {
    const path = process.env.EZIL_START_CONFIG;
    if (!path) throw new Error();
    const bytes = readFileSync(path); if (bytes.length > 16384) throw new Error();
    const config = z.object({ machineName: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
        authorityKeyArn: z.string(), reconciliationEnabled: z.boolean().default(false), settings: SettingsSchema }).strict()
        .parse(JSON.parse(bytes.toString()));
    if (config.settings.machineArn !== `arn:aws:states:us-east-1:${config.settings.deployment.accountId}:stateMachine:${config.machineName}`
        || !new RegExp(`^arn:aws:kms:us-east-1:${config.settings.deployment.accountId}:key/[a-f0-9-]{36}$`).test(config.authorityKeyArn)) throw new Error();
    const app = new App();
    const stack = new Stack(app, `${config.machineName}-stack`, { env: { region: config.settings.deployment.region, account: config.settings.deployment.accountId },
        terminationProtection: true });
    new ComputerStartDelivery(stack, 'Start', config);
} catch { throw new Error('EZIL_START_CONFIG is missing or invalid; supply the reviewed deployment-reference file'); }

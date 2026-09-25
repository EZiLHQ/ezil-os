import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { z } from 'zod';
import { ConfigurationDelivery } from '../lib/configuration-delivery.js';
import { SettingsSchema } from '../lib/delivery/contract.js';

// A reviewed deployment file contains ARNs/references, never key values.
// Separate entrypoint so foundation synth does not provision a workflow.
try {
    const path = process.env.EZIL_DELIVERY_CONFIG;
    if (!path) throw new Error();
    const bytes = readFileSync(path); if (bytes.length > 8192) throw new Error();
    const config = z.object({ machineName: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
        authorityKeyArn: z.string(), reconciliationEnabled: z.boolean().default(false), settings: SettingsSchema }).strict()
        .parse(JSON.parse(bytes.toString()));
    if (config.settings.machineArn !== `arn:aws:states:us-east-1:${config.settings.accountId}:stateMachine:${config.machineName}`
        || !new RegExp(`^arn:aws:kms:us-east-1:${config.settings.accountId}:key/[a-f0-9-]{36}$`).test(config.authorityKeyArn)) throw new Error();
    const app = new App();
    const stack = new Stack(app, `${config.machineName}-stack`, { env: { region: config.settings.region, account: config.settings.accountId },
        terminationProtection: true });
    new ConfigurationDelivery(stack, 'Configuration', config);
} catch { throw new Error('EZIL_DELIVERY_CONFIG is missing or invalid; supply the reviewed deployment-reference file'); }

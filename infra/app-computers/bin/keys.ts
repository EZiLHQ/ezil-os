import { readFileSync } from 'node:fs';
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { PilotKeysConfigSchema, PilotKeysStack } from '../lib/pilot-keys.js';
import { workloadStackName } from '../lib/workload-identity.js';

const path = process.env.EZIL_KEYS_CONFIG;
if (!path) throw new Error('EZIL_KEYS_CONFIG must name a reviewed keys config file');
const config = PilotKeysConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
new PilotKeysStack(new App(), workloadStackName(config.namespace, 'keys'), { config, terminationProtection: true,
    synthesizer: new BootstraplessSynthesizer(), env: { account: config.accountId, region: config.region } });

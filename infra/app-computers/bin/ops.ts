import { readFileSync } from 'node:fs';
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { OpsConfigSchema, OpsStack } from '../lib/ops.js';
import { workloadStackName } from '../lib/workload-identity.js';

const path = process.env.EZIL_OPS_CONFIG;
if (!path) throw new Error('EZIL_OPS_CONFIG must name a reviewed ops config file');
const config = OpsConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
// No roles (the DLM role is AWS-managed) and no assets: no CDK bootstrap.
new OpsStack(new App(), workloadStackName(config.namespace, 'ops'), { config, terminationProtection: true,
    synthesizer: new BootstraplessSynthesizer(), env: { account: config.accountId, region: config.region } });

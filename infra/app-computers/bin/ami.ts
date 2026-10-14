import { readFileSync } from 'node:fs';
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { AmiConfigSchema, AmiPipelineStack } from '../lib/ami-pipeline.js';
import { workloadStackName } from '../lib/workload-identity.js';

// Founder-run only; no workload boundary, assets, lookups or CDK bootstrap.
const path = process.env.EZIL_AMI_CONFIG;
if (!path) throw new Error('EZIL_AMI_CONFIG must name a reviewed AMI config file');
const config = AmiConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
new AmiPipelineStack(new App(), workloadStackName(config.namespace, 'ami'), { config, terminationProtection: true,
    synthesizer: new BootstraplessSynthesizer(), env: { account: config.accountId, region: config.region } });

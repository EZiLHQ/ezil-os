import { readFileSync } from 'node:fs';
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';

import { AppComputerFoundationStack, FoundationConfigSchema } from '../lib/foundation.js';
import { tagWorkload } from '../lib/workload-identity.js';

// Configuration is explicit: no default region, no account lookup. The npm
// `synth` script points this at the public placeholder example.
const path = process.env.EZIL_FOUNDATION_CONFIG;
if (!path) throw new Error('EZIL_FOUNDATION_CONFIG must name a reviewed foundation config file');
const config = FoundationConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
const app = new App();
// No roles and no assets: deployable with `aws cloudformation deploy`, no CDK bootstrap.
const stack = new AppComputerFoundationStack(app, `ezil-${config.stage}-foundation`, {
    config, synthesizer: new BootstraplessSynthesizer(),
    env: { region: config.region },
    terminationProtection: config.stage === 'production',
});
tagWorkload(stack, config.stage);

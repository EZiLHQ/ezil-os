import { readFileSync } from 'node:fs';
import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { DeployIdentityStack, IdentityConfigSchema } from '../lib/identity.js';

// Founder-run once (README "Founder bootstrap"); never deployed by CI.
const path = process.env.EZIL_IDENTITY_CONFIG;
if (!path) throw new Error('EZIL_IDENTITY_CONFIG must name a reviewed identity config file');
const config = IdentityConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
new DeployIdentityStack(new App(), `ezil-identity-${config.namespace}`, { config, terminationProtection: true,
    synthesizer: new BootstraplessSynthesizer(), env: { account: config.accountId, region: config.region } });

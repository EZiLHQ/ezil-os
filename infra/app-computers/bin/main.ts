import { App } from 'aws-cdk-lib';

import { AppComputerFoundationStack } from '../lib/foundation.js';

const stage = process.env.EZIL_INFRA_STAGE ?? 'pilot';
if (stage !== 'pilot' && stage !== 'production') {
    throw new Error('EZIL_INFRA_STAGE must be pilot or production');
}
const app = new App();
new AppComputerFoundationStack(app, `EzilAppComputers-${stage}`, {
    stage,
    env: { region: 'us-east-1' },
    terminationProtection: stage === 'production',
});

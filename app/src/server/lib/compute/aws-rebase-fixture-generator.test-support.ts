/** Run from repo root: (cd app && node --import ../infra/app-computers/node_modules/tsx/dist/loader.mjs src/server/lib/compute/aws-rebase-fixture-generator.test-support.ts) */
import { writeFileSync } from 'node:fs';
import { buildLifecycleWork } from './aws-intent';
import { fixtureIntent, fixtureRebaseIntent } from './aws-intent.test-support';
const types = ['t3a.medium', 't3.medium', 'm6i.large'];
const cases = {
    'start-ap-south-1': fixtureIntent('start'),
    'provision-ap-south-1': fixtureIntent('provision'),
    'stop-us-east-1': fixtureIntent('stop', 'us-east-1'),
    'provision-free-ap-south-1': fixtureIntent('provision', 'ap-south-1', 't3a.medium', types),
    'replace-free-ap-south-1': fixtureIntent('replace', 'ap-south-1', 't3a.medium', types),
    'rebase-replace': fixtureRebaseIntent(),
    'ebs-restore-rebind': fixtureRebaseIntent(true),
};
writeFileSync(`${__dirname}/aws-intent.fixtures.json`, JSON.stringify(Object.fromEntries(Object.entries(cases).map(([key, candidate]) => {
    const w = buildLifecycleWork(candidate);
    return [key, { name: w.name, stateMachineArn: w.stateMachineArn, digest: w.digest, input: w.input }];
})), null, 2) + '\n');

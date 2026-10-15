import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, BootstraplessSynthesizer, assertions } from 'aws-cdk-lib';
import { OpsConfigSchema, OpsStack } from '../lib/ops.js';

test('DLM policy description uses only the characters AWS DLM accepts (live create failed on ":" and ",")', () => {
    const config = OpsConfigSchema.parse(JSON.parse(readFileSync(join(__dirname, '..', 'config', 'ops.example.json'), 'utf8')));
    const stack = new OpsStack(new App(), 'ezil-pilot-ops', { config, synthesizer: new BootstraplessSynthesizer(),
        env: { account: config.accountId, region: config.region } });
    const policies = assertions.Template.fromStack(stack).findResources('AWS::DLM::LifecyclePolicy');
    assert.ok(Object.keys(policies).length >= 1);
    for (const p of Object.values(policies)) {
        const d = (p as { Properties: { Description: string } }).Properties.Description;
        assert.match(d, /^[0-9A-Za-z _-]{1,500}$/, d);
    }
});

// Cross-package contract: the app builds lifecycle executions with its own copy
// of the intent schema (app/src/server/lib/compute/aws-intent.ts; app CI installs
// no infra code). Its pinned fixtures must parse with THIS package's real
// parseLifecycleWork, so a drift on either side fails a test (the app's copy
// once missed identity-ops' ezil-<ns>-* machine-name rule and every intent it
// built would have been refused).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBurstable } from '../lib/lifecycle/deployment.js';
import { parseLifecycleWork } from '../lib/lifecycle/intent.js';
import { createHash } from 'node:crypto';

const FIXTURES = join(__dirname, '../../../app/src/server/lib/compute/aws-intent.fixtures.json');
interface AppFixture { name: string; stateMachineArn: string; digest: string; input: string }
const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Record<string, AppFixture>;

test('the app intent fixture file exists and covers provision (incl. a free-tier type), start and stop', () => {
    const keys = Object.keys(fixtures);
    assert.ok(keys.length >= 4, `expected at least 4 fixtures, found ${keys.length}`);
    const ops = new Set(Object.values(fixtures).map(f => JSON.parse(JSON.parse(f.input).document).operation));
    for (const op of ['provision', 'start', 'stop']) assert.ok(ops.has(op), `no ${op} fixture`);
    assert.ok(Object.values(fixtures).some(f => {
        const i = JSON.parse(JSON.parse(f.input).document);
        return i.operation === 'provision' && isBurstable(i.instanceType);
    }), 'no free-tier (burstable) provision fixture');
});

for (const [key, f] of Object.entries(fixtures)) {
    test(`app fixture ${key} parses with infra's parseLifecycleWork and matches its envelope`, () => {
        const envelope = JSON.parse(f.input) as Record<string, unknown>;
        assert.deepEqual(Object.keys(envelope), ['schemaVersion', 'document', 'digest']);
        assert.equal(envelope.schemaVersion, 1);
        assert.equal(envelope.digest, f.digest);
        const document = envelope.document as string, digest = f.digest;
        assert.equal(createHash('sha256').update(document, 'utf8').digest('hex'), digest);
        const intent = parseLifecycleWork({ document, digest, createdAt: new Date() });
        if (intent.rebasePreparation) assert.equal(JSON.stringify(intent), document, 'schema order and every byte must match the app');
        assert.equal(f.name, `computer-${intent.jobId}`);
        assert.equal(f.stateMachineArn, intent.deployment.stateMachineVersionArn);
    });
}

test('real rebase and EBS restore fixtures have pinned byte-for-byte hashes', () => {
    assert.equal(fixtures['rebase-replace']!.digest, 'f6f7238c7ea93f964963e6ff8475eb482af8e03a308f6e0f1742a1e461471d9f');
    assert.equal(fixtures['ebs-restore-rebind']!.digest, 'b8f44018ce1c923a17224c524f789af3a85dc520f3a315b2d39e064eee3f48a9');
});

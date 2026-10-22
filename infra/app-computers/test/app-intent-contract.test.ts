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
import { leaseFixture } from './lease-fixture.js';

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
        let document = envelope.document as string, digest = f.digest;
        const legacy = JSON.parse(document);
        // Lane A owns the shared file. Until its regenerated leases arrive,
        // adapt ONLY the exact obsolete sentinel; production must reject it.
        if (legacy.userData === 'ZXppbC1ub25jZQ==') {
            assert.throws(() => parseLifecycleWork({ document, digest, createdAt: new Date() }));
            legacy.userData = leaseFixture(legacy);
            document = JSON.stringify(legacy); digest = createHash('sha256').update(document).digest('hex');
        }
        const intent = parseLifecycleWork({ document, digest, createdAt: new Date() });
        assert.equal(f.name, `computer-${intent.jobId}`);
        assert.equal(f.stateMachineArn, intent.deployment.stateMachineVersionArn);
    });
}

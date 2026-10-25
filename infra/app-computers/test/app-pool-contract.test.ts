import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLifecycleWork } from '../lib/lifecycle/intent.js';
const fixtures = JSON.parse(readFileSync(path.resolve(__dirname, '../../../app/src/server/lib/compute/aws-intent.fixtures.json'), 'utf8'));
for (const operation of ['pool-provision', 'adopt', 'release', 'pool-retire']) test(`app ${operation} cross-parses byte for byte`, () => {
    const fixture = fixtures[operation];
    const envelope = JSON.parse(fixture.input);
    const intent = parseLifecycleWork({ ...envelope, createdAt: new Date() });
    assert.equal(intent.operation, operation);
    assert.equal(JSON.stringify(intent), envelope.document);
    assert.equal(envelope.digest, fixture.digest);
});

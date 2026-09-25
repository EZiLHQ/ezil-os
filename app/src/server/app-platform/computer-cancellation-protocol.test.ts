import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lifecycleFixture } from '../../../tests/fixtures/lifecycle';
import { computerRecoveryFixture } from '../../../tests/fixtures/computer-recovery';
import { parseComputerCancellation, type ComputerCancellationV1 } from './computer-cancellation-protocol';
import type { LifecycleWork } from './lifecycle-protocol';

const work = (input: unknown): LifecycleWork => {
    const document = JSON.stringify(input);
    return { document, digest: createHash('sha256').update(document).digest('hex'), createdAt: new Date() };
};
const fixture = () => {
    const source = lifecycleFixture('provision');
    const cancellation: ComputerCancellationV1 = { schemaVersion: 1, operation: 'cancel', cancellationId: randomUUID(),
        computerId: source.intent.computerId, source: { schemaVersion: 1, jobId: source.intent.jobId, digest: source.work.digest, stateAtRequest: 'running' },
        reason: 'stop_requested', requestedBy: randomUUID(),
        workflowVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancel:1' };
    return { source, cancellation };
};
describe('explicit computer cancellation contract', () => {
    it('accepts start-capable v1 and v2 source pins without modifying original bytes', () => {
        for (const source of [lifecycleFixture('provision'), lifecycleFixture('start'), lifecycleFixture('replace'), computerRecoveryFixture()]) {
            const { cancellation } = fixture(), original = source.work.document;
            cancellation.computerId = source.intent.computerId;
            cancellation.source = { schemaVersion: source.intent.schemaVersion, jobId: source.intent.jobId,
                digest: source.work.digest, stateAtRequest: 'queued' };
            expect(parseComputerCancellation(work(cancellation), source.work)).toEqual(cancellation);
            expect(source.work.document).toBe(original);
        }
    });
    it('allows automatic revocation only with no impersonated requester', () => {
        const { source, cancellation } = fixture(); cancellation.reason = 'authority_revoked';
        expect(() => parseComputerCancellation(work(cancellation), source.work)).toThrow(/^lifecycle_invalid$/);
        cancellation.requestedBy = null;
        expect(parseComputerCancellation(work(cancellation), source.work).reason).toBe('authority_revoked');
        cancellation.reason = 'stop_requested';
        expect(() => parseComputerCancellation(work(cancellation), source.work)).toThrow(/^lifecycle_invalid$/);
    });
    it.each(['computer', 'job', 'source-version', 'source-digest', 'version', 'operation', 'state',
        'account', 'region', 'mutable-workflow', 'source-machine', 'unknown-field', 'nested-field'])('rejects %s with a redacted error', kind => {
        const { source, cancellation: c } = fixture();
        if (kind === 'computer') c.computerId = randomUUID();
        if (kind === 'job') c.source.jobId = randomUUID();
        if (kind === 'source-version') c.source.schemaVersion = 2;
        if (kind === 'source-digest') c.source.digest = '0'.repeat(64);
        if (kind === 'version') Object.assign(c, { schemaVersion: 2 });
        if (kind === 'operation') Object.assign(c, { operation: 'retire' });
        if (kind === 'state') Object.assign(c.source, { stateAtRequest: 'succeeded' });
        if (kind === 'account') c.workflowVersionArn = c.workflowVersionArn.replace('123456789012', '111111111111');
        if (kind === 'region') c.workflowVersionArn = c.workflowVersionArn.replace('us-east-1', 'us-west-2');
        if (kind === 'mutable-workflow') c.workflowVersionArn = c.workflowVersionArn.replace(/:1$/, ':LIVE');
        if (kind === 'source-machine') c.workflowVersionArn = source.intent.deployment.stateMachineVersionArn.replace(/:1$/, ':2');
        if (kind === 'unknown-field') Object.assign(c, { key: 'sensitive-marker' });
        if (kind === 'nested-field') Object.assign(c.source, { instanceId: 'sensitive-marker' });
        expect(() => parseComputerCancellation(work(c), source.work)).toThrow(/^lifecycle_invalid$/);
    });
    it('rejects stop/retire sources even when their digest and identifiers match', () => {
        for (const operation of ['stop', 'retire'] as const) {
            const { cancellation } = fixture(), source = lifecycleFixture(operation);
            cancellation.computerId = source.intent.computerId;
            cancellation.source.jobId = source.intent.jobId; cancellation.source.digest = source.work.digest;
            expect(() => parseComputerCancellation(work(cancellation), source.work)).toThrow(/^lifecycle_invalid$/);
        }
    });
    it('validates both original UTF-8 digests and bounded document envelopes', () => {
        const { source, cancellation } = fixture(), c = work(cancellation);
        for (const bad of [{ ...c, document: c.document + ' ' }, { ...c, digest: 'bad' },
            { ...c, document: 'x'.repeat(4097) }, { ...c, createdAt: new Date(NaN) }, work('{malformed')]) {
            expect(() => parseComputerCancellation(bad, source.work)).toThrow(/^lifecycle_invalid$/);
        }
        expect(() => parseComputerCancellation(c, { ...source.work, document: source.work.document + ' ' })).toThrow(/^lifecycle_invalid$/);
        const invalidSource = work({ ...source.intent, deployment: { ...source.intent.deployment, key: 'sensitive-marker' } });
        cancellation.source.digest = invalidSource.digest;
        expect(() => parseComputerCancellation(work(cancellation), invalidSource)).toThrow(/^lifecycle_invalid$/);
    });
});

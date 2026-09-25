import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseComputerRecoveryWork } from './computer-recovery-protocol';
import { parseLifecycleWork } from './lifecycle-protocol';
import { lifecycleFixture, lifecycleDeployment } from '../../../tests/fixtures/lifecycle';

const valid = () => ({ schemaVersion: 2, operation: 'recover', jobId: randomUUID(), computerId: randomUUID(),
    revision: 2, targetGeneration: 2, fenceToken: randomUUID(), source: { schemaVersion: 1, jobId: randomUUID(), digest: 'a'.repeat(64) },
    dataVolumeId: 'vol-11111111111111111', dataScope: { generation: 1, fenceToken: randomUUID() }, deployment: lifecycleDeployment });
const work = (input: unknown) => { const document = JSON.stringify(input);
    return { document, digest: createHash('sha256').update(document).digest('hex'), createdAt: new Date() }; };
describe('versioned retained computer recovery contract', () => {
    it('recognizes explicit recovery from v1 and v2 source jobs', () => {
        for (const version of [1, 2]) { const input = valid(); input.source.schemaVersion = version;
            expect(parseComputerRecoveryWork(work(input))).toEqual(input); }
    });
    it('preserves v1 parsing and rejects cross-version reinterpretation', () => {
        const legacy = lifecycleFixture(); expect(parseLifecycleWork(legacy.work)).toEqual(legacy.intent);
        expect(() => parseComputerRecoveryWork(legacy.work)).toThrow('lifecycle_invalid');
        expect(() => parseLifecycleWork(work(valid()))).toThrow('lifecycle_invalid');
    });
    it.each(['version', 'unknown-field', 'nested-field', 'self-source', 'generation', 'fence', 'source-version', 'digest', 'mutable-pin'])('rejects %s with redacted errors', kind => {
        const input = valid();
        if (kind === 'version') input.schemaVersion = 3;
        if (kind === 'unknown-field') Object.assign(input, { providerKey: 'sensitive-input-marker' });
        if (kind === 'nested-field') Object.assign(input.dataScope, { root: '/other/computer' });
        if (kind === 'self-source') input.source.jobId = input.jobId;
        if (kind === 'generation') input.dataScope.generation = input.targetGeneration;
        if (kind === 'fence') input.fenceToken = input.dataScope.fenceToken;
        if (kind === 'source-version') input.source.schemaVersion = 3;
        if (kind === 'digest') input.source.digest = 'missing-pin';
        if (kind === 'mutable-pin') input.deployment = { ...input.deployment, launchTemplateVersion: '$Latest' };
        expect(() => parseComputerRecoveryWork(work(input))).toThrow(/^lifecycle_invalid$/);
    });
    it('checks original UTF-8 document digest before consuming stored authority', () => {
        const stored = work(valid()); stored.document += ' ';
        expect(() => parseComputerRecoveryWork(stored)).toThrow('lifecycle_invalid');
    });
});

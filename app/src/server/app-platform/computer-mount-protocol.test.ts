import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ComputerMountWorkSchema, mountReceiptMatches } from './computer-mount-protocol';
import { canonicalConfiguration } from './computer-configuration';
import { lifecycleDeployment as deployment } from '../../../tests/fixtures/lifecycle';

function work() {
    const scope = { computerId: randomUUID(), computerGeneration: 1, fenceToken: randomUUID(),
        providerInstanceId: 'i-0123456789abcdef0', dataVolumeId: 'vol-0123456789abcdef0' };
    const plan = { computerId: scope.computerId, filesystemUuid: randomUUID(), mode: 'initialize' as const,
        schemaVersion: 1 as const, volumeId: scope.dataVolumeId };
    return { authorization: { schemaVersion: 1 as const, authorizationId: randomUUID(), scope,
        filesystemUuid: plan.filesystemUuid, mode: plan.mode, digest: createHash('sha256').update(canonicalConfiguration(plan)).digest('hex'),
        issuedAt: 1800000000, expiresAt: 1800000900 }, plan, deployment };
}
describe('computer mount work protocol', () => {
    it('accepts canonical content and only the matching exact host receipt', () => {
        const w = ComputerMountWorkSchema.parse(work());
        const receipt = { schemaVersion: 1, authorizationId: w.authorization.authorizationId, scope: w.authorization.scope,
            digest: w.authorization.digest, state: 'mounted', computerId: w.plan.computerId, volumeId: w.plan.volumeId, filesystemUuid: w.plan.filesystemUuid };
        expect(mountReceiptMatches(w, receipt)).toBe(true);
        expect(mountReceiptMatches(w, { ...receipt, filesystemUuid: randomUUID() })).toBe(false);
        expect(mountReceiptMatches(w, { ...receipt, scope: { ...receipt.scope, fenceToken: randomUUID() } })).toBe(false);
        expect(mountReceiptMatches(w, { ...receipt, ready: true })).toBe(false);
    });
    it.each(['mode', 'filesystem', 'volume', 'computer', 'digest', 'expiry', 'extra'])('rejects changed %s', kind => {
        const w = work();
        if (kind === 'mode') Object.assign(w.plan, { mode: 'mount' });
        if (kind === 'filesystem') w.plan.filesystemUuid = randomUUID();
        if (kind === 'volume') w.plan.volumeId = 'vol-fffffffffffffffff';
        if (kind === 'computer') w.authorization.scope.computerId = randomUUID();
        if (kind === 'digest') w.authorization.digest = '0'.repeat(64);
        if (kind === 'expiry') w.authorization.expiresAt++;
        if (kind === 'extra') Object.assign(w, { upstream: 'caller-selected' });
        expect(ComputerMountWorkSchema.safeParse(w).success).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { buildLifecycleWork, LifecycleIntentInvalidError } from './aws-intent';
import { fixtureIntent, fixtureRebaseIntent, fixtureRebasePreparation } from './aws-intent.test-support';
import { buildEnrollmentUserData } from './aws-enroll';
import { parseEnrollmentUserData, rebaseRemainingBudget } from './aws-rebase-lease';
import { parseRebaseJson } from './aws-rebase-json';

const encode = (raw: unknown) => Buffer.from(JSON.stringify(raw)).toString('base64');
const lease = () => parseEnrollmentUserData(fixtureRebaseIntent().userData!);
describe('strict rebase wire', () => {
    it('serializes the entire lease and authorization in contract order', () => {
        const l = lease();
        expect(Object.keys(l)).toEqual(['v', 'computerId', 'volumeId', 'fsUuid', 'generation', 'leaseEpoch', 'nonce', 'provision', 'enrollUrl', 'rebase', 'rebasePermit']);
        expect(Object.keys(l.rebase!)).toEqual(['snapshotId', 'volumeId', 'fromDigest', 'toDigest']);
        expect(Object.keys(l.rebasePermit!)).toEqual(['v', 'preparationJobId', 'launchJobId', 'computerId', 'fsUuid', 'generation', 'leaseEpoch', 'fenceToken', 'issuedAt', 'expiresAt']);
        const p = fixtureRebasePreparation();
        expect(fixtureRebaseIntent().rebasePreparation!.digest).toBe(p.digest);
        expect(Object.keys(JSON.parse(p.document))).toEqual(['schemaVersion', 'jobId', 'computerId', 'sourceInstanceId', 'sourceVolumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest', 'toDigest', 'volumeGiB', 'sourceDeployment', 'deployment', 'createdAt']);
    });
    it('preserves maintenance authorization order and the distinct restored volume', () => {
        const l = parseEnrollmentUserData(fixtureRebaseIntent(true).userData!);
        expect(Object.keys(l.ebsRestore!)).toEqual(['v', 'preparationJobId', 'recoveryJobId', 'launchJobId', 'snapshotId', 'originalVolumeId', 'volumeId', 'computerId', 'fsUuid', 'fromDigest', 'sourceGeneration', 'sourceLeaseEpoch', 'generation', 'leaseEpoch', 'fenceToken', 'issuedAt', 'expiresAt', 'maintenance']);
        expect(l.ebsRestore!.volumeId).not.toBe(l.ebsRestore!.originalVolumeId);
    });
    it('fits the exact field-maxima budgets', () => {
        const url = `https://${'a'.repeat(477)}.com/api/compute/aws/enroll`;
        expect(url).toHaveLength(512);
        for (const [restore, decoded, encoded] of [[false, 1541, 2056], [true, 1620, 2160]] as const) {
            const l = parseEnrollmentUserData(fixtureRebaseIntent(restore).userData!);
            const max = { ...l, generation: 2147483647, leaseEpoch: 2147483647, nonce: 'n'.repeat(128), enrollUrl: url };
            if (max.rebasePermit) max.rebasePermit = { ...max.rebasePermit, generation: max.generation, leaseEpoch: max.leaseEpoch };
            if (max.ebsRestore) max.ebsRestore = { ...max.ebsRestore, sourceGeneration: 2147483646, sourceLeaseEpoch: 2147483646, generation: max.generation, leaseEpoch: max.leaseEpoch };
            const wire = encode(max);
            expect(parseEnrollmentUserData(wire)).toEqual(max);
            expect(Buffer.from(wire, 'base64').length).toBe(decoded);
            expect(wire.length).toBe(encoded);
        }
    });
    it.each([true, '2', 1.5, 0, 2147483648, Infinity, NaN])('rejects counter %s without coercion', (value) => {
        expect(() => parseEnrollmentUserData(encode({ ...lease(), generation: value }))).toThrow();
    });
    it.each(['computerId', 'fsUuid', 'generation', 'leaseEpoch', 'launchJobId', 'fenceToken', 'preparationJobId'] as const)(
        'rejects a changed permit %s against its lease or intent', (key) => {
            const i = fixtureRebaseIntent(), l = lease();
            (l.rebasePermit as unknown as Record<string, unknown>)[key] = key === 'generation' || key === 'leaseEpoch' ? 99 : '99999999-9999-4999-8999-999999999999';
            expect(() => buildLifecycleWork({ ...i, userData: encode(l) })).toThrow(LifecycleIntentInvalidError);
        });
    it.each(['rebase', 'rebasePermit'] as const)('rejects a missing %s', (key) => {
        const l = lease(); delete l[key];
        expect(() => parseEnrollmentUserData(encode(l))).toThrow();
    });
    it.each(['volumeId', 'fromDigest', 'toDigest'] as const)('rejects changed rebase %s', (key) => {
        const i = fixtureRebaseIntent(), l = lease();
        l.rebase![key] = key === 'volumeId' ? 'vol-22222222222222222' : 'sha256:' + 'c'.repeat(64);
        expect(() => buildLifecycleWork({ ...i, userData: encode(l) })).toThrow();
    });
    it.each(['2026-02-30T12:00:00.000Z', '2026-10-22T12:00:00Z', '2026-10-22T12:00:00.000+00:00'])('rejects invalid TIME %s', (issuedAt) => {
        const l = lease(); l.rebasePermit!.issuedAt = issuedAt;
        expect(() => parseEnrollmentUserData(encode(l))).toThrow();
    });
    it('checks skew and the zero-budget reserve boundary using an injected clock', () => {
        const permit = lease().rebasePermit!;
        expect(rebaseRemainingBudget(permit, new Date('2026-10-22T11:59:30.000Z'))).toBe(510000);
        expect(() => rebaseRemainingBudget(permit, new Date('2026-10-22T11:59:29.999Z'))).toThrow('permit_invalid');
        expect(rebaseRemainingBudget(permit, new Date('2026-10-22T12:07:59.999Z'))).toBe(1);
        expect(() => rebaseRemainingBudget(permit, new Date('2026-10-22T12:08:00.000Z'))).toThrow('enrollment_time_insufficient');
        expect(() => rebaseRemainingBudget(permit, new Date('2026-10-22T12:10:00.000Z'))).toThrow('permit_expired');
    });
    it.each(['', 'ZXppbC1ub25jZQ==', 'e30', 'e30=\n', 'e31=', 'A'.repeat(4100)])('rejects noncanonical/bad/oversized base64 #%#', (value) => {
        expect(() => parseEnrollmentUserData(value)).toThrow();
    });
    it.each(['{"v":1,"v":1}', '{"v":1,"\\u0076":1}', '{"x":1e999}', '{"x":NaN}'])('rejects strict JSON %s', (value) => {
        expect(() => parseRebaseJson(value)).toThrow();
    });
    it('rejects unknown versions and keys, modes combined and malformed URLs', () => {
        const l = lease();
        for (const raw of [{ ...l, v: 2 }, { ...l, unexpected: true }, { ...l, rebasePermit: { ...l.rebasePermit, v: 2 } },
            { ...l, rebase: { ...l.rebase, extra: true } }, { ...l, ebsRestore: parseEnrollmentUserData(fixtureRebaseIntent(true).userData!).ebsRestore },
            ...['http://os.example.com/api/compute/aws/enroll', 'https://u:p@os.example.com/api/compute/aws/enroll', 'https://os.example.com/api/compute/aws/enroll?x=1'].map(enrollUrl => ({ ...l, enrollUrl }))]) {
            expect(() => parseEnrollmentUserData(encode(raw))).toThrow();
        }
    });
    it('normalizes existing UUID inputs and validates the complete serialized lease', () => {
        const l = lease(); const { v: _v, ...input } = l;
        expect(parseEnrollmentUserData(buildEnrollmentUserData({ ...input, volumeId: l.volumeId!, computerId: l.computerId.toUpperCase() })).computerId).toBe(l.computerId);
        expect(() => buildLifecycleWork({ ...fixtureIntent('provision'), rebasePreparation: fixtureRebaseIntent().rebasePreparation })).toThrow();
        expect(() => buildLifecycleWork({ ...fixtureRebaseIntent(), rebasePreparation: undefined })).toThrow();
    });
});

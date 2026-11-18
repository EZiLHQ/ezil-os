import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { PlacementExecutor } from '@/server/lib/compute/placement';
import { nativeDeploymentSha256, nativePolicyCanonical } from './accepted-policy';
import { signNativeQualificationPlacement, type QualificationPlacementChallenge } from './qualification-placement';

const id = (digit: number) => '00000000-0000-4000-8000-00000000000' + digit;
const initial = new Date('2026-11-19T00:00:00.000Z');
const at = (seconds: number) => new Date(initial.getTime() + seconds * 1000);
const model = { hostPolicyDigest: 'sha256:' + 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64) };
const target = { computerId: id(1), ownerUserId: id(2), instanceId: 'i-0123456789abcdef0' };
const secret = 'example-qualification-edge-secret';
const challenge: QualificationPlacementChallenge = {
    v: 1, computerId: target.computerId, bootId: id(3),
    placement: { generation: '11', leaseEpoch: '29', instanceId: target.instanceId },
    profileDigest: model.hostPolicyDigest, manifestSha256: model.artifactManifestSha256,
    nonce: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    issuedAt: at(0).toISOString(), expiresAt: at(300).toISOString(),
};

function fixture({ owned = true, row = {}, reservation = false, duringRead = () => {} }: {
    owned?: boolean; row?: Record<string, unknown>; reservation?: boolean; duringRead?: () => void;
} = {}) {
    const dialect = new PgDialect();
    const queries: string[] = [];
    const db: PlacementExecutor = {
        async execute(query) {
            const { sql, params } = dialect.sqlToQuery(query);
            queries.push(sql);
            if (sql.includes('native-session:owned-now')) {
                expect(params).toEqual([target.computerId, target.ownerUserId]);
                return owned ? [{ owned: 1 }] : [];
            }
            if (sql.includes('placement:read')) {
                expect(params).toEqual([target.computerId]);
                duringRead();
                return [{
                    computer_id: target.computerId, owner_user_id: target.ownerUserId, provider: 'aws-ec2', workspace_store: 'ebs',
                    generation: '11', lease_epoch: '29', state: 'RUNNING', instance_id: target.instanceId,
                    enroll_consumed_hash: 'c'.repeat(64), fence_token: id(4), lease_until: at(180), updated_at: at(0), ...row,
                }];
            }
            if (sql.includes('placement:image-reservation')) return reservation ? [{ job_id: id(9) }] : [];
            throw new Error('unexpected SQL');
        },
    };
    return { db, queries, target, deployment: model, controlSecret: secret, now: () => at(0) };
}
const sign = (c = challenge, deps = fixture()) => signNativeQualificationPlacement(nativePolicyCanonical(c), deps);

describe('native qualification placement signer', () => {
    it('simultaneously resolves canonical ownership and placement and matches the Python wire vector', async () => {
        const parts = fixture();
        const proof = await sign(challenge, parts);
        expect(proof.receipt.expiresAt).toBe(at(180).toISOString());
        expect(proof.receipt.ownerUserId).toBe(id(2));
        expect(proof.receipt.placement.fenceToken).toBe(id(4));
        expect(nativeDeploymentSha256(nativePolicyCanonical(proof.receipt))).toBe('0b36ebbb0cdceb08f0a1dcdc299817f40a652b9d7f7741af9fc6d996bec4e7b3');
        expect(proof.signature).toBe('v1=30c732e7ae647c398480a78f5690c5ff741b5119472486c99b6e5524a2896285');
        expect(parts.queries.map(query => query.match(/\/\* (.*?) \*\//)?.[1])).toEqual([
            'native-session:owned-now', 'placement:read', 'placement:image-reservation',
        ]);
    });

    it('refuses forged placement fields, noncanonical JSON, invalid counters and noncanonical nonce', async () => {
        const parts = fixture();
        for (const invalid of [
            { ...challenge, ownerUserId: id(2) },
            { ...challenge, placement: { ...challenge.placement, fenceToken: id(4) } },
            { ...challenge, placement: { ...challenge.placement, generation: '011' } },
            { ...challenge, nonce: challenge.nonce.slice(0, -1) + '9' },
            { ...challenge, expiresAt: at(301).toISOString() },
        ]) {
            await expect(signNativeQualificationPlacement(nativePolicyCanonical(invalid), parts)).rejects.toThrow('qualification_challenge_invalid');
        }
        await expect(signNativeQualificationPlacement(JSON.stringify(challenge), parts)).rejects.toThrow('qualification_challenge_invalid');
        await expect(signNativeQualificationPlacement(nativePolicyCanonical(challenge).replace('"v":1', '"v":1,"v":1'), parts))
            .rejects.toThrow('qualification_challenge_invalid');
        expect(parts.queries).toHaveLength(0);
    });

    it('refuses stale challenges before and after reads, and clamps to the shorter challenge or lease', async () => {
        await expect(sign(challenge, { ...fixture(), now: () => at(301) })).rejects.toThrow('qualification_challenge_expired');
        await expect(sign(challenge, { ...fixture(), now: () => at(-6) })).rejects.toThrow('qualification_challenge_expired');
        let clock = at(0);
        const elapsed = fixture({ duringRead: () => { clock = at(301); } });
        await expect(sign(challenge, { ...elapsed, now: () => clock })).rejects.toThrow('qualification_challenge_expired');
        await expect(sign(challenge, fixture({ row: { lease_until: at(-1) } }))).rejects.toThrow('qualification_lease_expired');
        expect((await sign({ ...challenge, expiresAt: at(100).toISOString() })).receipt.expiresAt).toBe(at(100).toISOString());
    });

    it('refuses wrong-target and stale canonical placement evidence', async () => {
        for (const patch of [
            { computerId: id(9) },
            { profileDigest: 'sha256:' + 'd'.repeat(64) },
            { manifestSha256: 'd'.repeat(64) },
            { placement: { ...challenge.placement, instanceId: 'i-00000000' } },
        ]) {
            await expect(sign({ ...challenge, ...patch })).rejects.toThrow('qualification_target_mismatch');
        }
        for (const row of [{ lease_epoch: '28' }, { generation: '12' }, { state: 'STOPPED' }, { instance_id: 'i-00000000' },
            { fence_token: null }, { enroll_consumed_hash: null }]) {
            await expect(sign(challenge, fixture({ row }))).rejects.toThrow('qualification_placement_mismatch');
        }
        await expect(sign(challenge, fixture({ owned: false }))).rejects.toThrow('qualification_owner_mismatch');
        await expect(sign(challenge, fixture({ row: { owner_user_id: id(9) } }))).rejects.toThrow('placement_not_owned');
        await expect(sign(challenge, fixture({ reservation: true }))).rejects.toThrow('image_job_conflict');
    });
});

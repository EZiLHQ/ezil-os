/**
 * C-6 enrollment material (aws-enroll.ts): the one-time nonce and the host
 * lease user data (infra/host-agent/lib/ezil_host/lease.py). No network.
 */

import { describe, expect, it } from 'vitest';

import { readAwsEnrollUrl } from './aws-config';
import { buildEnrollmentUserData, ENROLL_NONCE_TTL_SECONDS, EnrollmentUserDataError, issueEnrollmentNonce, nonceHashOf, USER_DATA_MAX } from './aws-enroll';

const NOW = new Date('2026-10-14T06:00:00Z');
const C1 = 'C1C1C1C1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const FS = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5';
const URL_OK = 'https://app.example.test/api/compute/aws/enroll';
/** lease.py NONCE_RE */
const HOST_NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;

describe('issueEnrollmentNonce', () => {
    it('32 random bytes → a base64url nonce the host accepts; only its sha256 is meant for storage', () => {
        const n = issueEnrollmentNonce(NOW, () => Buffer.alloc(32, 0xfb));
        expect(n.nonce).toMatch(HOST_NONCE_RE);
        expect(n.nonce).toHaveLength(43);
        expect(n.nonceHash).toMatch(/^[a-f0-9]{64}$/);
        expect(n.nonceHash).toBe(nonceHashOf(n.nonce));
        expect(n.nonceHash).not.toContain(n.nonce);
    });

    it('expires exactly 10 minutes after issue (C-6: at most 10)', () => {
        expect(ENROLL_NONCE_TTL_SECONDS).toBeLessThanOrEqual(600);
        expect(issueEnrollmentNonce(NOW, () => Buffer.alloc(32, 1)).expiresAt).toEqual(new Date(NOW.getTime() + 600_000));
    });

    it.each([16, 31, 33])('a random source that returns %i bytes is refused', (n) => {
        expect(() => issueEnrollmentNonce(NOW, () => Buffer.alloc(n, 1))).toThrow('32 random bytes');
    });

    it('the default source gives different nonces', () => {
        expect(issueEnrollmentNonce(NOW).nonce).not.toBe(issueEnrollmentNonce(NOW).nonce);
    });
});

describe('buildEnrollmentUserData (the host lease JSON)', () => {
    const nonce = Buffer.alloc(32, 9).toString('base64url');
    const base = { computerId: C1, fsUuid: FS, generation: 2, leaseEpoch: 5, nonce, enrollUrl: URL_OK };
    const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;

    it('a wake (replace) carries the retained volume, the fs uuid, the epoch and provision=false', () => {
        const ud = buildEnrollmentUserData({ ...base, volumeId: 'vol-11111111111111111', provision: false });
        expect(decode(ud)).toEqual({
            v: 1, computerId: C1.toLowerCase(), volumeId: 'vol-11111111111111111', fsUuid: FS, generation: 2, leaseEpoch: 5, nonce, provision: false, enrollUrl: URL_OK,
        });
        // Valid base64 for the intent's userData pattern.
        expect(ud).toMatch(/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    });

    it('a provision has no volume yet: volumeId absent, provision=true', () => {
        const lease = decode(buildEnrollmentUserData({ ...base, generation: 1, leaseEpoch: 1, volumeId: null, provision: true }));
        expect(lease).not.toHaveProperty('volumeId');
        expect(lease.provision).toBe(true);
    });

    it.each([
        ['provision with a volume', { volumeId: 'vol-11111111111111111', provision: true }, 'volumeId'],
        ['wake without a volume', { volumeId: null, provision: false }, 'volumeId'],
        ['a nonce the host would refuse', { volumeId: null, provision: true, nonce: 'short' }, 'nonce'],
        ['epoch 0', { volumeId: null, provision: true, leaseEpoch: 0 }, 'leaseEpoch'],
        ['generation 0', { volumeId: null, provision: true, generation: 0 }, 'generation'],
    ] as const)('%s is refused', (_n, over, reason) => {
        expect(() => buildEnrollmentUserData({ ...base, ...over })).toThrow(new EnrollmentUserDataError(reason));
    });

    it('reference restore fits comfortably with the longest enrollment nonce and restore token', () => {
        const restore = { kind: 'cf-snapshot' as const, migrationId: FS, generation: FS,
            fetchBase: `https://app.example.test/api/compute/restore/${C1.toLowerCase()}`,
            identityToken: '_'.repeat(43), system: true };
        const encoded = buildEnrollmentUserData({ ...base, nonce: '_'.repeat(128), volumeId: null, provision: true, restore });
        expect(encoded.length).toBeLessThan(USER_DATA_MAX / 2);
        expect(decode(encoded).restore).toEqual(restore);
    });

    it('stays inside the intent userData limit (4096 base64 chars); an oversized URL is refused', () => {
        expect(buildEnrollmentUserData({ ...base, volumeId: 'vol-11111111111111111', provision: false }).length).toBeLessThan(USER_DATA_MAX);
        const long = `https://${'a'.repeat(3100)}.example.test/api/compute/aws/enroll`;
        expect(() => buildEnrollmentUserData({ ...base, enrollUrl: long, volumeId: null, provision: true })).toThrow(new EnrollmentUserDataError('too_large'));
    });
});

describe('readAwsEnrollUrl', () => {
    it.each([
        [URL_OK, URL_OK],
        ['https://app.example.test:443/api/compute/aws/enroll', URL_OK],
        ['  ' + URL_OK + '  ', URL_OK],
    ])('%s → %s', (raw, want) => expect(readAwsEnrollUrl({ EZIL_AWS_ENROLL_URL: raw })).toBe(want));

    it.each([
        undefined,
        '',
        'http://app.example.test/api/compute/aws/enroll',
        'https://app.example.test/api/compute/aws/enroll?x=1',
        'https://app.example.test/api/compute/aws/enroll#f',
        'https://u:p@app.example.test/api/compute/aws/enroll',
        'https://app.example.test:8443/api/compute/aws/enroll',
        'https://app.example.test/api/compute/aws/enroll/',
        'https://127.0.0.1/api/compute/aws/enroll',
        'not a url',
    ])('%s → null (fail closed)', (raw) => expect(readAwsEnrollUrl({ EZIL_AWS_ENROLL_URL: raw })).toBeNull());
});

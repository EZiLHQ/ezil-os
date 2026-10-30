import { afterEach, describe, expect, it, vi } from 'vitest';

import { AwsClientError, toAwsClientError } from './aws-errors';
import { instanceMetadataCredentials } from './aws-instance-credentials';

const NOW = new Date('2026-10-20T10:00:00Z');
const EXPIRATION = new Date(NOW.getTime() + 3600_000);
const IMDS = 'http://169.254.169.254/latest';
const PATH = '/meta-data/iam/security-credentials/';
const DOCUMENT = {
    Code: 'Success', AccessKeyId: 'INSTANCE_KEY', SecretAccessKey: 'INSTANCE_SECRET', Token: 'INSTANCE_SESSION', Expiration: EXPIRATION.toISOString(),
};

function mockMetadata(document: unknown = DOCUMENT) {
    const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response('metadata-token'))
        .mockResolvedValueOnce(new Response('host-role\n'))
        .mockResolvedValueOnce(new Response(JSON.stringify(document)));
    vi.stubGlobal('fetch', fetch);
    return fetch;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('explicit EC2 IMDSv2 credentials', () => {
    it('fetches a token first and authenticates EVERY metadata GET with a two-second timeout', async () => {
        const fetch = mockMetadata();
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        const creds = await instanceMetadataCredentials({ now: () => NOW })();
        expect(creds).toEqual({ accessKeyId: DOCUMENT.AccessKeyId, secretAccessKey: DOCUMENT.SecretAccessKey, sessionToken: DOCUMENT.Token, expiration: EXPIRATION });
        expect(fetch.mock.calls).toEqual([
            [`${IMDS}/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: expect.any(AbortSignal), redirect: 'error' }],
            [`${IMDS}${PATH}`, { method: 'GET', headers: { 'X-aws-ec2-metadata-token': 'metadata-token' }, signal: expect.any(AbortSignal), redirect: 'error' }],
            [`${IMDS}${PATH}host-role`, { method: 'GET', headers: { 'X-aws-ec2-metadata-token': 'metadata-token' }, signal: expect.any(AbortSignal), redirect: 'error' }],
        ]);
        expect(timeout.mock.calls).toEqual([[2000], [2000], [2000]]);
    });

    it.each([EXPIRATION.getTime() - 300_000, EXPIRATION.getTime()])('refreshes at the margin or after expiry (%s), coalescing concurrent callers', async (refreshTime) => {
        let now = NOW;
        const fetch = mockMetadata();
        const provider = instanceMetadataCredentials({ now: () => now });
        const [first, concurrent] = await Promise.all([provider(), provider()]);
        expect(concurrent).toBe(first);
        now = new Date(EXPIRATION.getTime() - 300_001);
        expect(await provider()).toBe(first);
        expect(fetch).toHaveBeenCalledTimes(3);
        fetch.mockResolvedValueOnce(new Response('new-metadata-token'))
            .mockResolvedValueOnce(new Response('host-role'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...DOCUMENT, AccessKeyId: 'NEW_KEY', Expiration: new Date(EXPIRATION.getTime() + 3600_000).toISOString() })));
        now = new Date(refreshTime);
        const [fresh, shared] = await Promise.all([provider(), provider()]);
        expect(fresh.accessKeyId).toBe('NEW_KEY');
        expect(shared).toBe(fresh);
        expect(fetch).toHaveBeenCalledTimes(6);
        expect(fetch.mock.calls[4]![1]!.headers).toEqual({ 'X-aws-ec2-metadata-token': 'new-metadata-token' });
    });

    it.each([0, 1, 2])('fails closed on HTTP failure at step %i without an IMDSv1 retry', async (step) => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        for (let i = 0; i < step; i++) fetch.mockResolvedValueOnce(new Response(i === 0 ? 'metadata-token' : 'host-role'));
        fetch.mockResolvedValueOnce(new Response('secret response body', { status: 403 }));
        vi.stubGlobal('fetch', fetch);
        const error = await instanceMetadataCredentials({ now: () => NOW })().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AwsClientError);
        expect(error).toMatchObject({ code: 'credentials_unavailable', retryable: true, definite: true });
        expect(toAwsClientError(error)).toBe(error);
        expect(String(error)).not.toContain('secret response body');
        expect(fetch).toHaveBeenCalledTimes(step + 1);
    });

    it('unreachable IMDS is typed, sanitized, and can be retried without cached rejection', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('INSTANCE_SECRET'));
        vi.stubGlobal('fetch', fetch);
        const provider = instanceMetadataCredentials();
        await expect(provider()).rejects.toMatchObject({ code: 'credentials_unavailable', message: 'credentials_unavailable:InstanceMetadataUnavailable' });
        await expect(provider()).rejects.toBeInstanceOf(AwsClientError);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each(['', '  '])('refuses an empty token before making ANY metadata GET', async (token) => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(token));
        vi.stubGlobal('fetch', fetch);
        await expect(instanceMetadataCredentials()()).rejects.toMatchObject({ code: 'credentials_unavailable' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each(['', 'role-a\nrole-b', '../other'])('refuses an invalid role name %j', async (role) => {
        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('token')).mockResolvedValueOnce(new Response(role));
        vi.stubGlobal('fetch', fetch);
        await expect(instanceMetadataCredentials()()).rejects.toMatchObject({ code: 'credentials_unavailable' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([
        null, {}, { ...DOCUMENT, Token: '' }, { ...DOCUMENT, AccessKeyId: 123 }, { ...DOCUMENT, SecretAccessKey: null },
        { ...DOCUMENT, Code: 'Failed' }, { ...DOCUMENT, Expiration: 'invalid' }, { ...DOCUMENT, Expiration: NOW.toISOString() },
    ])('rejects incomplete or expired metadata credentials (%j)', async (document) => {
        mockMetadata(document);
        await expect(instanceMetadataCredentials({ now: () => NOW })()).rejects.toMatchObject({ code: 'credentials_unavailable' });
    });

    it('aborts a stalled response body after two seconds', async () => {
        vi.useFakeTimers();
        vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), ms);
            return controller.signal;
        });
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => ({
            ok: true,
            text: () => new Promise<string>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
        } as Response));
        vi.stubGlobal('fetch', fetch);
        const result = instanceMetadataCredentials()();
        const rejection = expect(result).rejects.toMatchObject({ code: 'credentials_unavailable' });
        await vi.advanceTimersByTimeAsync(2000);
        await rejection;
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not return stale credentials when refresh fails', async () => {
        let now = NOW;
        const fetch = mockMetadata();
        const provider = instanceMetadataCredentials({ now: () => now });
        await provider();
        now = EXPIRATION;
        fetch.mockRejectedValue(new Error('offline'));
        await expect(provider()).rejects.toMatchObject({ code: 'credentials_unavailable' });
    });
});

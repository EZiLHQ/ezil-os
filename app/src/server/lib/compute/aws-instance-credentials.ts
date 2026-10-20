import { AwsClientError } from './aws-errors';
import type { AwsCredentials } from './aws-clients';

const IMDS = 'http://169.254.169.254/latest';
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Explicit IMDSv2 only: no SDK credential chain, environment keys, files, or IMDSv1 fallback. */
export function instanceMetadataCredentials(opts: { now?: () => Date } = {}): () => Promise<AwsCredentials> {
    const now = opts.now ?? (() => new Date());
    let cached: AwsCredentials | null = null;
    let pending: Promise<AwsCredentials> | null = null;
    const read = async (path: string, method: string, headers: Record<string, string>): Promise<string> => {
        const response = await fetch(`${IMDS}${path}`, {
            method, headers, signal: AbortSignal.timeout(2000), redirect: 'error',
        });
        if (!response.ok) throw new Error('ImdsRequestFailed');
        return response.text();
    };
    const refresh = async (): Promise<AwsCredentials> => {
        try {
            const token = (await read('/api/token', 'PUT', { 'X-aws-ec2-metadata-token-ttl-seconds': '300' })).trim();
            if (!token) throw new Error('ImdsTokenMissing');
            const headers = { 'X-aws-ec2-metadata-token': token };
            const path = '/meta-data/iam/security-credentials/';
            const role = (await read(path, 'GET', headers)).trim();
            if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(role)) throw new Error('ImdsRoleInvalid');
            const c: unknown = JSON.parse(await read(`${path}${encodeURIComponent(role)}`, 'GET', headers));
            if (!c || typeof c !== 'object') throw new Error('ImdsCredentialsIncomplete');
            const fields = c as Record<string, unknown>;
            const { AccessKeyId, SecretAccessKey, Token, Expiration, Code } = fields;
            if (Code !== 'Success' || typeof AccessKeyId !== 'string' || !AccessKeyId.trim()
                || typeof SecretAccessKey !== 'string' || !SecretAccessKey.trim()
                || typeof Token !== 'string' || !Token.trim() || typeof Expiration !== 'string') {
                throw new Error('ImdsCredentialsIncomplete');
            }
            const expiration = new Date(Expiration);
            if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= now().getTime()) throw new Error('ImdsCredentialsExpired');
            return { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: Token, expiration };
        } catch {
            // Neither metadata response bodies nor underlying errors may expose credentials.
            throw new AwsClientError('credentials_unavailable', true, 'InstanceMetadataUnavailable');
        }
    };
    return async () => {
        if (cached && cached.expiration.getTime() - REFRESH_MARGIN_MS > now().getTime()) return cached;
        pending ??= refresh().finally(() => { pending = null; });
        cached = await pending;
        return cached;
    };
}

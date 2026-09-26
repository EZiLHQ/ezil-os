import { S3Client, GetObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { instanceCredentials, type MetadataRequest } from './aws-host-identity.js';
import type { Delivery, Provisioning } from './configuration-delivery-contract.js';

/** Exported for SDK wire tests; the CLI always uses real instance metadata and
 * fixed regional AWS endpoints. No credential values enter SSM input/output. */
export async function fetchConfiguration(value: Pick<Delivery, 'digest' | 'object'>, host: Provisioning, signal: AbortSignal,
    options: { requestHandler?: S3ClientConfig['requestHandler']; metadataRequest?: MetadataRequest } = {}) {
    const credentials = await instanceCredentials({ accountId: host.accountId, region: host.region,
        instanceId: host.scope.providerInstanceId }, signal, options.metadataRequest);
    const common = { region: host.region, credentials, maxAttempts: 1,
        requestHandler: options.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 7000, throwOnRequestTimeout: true } };
    const s3 = new S3Client({ ...common, endpoint: 'https://s3.us-east-1.amazonaws.com', forcePathStyle: true, followRegionRedirects: false });
    const ecr = new ECRClient({ ...common, endpoint: 'https://api.ecr.us-east-1.amazonaws.com' });
    try {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const object = await s3.send(new GetObjectCommand({ Bucket: host.bucket, Key: value.object.key,
            VersionId: value.object.versionId, ExpectedBucketOwner: host.accountId, ChecksumMode: 'ENABLED' }), { abortSignal: bounded });
        const body = object.Body;
        if (!body || !('destroy' in body)) {
            if (body && 'cancel' in body) await body.cancel();
            throw new Error('configuration_download_invalid');
        }
        const abort = () => body.destroy(new Error('configuration_download_cancelled'));
        bounded.addEventListener('abort', abort, { once: true });
        let bytes: Buffer;
        try {
            if (bounded.aborted || object.VersionId !== value.object.versionId || object.ContentLength !== value.object.bytes
                || object.ContentType !== 'application/json' || object.ServerSideEncryption !== 'aws:kms'
                || object.SSEKMSKeyId !== host.kmsKeyArn || object.ChecksumSHA256 !== Buffer.from(value.digest, 'hex').toString('base64')) {
                throw new Error('configuration_download_invalid');
            }
            let length = 0; const chunks: Buffer[] = [];
            for await (const chunk of body) {
                const part = Buffer.from(chunk); length += part.length;
                if (length > value.object.bytes) throw new Error('configuration_download_invalid');
                chunks.push(part);
            }
            bytes = Buffer.concat(chunks);
        } finally { bounded.removeEventListener('abort', abort); body.destroy(); }
        return { bytes, async registryCredentials() {
            const registry = `${host.accountId}.dkr.ecr.us-east-1.amazonaws.com`;
            const result = await ecr.send(new GetAuthorizationTokenCommand({ registryIds: [host.accountId] }), {
                abortSignal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            });
            if (result.authorizationData?.length !== 1) throw new Error('registry_credentials_invalid');
            const entry = result.authorizationData[0]!;
            if (entry.proxyEndpoint !== `https://${registry}` || !entry.expiresAt || entry.expiresAt.getTime() <= Date.now() + 930000
                || !entry.authorizationToken || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.authorizationToken)
                || entry.authorizationToken.length > 24000) throw new Error('registry_credentials_invalid');
            const decoded = Buffer.from(entry.authorizationToken, 'base64');
            try {
                if (decoded.toString('base64') !== entry.authorizationToken || !decoded.subarray(0, 4).equals(Buffer.from('AWS:'))) {
                    throw new Error('registry_credentials_invalid');
                }
                const token = decoded.subarray(4).toString();
                if (!/^[\x21-\x7e]{1,16384}$/.test(token)) throw new Error('registry_credentials_invalid');
                return Buffer.from(JSON.stringify([{ registry, token }]));
            } finally { decoded.fill(0); }
        }, destroy() { s3.destroy(); ecr.destroy(); } };
    } catch { s3.destroy(); ecr.destroy(); throw new Error('configuration_download_unavailable'); }
}

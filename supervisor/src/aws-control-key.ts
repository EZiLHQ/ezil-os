import { GetSecretValueCommand, SecretsManagerClient, type SecretsManagerClientConfig } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { instanceCredentials, type MetadataRequest } from './aws-host-identity.js';
import { canonicalJson } from './control-protocol.js';
import { ProvisioningSchema, type Provisioning } from './configuration-delivery-contract.js';
import { controlSecretIdentity, type ControlBootstrapAuthorization } from './control-bootstrap-contract.js';

const bindingSchema = z.object({ schemaVersion: z.literal(1), scope: ProvisioningSchema.innerType().shape.scope,
    origin: z.string(), keyHex: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export interface ControlKeyTransportOptions {
    /** Wire-test seams only; never CLI arguments, environment or SSM data. */
    metadataRequest?: MetadataRequest; requestHandler?: SecretsManagerClientConfig['requestHandler'];
}
/** Read the exact approved AWSCURRENT version using this EC2 instance's IMDSv2
 * identity. No default credential chain, endpoint override, retry or fallback. */
export async function fetchControlKey(host: Provisioning, authority: ControlBootstrapAuthorization,
    signal: AbortSignal, options: ControlKeyTransportOptions = {}): Promise<Buffer> {
    let client: SecretsManagerClient | undefined;
    try {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        const credentials = await instanceCredentials({ accountId: host.accountId, region: host.region,
            instanceId: host.scope.providerInstanceId }, bounded, options.metadataRequest);
        client = new SecretsManagerClient({ region: host.region, credentials, maxAttempts: 1,
            endpoint: 'https://secretsmanager.us-east-1.amazonaws.com',
            requestHandler: options.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 7000, throwOnRequestTimeout: true } });
        const { name, origin } = controlSecretIdentity(host, authority);
        const value = await client.send(new GetSecretValueCommand({ SecretId: name,
            VersionId: authority.secretVersionId, VersionStage: 'AWSCURRENT' }), { abortSignal: bounded });
        const prefix = `arn:aws:secretsmanager:${host.region}:${host.accountId}:secret:${name}-`;
        if (bounded.aborted || value.Name !== name || value.VersionId !== authority.secretVersionId
            || !value.ARN?.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(value.ARN.slice(prefix.length))
            || !value.VersionStages?.includes('AWSCURRENT') || value.SecretBinary !== undefined || !value.SecretString
            || Buffer.byteLength(value.SecretString) > 4096) throw new Error();
        const parsed = bindingSchema.safeParse(JSON.parse(value.SecretString));
        if (!parsed.success || canonicalJson(parsed.data.scope) !== canonicalJson(host.scope) || parsed.data.origin !== origin) throw new Error();
        // SDK JSON strings cannot be zeroed. Never log them or retain the client
        // response; callers wipe the returned raw bytes after use.
        return Buffer.from(parsed.data.keyHex, 'hex');
    } catch { throw new Error('control_key_unavailable'); }
    finally { client?.destroy(); }
}

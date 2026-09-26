import { randomBytes } from 'node:crypto';
import { SecretsManagerClient, DescribeSecretCommand, GetSecretValueCommand, CreateSecretCommand,
    type SecretsManagerClientConfig, type DescribeSecretCommandOutput } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { canonicalConfiguration } from './computer-configuration';
import { ComputerControlKeyPolicySchema, ComputerControlKeyWorkSchema, ComputerControlScopeSchema,
    computerControlKeyIdentity, controlKeyArnMatches, type ComputerControlKeys,
    type ComputerControlKeyPolicy, type ComputerControlKeyWork } from './computer-control-key';

export interface AwsComputerControlKeyOptions {
    policy: ComputerControlKeyPolicy;
    /** Required scoped federation; never fall back to environment/profile/IMDS. */
    credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
    /** SDK wire fixture only, not deployment configuration. */
    requestHandler?: SecretsManagerClientConfig['requestHandler'];
}
export class ComputerControlKeyError extends Error {
    constructor(readonly code: 'control_key_invalid' | 'control_key_unavailable' | 'control_key_conflict') { super(code); }
}
const fail = (code: ComputerControlKeyError['code']): never => { throw new ComputerControlKeyError(code); };
const valueSchema = z.object({ schemaVersion: z.literal(1), scope: ComputerControlScopeSchema,
    origin: z.string(), keyHex: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** One-time creation followed by independent metadata/value verification.
 * The trusted issuer must persist a creation attempt before selecting create.
 * Existing, ambiguous or revoked references are never overwritten or rotated.
 * Only references leave this module; no key values reach DB/logs/workflows. */
export function createAwsComputerControlKeys(options: AwsComputerControlKeyOptions): ComputerControlKeys & { destroy(): void } {
    const checked = ComputerControlKeyPolicySchema.safeParse(options.policy);
    if (!checked.success || typeof options.credentials !== 'function') return fail('control_key_invalid');
    const policy = Object.freeze(checked.data);
    const client = new SecretsManagerClient({ region: policy.region, endpoint: 'https://secretsmanager.us-east-1.amazonaws.com',
        maxAttempts: 1, requestHandler: options.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 7000, throwOnRequestTimeout: true },
        credentials: async () => {
            const c = await options.credentials();
            if (!c || !/^ASIA[A-Z0-9]{16}$/.test(c.accessKeyId) || !c.secretAccessKey || !c.sessionToken
                || !(c.expiration instanceof Date) || !(c.expiration.getTime() > Date.now() + 30000)) return fail('control_key_invalid');
            return c;
        } });
    const tags = (w: ComputerControlKeyWork) => ({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': policy.namespace,
        'ezil:computer-id': w.scope.computerId, 'ezil:generation': String(w.scope.computerGeneration), 'ezil:fence-token': w.scope.fenceToken });
    function metadata(w: ComputerControlKeyWork, d: DescribeSecretCommandOutput) {
        const expected = tags(w), actual = new Map(d.Tags?.map(t => [t.Key, t.Value]));
        const { name } = computerControlKeyIdentity(policy, w);
        if (d.Name !== name || !d.ARN || !controlKeyArnMatches(policy, w, d.ARN) || d.KmsKeyId !== policy.kmsKeyArn
            || d.DeletedDate || d.RotationEnabled || d.RotationLambdaARN || d.OwningService
            || (d.PrimaryRegion && d.PrimaryRegion !== policy.region) || d.ReplicationStatus?.length
            || actual.size !== (d.Tags?.length ?? 0) || Object.entries(expected).some(([key, value]) => actual.get(key) !== value)
            || canonicalConfiguration(d.VersionIdsToStages) !== canonicalConfiguration({ [w.versionId]: ['AWSCURRENT'] })) {
            return fail('control_key_conflict');
        }
        return d.ARN;
    }
    async function run(w: ComputerControlKeyWork, mode: 'create' | 'observe', signal: AbortSignal) {
        const identity = computerControlKeyIdentity(policy, w);
        let d: DescribeSecretCommandOutput | undefined;
        try { d = await client.send(new DescribeSecretCommand({ SecretId: w.secretArn ?? identity.name }), { abortSignal: signal }); }
        catch (e) { if (!(e instanceof Error && e.name === 'ResourceNotFoundException')) throw e; }
        if (!d) {
            if (mode === 'observe') return { state: 'missing' as const };
            if (w.secretArn !== null || Date.now() - Date.parse(w.attemptedAt) > 30000 || signal.aborted) return fail('control_key_invalid');
            const key = randomBytes(32);
            try {
                // SDK JSON strings cannot be zeroed. Never log a request or
                // response; wipe the source bytes and retain no returned key.
                const result = await client.send(new CreateSecretCommand({ Name: identity.name, ClientRequestToken: w.versionId,
                    KmsKeyId: policy.kmsKeyArn, SecretString: JSON.stringify({ schemaVersion: 1, scope: w.scope,
                        origin: identity.origin, keyHex: key.toString('hex') }),
                    Tags: Object.entries(tags(w)).map(([Key, Value]) => ({ Key, Value })),
                }), { abortSignal: signal });
                if (result.Name !== identity.name || result.VersionId !== w.versionId || !result.ARN || !controlKeyArnMatches(policy, w, result.ARN)) {
                    return fail('control_key_conflict');
                }
            } catch (e) { if (!(e instanceof Error && e.name === 'ResourceExistsException')) throw e; }
            finally { key.fill(0); }
            // Creation ACK is not confirmation. A lost response remains an
            // observation-only retry; this function sends CreateSecret once.
            d = await client.send(new DescribeSecretCommand({ SecretId: identity.name }), { abortSignal: signal });
        }
        const arn = metadata(w, d);
        const value = await client.send(new GetSecretValueCommand({ SecretId: arn, VersionId: w.versionId, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
        if (value.ARN !== arn || value.Name !== identity.name || value.VersionId !== w.versionId || value.SecretBinary !== undefined
            || canonicalConfiguration(value.VersionStages) !== canonicalConfiguration(['AWSCURRENT'])
            || !value.SecretString || Buffer.byteLength(value.SecretString) > 4096) return fail('control_key_conflict');
        let parsed: ReturnType<typeof valueSchema.safeParse>;
        try { parsed = valueSchema.safeParse(JSON.parse(value.SecretString)); } catch { return fail('control_key_conflict'); }
        if (!parsed.success || canonicalConfiguration(parsed.data.scope) !== canonicalConfiguration(w.scope)
            || parsed.data.origin !== identity.origin) return fail('control_key_conflict');
        if (signal.aborted) return fail('control_key_unavailable');
        return { state: 'confirmed' as const, versionId: w.versionId, secretArn: arn };
    }
    const transport: ComputerControlKeys & { destroy(): void } = { policy, destroy: () => client.destroy(), prepare: async (input, mode, outer) => {
        const parsed = ComputerControlKeyWorkSchema.safeParse(input);
        if (!parsed.success || !['create', 'observe'].includes(mode) || Date.parse(parsed.data.attemptedAt) > Date.now() + 5000
            || (parsed.data.secretArn !== null && !controlKeyArnMatches(policy, parsed.data, parsed.data.secretArn))) return fail('control_key_invalid');
        if (outer.aborted) return fail('control_key_unavailable');
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
            const interrupted = new Promise<never>((_resolve, reject) => {
                cancel = () => { reject(new ComputerControlKeyError('control_key_unavailable')); controller.abort(); };
                if (outer.aborted) cancel(); else outer.addEventListener('abort', cancel, { once: true });
                timer = setTimeout(cancel, 12000);
            });
            return await Promise.race([interrupted, run(parsed.data, mode, controller.signal)]);
        } catch (e) { if (e instanceof ComputerControlKeyError) throw e; return fail('control_key_unavailable'); }
        finally { clearTimeout(timer); outer.removeEventListener('abort', cancel); }
    } };
    return Object.freeze(transport);
}

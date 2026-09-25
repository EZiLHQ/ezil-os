import { createHash, createHmac } from 'node:crypto';
import { SFNClient, paginateGetExecutionHistory } from '@aws-sdk/client-sfn';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { awsDependencies } from './aws.js';
import { canonical, equal } from './contract.js';
import { CANCELLATION_PATH, CancellationScopeSchema, cancellationAuthorityFor,
    type Cancellation, type CancellationScope, type CancellationSettings } from './cancellation-contract.js';
import type { RecoveryDependencies } from './recovery-aws.js';

export interface CancellationDependencies extends RecoveryDependencies {
    cancellationAuthority(c: Cancellation, digest: string): Promise<CancellationScope | null>;
}
/** The Lambda reads only. State-machine tasks own every destructive operation. */
export function cancellationDependencies(settings: CancellationSettings, test?: Parameters<typeof awsDependencies>[1]): CancellationDependencies {
    const options = { region: 'us-east-1', maxAttempts: 1, ...(test ? { credentials: test.credentials } : {}),
        requestHandler: test?.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } };
    const sfn = new SFNClient({ ...options, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const secrets = new SecretsManagerClient({ ...options, endpoint: 'https://secretsmanager.us-east-1.amazonaws.com' });
    const reads = awsDependencies(settings.lifecycle, test);
    return { execution: reads.execution, instances: reads.instances, volumes: reads.volumes, now: Date.now,
        history: async arn => {
            const events = []; let pages = 0, lastToken: string | undefined;
            for await (const page of paginateGetExecutionHistory({ client: sfn, pageSize: 1000, stopOnSameToken: true },
                { executionArn: arn, reverseOrder: false, includeExecutionData: false }, { abortSignal: AbortSignal.timeout(10000) })) {
                events.push(...page.events ?? []); pages++; lastToken = page.nextToken;
                if (events.length > 4000 || (pages >= 4 && lastToken)) throw new Error('cancellation_history_incomplete');
            }
            if (lastToken) throw new Error('cancellation_history_incomplete');
            return events;
        },
        cancellationAuthority: async (c, digest) => {
            const value = await secrets.send(new GetSecretValueCommand({ SecretId: settings.cancellationSecretArn, VersionStage: 'AWSCURRENT' }),
                { abortSignal: AbortSignal.timeout(6000) });
            if (value.ARN !== settings.cancellationSecretArn || value.SecretBinary || !value.SecretString
                || !/^[a-f0-9]{64}$/.test(value.SecretString) || !value.VersionStages?.includes('AWSCURRENT')) throw new Error('cancellation_authority_unavailable');
            return requestCancellationAuthority(settings.lifecycle.authorityOrigin, value.SecretString, c, digest, test?.fetcher);
        } };
}
export async function requestCancellationAuthority(origin: string, key: string, c: Cancellation, digest: string, fetcher = fetch): Promise<CancellationScope | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('cancellation_authority_unavailable');
    const request = cancellationAuthorityFor(c, digest), body = canonical(request), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(['ezil-cancellation-authority-v1', 'POST', CANCELLATION_PATH,
        timestamp, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    const response = await fetcher(origin + CANCELLATION_PATH, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000), body,
        headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature } });
    const reader = response.body?.getReader(); if (!reader) throw new Error('cancellation_authority_unavailable');
    try {
        let bytes = 0; const chunks: Uint8Array[] = [];
        for (;;) { const p = await reader.read(); if (p.done) break; bytes += p.value.length; if (bytes > 65536) throw new Error(); chunks.push(p.value); }
        if (response.status === 403) return null;
        if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
        const { authorized, schemaVersion, computerId, cancellationId, digest: responseDigest, ...scope } = JSON.parse(Buffer.concat(chunks).toString());
        if (!equal({ authorized, schemaVersion, computerId, cancellationId, digest: responseDigest }, { authorized: true, ...request })) throw new Error();
        return CancellationScopeSchema.parse(scope);
    } catch { throw new Error('cancellation_authority_unavailable'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

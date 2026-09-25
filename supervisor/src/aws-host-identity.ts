import { Agent, request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { z } from 'zod';

export type MetadataRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export interface InstanceIdentity { accountId: string; region: 'us-east-1'; instanceId: string }

/** Host-only IMDSv2. A fixed literal endpoint and dedicated agent deliberately
 * ignore proxy, profile and metadata-endpoint environment overrides. There is
 * no v1 fallback, retry, stale-credential extension or stored-key alternative. */
export async function instanceCredentials(expected: InstanceIdentity, signal: AbortSignal,
    send: MetadataRequest = request) {
    const agent = new Agent({ keepAlive: false });
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const call = (path: string, method: 'PUT' | 'GET', headers: Record<string, string>) => new Promise<Buffer>((resolve, reject) => {
        if (bounded.aborted) { reject(new Error('host_identity_unavailable')); return; }
        const req = send({ hostname: '169.254.169.254', port: 80, path, method, headers, agent, signal: bounded }, response => {
            if (response.statusCode !== 200) { response.destroy(); reject(new Error('host_identity_unavailable')); return; }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 32768) { req.destroy(); reject(new Error('host_identity_unavailable')); }
                else chunks.push(chunk);
            });
            response.once('error', () => reject(new Error('host_identity_unavailable')));
            response.once('end', () => resolve(Buffer.concat(chunks)));
        });
        req.once('error', () => reject(new Error('host_identity_unavailable')));
        req.end();
    });
    try {
        const token = (await call('/latest/api/token', 'PUT', { 'x-aws-ec2-metadata-token-ttl-seconds': '60' })).toString();
        if (!/^[\x21-\x7e]{1,2048}$/.test(token)) throw new Error();
        const headers = { 'x-aws-ec2-metadata-token': token };
        const identity = JSON.parse((await call('/latest/dynamic/instance-identity/document', 'GET', headers)).toString());
        if (identity.accountId !== expected.accountId || identity.region !== expected.region || identity.instanceId !== expected.instanceId) {
            throw new Error();
        }
        const role = (await call('/latest/meta-data/iam/security-credentials/', 'GET', headers)).toString().trim();
        if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(role)) throw new Error();
        const parsed = z.object({ Code: z.literal('Success'), AccessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/),
            SecretAccessKey: z.string().min(1).max(256), Token: z.string().min(1).max(16384),
            Expiration: z.string().datetime() }).safeParse(JSON.parse((await call(`/latest/meta-data/iam/security-credentials/${role}`, 'GET', headers)).toString()));
        if (!parsed.success) throw new Error();
        const expiration = new Date(parsed.data.Expiration);
        if (expiration.getTime() <= Date.now() + 30000) throw new Error();
        return { accessKeyId: parsed.data.AccessKeyId, secretAccessKey: parsed.data.SecretAccessKey,
            sessionToken: parsed.data.Token, expiration };
    } catch { throw new Error('host_identity_unavailable'); }
    finally { agent.destroy(); }
}

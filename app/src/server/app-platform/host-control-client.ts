import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RuntimePlan } from './runtime-plan';

export interface HostScope {
    computerId: string; computerGeneration: number; providerInstanceId: string;
    fenceToken: string; dataVolumeId: string;
}
export interface HostCommand {
    schemaVersion: 1; requestId: string; computerId: string; computerGeneration: number;
    installationId: string; operation: 'reconcile'; generation: number;
    desired: 'running' | 'stopped'; plan: RuntimePlan;
}
const observationSchema = z.object({
    computerId: z.string().uuid(), computerGeneration: z.number().int().positive(), installationId: z.string().uuid(),
    generation: z.number().int().positive(), desired: z.enum(['running', 'stopped']),
    intentDigest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['unknown', 'running', 'stopped', 'failed']),
    settled: z.boolean(), runtimeDeadlineMs: z.number().int().positive().nullable(),
}).strict();
export type HostObservation = z.infer<typeof observationSchema>;
export interface HostControlClient {
    readonly scope: HostScope;
    observe(installationId: string): Promise<HostObservation | null>;
    reconcile(command: HostCommand): Promise<void>;
}
export class HostControlError extends Error {
    constructor(readonly code: 'host_unavailable' | 'host_response_invalid' | 'host_rejected') { super(code); }
}
export function hostIntentDigest(command: HostCommand): string {
    const canonical = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
        if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
        return JSON.stringify(value);
    };
    const intent = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'requestId'));
    return createHash('sha256').update(canonical(intent)).digest('hex');
}

/** Only trusted computer provisioning resolves this target and generation key.
 * Never accept an origin/key from an app, browser, manifest or outbox payload.
 * HTTPS syntax is not SSRF protection; DNS/routing policy belongs to provisioning.
 * Loopback HTTP exists solely for private, explicit local protocol acceptance. */
export function createHostControlClient(target: HostScope & { origin: string; secret: Uint8Array },
    options: { privateValidation?: boolean } = {}): HostControlClient {
    let url: URL;
    try { url = new URL(target.origin); } catch { throw new Error('invalid_host_control_configuration'); }
    if (url.origin !== target.origin || url.username || url.password || target.secret.length !== 32
        || (url.protocol !== 'https:' && !(options.privateValidation && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
        throw new Error('invalid_host_control_configuration');
    }
    const origin = target.origin;
    const scope: HostScope = Object.freeze({ computerId: target.computerId, computerGeneration: target.computerGeneration,
        providerInstanceId: target.providerInstanceId, fenceToken: target.fenceToken, dataVolumeId: target.dataVolumeId });
    const secret = Buffer.from(target.secret);
    const send = async (value: object): Promise<{ status: number; body: unknown }> => {
        const body = Buffer.from(JSON.stringify(value));
        if (body.length > 65_536) throw new HostControlError('host_rejected');
        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(24).toString('base64url');
        const digest = createHash('sha256').update(body).digest('hex');
        const signature = createHmac('sha256', secret)
            .update(`ezil-supervisor-v1\nPOST\n/v1/control\n${timestamp}\n${nonce}\n${digest}`).digest('hex');
        try {
            const response = await fetch(`${origin}/v1/control`, {
                method: 'POST', body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
                headers: { 'content-type': 'application/json', 'x-ezil-timestamp': timestamp,
                    'x-ezil-nonce': nonce, 'x-ezil-signature': signature },
            });
            if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
                await response.body?.cancel(); throw new HostControlError('host_response_invalid');
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = []; let size = 0;
            try {
                for (;;) {
                    const item = await reader.read(); if (item.done) break;
                    size += item.value.byteLength;
                    if (size > 16_384) { await reader.cancel(); throw new HostControlError('host_response_invalid'); }
                    chunks.push(item.value);
                }
            } finally { reader.releaseLock(); }
            let parsed: unknown;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw new HostControlError('host_response_invalid'); }
            return { status: response.status, body: parsed };
        } catch (error) {
            if (error instanceof HostControlError) throw error;
            // Response bodies, URLs, raw transport errors and signing keys never
            // enter database error codes or user-visible errors.
            throw new HostControlError('host_unavailable');
        }
    };
    return {
        scope,
        async observe(installationId) {
            const result = await send({ schemaVersion: 1, requestId: randomUUID(), computerId: scope.computerId,
                computerGeneration: scope.computerGeneration, installationId, operation: 'observe' });
            if (result.status === 404 && z.object({ code: z.literal('installation_not_found') }).strict().safeParse(result.body).success) return null;
            if (result.status !== 200) throw new HostControlError('host_rejected');
            const parsed = observationSchema.safeParse(result.body);
            if (!parsed.success || parsed.data.computerId !== scope.computerId
                || parsed.data.computerGeneration !== scope.computerGeneration || parsed.data.installationId !== installationId) {
                throw new HostControlError('host_response_invalid');
            }
            return parsed.data;
        },
        async reconcile(command) {
            if (command.computerId !== scope.computerId || command.computerGeneration !== scope.computerGeneration) {
                throw new HostControlError('host_rejected');
            }
            const result = await send(command);
            const receipt = z.object({ requestId: z.literal(command.requestId), installationId: z.literal(command.installationId),
                generation: z.literal(command.generation), state: z.literal('queued'), reused: z.boolean() }).strict();
            if (result.status !== 202) throw new HostControlError('host_rejected');
            if (!receipt.safeParse(result.body).success) throw new HostControlError('host_response_invalid');
        },
    };
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyControlRequest } from './control-auth.js';
import { ControlCommandSchema, intentDigest, type ExecutionPlan } from './control-protocol.js';
import { ControlStore, type StoredIntent } from './control-store.js';

export interface ComputerDriver {
    /** Must observe only; never pull, create, start, or refresh a runtime lease. */
    observe(installationId: string): Promise<{ state: StoredIntent['observed'] }>;
    /** Check isCurrent before starting and after asynchronous operations. A
     * superseded generation must be stopped before reporting completion. */
    reconcile(intent: StoredIntent, isCurrent: () => boolean): Promise<StoredIntent['observed']>;
}
export type ControlServiceOptions = {
    computerId: string;
    computerGeneration: number;
    secret: Uint8Array;
    store: ControlStore;
    driver: ComputerDriver;
    approvePlan(plan: ExecutionPlan, installationId: string): boolean;
    isAvailable?: () => boolean;
    onFailure?: (code: string) => void;
    onSettled?: (result: { installationId: string; generation: number; state: StoredIntent['observed'] }) => void | Promise<void>;
    configuration?: () => { revision: number; digest: string };
};
const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify(value));
};
async function readBody(request: IncomingMessage): Promise<Buffer> {
    if (request.headers['content-encoding']) throw new Error('unsupported_encoding');
    const length = request.headers['content-length'];
    if (length && (!/^[0-9]+$/.test(length) || Number(length) > 65_536)) throw new Error('body_too_large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const data of request) {
        const chunk = Buffer.from(data as Uint8Array);
        size += chunk.length;
        if (size > 65_536) throw new Error('body_too_large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** Listen only on host loopback behind the separately authenticated tunnel.
 * This service never accepts browser credentials or publisher manifests. It
 * persists commands and returns a receipt before long container operations. */
export function createControlService(options: ControlServiceOptions) {
    if (options.secret.length < 32) throw new Error('control_secret_too_short');
    const available = () => { try { return options.isAvailable?.() ?? true; } catch { return false; } };
    const reportFailure = (code: string) => {
        try { void Promise.resolve(options.onFailure?.(code)).catch(() => undefined); }
        catch { /* Logging cannot break reconciliation or expose the error. */ }
    };
    const scheduled = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const schedule = (installationId: string) => {
        scheduled.add(installationId);
        if (running.has(installationId)) return;
        const task = Promise.resolve().then(async () => {
            while (scheduled.delete(installationId)) {
                const intent = options.store.get(installationId);
                if (!intent) continue;
                const isCurrent = () => available()
                    && options.store.get(installationId)?.generation === intent.generation;
                const observe = (state: StoredIntent['observed']) => {
                    const recorded = options.store.observe(installationId, intent.generation, state);
                    if (recorded) {
                        try { void Promise.resolve(options.onSettled?.({ installationId, generation: intent.generation, state }))
                            .catch(() => reportFailure('control_observation_callback_failed')); }
                        catch { reportFailure('control_observation_callback_failed'); }
                    }
                    return recorded;
                };
                try {
                    const observed = await options.driver.reconcile(intent, isCurrent);
                    if (!observe(observed)) scheduled.add(installationId);
                } catch {
                    // Docker errors may contain paths/configuration. Log only
                    // this fixed code; leave the durable command retryable.
                    observe('failed');
                    reportFailure('computer_reconcile_failed');
                }
            }
        }).catch(() => reportFailure('control_store_unavailable')).finally(() => {
            running.delete(installationId);
            if (scheduled.has(installationId)) schedule(installationId);
        });
        running.set(installationId, task);
    };
    const handler = async (request: IncomingMessage, response: ServerResponse) => {
        if (!available()) return json(response, 503, { code: 'computer_control_unavailable' });
        if (request.method !== 'POST' || request.url !== '/v1/control') return json(response, 404, { code: 'not_found' });
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
            return json(response, 415, { code: 'json_required' });
        }
        try {
            const body = await readBody(request);
            if (!available()) return json(response, 503, { code: 'computer_control_unavailable' });
            const auth = verifyControlRequest({ method: request.method, path: request.url, body, headers: request.headers },
                options.secret, options.store);
            if (!auth.ok) return json(response, 401, { code: auth.code });
            let value: unknown;
            try { value = JSON.parse(body.toString('utf8')); }
            catch { return json(response, 400, { code: 'invalid_json' }); }
            const parsed = ControlCommandSchema.safeParse(value);
            if (!parsed.success) return json(response, 400, { code: 'invalid_command',
                issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) });
            const command = parsed.data;
            if (command.computerId !== options.computerId || command.computerGeneration !== options.computerGeneration) {
                return json(response, 403, { code: 'computer_scope_mismatch' });
            }
            if (command.operation === 'configuration') {
                const current = options.configuration?.();
                if (!current || !Number.isSafeInteger(current.revision) || current.revision < 1 || !/^[a-f0-9]{64}$/.test(current.digest)) {
                    return json(response, 503, { code: 'computer_configuration_unavailable' });
                }
                return json(response, 200, { computerId: options.computerId, computerGeneration: options.computerGeneration,
                    configurationRevision: current.revision, configurationDigest: current.digest });
            }
            if (command.operation === 'observe') {
                const before = options.store.get(command.installationId);
                if (!before) return json(response, 404, { code: 'installation_not_found' });
                const observed = await options.driver.observe(command.installationId);
                if (!['unknown', 'running', 'stopped', 'failed'].includes(observed.state)) throw new Error('invalid_observation');
                if (!available()) return json(response, 503, { code: 'computer_control_unavailable' });
                const current = options.store.get(command.installationId);
                if (!current || current.generation !== before.generation) {
                    return json(response, 409, { code: 'observation_superseded' });
                }
                // Health can become visible before reconciliation commits. Do
                // not acknowledge completion while a driver operation is still
                // pending, or label an old read with a newer command revision.
                return json(response, 200, { computerId: options.computerId,
                    computerGeneration: options.computerGeneration, installationId: command.installationId,
                    generation: current.generation, desired: current.desired, intentDigest: intentDigest(current.command),
                    state: observed.state, settled: !running.has(command.installationId)
                        && current.observed !== 'unknown' && current.observed === observed.state,
                    runtimeDeadlineMs: options.store.runtimeDeadline(current.command) });
            }
            // Revocation must not prevent stopping an already owned runtime.
            if (command.desired === 'running' && !options.approvePlan(command.plan, command.installationId)) {
                return json(response, 403, { code: 'execution_plan_not_approved' });
            }
            const accepted = options.store.accept(command);
            json(response, 202, { requestId: command.requestId, installationId: command.installationId,
                generation: command.generation, state: 'queued', reused: accepted === 'reused' });
            schedule(command.installationId);
        } catch (error) {
            if (response.writableEnded || response.destroyed) return;
            const code = error instanceof Error ? error.message : '';
            if (['request_id_conflict', 'generation_conflict', 'stale_generation'].includes(code)) {
                return json(response, 409, { code });
            }
            if (['body_too_large', 'unsupported_encoding'].includes(code)) return json(response, 413, { code });
            return json(response, 503, { code: 'computer_control_unavailable' });
        }
    };
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 },
        (request, response) => { void handler(request, response); });
    server.maxRequestsPerSocket = 100;
    return { server, drain: async () => {
        while (running.size) await Promise.all([...running.values()]);
    } };
}

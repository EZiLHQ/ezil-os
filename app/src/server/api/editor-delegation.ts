import type { DelegationPolicy } from './delegation-core';
import type { DelegationRequest } from './delegation-auth';

const READ = 'ezil:sessions:read';
const WRITE = 'ezil:sessions:write';
const editorReads = new Set([
    'agentSession.list', 'agentSession.get', 'agentSession.events', 'agentSession.operation',
    'agentSession.models', 'agentSession.settings', 'agentSession.control',
]);
const editorWrites = new Set([
    'agentSession.send', 'agentSession.cancel', 'agentSession.create', 'agentSession.configure', 'computer.start',
]);

export const EDITOR_DELEGATION_POLICY = {
    scopeByProcedure: new Map([
        ...[...editorReads].map(procedure => [procedure, READ] as const),
        ...[...editorWrites].map(procedure => [procedure, procedure === 'computer.start' ? 'ezil:computers:start' : WRITE] as const),
    ]),
} satisfies DelegationPolicy;
export const MAX_EDITOR_DELEGATION_BYTES = 64 * 1024;

export function editorDelegationEnabled(env: NodeJS.ProcessEnv): boolean {
    return env.EZIL_DELEGATED_EDITOR_SESSIONS === 'enabled'
        && env.EZIL_EDITOR_BRIDGE === 'enabled'
        && env.EZIL_DELEGATION_ISSUER === 'https://connect-staging.ezil.work'
        && env.EZIL_DELEGATION_AUDIENCE === 'https://os-staging.ezil.work';
}

export interface TrpcDelegationRequest extends DelegationRequest {
    editorBody?: Uint8Array;
}

export function trpcMutationPath(url: URL, procedures: ReadonlySet<string>): boolean {
    return url.pathname.startsWith('/api/trpc/') && procedures.has(url.pathname.slice('/api/trpc/'.length))
        && url.searchParams.size === 0;
}

export function editorMutationPath(url: URL): boolean {
    return trpcMutationPath(url, editorWrites);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bindTrpcDelegation(request: TrpcDelegationRequest, reads: ReadonlySet<string>, writes: ReadonlySet<string>) {
    const url = URL.parse(request.url);
    if (!url?.pathname.startsWith('/api/trpc/')) return;
    const procedure = url.pathname.slice('/api/trpc/'.length);
    if (request.method === 'GET' && !request.hasBody && reads.has(procedure)) {
        const keys = [...url.searchParams.keys()];
        if (keys.length > 1 || keys.some(key => key !== 'input')) return;
        return { procedure, serializedInput: url.searchParams.get('input') ?? '', type: 'query' as const };
    }
    if (request.method !== 'POST' || !trpcMutationPath(url, writes)
        || !request.editorBody?.byteLength || request.editorBody.byteLength > MAX_EDITOR_DELEGATION_BYTES) return;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    try {
        const serializedInput = text.decode(request.editorBody);
        const envelope: unknown = JSON.parse(serializedInput);
        if (!isRecord(envelope) || Object.keys(envelope).length !== 1
            || !Object.hasOwn(envelope, 'json') || !isRecord(envelope.json)) return;
        return { procedure, serializedInput, type: 'mutation' as const };
    } catch {
        return;
    }
}

export function editorDelegationBinding(request: TrpcDelegationRequest) {
    return bindTrpcDelegation(request, editorReads, editorWrites);
}

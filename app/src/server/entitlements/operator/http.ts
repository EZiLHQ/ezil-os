/**
 * The ezil-os entitlement source routes, `{OS origin}/api/gateway/admin-entitlements/v1/{catalog|assignments|commands}`
 * (Plans brief ACK, contract 58d78935). Only the Gateway's dedicated sender key opens them: every request, GET
 * included, is verified (EZIL-AE-V1) before anything is read. HTTP edges, as Universe's: no sender key configured →
 * 503; bad kid/skew/signature → 401 unauthorized_sender; a commands body that is not JSON or has no valid command_id
 * → 400; every command answer (applied, replayed, refused) → 200. A non-matching assignments pair → 404.
 */
import { commandIdOf, FORMATS } from './contract';
import { catalog, handleCommand, readAssignments, type OperatorEntitlementDeps } from './service';
import { readSenderKeys, SENDER_KEYS_ENV, verifySender } from './signature';
import { SourceUnavailable } from './store';

export type Endpoint = 'catalog' | 'assignments' | 'commands';
const MAX_BODY_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export async function handleAdminEntitlementRequest(request: Request, endpoint: Endpoint, options: {
    env?: Record<string, string | undefined>; deps: () => Promise<OperatorEntitlementDeps>; nowSeconds?: () => number;
}): Promise<Response> {
    const keys = readSenderKeys((options.env ?? process.env)[SENDER_KEYS_ENV]);
    if (!keys) return json(503, { error: 'source_unconfigured' });
    const method = request.method.toUpperCase();
    const expected = endpoint === 'commands' ? 'POST' : 'GET';
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_BODY_BYTES) return json(413, { error: 'body_too_large' });
    const url = new URL(request.url);
    const kid = verifySender(keys, { method, pathWithQuery: url.pathname + url.search, headers: request.headers, body },
        (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))());
    if (!kid) return json(401, { error: 'unauthorized_sender' });
    if (method !== expected) return json(405, { error: 'method_not_allowed' });
    try {
        if (endpoint === 'catalog') return json(200, catalog());
        if (endpoint === 'assignments') {
            const osUserId = url.searchParams.get('os_user_id') ?? '', account = url.searchParams.get('account_public_id') ?? '';
            if (!UUID.test(osUserId) || !UUID.test(account) || [...url.searchParams.keys()].some(k => k !== 'os_user_id' && k !== 'account_public_id')) {
                return json(400, { error: 'invalid_query' });
            }
            const view = await readAssignments(await options.deps(), { kind: 'individual', os_user_id: osUserId, account_public_id: account });
            return view ? json(200, view) : json(404, { error: 'identity_not_found' });
        }
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return json(400, { error: 'invalid_json' }); }
        const commandId = commandIdOf(parsed);
        if (!commandId) return json(400, { error: 'invalid_command_id' });
        return json(200, await handleCommand(await options.deps(), parsed as Record<string, unknown>, commandId, kid));
    } catch (error) {
        if (error instanceof SourceUnavailable) return json(503, { error: 'source_unavailable' });
        console.error('[admin-entitlements] failed', { endpoint, error: error instanceof Error ? error.name : 'unknown' });
        return json(500, { error: 'internal_error', format: FORMATS.result });
    }
}

/** Production deps: the app database and billing store, loaded on use. */
export async function productionDeps(): Promise<OperatorEntitlementDeps> {
    const [{ db }, { getBillingDeps }, { createOperatorEntitlementDeps }] = await Promise.all([
        import('@/server/db'), import('@/server/billing/deps'), import('./store')]);
    return createOperatorEntitlementDeps(db, getBillingDeps());
}

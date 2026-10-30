export class PoolError extends Error {
    constructor(readonly status: number, code: string) { super(code); }
}
/** Admission could not fit this open only because of capacity; the open may reserve demand
 * (capacity-demand.ts) instead of failing. Same code/status as the original guard. */
export class PoolCapacityPressure extends PoolError {
    constructor(readonly target: { computerId: string; region: string; zoneId: string; instanceType: string }) { super(503, 'open_pool_capacity'); }
}
/** Named guards are individually removed by the offline mutation check. */
export function poolGuard(name: string, allowed: unknown, status = 403): asserts allowed {
    if (!allowed) throw new PoolError(status, name);
}
export const POOL_NO_STORE = { 'cache-control': 'no-store', vary: 'X-Ezil-Identity-Document, X-Ezil-Identity-Signature' };
export function poolErrorResponse(error: unknown): Response {
    const status = error instanceof PoolError ? error.status : 503;
    return status === 204 ? new Response(null, { status, headers: POOL_NO_STORE })
        : Response.json({ error: status === 503 ? 'pool_unavailable' : 'pool_refused', ...(status === 503 ? { retryable: true } : {}) }, { status, headers: POOL_NO_STORE });
}

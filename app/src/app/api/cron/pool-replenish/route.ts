import { db } from '@/server/db';
import { createPoolReplenishDeps } from '@/server/lib/compute/aws-pool-runtime';
import { runPoolReplenish } from '@/server/lib/compute/aws-pool-replenish';
import { poolErrorResponse } from '@/server/lib/compute/aws-pool-errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 50;
export async function GET(req: Request): Promise<Response> {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return new Response(null, { status: 404 });
    try {
        const start = performance.now(), before = new Date();
        const deps = createPoolReplenishDeps(db, process.env);
        const records = await runPoolReplenish(deps);
        // Recovery is scheduled-only, after normal reconciliation and dispatch. Leave headroom below the route deadline.
        const budget = Math.min(8_000, (maxDuration - 15) * 1000 - (performance.now() - start));
        if (budget > 0) await deps.store.reconcileSettledFailures?.(before, budget);
        return Response.json({ passes: records ?? [] }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return poolErrorResponse(error); }
}

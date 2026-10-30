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
        const records = await runPoolReplenish(createPoolReplenishDeps(db, process.env));
        return Response.json({ passes: records ?? [] }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return poolErrorResponse(error); }
}

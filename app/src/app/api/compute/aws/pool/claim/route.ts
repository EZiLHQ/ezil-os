import { db } from '@/server/db';
import { handlePoolClaim } from '@/server/lib/compute/aws-pool-claim';
import { createPoolHostDeps } from '@/server/lib/compute/aws-pool-runtime';
import { poolErrorResponse } from '@/server/lib/compute/aws-pool-errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Allows the five-second adoption hold; Request.signal cancels it on disconnect.
export const maxDuration = 20;
export async function GET(req: Request): Promise<Response> {
    try { return await handlePoolClaim(req, createPoolHostDeps(db, process.env)); }
    catch (error) { return poolErrorResponse(error); }
}

import { db } from '@/server/db';
import { handlePoolHost } from '@/server/lib/compute/aws-pool-host';
import { createPoolHostDeps } from '@/server/lib/compute/aws-pool-runtime';
import { poolErrorResponse } from '@/server/lib/compute/aws-pool-errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
    try { return await handlePoolHost(req, createPoolHostDeps(db, process.env), 'enroll'); }
    catch (error) { return poolErrorResponse(error); }
}

import { db } from '@/server/db';
import { createPoolHostDeps } from '@/server/lib/compute/aws-pool-runtime';
import { handlePoolSessionReady } from '@/server/lib/compute/aws-pool-session';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request): Promise<Response> {
    return handlePoolSessionReady(req, createPoolHostDeps(db, process.env));
}

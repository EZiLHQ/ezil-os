import { proxyMigrationRestore } from '@/server/lib/compute/provider-migrate-restore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ computerId: string; kind: string; index: string }> }): Promise<Response> {
    return proxyMigrationRestore(req, await context.params);
}

import { getBillingDeps } from '@/server/billing/deps';
import usageIngest from '@/server/billing/http/usage-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    return usageIngest(request, getBillingDeps());
}

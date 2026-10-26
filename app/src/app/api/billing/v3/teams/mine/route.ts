import { teamBillingUnavailable } from '@/server/billing/v3/rest-entitlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
    return teamBillingUnavailable(request);
}

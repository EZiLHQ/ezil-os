import { teamBillingUnavailable } from '@/server/billing/v3/rest-entitlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    // No team, recipient, project, or idempotency input is read or acted upon.
    return teamBillingUnavailable(request);
}

import { getBillingDeps } from '@/server/billing/deps';
import stripeWebhook from '@/server/billing/http/stripe-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    return stripeWebhook(request, getBillingDeps());
}

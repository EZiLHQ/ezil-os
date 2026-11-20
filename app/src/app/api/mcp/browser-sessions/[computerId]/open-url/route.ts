import { productionBrowserCanary } from '@/server/browser-open/canary';
import { browserUnavailable, handleBrowserOpen } from '@/server/browser-open/receiver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function POST(request: Request): Promise<Response> {
    const canary = productionBrowserCanary();
    return canary ? handleBrowserOpen(request, canary) : browserUnavailable();
}

import { productionBrowserCanary } from '@/server/browser-open/canary';
import { handleBrowserCapabilities, unavailableBrowserCapability } from '@/server/browser-open/receiver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    const canary = productionBrowserCanary();
    return canary ? handleBrowserCapabilities(request, canary) : unavailableBrowserCapability();
}

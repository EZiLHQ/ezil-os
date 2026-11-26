import { handleBrowserObserve } from '@/server/browser-observe/receiver';
import { browserObserveRelay } from '@/server/browser-observe/relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Delegated Browser observation and page control. Off (404) unless this deployment's switches and pairing say so. */
export async function POST(request: Request): Promise<Response> {
    return handleBrowserObserve(request, browserObserveRelay());
}

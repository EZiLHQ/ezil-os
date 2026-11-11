import type { SessionDb } from '@/server/agent-session/store';
import { handleEditorSync } from '@/server/agent-session/sync-route';
import { db } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Worker-forwarded editor sync; see `server/agent-session/sync-route.ts`. */
export async function POST(request: Request): Promise<Response> {
    return handleEditorSync(request, {
        db: db as unknown as SessionDb,
        secret: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET,
        enabled: process.env.EZIL_EDITOR_BRIDGE,
        controls: process.env.EZIL_EDITOR_BRIDGE_CONTROLS,
        effort: process.env.EZIL_EDITOR_BRIDGE_EFFORT,
        now: () => Date.now(),
    });
}

import { db } from '@/server/db';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { handleNativeAuthRest, productionNativeAuthRestDeps } from '@/server/native-auth/rest';

/**
 * Prepare a native authorization intent (MCP, signed delegation). Off unless EZIL_NATIVE_AUTH_INTENTS=1 and
 * EZIL_NATIVE_SESSIONS=1; blocked until the shared delegation verifier is wired. Never dispatches.
 */
export async function POST(req: Request): Promise<Response> {
    return handleNativeAuthRest(req, productionNativeAuthRestDeps(db as unknown as NativeAuthorityDb));
}

import { db } from '@/server/db';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { handleNativeAuthRest, productionNativeAuthRestDeps } from '@/server/native-auth/rest';

/** The exact intent and its exact operation, current-owner projection. Read only: no proof, exchange, claim or dispatch. */
export async function GET(req: Request): Promise<Response> {
    return handleNativeAuthRest(req, productionNativeAuthRestDeps(db as unknown as NativeAuthorityDb));
}

import { db } from '@/server/db';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { handleNativeAuthRest, productionNativeAuthRestDeps } from '@/server/native-auth/rest';

/** Broker status of the caller's native session (`statusKind: 'broker_status'`). Read only. */
export async function GET(req: Request): Promise<Response> {
    return handleNativeAuthRest(req, productionNativeAuthRestDeps(db as unknown as NativeAuthorityDb));
}

import { db } from '@/server/db';
import { handleNativeSessionCreate, productionNativeSessionDeps, type NativeSessionSupabase } from '@/server/native-session/http';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { createClient } from '@/utils/supabase/server';

export const maxDuration = 30;

/** Create a native session operation. Off unless EZIL_NATIVE_SESSIONS=1; host transport is unavailable in this build. */
export async function POST(req: Request): Promise<Response> {
    return handleNativeSessionCreate(req, productionNativeSessionDeps(db as unknown as NativeAuthorityDb,
        createClient as unknown as () => Promise<NativeSessionSupabase>));
}

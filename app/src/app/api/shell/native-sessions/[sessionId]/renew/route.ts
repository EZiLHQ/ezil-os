import { db } from '@/server/db';
import { handleNativeSessionRenew, productionNativeSessionDeps, type NativeSessionSupabase } from '@/server/native-session/http';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { createClient } from '@/utils/supabase/server';

export const maxDuration = 30;

/** Explicit renewal: a new operation after a fresh authority check. Off unless EZIL_NATIVE_SESSIONS=1. */
export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    const { sessionId } = await params;
    return handleNativeSessionRenew(req, sessionId, productionNativeSessionDeps(db as unknown as NativeAuthorityDb,
        createClient as unknown as () => Promise<NativeSessionSupabase>));
}

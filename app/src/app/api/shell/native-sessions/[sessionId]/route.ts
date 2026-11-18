import { db } from '@/server/db';
import { handleNativeSessionStatus, productionNativeSessionDeps, type NativeSessionSupabase } from '@/server/native-session/http';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import { createClient } from '@/utils/supabase/server';

/** Persisted current-owner status. Read only: no refresh, exchange, host lookup, wake or write. */
export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }): Promise<Response> {
    const { sessionId } = await params;
    return handleNativeSessionStatus(req, sessionId, productionNativeSessionDeps(db as unknown as NativeAuthorityDb,
        createClient as unknown as () => Promise<NativeSessionSupabase>));
}

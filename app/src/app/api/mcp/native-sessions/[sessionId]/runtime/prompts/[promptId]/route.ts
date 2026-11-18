import { db } from '@/server/db';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import type { SqlExecutor } from '@/server/api/delegation-store';
import { handleNativeRuntimeRest, productionNativeRuntimeDeps } from '@/server/native-session/runtime-http';
import type { NativeSessionSupabase } from '@/server/native-session/http';
import { createClient } from '@/utils/supabase/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; promptId: string }> }): Promise<Response> {
    const p = await params;
    return handleNativeRuntimeRest(req, 'promptGet', p.sessionId, p.promptId, productionNativeRuntimeDeps(
        db as unknown as NativeAuthorityDb & SqlExecutor, createClient as unknown as () => Promise<NativeSessionSupabase>));
}

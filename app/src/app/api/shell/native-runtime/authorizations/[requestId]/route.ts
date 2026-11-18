import { db } from '@/server/db';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import type { SqlExecutor } from '@/server/api/delegation-store';
import { handleRuntimeConsentGet, handleRuntimeConsentPost, productionNativeRuntimeDeps } from '@/server/native-session/runtime-http';
import type { NativeSessionSupabase } from '@/server/native-session/http';
import { createClient } from '@/utils/supabase/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const deps = () => productionNativeRuntimeDeps(db as unknown as NativeAuthorityDb & SqlExecutor, createClient as unknown as () => Promise<NativeSessionSupabase>);
export async function GET(req: Request, { params }: { params: Promise<{ requestId: string }> }): Promise<Response> {
    return handleRuntimeConsentGet(req, (await params).requestId, deps());
}
export async function POST(req: Request, { params }: { params: Promise<{ requestId: string }> }): Promise<Response> {
    return handleRuntimeConsentPost(req, (await params).requestId, deps());
}

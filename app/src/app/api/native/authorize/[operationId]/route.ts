import { db } from '@/server/db';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import type { NativeSessionSupabase } from '@/server/native-session/http';
import { handleNativeConsentDecision, productionNativeConsentDeps } from '@/server/native-auth/consent';
import { createClient } from '@/utils/supabase/server';

export const maxDuration = 30;

/** The owner's explicit allow/deny for one native authorization intent. Normal cookie, exact origin only. */
export async function POST(req: Request, { params }: { params: Promise<{ operationId: string }> }): Promise<Response> {
    const { operationId } = await params;
    return handleNativeConsentDecision(req, operationId, productionNativeConsentDeps(db as unknown as NativeAuthorityDb,
        createClient as unknown as () => Promise<NativeSessionSupabase>));
}

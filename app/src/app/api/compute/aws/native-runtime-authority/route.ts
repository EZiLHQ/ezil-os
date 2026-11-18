import { createProductionNativeAiPort } from '@/server/native-session/production';
import { db } from '@/server/db';
import { readPlacement } from '@/server/lib/compute/placement';
import { handleNativeRuntimeAuthorityQuery } from '@/server/native-session/runtime-authority-query';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Real0031 history/live/revocation adapter requires accepted deployment pins; fixtures are not customer qualification. */
export async function POST(request: Request): Promise<Response> {
    return handleNativeRuntimeAuthorityQuery(request, { db, env: process.env, aiPort: createProductionNativeAiPort(db, process.env), now: () => new Date(),
        placement: async computerId => (await readPlacement(db, computerId)).record });
}

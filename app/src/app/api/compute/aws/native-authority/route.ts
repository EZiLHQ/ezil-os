import { createProductionNativeConsentReader } from '@/server/native-session/production';
import { db } from '@/server/db';
import { readPlacement } from '@/server/lib/compute/placement';
import { handleNativeAuthorityQuery } from '@/server/native-session/native-authority-reader';

/**
 * `POST /api/compute/aws/native-authority`: an AWS host's pure, signed native permission query (logic and wire
 * format in `native-authority-reader.ts`; the sender is infra/host-agent `native_authority.py`). Called by the
 * host, never by a browser: no session, cookie or Bearer. The epoch's control key is the authority.
 *
 * The real approved consent reader is composed only under a validated trusted deployment descriptor.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
    return handleNativeAuthorityQuery(req, {
        env: process.env, db, now: () => new Date(), consent: createProductionNativeConsentReader(process.env),
        placement: async computerId => (await readPlacement(db, computerId)).record,
    });
}

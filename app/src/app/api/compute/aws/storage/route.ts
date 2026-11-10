import { db } from '@/server/db';
import { handleHostStorageSample } from '@/server/billing/http/host-storage';
import { createBillingStore } from '@/server/billing/store';
import { readPlacement } from '@/server/lib/compute/placement';

/**
 * `POST /api/compute/aws/storage`: an AWS host agent's storage sample (logic and wire format in
 * `host-storage.ts`; the sender is infra/host-agent `storage.py`). Called by the host, never by a
 * browser: no session, no cookie. The epoch's control key is the authority.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
    const store = createBillingStore(db);
    return handleHostStorageSample(req, {
        env: process.env, now: () => new Date(),
        placement: async computerId => (await readPlacement(db, computerId)).record,
        record: (userId, sample) => store.insertStorageSampleOnce!(userId, sample),
    });
}

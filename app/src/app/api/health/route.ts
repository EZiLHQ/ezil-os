import { NextResponse } from 'next/server';
import { deploySha } from '@/server/feedback/deploy-sha';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Liveness plus the deployed commit, so a staging URL can be tied to an exact SHA (the same source feedback reports are stamped with). */
export function GET(): NextResponse {
    return NextResponse.json(
        { ok: true, sha: deploySha() },
        { headers: { 'cache-control': 'no-store' } },
    );
}

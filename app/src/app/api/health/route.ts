import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHA = /^[0-9a-f]{7,40}$/;

/** Liveness plus the deployed commit, so a staging URL can be tied to an exact SHA. */
export function GET(): NextResponse {
    const raw = process.env.EZIL_GIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '';
    return NextResponse.json(
        { ok: true, sha: SHA.test(raw) ? raw : null },
        { headers: { 'cache-control': 'no-store' } },
    );
}

import { NextResponse } from 'next/server';
import { deploySha } from '@/server/feedback/deploy-sha';
import { REBASE_RELEASE_REGISTRY_CAPACITY } from '@/server/lib/compute/aws-rebase-release';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness plus the deployed commit, so a staging URL can be tied to an exact SHA (the same source feedback reports are stamped with).
 * `registryCapacity` is the release-registry limit this running build's parsers enforce (the same constant, not a configured value):
 * the operator's in-container probe reads it before a registry may grow past what the running app can parse.
 */
export function GET(): NextResponse {
    return NextResponse.json(
        { ok: true, sha: deploySha(), registryCapacity: REBASE_RELEASE_REGISTRY_CAPACITY },
        { headers: { 'cache-control': 'no-store' } },
    );
}

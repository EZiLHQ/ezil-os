import { env } from '@/env';
import { db } from '@/server/db';
import { authorizeCancellation } from '@/server/app-platform/cancellation-consumer';
import { createCancellationAuthorityHandler } from '@/server/app-platform/cancellation-authority-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createCancellationAuthorityHandler({
    enabled: env.EZIL_CANCELLATION_AUTHORITY_ENABLED === 'true', secret: env.EZIL_CANCELLATION_AUTHORITY_SECRET,
    authorize: input => authorizeCancellation({ database: db, enabled: env.EZIL_CANCELLATION_AUTHORITY_ENABLED === 'true',
        deployments: env.EZIL_LIFECYCLE_DEPLOYMENTS, workflows: env.EZIL_CANCELLATION_WORKFLOWS }, input),
});

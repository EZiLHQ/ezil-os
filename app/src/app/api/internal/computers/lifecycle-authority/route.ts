import { env } from '@/env';
import { db } from '@/server/db';
import { authorizeLifecycleWork, authorizeComputerRecoveryWork } from '@/server/app-platform/lifecycle-consumer';
import { createLifecycleAuthorityHandler } from '@/server/app-platform/lifecycle-authority-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createLifecycleAuthorityHandler({
    enabled: env.EZIL_LIFECYCLE_AUTHORITY_ENABLED === 'true', secret: env.EZIL_LIFECYCLE_AUTHORITY_SECRET,
    authorize: input => authorizeLifecycleWork({ database: db, enabled: env.EZIL_LIFECYCLE_AUTHORITY_ENABLED === 'true',
        osAccessMode: env.EZIL_OS_ACCESS_MODE, deployments: env.EZIL_LIFECYCLE_DEPLOYMENTS }, input),
    authorizeRecovery: input => authorizeComputerRecoveryWork({ database: db, enabled: env.EZIL_LIFECYCLE_AUTHORITY_ENABLED === 'true',
        osAccessMode: env.EZIL_OS_ACCESS_MODE, deployments: env.EZIL_LIFECYCLE_DEPLOYMENTS }, input),
});

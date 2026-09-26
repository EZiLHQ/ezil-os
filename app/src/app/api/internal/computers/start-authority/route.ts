import { env } from '@/env';
import { db } from '@/server/db';
import { authorizeComputerStart } from '@/server/app-platform/computer-start-delivery';
import { createStartAuthorityHandler } from '@/server/app-platform/computer-start-authority-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createStartAuthorityHandler({
    enabled: env.EZIL_START_AUTHORITY_ENABLED === 'true', secret: env.EZIL_START_AUTHORITY_SECRET,
    authorize: work => env.EZIL_START_CONTROL_KEY_POLICY ? authorizeComputerStart({ database: db,
        enabled: env.EZIL_START_AUTHORITY_ENABLED === 'true', osAccessMode: env.EZIL_OS_ACCESS_MODE,
        deployments: env.EZIL_LIFECYCLE_DEPLOYMENTS, keys: { policy: env.EZIL_START_CONTROL_KEY_POLICY },
    }, work) : Promise.resolve(false),
});

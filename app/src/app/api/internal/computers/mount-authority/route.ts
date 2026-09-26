import { env } from '@/env';
import { db } from '@/server/db';
import { authorizeComputerMount } from '@/server/app-platform/computer-mount-delivery';
import { createMountAuthorityHandler } from '@/server/app-platform/computer-mount-authority-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = createMountAuthorityHandler({
    enabled: env.EZIL_MOUNT_AUTHORITY_ENABLED === 'true', secret: env.EZIL_MOUNT_AUTHORITY_SECRET,
    authorize: work => authorizeComputerMount({ database: db, enabled: env.EZIL_MOUNT_AUTHORITY_ENABLED === 'true',
        osAccessMode: env.EZIL_OS_ACCESS_MODE, deployments: env.EZIL_LIFECYCLE_DEPLOYMENTS }, work),
});

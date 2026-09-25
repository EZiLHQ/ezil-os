import { env } from '@/env';
import { db } from '@/server/db';
import { authorizeConfigurationWork } from '@/server/app-platform/configuration-authority';
import { createConfigurationAuthorityHandler } from '@/server/app-platform/configuration-authority-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createConfigurationAuthorityHandler({
    enabled: env.EZIL_CONFIGURATION_AUTHORITY_ENABLED === 'true',
    secret: env.EZIL_CONFIGURATION_AUTHORITY_SECRET,
    authorize: input => authorizeConfigurationWork({ database: db,
        enabled: env.EZIL_CONFIGURATION_AUTHORITY_ENABLED === 'true', osAccessMode: env.EZIL_OS_ACCESS_MODE }, input),
});

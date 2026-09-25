import { TRPCError } from '@trpc/server';

import { env } from '@/env';

export function requireMarketplaceApi(): void {
    if (env.EZIL_APP_MARKETPLACE_API_ENABLED !== 'true') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Marketplace is not enabled' });
    }
}

export function requireSubmissionIntake(): void {
    if (env.EZIL_APP_SUBMISSION_INTAKE_ENABLED !== 'true') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Repository intake is not enabled' });
    }
}

export function requireAppInstall(): void {
    if (env.EZIL_APP_INSTALL_ENABLED !== 'true') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Application installation is not enabled' });
    }
}

export function requireAppRuntimeCommands(): void {
    if (env.EZIL_APP_RUNTIME_COMMANDS_ENABLED !== 'true') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Application runtime commands are not enabled' });
    }
}

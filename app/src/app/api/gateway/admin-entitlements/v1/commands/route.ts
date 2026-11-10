import { handleAdminEntitlementRequest, productionDeps } from '@/server/entitlements/operator/http';

/** Product entitlements v1, producer ezil-os: `POST commands`, signed by the Gateway's dedicated sender key (EZIL-AE-V1). */
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
    return handleAdminEntitlementRequest(request, 'commands', { deps: productionDeps });
}

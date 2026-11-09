import { handleAdminEntitlementRequest, productionDeps } from '@/server/entitlements/operator/http';

/** Product entitlements v1, producer ezil-os: `GET catalog`, signed by the Gateway's dedicated sender key (EZIL-AE-V1). */
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
    return handleAdminEntitlementRequest(request, 'catalog', { deps: productionDeps });
}

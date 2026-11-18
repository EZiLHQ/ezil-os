/** Only the configured deployment origin selects a native Gateway. */
export const STAGING_NATIVE_GATEWAY = 'https://ai-staging.ezil.work';
export const PRODUCTION_NATIVE_GATEWAY = 'https://ai.ezil.work';
export type NativeGatewayOrigin = typeof STAGING_NATIVE_GATEWAY | typeof PRODUCTION_NATIVE_GATEWAY;
export type NativeGatewayEnvironment = 'staging' | 'production';

const staging = Object.freeze({ gatewayOrigin: STAGING_NATIVE_GATEWAY, environment: 'staging' } as const);
const production = Object.freeze({ gatewayOrigin: PRODUCTION_NATIVE_GATEWAY, environment: 'production' } as const);

export function nativeGatewayTarget(osOrigin: unknown): Readonly<{
    gatewayOrigin: NativeGatewayOrigin;
    environment: NativeGatewayEnvironment;
}> | null {
    switch (osOrigin) {
        case 'https://os-staging.ezil.work': return staging;
        case 'https://os.ezil.work':
        case 'https://os-prod.ezil.work': return production;
        default: return null;
    }
}

export function nativeGatewayTargetForIssuer(issuer: string): ReturnType<typeof nativeGatewayTarget> {
    let url: URL;
    try { url = new URL(issuer); } catch { return null; }
    if (url.username || url.password || url.search || url.hash ||
        (issuer !== url.origin && !issuer.startsWith(url.origin + '/'))) return null;
    return nativeGatewayTarget(url.origin);
}

export function isNativeGatewayOrigin(origin: unknown): origin is NativeGatewayOrigin {
    return origin === STAGING_NATIVE_GATEWAY || origin === PRODUCTION_NATIVE_GATEWAY;
}

import { bareHttpsOrigin } from './delegation-core';

type Environment = Record<string, string | undefined>;

/** Deployment-owned pins; request headers never select the application or Worker origin. */
export function onboardingOriginsConfigured(env: Environment): boolean {
    const origin = bareHttpsOrigin(env.EZIL_OS_PUBLIC_ORIGIN);
    const issuer = bareHttpsOrigin(env.EZIL_DELEGATION_ISSUER);
    return !!origin && !!issuer && origin !== issuer && env.EZIL_DELEGATION_AUDIENCE === origin;
}

/** Set only after the matching Worker release has been qualified for bridge/control protocol 2. */
export function editorWorkerOrigin(env: Environment): string | undefined {
    const origin = bareHttpsOrigin(env.EZIL_EDITOR_WORKER_ORIGIN);
    return env.EZIL_EDITOR_WORKER_PROTOCOL === '2' && origin
        && env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.replace(/\/$/, '') === origin ? origin : undefined;
}

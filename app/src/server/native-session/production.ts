/** Server-owned production graph. Pins authorize configuration; Host readiness still proves its installed artifact. */
import { readApprovedNativeConsentBinding, readNativeConsentHistory } from '@/server/native-auth/consent-binding';
import { readNativeConsentRevocation } from '@/server/native-auth/store';
import type { NativeAuthorityDb } from './authority';
import { loadAcceptedNativeDeployment, type AcceptedNativeDeployment } from './accepted-policy';
import { createAwsHostTransport } from './aws-host-transport';
import { UNAVAILABLE_HOST_TRANSPORT, type NativeHostTransport } from './host-transport';
import { createNativeRuntimeAiPort } from './runtime-composition';
import type { NativeAiAuthorityPort } from './runtime-authority';
import type { NativeConsentReader } from './native-authority-reader';

type Env = Readonly<Record<string, string | undefined>>;
const matches = (b: { policyId: string; profileId: string }, pin: AcceptedNativeDeployment) =>
    b.policyId === pin.policyId && b.profileId === pin.profileId;
export function createProductionNativeHostTransport(env: Env, request: typeof fetch = fetch): NativeHostTransport {
    const accepted = loadAcceptedNativeDeployment(env);
    if (accepted.state !== 'ready') return UNAVAILABLE_HOST_TRANSPORT;
    return createAwsHostTransport({ env: { ...env }, fetch: request, expectedManifestSha256: accepted.deployment.artifactManifestSha256 });
}
export function createProductionNativeAiPort(db: NativeAuthorityDb, env: Env): NativeAiAuthorityPort | null {
    const accepted = loadAcceptedNativeDeployment(env);
    if (accepted.state !== 'ready') return null;
    const pin = accepted.deployment;
    return createNativeRuntimeAiPort(db, {
        history: async (_db, key) => { const h = await readNativeConsentHistory(db, key);return h && matches(h.binding, pin) ? h : null; },
        active: async (_db, key) => { const b = await readApprovedNativeConsentBinding(db, key);return b && matches(b, pin) ? b : null; },
        revocation: readNativeConsentRevocation,
    }, pin.corePolicyDigest);
}
export function createProductionNativeConsentReader(env: Env): NativeConsentReader | null {
    const accepted = loadAcceptedNativeDeployment(env);
    if (accepted.state !== 'ready') return null;
    return async (db, key) => { const b = await readApprovedNativeConsentBinding(db, key);return b && matches(b, accepted.deployment) ? b : null; };
}

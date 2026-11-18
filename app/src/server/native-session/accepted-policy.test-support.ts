/** Synthetic deployment fixtures only; no installed artifact or customer qualification. */
import { nativePolicyCanonical as canonical, nativeDeploymentSha256 as sha, NATIVE_ACCEPTED_PROFILE as profile } from './accepted-policy';
import { nativeGatewayTarget } from './native-gateway-origin';
export function acceptedDeploymentFixture(policyId = '11111111-1111-4111-8111-111111111111',
    osOrigin = 'https://os-staging.ezil.work') {
    const target = nativeGatewayTarget(osOrigin);
    if (!target) throw new Error('unsupported fixture deployment');
    const files = ['gatewayNativeSupervisor.mjs', 'gatewayNativeJournal.mjs', 'gatewayNativeContract.mjs', 'cli'].map(path =>
        ({ path, sha256: 'a'.repeat(64), size: 1, mode: path === 'cli' ? '0755' : '0644' }));
    const artifact = canonical({ v: 1, kind: 'ezil-native-runtime', cliVersion: '2.1.310', nodeAbi: '127',
        supervisorProtocol: 'ezil-native-supervisor-v1', entrypoints: { core: files[0]!.path, cli: 'cli' }, files });
    const policy = canonical({ model: profile.model, tools: profile.tools, limits: profile.limits,
        gatewayOrigin: target.gatewayOrigin, caPem: '-----BEGIN CERTIFICATE-----\nSYNTHETIC-TEST-ONLY\n-----END CERTIFICATE-----', spkiSha256: 'A'.repeat(43) + '=' });
    const descriptor = { v: 1, policyRevision: profile.policyRevision, profileId: profile.profileId, policyId, artifactManifestBytes: artifact,
        hostProfileBytes: canonical(profile), corePolicyBytes: policy };
    const raw = JSON.stringify(descriptor);
    return { descriptor, env: { EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR: raw, EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256: sha(raw),
        EZIL_NATIVE_RUNTIME_MANIFEST_SHA256: sha(artifact), EZIL_NATIVE_AUTHORIZATION_POLICY_ID: policyId,
        EZIL_NATIVE_SESSIONS_ORIGIN: osOrigin, EZIL_NATIVE_AUTHORIZATION_AUDIENCE: target.gatewayOrigin }, policy };
}

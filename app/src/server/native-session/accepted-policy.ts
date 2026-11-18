/** Trusted deployment configuration only. No caller input, observed runtime digest, or Core code imports. */
import { createHash } from 'node:crypto';

import { nativeGatewayTarget, type NativeGatewayOrigin } from './native-gateway-origin';

export const NATIVE_DEPLOYMENT_ENV = ['EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR', 'EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256',
    'EZIL_NATIVE_RUNTIME_MANIFEST_SHA256', 'EZIL_NATIVE_AUTHORIZATION_POLICY_ID'] as const;
export const NATIVE_POLICY_REVISION = 'bare-cli2.1.310-r2';
export const NATIVE_ACCEPTED_TOOLS = Object.freeze(['Bash', 'Edit', 'Read']);
const LIMITS = Object.freeze({ maxRequestsPerOperation: 256, maxRequestsPerLease: 2048, maxConcurrentRequests: 2,
    maxRequestBytes: 4194304, maxResponseBytes: 33554432, maxOutputTokens: 64000, upstreamTimeoutMs: 600000,
    maxTurnMs: 3600000, maxInstructionBytes: 16384 });
/** Public Host execution profile data; its canonical bytes must match the installed descriptor. */
export const NATIVE_ACCEPTED_PROFILE = Object.freeze({ policyRevision: NATIVE_POLICY_REVISION, profileId: 'ezil-native-claude-v1', cliVersion: '2.1.310',
    model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits', tools: NATIVE_ACCEPTED_TOOLS, limits: LIMITS, wallSeconds: 14400 });
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REL = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]{0,99}){0,15}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => plain(v)
    && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const nativeDeploymentSha256 = (bytes: string) => createHash('sha256').update(bytes, 'utf8').digest('hex');
/** Canonical JSON contract: recursively sorted object keys; arrays retain order; UTF-8, no whitespace. */
export function nativePolicyCanonical(value: unknown): string {
    const normalized = (v: unknown): unknown => Array.isArray(v) ? v.map(normalized) : plain(v)
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalized(v[k])])) : v;
    return JSON.stringify(normalized(value));
}
function canonicalObject(bytes: unknown): Record<string, unknown> | null {
    if (typeof bytes !== 'string') return null;
    try { const value: unknown = JSON.parse(bytes); return plain(value) && nativePolicyCanonical(value) === bytes ? value : null; }
    catch { return null; }
}
function validArtifact(m: Record<string, unknown>): boolean {
    if (!exact(m, ['v', 'kind', 'cliVersion', 'nodeAbi', 'supervisorProtocol', 'entrypoints', 'files']) || m.v !== 1
        || m.kind !== 'ezil-native-runtime' || m.cliVersion !== '2.1.310' || m.supervisorProtocol !== 'ezil-native-supervisor-v1'
        || typeof m.nodeAbi !== 'string' || !/^[1-9][0-9]{0,4}$/.test(m.nodeAbi)
        || !exact(m.entrypoints, ['core', 'cli']) || !Array.isArray(m.files) || m.files.length < 3 || m.files.length > 20000) return false;
    const paths = new Map<string, Record<string, unknown>>(); let total = 0;
    for (const file of m.files) {
        if (!exact(file, ['path', 'sha256', 'size', 'mode']) || typeof file.path !== 'string' || !REL.test(file.path)
            || file.path === 'manifest.json' || typeof file.sha256 !== 'string' || !HEX.test(file.sha256)
            || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > 2147483648
            || !['0644', '0755'].includes(String(file.mode))) return false;
        const lower = file.path.toLowerCase();
        if ([...paths.keys()].some(p => p === lower || p.startsWith(lower + '/') || lower.startsWith(p + '/'))) return false;
        paths.set(lower, file); total += Number(file.size);
    }
    const core = m.entrypoints.core, cli = m.entrypoints.cli;
    if (total > 2147483648 || typeof core !== 'string' || typeof cli !== 'string' || !REL.test(core) || !REL.test(cli)
        || !core.endsWith('gatewayNativeSupervisor.mjs')) return false;
    const prefix = core.slice(0, -'gatewayNativeSupervisor.mjs'.length);
    return paths.get(cli.toLowerCase())?.path === cli && paths.get(cli.toLowerCase())?.mode === '0755'
        && ['gatewayNativeSupervisor.mjs', 'gatewayNativeJournal.mjs', 'gatewayNativeContract.mjs'].every(n => paths.get((prefix + n).toLowerCase())?.path === prefix + n);
}
export interface AcceptedNativeDeployment {
    readonly policyRevision: typeof NATIVE_POLICY_REVISION; readonly profileId: 'ezil-native-claude-v1'; readonly policyId: string; readonly artifactManifestSha256: string;
    /** Core compiled-policy digest, raw64. Distinct from the Host profile digest. */
    readonly gatewayOrigin: NativeGatewayOrigin; readonly corePolicyDigest: string; readonly hostPolicyDigest: string; readonly descriptorSha256: string;
}
export type NativeDeploymentState = { state: 'off' } | { state: 'blocked'; reason: 'native_deployment_unqualified' }
    | { state: 'ready'; deployment: Readonly<AcceptedNativeDeployment> };
/** A pinned descriptor is deployment intent; the Host still independently verifies its installed tree/kernel witness. */
export function loadAcceptedNativeDeployment(env: Readonly<Record<string, string | undefined>>): NativeDeploymentState {
    if (NATIVE_DEPLOYMENT_ENV.slice(0, 3).every(k => !env[k])) return { state: 'off' };
    const refuse = (): NativeDeploymentState => ({ state: 'blocked', reason: 'native_deployment_unqualified' });
    const target = nativeGatewayTarget(env.EZIL_NATIVE_SESSIONS_ORIGIN);
    if (!target || env.EZIL_NATIVE_AUTHORIZATION_AUDIENCE !== target.gatewayOrigin) return refuse();
    const raw = env.EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR, pin = env.EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256;
    const artifactPin = env.EZIL_NATIVE_RUNTIME_MANIFEST_SHA256, policyId = env.EZIL_NATIVE_AUTHORIZATION_POLICY_ID;
    if (!raw || Buffer.byteLength(raw, 'utf8') > 1048576 || !pin || !HEX.test(pin) || nativeDeploymentSha256(raw) !== pin
        || !artifactPin || !HEX.test(artifactPin) || !policyId || !UUID.test(policyId)) return refuse();
    let descriptor: unknown; try { descriptor = JSON.parse(raw); } catch { return refuse(); }
    if (!exact(descriptor, ['v', 'policyRevision', 'profileId', 'policyId', 'artifactManifestBytes', 'hostProfileBytes', 'corePolicyBytes']) || descriptor.v !== 1
        || descriptor.policyRevision !== NATIVE_POLICY_REVISION || descriptor.profileId !== NATIVE_ACCEPTED_PROFILE.profileId || descriptor.policyId !== policyId) return refuse();
    const artifact = canonicalObject(descriptor.artifactManifestBytes), host = canonicalObject(descriptor.hostProfileBytes), policy = canonicalObject(descriptor.corePolicyBytes);
    if (!artifact || !validArtifact(artifact) || nativeDeploymentSha256(String(descriptor.artifactManifestBytes)) !== artifactPin
        || !host || nativePolicyCanonical(host) !== nativePolicyCanonical(NATIVE_ACCEPTED_PROFILE)
        || !policy || !exact(policy, ['model', 'tools', 'limits', 'gatewayOrigin', 'caPem', 'spkiSha256'])
        || policy.model !== host.model || nativePolicyCanonical(policy.tools) !== nativePolicyCanonical(NATIVE_ACCEPTED_TOOLS)
        || nativePolicyCanonical(policy.limits) !== nativePolicyCanonical(LIMITS) || policy.gatewayOrigin !== target.gatewayOrigin
        || !(typeof policy.caPem === 'string' && policy.caPem.length <= 32768 && policy.caPem.includes('-----BEGIN CERTIFICATE-----'))
        || !(typeof policy.spkiSha256 === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(policy.spkiSha256))) return refuse();
    return { state: 'ready', deployment: Object.freeze({ policyRevision: NATIVE_POLICY_REVISION, profileId: 'ezil-native-claude-v1', policyId, artifactManifestSha256: artifactPin,
        gatewayOrigin: target.gatewayOrigin, corePolicyDigest: nativeDeploymentSha256(String(descriptor.corePolicyBytes)),
        hostPolicyDigest: 'sha256:' + nativeDeploymentSha256(String(descriptor.hostProfileBytes)), descriptorSha256: pin }) };
}

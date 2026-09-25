import { getComputerManifestDigest } from './computer-app-manifest';
import { getComputerPolicyDigest, validateComputerPolicyAgainstManifest } from './approved-computer-app-policy';
import { RESERVED_COMPUTER_PORTS } from './port-leases';

export class RuntimePlanError extends Error {}
const reject = (code: string): never => { throw new RuntimePlanError(code); };

/** Controller-side DTO for the supervisor's v1 execution protocol. It contains
 * only compiled authority, never a publisher-supplied plan or host filesystem
 * root. Keep its serialized acceptance checked against the host protocol. */
export interface RuntimePlan {
    releaseId: string;
    policyDigest: string;
    image: string;
    services: {
        name: string; internalPort: number; hostPort: number;
        process: { kind: 'node'; entrypoint: string; args: string[] }
            | { kind: 'reticle-daemon-v1'; projectId: string; privateDirectory: string };
        health: { path: string; status: number }; dependsOn: string[];
    }[];
    privateDirectories: { name: string; containerPath: string }[];
    projectGrants: { projectId: string; containerPath: string; access: 'read' | 'read-write' }[];
    allowedOrigins: string[];
    resources: { cpu: number; memoryMiB: number; temporaryMiB: number; maxRuntimeSeconds: number };
}

export interface RuntimePlanRecords {
    installationId: string;
    app: { id: string; publisherId: string; slug: string };
    release: { id: string; version: string; manifest: unknown; policy: unknown;
        manifestDigest: string; policyDigest: string; imageReference: string;
        provenanceDigest: string; sourceCommitSha: string | null };
    services: { name: string; protocol: string; scope: string; internalPort: number; healthPath: string }[];
    leases: { serviceName: string; hostPort: number }[];
    grants: { folder: string; scope: string; access: string; projectId: string | null }[];
    projectId?: string;
}

/** Caller must load these records under ownership/authorization locks. This
 * pure function validates evidence and actual host compatibility, not identity.
 * Unsupported runtime features fail explicitly instead of disappearing. */
export function compileRuntimePlan(records: RuntimePlanRecords): RuntimePlan {
    const { app, release } = records;
    const contracts = validateComputerPolicyAgainstManifest(release.manifest, release.policy);
    if (!contracts.success) return reject('release_contract_invalid');
    const { manifest, policy } = contracts.data;
    if (manifest.appId !== app.id || manifest.publisherId !== app.publisherId || manifest.slug !== app.slug
        || manifest.version !== release.version || getComputerManifestDigest(manifest) !== release.manifestDigest
        || getComputerPolicyDigest(policy) !== release.policyDigest || policy.image.reference !== release.imageReference
        || policy.image.provenanceDigest !== release.provenanceDigest
        || (manifest.source.kind === 'github' && manifest.source.commitSha !== release.sourceCommitSha)) {
        return reject('release_evidence_mismatch');
    }
    // The initial real driver has one container/service and no injected config,
    // secrets, arbitrary outbound rules, or database backup/migration adapter.
    if (manifest.runtime.profile !== 'node24-computer-v1' || manifest.services.length !== 1
        || manifest.services[0]!.dependsOn.length) return reject('unsupported_service_layout');
    if (policy.image.reference.length > 500
        || !/^[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(policy.image.reference)) {
        return reject('unsupported_image_registry');
    }
    if (manifest.configuration.length || manifest.secrets.length || policy.secretBindings.length) {
        return reject('runtime_configuration_unsupported');
    }
    if (manifest.egressOrigins.length || policy.egressOrigins.length) return reject('runtime_egress_unsupported');
    if (manifest.update.strategy !== 'compatible' || policy.backup.mode === 'database-adapter') {
        return reject('runtime_state_adapter_unsupported');
    }
    const service = manifest.services[0]!;
    const storedService = records.services[0];
    const lease = records.leases[0];
    if (records.services.length !== 1 || records.leases.length !== 1 || !storedService || !lease
        || storedService.name !== service.name || storedService.internalPort !== service.internalPort
        || storedService.protocol !== service.protocol || storedService.scope !== service.scope
        || storedService.healthPath !== service.health.path || lease.serviceName !== service.name
        || !Number.isInteger(lease.hostPort) || lease.hostPort < 1024 || lease.hostPort > 65535
        || RESERVED_COMPUTER_PORTS.has(lease.hostPort)) return reject('service_lease_mismatch');
    if (service.health.path.length > 256 || !/^\/(?!\/)[a-zA-Z0-9._/-]*$/.test(service.health.path)) return reject('unsupported_health_path');
    const temporaryMiB = policy.resources.ephemeralDiskLimitMiB;
    if (temporaryMiB < 16 || temporaryMiB > 4096) return reject('unsupported_temporary_storage');
    const privateDirectories = manifest.persistence.mode === 'computer-volume'
        ? manifest.persistence.privateDirectories : [];
    const projectGrants: RuntimePlan['projectGrants'] = [];
    if (policy.mounts.sharedFolders.some(f => f.folder !== 'Projects' || f.scope !== 'selected-projects')) {
        return reject('unsupported_shared_folder');
    }
    if (records.projectId) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(records.projectId)) return reject('invalid_project');
        const grant = records.grants.find(g => g.projectId === records.projectId
            && g.folder === 'Projects' && g.scope === 'selected-projects');
        const approved = policy.mounts.sharedFolders.find(f => f.folder === 'Projects');
        const requested = manifest.persistence.mode === 'computer-volume'
            ? manifest.persistence.sharedFolders.find(f => f.folder === 'Projects') : undefined;
        if (!grant || !approved || !requested || !['read', 'read-write'].includes(grant.access)
            || (grant.access === 'read-write' && approved.access !== 'read-write')) return reject('project_not_connected');
        projectGrants.push({ projectId: records.projectId, containerPath: requested.containerPath,
            access: grant.access as 'read' | 'read-write' });
    } else if (policy.mounts.sharedFolders.length || service.scope === 'selected-project') {
        return reject('project_selection_required');
    }
    let process: RuntimePlan['services'][number]['process'];
    if (service.process.kind === 'reticle-daemon-v1') {
        if (service.internalPort !== 4400 || service.health.path !== '/status' || service.health.status !== 200
            || privateDirectories.length !== 1 || projectGrants.length !== 1
            || projectGrants[0]!.access !== 'read-write') return reject('invalid_reticle_binding');
        process = { kind: 'reticle-daemon-v1', projectId: projectGrants[0]!.projectId,
            privateDirectory: privateDirectories[0]!.name };
    } else if (service.process.kind === 'node') {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9._/-]*\.(?:js|mjs|cjs)$/.test(service.process.entrypoint)) {
            return reject('unsupported_entrypoint');
        }
        process = service.process;
    } else return reject('unsupported_process');

    const origin = new URL(policy.appOriginBase);
    origin.hostname = `i-${records.installationId}.${origin.hostname}`;
    const allowedOrigins = [...new Set([...policy.allowedOsOrigins, origin.origin])].sort();
    if (allowedOrigins.length > 8) return reject('too_many_origins');
    if (allowedOrigins.some(value => value.length > 253)) return reject('unsupported_origin_length');
    const plan: RuntimePlan = {
        releaseId: release.id, policyDigest: release.policyDigest, image: policy.image.reference,
        services: [{ name: service.name, internalPort: service.internalPort, hostPort: lease.hostPort,
            process, health: service.health, dependsOn: [] }],
        privateDirectories, projectGrants, allowedOrigins,
        resources: { cpu: policy.resources.cpuLimit, memoryMiB: policy.resources.memoryLimitMiB,
            temporaryMiB, maxRuntimeSeconds: policy.resources.maxRuntimeSeconds },
    };
    // Leave room for the control envelope below the host's 64 KiB request cap.
    if (Buffer.byteLength(JSON.stringify(plan)) > 40_000) return reject('execution_plan_too_large');
    return plan;
}

export function sameRuntimePlan(a: unknown, b: unknown): boolean {
    const canonical = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
        }
        return JSON.stringify(value);
    };
    return canonical(a) === canonical(b);
}

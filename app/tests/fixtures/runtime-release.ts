import { ComputerAppManifestV2Schema, getComputerManifestDigest, type ComputerAppManifestV2 } from '../../src/server/app-platform/computer-app-manifest';
import { ApprovedComputerAppPolicyV2Schema, getComputerPolicyDigest } from '../../src/server/app-platform/approved-computer-app-policy';
import type { RuntimePlanRecords } from '../../src/server/app-platform/runtime-plan';

/** Test-only approved records; no publication, network or build execution. */
export function runtimeRecords(kind: 'node' | 'reticle' = 'node', identity: Partial<{
    appId: string; publisherId: string; installationId: string; releaseId: string;
}> = {}, mutate?: (manifest: ComputerAppManifestV2) => void): RuntimePlanRecords {
    const ids = { appId: 'a1111111-1111-4111-8111-111111111111', publisherId: 'b2222222-2222-4222-8222-222222222222',
        installationId: 'c3333333-3333-4333-8333-333333333333', releaseId: 'd4444444-4444-4444-8444-444444444444', ...identity };
    const reticle = kind === 'reticle';
    const digest = `sha256:${'b'.repeat(64)}`;
    let manifest = ComputerAppManifestV2Schema.parse({
        schemaVersion: 2, appId: ids.appId, publisherId: ids.publisherId,
        name: reticle ? 'Reticle' : 'Notes', slug: reticle ? 'reticle' : 'notes', version: '1.0.0',
        source: { kind: 'github', url: reticle ? 'https://github.com/reticlehq/reticle' : 'https://github.com/acme/notes',
            commitSha: reticle ? '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19' : 'a'.repeat(40) },
        runtime: { profile: 'node24-computer-v1', architecture: 'linux/amd64' },
        build: reticle ? { recipe: 'pnpm-workspace-v1', workspace: 'server', pnpmVersion: '10.33.2', lockfileDigest: digest }
            : { recipe: 'npm-ci-v1' },
        services: [{ name: reticle ? 'daemon' : 'web', protocol: 'http', scope: reticle ? 'selected-project' : 'installation',
            process: reticle ? { kind: 'reticle-daemon-v1' } : { kind: 'node', entrypoint: 'dist/server.mjs', args: [] },
            internalPort: reticle ? 4400 : 8080, preferredHostPort: 4400,
            health: { path: reticle ? '/status' : '/health', status: 200 }, dependsOn: [] }],
        launch: reticle ? { mode: 'integration', adapter: 'reticle-v1', service: 'daemon' }
            : { mode: 'web', service: 'web', path: '/', embedding: { mode: 'iframe', sandbox: ['allow-scripts', 'allow-same-origin'] } },
        configuration: [], capabilities: reticle ? ['projects.read', 'projects.write', 'runs.read', 'mcp.invoke'] : [],
        secrets: [], egressOrigins: [],
        resources: { cpu: 0.25, memoryMiB: 512, ephemeralDiskMiB: 1024, maxRuntimeSeconds: 3600 },
        persistence: { mode: 'computer-volume', privateDirectories: [{ name: 'state', containerPath: '/data/state' }],
            sharedFolders: reticle ? [{ folder: 'Projects', scope: 'selected-projects', access: 'read-write', containerPath: '/workspace/project' }] : [],
            backup: { mode: 'daily-snapshot' } },
        update: { strategy: 'compatible', stateVersion: '1' },
    });
    mutate?.(manifest);
    manifest = ComputerAppManifestV2Schema.parse(manifest);
    const policy = ApprovedComputerAppPolicyV2Schema.parse({
        schemaVersion: 2, manifestDigest: getComputerManifestDigest(manifest),
        image: { reference: `123456789012.dkr.ecr.us-east-1.amazonaws.com/${manifest.slug}@${digest}`, provenanceDigest: digest },
        allowedOsOrigins: ['https://cloud.ezil.org'], appOriginBase: 'https://apps.ezil.org',
        launch: manifest.launch.mode === 'web' ? { mode: 'web', embedding: manifest.launch.embedding }
            : { mode: 'integration', adapter: 'reticle-v1' },
        services: manifest.services.map(s => ({ name: s.name, scope: s.scope, processKind: s.process.kind, internalPort: s.internalPort })),
        capabilities: manifest.capabilities, secretBindings: manifest.secrets, egressOrigins: manifest.egressOrigins,
        mounts: { privateDirectories: manifest.persistence.mode === 'computer-volume' ? manifest.persistence.privateDirectories.map(d => d.name) : [],
            sharedFolders: manifest.persistence.mode === 'computer-volume' ? manifest.persistence.sharedFolders.map(({ folder, access, scope }) => ({ folder, access, scope })) : [] },
        resources: { cpuLimit: manifest.resources.cpu, memoryLimitMiB: manifest.resources.memoryMiB,
            ephemeralDiskLimitMiB: manifest.resources.ephemeralDiskMiB, maxRuntimeSeconds: manifest.resources.maxRuntimeSeconds },
        lifecycle: { idleTimeoutSeconds: 600 }, quotas: { runningAppsPerComputer: 2 },
        backup: manifest.persistence.mode === 'ephemeral' ? { mode: 'none' } : { mode: 'daily-snapshot', retentionDays: 7 },
    });
    return { installationId: ids.installationId, app: { id: ids.appId, publisherId: ids.publisherId, slug: manifest.slug },
        release: { id: ids.releaseId, version: manifest.version, manifest, policy,
            manifestDigest: getComputerManifestDigest(manifest), policyDigest: getComputerPolicyDigest(policy),
            imageReference: policy.image.reference, provenanceDigest: digest,
            sourceCommitSha: manifest.source.kind === 'github' ? manifest.source.commitSha : null },
        services: manifest.services.map(s => ({ name: s.name, protocol: s.protocol, scope: s.scope, internalPort: s.internalPort, healthPath: s.health.path })),
        leases: manifest.services.map((s, i) => ({ serviceName: s.name, hostPort: 4400 + i })), grants: [],
    };
}

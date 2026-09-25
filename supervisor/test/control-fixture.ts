import type { ReconcileCommand } from '../src/control-protocol.js';

export const computerId = '11111111-1111-4111-8111-111111111111';
export const installationId = '22222222-2222-4222-8222-222222222222';
export const projectId = '33333333-3333-4333-8333-333333333333';
export function command(): ReconcileCommand {
    return { schemaVersion: 1, requestId: '44444444-4444-4444-8444-444444444444', computerId,
        computerGeneration: 1, installationId, generation: 1, operation: 'reconcile', desired: 'running',
        plan: { releaseId: '55555555-5555-4555-8555-555555555555', policyDigest: `sha256:${'a'.repeat(64)}`,
            image: `sha256:${'b'.repeat(64)}`,
            services: [{ name: 'daemon', internalPort: 4400, hostPort: 4400, process: {
                kind: 'reticle-daemon-v1', projectId, privateDirectory: 'state' },
            health: { path: '/status', status: 200 }, dependsOn: [] }],
            privateDirectories: [{ name: 'state', containerPath: '/data/reticle' }],
            projectGrants: [{ projectId, containerPath: '/workspace/projects', access: 'read-write' }],
            allowedOrigins: ['https://i-example.apps.ezil.org'],
            resources: { cpu: 0.5, memoryMiB: 768, temporaryMiB: 64, maxRuntimeSeconds: 3600 },
        } };
}

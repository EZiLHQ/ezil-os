import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid();
const generation = z.number().int().min(1).max(2_147_483_647);
const name = z.string().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativeFile = z.string().max(240).regex(/^[a-zA-Z0-9_][a-zA-Z0-9._/-]*\.(?:js|mjs|cjs)$/)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..' && part !== ''));
const containerPath = (root: string) => z.string().max(240).refine(value =>
    value.startsWith(`/${root}/`) && value.split('/').slice(2).every(part =>
        /^[a-zA-Z0-9._-]+$/.test(part) && part !== '.' && part !== '..'));
export const RESERVED_HOST_PORTS = new Set([3000, 3002, 4822, 5900, 5901, 8080, 8181, 8443, 9222, 9223]);
const hostPort = z.number().int().min(1024).max(65535).refine(value => !RESERVED_HOST_PORTS.has(value));
const origin = z.string().max(253).refine(value => {
    try {
        const url = new URL(value);
        return url.origin === value && !url.username && !url.password
            && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'));
    } catch { return false; }
});

/** This is a narrow host execution command, not a publisher manifest. Only
 * the authenticated controller may compile it from approved release records,
 * owned installations, persisted port leases and explicit folder grants. */
export const ExecutionPlanSchema = z.object({
    releaseId: uuid,
    policyDigest: digest,
    // A local content ID permits private validation of an unpushed artifact.
    // Production host configuration must additionally allowlist repositories.
    image: z.string().max(500).regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/),
    services: z.array(z.object({
        name, internalPort: z.number().int().min(1024).max(65535), hostPort,
        process: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('node'), entrypoint: relativeFile,
                args: z.array(z.string().max(256).regex(/^[^\x00-\x1f\x7f-\x9f]*$/)).max(16) }).strict(),
            z.object({ kind: z.literal('reticle-daemon-v1'), projectId: uuid, privateDirectory: name }).strict(),
        ]),
        health: z.object({ path: z.string().max(256).regex(/^\/(?!\/)[a-zA-Z0-9._/-]*$/)
            .refine(value => !value.split('/').some(part => part === '.' || part === '..')),
        status: z.number().int().min(200).max(299) }).strict(),
        dependsOn: z.array(name).max(4),
    }).strict()).min(1).max(4),
    privateDirectories: z.array(z.object({ name, containerPath: containerPath('data') }).strict()).max(16),
    projectGrants: z.array(z.object({ projectId: uuid, containerPath: containerPath('workspace'),
        access: z.enum(['read', 'read-write']) }).strict()).max(8),
    allowedOrigins: z.array(origin).min(1).max(8),
    resources: z.object({ cpu: z.number().positive().max(1), memoryMiB: z.number().int().min(128).max(4096),
        temporaryMiB: z.number().int().min(16).max(4096),
        maxRuntimeSeconds: z.number().int().min(1).max(28_800) }).strict(),
}).strict().superRefine((plan, ctx) => {
    const reject = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const unique = (items: unknown[], path: string[]) => {
        if (new Set(items).size !== items.length) reject(path, 'duplicate_value');
    };
    unique(plan.services.map(s => s.name), ['services']);
    unique(plan.services.map(s => s.hostPort), ['services']);
    unique(plan.privateDirectories.map(d => d.name), ['privateDirectories']);
    unique(plan.projectGrants.map(g => g.projectId), ['projectGrants']);
    unique(plan.allowedOrigins, ['allowedOrigins']);
    const paths = [...plan.privateDirectories, ...plan.projectGrants].map(item => item.containerPath);
    if (paths.some((path, i) => paths.some((other, j) => i !== j && (path === other || path.startsWith(`${other}/`))))) {
        reject(['privateDirectories'], 'overlapping_mounts');
    }
    for (const [index, service] of plan.services.entries()) {
        const visited = new Set<string>();
        const walk = (current: string, parents: Set<string>) => {
            if (parents.has(current)) return false;
            if (visited.has(current)) return true;
            const item = plan.services.find(s => s.name === current);
            if (!item) return false;
            const chain = new Set([...parents, current]);
            if (!item.dependsOn.every(dep => walk(dep, chain))) return false;
            visited.add(current);
            return true;
        };
        if (!walk(service.name, new Set())) reject(['services', index, 'dependsOn'], 'invalid_dependency_graph');
        if (service.process.kind === 'reticle-daemon-v1') {
            const process = service.process;
            if (service.internalPort !== 4400 || service.health.path !== '/status' || service.health.status !== 200
                || !plan.privateDirectories.some(d => d.name === process.privateDirectory)
                || !plan.projectGrants.some(g => g.projectId === process.projectId && g.access === 'read-write')) {
                reject(['services', index], 'invalid_reticle_binding');
            }
        }
    }
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
const envelope = { schemaVersion: z.literal(1), requestId: uuid, computerId: uuid, computerGeneration: generation,
    installationId: uuid };
export const ControlCommandSchema = z.discriminatedUnion('operation', [
    z.object({ ...envelope, operation: z.literal('observe') }).strict(),
    z.object({ ...envelope, operation: z.literal('reconcile'), generation,
        desired: z.enum(['running', 'stopped']), plan: ExecutionPlanSchema }).strict(),
]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;
export type ReconcileCommand = Extract<ControlCommand, { operation: 'reconcile' }>;

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
export function intentDigest(command: ReconcileCommand): string {
    const { requestId: _requestId, ...intent } = command;
    return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

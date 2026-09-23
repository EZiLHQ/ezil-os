import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

export type ContractIssue = { path: (string | number)[]; code: string };
export type ContractResult<T> =
    | { success: true; data: T }
    | { success: false; issues: ContractIssue[] };

/** Use this boundary for untrusted JSON; never serialize or log raw Zod errors.
 * Fixed object keys (no records) keep input values out of issue paths too. */
export function parseContract<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): ContractResult<T> {
    const result = schema.safeParse(input);
    return result.success ? result : {
        success: false,
        issues: result.error.issues.slice(0, 64).map(({ path, code }) => ({ path, code })),
    };
}

function boundedString(max: number, pattern?: RegExp) {
    return z.string().min(1).max(max).refine((value) =>
        [...value].every((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && (code < 127 || code > 159);
        }) && (!pattern || pattern.test(value)));
}

export const UuidSchema = z.string().length(36).uuid().transform((value) => value.toLowerCase());
export const Sha256DigestSchema = z.string().length(71).regex(/^sha256:[a-f0-9]{64}$/);

function publicHostname(host: string): boolean {
    const labels = host.split('.');
    return host.length <= 253 && labels.length > 1 && isIP(host) === 0
        && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
        && /^[a-z]{2,63}$/.test(labels[labels.length - 1])
        && !['localhost', 'local', 'localdomain', 'internal', 'lan', 'home', 'arpa', 'invalid', 'test', 'onion', 'alt']
            .some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function httpsUrl(value: string): URL | undefined {
    // Reject ambiguous input BEFORE URL's whitespace, escape and path normalization.
    if (!/^https:\/\//i.test(value) || /[\s\\%@?#]/.test(value)
        || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return;
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port
            && publicHostname(url.hostname)) return url;
    } catch { /* Invalid URLs have no public error containing the input. */ }
}

/** HTTPS/443 syntax only. All IP literals, local names and encoded authorities
 * are excluded. DNS resolution/rebinding, redirects and fetch limits MUST be
 * checked by the eventual network boundary; a valid hostname is not SSRF proof. */
export const HttpsOriginSchema = boundedString(2048).refine((value) => {
    const url = httpsUrl(value);
    return !!url && /^https:\/\/[^/]+\/?$/i.test(value) && url.pathname === '/';
}).transform((value) => new URL(value).origin);

const GithubRepositorySchema = boundedString(256).refine((value) => {
    const url = httpsUrl(value);
    return url?.hostname === 'github.com'
        && /^https:\/\/github\.com\/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_-][a-z0-9_.-]{0,99}\/?$/i.test(value);
}).transform((value) => value.replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase());

/** Syntax only: registry/repository@sha256:digest, never a mutable tag.
 * Provider support, registry ownership and image provenance are separate checks. */
export const OciImageSchema = boundedString(512).refine((value) => {
    const match = /^([^/]+)\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:([a-f0-9]{64})$/.exec(value);
    return !!match && publicHostname(match[1]);
});

function relativePath(value: string): boolean {
    return value.split('/').every((part) => part !== '.' && part !== '..' && /^[a-z0-9._-]+$/i.test(part));
}
const RelativePathSchema = boundedString(240).refine(relativePath);
const HttpPathSchema = boundedString(512).refine((value) => value === '/'
    || (value.startsWith('/') && relativePath(value.slice(1).replace(/\/$/, ''))));
const HealthSchema = z.object({
    path: HttpPathSchema,
    status: z.number().int().min(200).max(299),
}).strict();

export const CapabilitySchema = z.enum(['context.read', 'window.set-title', 'window.close', 'storage.objects', 'ai.responses']);
export function uniqueArray<T extends z.ZodTypeAny>(schema: T, max: number) {
    return z.array(schema).max(max).refine((items) => new Set(items).size === items.length);
}
export const CapabilitiesSchema = uniqueArray(CapabilitySchema, 5).default([]);
const SandboxTokenSchema = z.enum([
    'allow-scripts', 'allow-forms', 'allow-same-origin', 'allow-popups',
    'allow-popups-to-escape-sandbox', 'allow-downloads', 'allow-top-navigation-by-user-activation',
]);
export const EmbeddingSchema = z.discriminatedUnion('mode', [
    z.object({
        mode: z.literal('iframe'),
        // Permissions must be explicit in BOTH the request and approval.
        sandbox: uniqueArray(SandboxTokenSchema, 7),
    }).strict(),
    z.object({ mode: z.literal('external') }).strict(),
]);

/** Every declaration is a required environment input in v1; optional secrets
 * need a future contract. A reference neither contains a value nor proves the
 * publisher may use it. Runtime resolution must enforce installation scope. */
export const SecretReferenceSchema = z.object({
    name: boundedString(64, /^[A-Z][A-Z0-9_]*$/).refine((name) =>
        !/^(?:EZIL_|CLOUDFLARE_|CF_|AWS_|AZURE_|SUPABASE_|OPENAI_|ANTHROPIC_|GOOGLE_)/.test(name)
        && !/^(?:NODE_|LD_|DYLD_|NPM_CONFIG_)/.test(name)
        && !['PATH', 'HOME', 'PORT'].includes(name)),
    ref: UuidSchema,
}).strict();
export const SecretReferencesSchema = z.array(SecretReferenceSchema).max(16)
    .refine((secrets) => new Set(secrets.map(({ name }) => name)).size === secrets.length).default([]);
export const EgressOriginsSchema = uniqueArray(HttpsOriginSchema, 16).default([]);

export const PersistenceSchema = z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('publisher-managed') }).strict(),
    z.object({ mode: z.literal('ephemeral') }).strict(),
    z.object({ mode: z.literal('objects'), maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
    z.object({ mode: z.literal('external-database'), secretRef: UuidSchema }).strict(),
]);

export const PILOT_LIMITS = Object.freeze({
    cpu: 0.25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 28_800,
    objectBytes: 1_073_741_824, idleTimeoutSeconds: 600, instancesPerUser: 2, instancesPerApp: 5,
});
const ResourceRequirementsSchema = z.object({
    // Minimum requirements, not authority to provision. Only the fixed basic
    // allocation can be approved; larger requests remain incompatible.
    cpu: z.number().finite().positive().max(256),
    memoryMiB: z.number().int().positive().max(262_144),
    diskMiB: z.number().int().positive().max(1_048_576),
    maxRuntimeSeconds: z.number().int().positive().max(86_400),
}).strict();

export const AppManifestV1Schema = z.object({
    schemaVersion: z.literal(1),
    appId: UuidSchema,
    publisherId: UuidSchema,
    name: boundedString(80).refine((value) => value.trim().length > 0),
    slug: boundedString(64, /^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: boundedString(64, /^[a-z0-9][a-z0-9.+_-]*$/i),
    source: z.discriminatedUnion('kind', [
        // Hosted URL is the deployment origin; paths belong in launch.path.
        z.object({ kind: z.literal('hosted'), url: HttpsOriginSchema }).strict(),
        z.object({
            kind: z.literal('github'), url: GithubRepositorySchema,
            commitSha: z.string().length(40).regex(/^[a-f0-9]{40}$/i).transform((value) => value.toLowerCase()),
            subdirectory: RelativePathSchema.optional(), // Omitted means repository root.
        }).strict(),
        z.object({ kind: z.literal('oci'), image: OciImageSchema }).strict(),
    ]),
    launch: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('web'), path: HttpPathSchema, embedding: EmbeddingSchema }).strict(),
        z.object({ mode: z.literal('service') }).strict(),
    ]),
    runtime: z.discriminatedUnion('profile', [
        z.object({ profile: z.literal('external') }).strict(),
        z.object({
            profile: z.literal('node24-http-v1'),
            // Executed as a file + argv by the fixed loader, never as a shell command.
            entrypoint: RelativePathSchema.refine((value) => !value.startsWith('-') && /\.(?:js|mjs|cjs)$/.test(value)),
            args: z.array(boundedString(256)).max(16).default([]),
            port: z.number().int().min(1024).max(65535), health: HealthSchema,
        }).strict(),
        z.object({
            profile: z.literal('oci-linux-amd64'), port: z.number().int().min(1024).max(65535), health: HealthSchema,
        }).strict(),
    ]),
    build: z.object({ recipe: z.literal('npm-ci-v1'), script: z.literal('build').optional() }).strict().optional(),
    capabilities: CapabilitiesSchema,
    secrets: SecretReferencesSchema,
    egressOrigins: EgressOriginsSchema,
    resources: ResourceRequirementsSchema.optional(),
    persistence: PersistenceSchema,
}).strict().superRefine((manifest, ctx) => {
    const reject = (path: string[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'incompatible_fields' });
    const expected = { hosted: 'external', github: 'node24-http-v1', oci: 'oci-linux-amd64' } as const;
    if (manifest.runtime.profile !== expected[manifest.source.kind]) reject(['runtime', 'profile']);
    if (manifest.source.kind === 'hosted') {
        if (manifest.build) reject(['build']);
        if (manifest.resources) reject(['resources']);
        if (manifest.secrets.length) reject(['secrets']);
        if (manifest.egressOrigins.length) reject(['egressOrigins']);
        if (manifest.persistence.mode !== 'publisher-managed') reject(['persistence']);
    } else {
        if (!manifest.resources) reject(['resources']);
        if (manifest.persistence.mode === 'publisher-managed') reject(['persistence']);
        if (manifest.source.kind === 'github' ? !manifest.build : !!manifest.build) reject(['build']);
    }
    if (manifest.capabilities.includes('storage.objects') !== (manifest.persistence.mode === 'objects')) reject(['capabilities']);
    if (manifest.persistence.mode === 'external-database') {
        const secretRef = manifest.persistence.secretRef;
        if (!manifest.secrets.some(({ ref }) => ref === secretRef)) reject(['persistence', 'secretRef']);
    }
});

export type AppManifestV1 = z.infer<typeof AppManifestV1Schema>;
export function validateAppManifest(input: unknown): ContractResult<AppManifestV1> {
    return parseContract(AppManifestV1Schema, input);
}

/** A candidate still needs ownership, source/dependency inspection, network,
 * framing and deployment validation. An external database additionally needs
 * an approved service and verified installation-scoped data/credentials.
 * Recognizing OCI is not support for it. */
export function checkPilotCompatibility(manifest: AppManifestV1): ContractResult<'hosted' | 'node-http'> {
    const issues: ContractIssue[] = [];
    const reject = (path: (string | number)[], code: string) => issues.push({ path, code });
    if (manifest.source.kind === 'oci') reject(['source', 'kind'], 'unsupported_source');
    if (manifest.launch.mode === 'service') reject(['launch', 'mode'], 'unsupported_launch');
    if (manifest.capabilities.includes('ai.responses')) reject(['capabilities'], 'unsupported_capability');
    if (manifest.persistence.mode === 'objects' && manifest.persistence.maxBytes > PILOT_LIMITS.objectBytes) {
        reject(['persistence', 'maxBytes'], 'unsupported_quota');
    }
    if (manifest.resources) {
        for (const key of ['cpu', 'memoryMiB', 'diskMiB', 'maxRuntimeSeconds'] as const) {
            if (manifest.resources[key] > PILOT_LIMITS[key]) reject(['resources', key], 'unsupported_resources');
        }
    }
    if (manifest.launch.mode === 'web' && manifest.launch.embedding.mode === 'iframe'
        && manifest.capabilities.length && !manifest.launch.embedding.sandbox.includes('allow-same-origin')) {
        reject(['launch', 'embedding', 'sandbox'], 'opaque_origin_capabilities');
    }
    return issues.length ? { success: false, issues } : {
        success: true, data: manifest.source.kind === 'hosted' ? 'hosted' : 'node-http',
    };
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** Hash the schema-parsed/defaulted manifest. Array order is intentionally
 * preserved, including argv. This binding does not prove source provenance. */
export function getManifestDigest(manifest: AppManifestV1): string {
    return `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`;
}

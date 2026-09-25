import { z } from 'zod';

import {
    HttpsOriginSchema, RelativePathSchema, Sha256DigestSchema, UuidSchema, parseContract,
} from './manifest';
import type { ContractResult } from './manifest';

/** Input syntax for a public HTTPS Git repository URL. This accepts hosts
 * beyond GitHub so inspection can return an explicit unsupported-host result.
 * It is not a fetch policy: DNS, redirects, IP changes, archive bytes and
 * authorization must be checked by the isolated intake service. */
export const PublicRepositoryUrlSchema = z.string().min(1).max(2048).refine((value) => {
    if (!/^https:\/\//i.test(value) || /[\s\\%@?#]/.test(value)
        || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value)
        || [...value].some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || (code >= 127 && code <= 159);
        })) return false;
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/$/, '');
        const segments = path.split('/').slice(1);
        return HttpsOriginSchema.safeParse(url.origin).success
            && segments.length >= 2
            && segments.every((part) => /^[a-z0-9][a-z0-9._~-]{0,99}$/i.test(part))
            && !segments.some((part) => part === '.' || part === '..');
    } catch {
        return false;
    }
}).transform((value) => {
    const url = new URL(value);
    return url.origin + url.pathname.replace(/\/$/, '');
});

/** A submitter asks for inspection. No URL, client request ID or optional
 * commit pin grants build, release, cloud or publication authority. */
export const RepositorySubmissionV1Schema = z.object({
    schemaVersion: z.literal(1),
    repositoryUrl: PublicRepositoryUrlSchema,
    requestedCommitSha: z.string().length(40).regex(/^[a-f0-9]{40}$/i)
        .transform((value) => value.toLowerCase()).optional(),
    clientRequestId: UuidSchema,
}).strict();
export type RepositorySubmissionV1 = z.infer<typeof RepositorySubmissionV1Schema>;

export function validateRepositorySubmission(input: unknown): ContractResult<RepositorySubmissionV1> {
    return parseContract(RepositorySubmissionV1Schema, input);
}

const sourceEvidence = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('file'),
        path: RelativePathSchema,
        line: z.number().int().positive(),
    }).strict(),
    z.object({
        kind: z.literal('repository-metadata'),
        fact: z.enum(['host', 'commit', 'tree', 'license']),
    }).strict(),
]);
const evidence = z.array(sourceEvidence).min(1).max(8);
const workspacePath = z.union([z.literal('.'), RelativePathSchema]);
const workspaceName = z.string().min(1).max(120).regex(/^[a-z0-9@/._-]+$/i);
const targetName = z.string().min(1).max(48).regex(/^[a-z][a-z0-9-]*$/);

/** Produced only by a trusted inspector after resolving a full commit.
 * Evidence cites bounded source positions or repository metadata; this data
 * is a review aid, not proof of licensing, runtime safety or readiness. */
export const RepositoryInspectionV1Schema = z.object({
    schemaVersion: z.literal(1),
    submissionId: UuidSchema,
    repositoryUrl: PublicRepositoryUrlSchema,
    commitSha: z.string().length(40).regex(/^[a-f0-9]{40}$/i).transform((value) => value.toLowerCase()),
    archiveDigest: Sha256DigestSchema,
    workspaces: z.array(z.object({
        // "." is a logical repository root, never a caller-selected host path.
        path: workspacePath,
        name: workspaceName,
        packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'unknown']),
        workspaceDependencies: z.array(workspaceName).max(64)
            .refine((items) => new Set(items).size === items.length),
        evidence,
    }).strict()).max(64),
    launchTargets: z.array(z.object({
        name: targetName,
        workspacePath,
        kind: z.enum(['web', 'service', 'cli', 'unknown']),
        integrationAdapter: z.literal('reticle-v1').optional(),
        entrypointPath: RelativePathSchema.optional(),
        internalPort: z.number().int().min(1024).max(65535).optional(),
        dependsOn: z.array(targetName).max(8),
        evidence,
    }).strict()).max(32),
    stateRequirements: z.array(z.object({
        kind: z.enum(['filesystem', 'sqlite', 'postgres', 'browser-only', 'unknown']),
        evidence,
    }).strict()).max(16),
    license: z.object({
        identifier: z.string().max(80).regex(/^[a-z0-9.+_-]+$/i),
        evidence,
    }).strict().optional(),
    compatibility: z.object({
        status: z.enum(['pilot-candidate', 'needs-configuration', 'unsupported']),
        reasons: z.array(z.enum([
            'unsupported-host', 'unsupported-language', 'unsupported-architecture',
            'missing-lockfile', 'missing-web-ui', 'missing-companion-service',
            'unsupported-storage', 'native-build-required', 'license-review-required',
            'configuration-required', 'build-or-runtime-unknown',
        ])).max(16).refine((items) => new Set(items).size === items.length),
    }).strict(),
}).strict().superRefine((result, ctx) => {
    const names = new Set(result.launchTargets.map((target) => target.name));
    const paths = new Set(result.workspaces.map((workspace) => workspace.path));
    const workspaceNames = new Set(result.workspaces.map((workspace) => workspace.name));
    result.workspaces.forEach((workspace, index) => {
        workspace.workspaceDependencies.forEach((dependency, dependencyIndex) => {
            if (!workspaceNames.has(dependency) || dependency === workspace.name) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['workspaces', index, 'workspaceDependencies', dependencyIndex],
                    message: 'invalid_workspace_dependency',
                });
            }
        });
    });
    result.launchTargets.forEach((target, index) => {
        if (target.integrationAdapter && (target.kind !== 'service'
            || result.repositoryUrl !== 'https://github.com/reticlehq/reticle')) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['launchTargets', index, 'integrationAdapter'], message: 'unsupported_adapter' });
        }
        if (!paths.has(target.workspacePath)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['launchTargets', index, 'workspacePath'], message: 'unknown_workspace' });
        }
        target.dependsOn.forEach((dependency, dependencyIndex) => {
            if (!names.has(dependency) || dependency === target.name) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['launchTargets', index, 'dependsOn', dependencyIndex],
                    message: 'invalid_dependency',
                });
            }
        });
    });
    if (names.size !== result.launchTargets.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['launchTargets'], message: 'duplicate_target' });
    }
    if (paths.size !== result.workspaces.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaces'], message: 'duplicate_workspace' });
    }
    if (workspaceNames.size !== result.workspaces.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaces'], message: 'duplicate_workspace_name' });
    }
    if (result.compatibility.status === 'pilot-candidate'
        && (result.compatibility.reasons.length || !result.launchTargets.some((target) =>
            target.kind === 'web' || target.integrationAdapter === 'reticle-v1'))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compatibility'], message: 'candidate_requires_window_target_without_blockers' });
    }
    if (result.compatibility.status === 'unsupported' && !result.compatibility.reasons.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compatibility', 'reasons'], message: 'reason_required' });
    }
});
export type RepositoryInspectionV1 = z.infer<typeof RepositoryInspectionV1Schema>;

export function validateRepositoryInspection(input: unknown): ContractResult<RepositoryInspectionV1> {
    return parseContract(RepositoryInspectionV1Schema, input);
}

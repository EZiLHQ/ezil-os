import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import {
    getComputerPolicyDigest, validateComputerPolicyAgainstManifest,
} from '@/server/app-platform/approved-computer-app-policy';
import { getComputerManifestDigest } from '@/server/app-platform/computer-app-manifest';
import { assignComputerHostPorts } from '@/server/app-platform/port-leases';
import {
    appAuditEvents, appGrants, appInstallations, appJobs, appOutbox,
    appPortLeases, appPublications, appPublishers, appReleases, appServices,
    apps, computers,
} from '@/server/db/schema';
import { requireAppInstall, requireMarketplaceApi } from './marketplace-flags';
import { protectedProcedure } from '../trpc';

/** Install records one desired state and stable service leases. It never
 * starts the computer, pulls an image, grants a shared folder, or claims that
 * an app is ready. A separately deployed supervisor must consume the job. */
export const installAppProcedure = protectedProcedure.input(z.object({
    computerId: z.string().uuid(),
    appId: z.string().uuid(),
    clientRequestId: z.string().uuid(),
}).strict()).mutation(async ({ ctx, input }) => {
    requireMarketplaceApi();
    requireAppInstall();
    return ctx.db.transaction(async (tx) => {
        // This row lock serializes port allocation across installations on
        // one computer. The partial unique index remains the final guard.
        const [computer] = await tx.select({ id: computers.id, provider: computers.provider })
            .from(computers)
            .where(and(eq(computers.id, input.computerId), eq(computers.userId, ctx.user.id),
                isNull(computers.deletedAt)))
            .limit(1).for('update');
        if (!computer) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
        if (computer.provider !== 'aws-ec2') {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'An AWS computer is required' });
        }

        const [catalogApp] = await tx.select({
            id: apps.id, publisherId: apps.publisherId, slug: apps.slug,
            visibility: apps.visibility,
        }).from(apps).where(eq(apps.id, input.appId)).limit(1).for('share');
        if (!catalogApp) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application not found' });
        const [publisher] = await tx.select({ id: appPublishers.id }).from(appPublishers)
            .where(and(eq(appPublishers.id, catalogApp.publisherId), eq(appPublishers.status, 'active')))
            .limit(1).for('share');
        if (!publisher) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application not found' });
        if (catalogApp.visibility === 'grant-only') {
            const [grant] = await tx.select({ userId: appGrants.userId }).from(appGrants)
                .where(and(eq(appGrants.appId, catalogApp.id), eq(appGrants.userId, ctx.user.id),
                    isNull(appGrants.revokedAt)))
                .limit(1).for('share');
            if (!grant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application not found' });
        }

        const [publication] = await tx.select({ releaseId: appPublications.releaseId })
            .from(appPublications).where(eq(appPublications.appId, catalogApp.id))
            .limit(1).for('share');
        if (!publication) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application not found' });
        const [release] = await tx.select({
            id: appReleases.id,
            version: appReleases.version,
            manifest: appReleases.manifest,
            policy: appReleases.policy,
            manifestDigest: appReleases.manifestDigest,
            policyDigest: appReleases.policyDigest,
            imageReference: appReleases.imageReference,
            provenanceDigest: appReleases.provenanceDigest,
            sourceCommitSha: appReleases.sourceCommitSha,
        }).from(appReleases)
            .where(and(eq(appReleases.id, publication.releaseId), eq(appReleases.appId, catalogApp.id),
                eq(appReleases.status, 'approved')))
            .limit(1).for('share');
        if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application not found' });
        const contracts = validateComputerPolicyAgainstManifest(release.manifest, release.policy);
        if (!contracts.success) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Application release is not installable' });
        }
        const { manifest, policy } = contracts.data;
        if (manifest.appId !== catalogApp.id || manifest.publisherId !== catalogApp.publisherId
            || manifest.slug !== catalogApp.slug
            || manifest.version !== release.version
            || getComputerManifestDigest(manifest) !== release.manifestDigest
            || getComputerPolicyDigest(policy) !== release.policyDigest
            || policy.image.reference !== release.imageReference
            || policy.image.provenanceDigest !== release.provenanceDigest
            || (manifest.source.kind === 'github'
                && manifest.source.commitSha !== release.sourceCommitSha)) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Application release evidence is inconsistent' });
        }

        const [current] = await tx.select({ id: appInstallations.id, status: appInstallations.status })
            .from(appInstallations)
            .where(and(eq(appInstallations.computerId, computer.id),
                eq(appInstallations.appId, catalogApp.id), isNull(appInstallations.uninstalledAt)))
            .limit(1).for('share');
        if (current) {
            const [job] = await tx.select({ id: appJobs.id }).from(appJobs)
                .where(and(eq(appJobs.installationId, current.id), eq(appJobs.operation, 'install')))
                .limit(1);
            if (!job) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Installation job missing' });
            return { installationId: current.id, jobId: job.id, status: current.status, reused: true };
        }

        const [created] = await tx.insert(appInstallations).values({
            computerId: computer.id, appId: catalogApp.id, releaseId: release.id,
            installedBy: ctx.user.id,
        }).onConflictDoNothing().returning({ id: appInstallations.id, status: appInstallations.status });
        if (!created) {
            // An unexpected writer ignored the computer lock. Fail the whole
            // transaction; do not guess which installation won the race.
            throw new TRPCError({ code: 'CONFLICT', message: 'Installation changed concurrently' });
        }
        const services = manifest.services.map((service) => ({
            installationId: created.id, computerId: computer.id,
            name: service.name, protocol: service.protocol, scope: service.scope,
            internalPort: service.internalPort, preferredHostPort: service.preferredHostPort ?? null,
            healthPath: service.health.path,
        }));
        await tx.insert(appServices).values(services);
        const existingLeases = await tx.select({ hostPort: appPortLeases.hostPort }).from(appPortLeases)
            .where(and(eq(appPortLeases.computerId, computer.id), isNull(appPortLeases.releasedAt)));
        let assignments: ReturnType<typeof assignComputerHostPorts>;
        try {
            assignments = assignComputerHostPorts(manifest.services, existingLeases.map(({ hostPort }) => hostPort));
        } catch {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No application service ports available' });
        }
        await tx.insert(appPortLeases).values(assignments.map(({ name, hostPort }) => ({
            installationId: created.id, computerId: computer.id,
            serviceName: name, hostPort,
        })));
        const [job] = await tx.insert(appJobs).values({
            installationId: created.id, computerId: computer.id,
            requestedBy: ctx.user.id, operation: 'install', idempotencyKey: input.clientRequestId,
        }).returning({ id: appJobs.id });
        if (!job) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Installation job missing' });
        await tx.insert(appOutbox).values({ jobId: job.id });
        await tx.insert(appAuditEvents).values({
            actorUserId: ctx.user.id, action: 'installation.requested',
            appId: catalogApp.id, releaseId: release.id,
            installationId: created.id, computerId: computer.id,
        });
        return { installationId: created.id, jobId: job.id, status: created.status, reused: false };
    });
});

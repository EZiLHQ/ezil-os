import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { env } from '@/env';
import { ApplicationComputerStartError, prepareApplicationComputerStart } from '@/server/app-platform/application-computer-start';
import { compileRuntimePlan, RuntimePlanError, sameRuntimePlan } from '@/server/app-platform/runtime-plan';
import type { db } from '@/server/db';
import {
    appAuditEvents, appFolderGrants, appGrants, appInstallations, appJobs, appOutbox,
    appPortLeases, appPublishers, appReleases, appRuntimeCommands, appRuntimeRequests,
    apps, appServices, computerInstances,
    computerRuntimes, computers,
} from '@/server/db/schema';
import { protectedProcedure } from '../trpc';
import { requireAppRuntimeCommands, requireMarketplaceApi } from './marketplace-flags';

type Command = typeof appRuntimeCommands.$inferSelect;
const commonInput = { computerId: z.string().uuid(), installationId: z.string().uuid(), clientRequestId: z.string().uuid() };
const launchInput = z.object({ ...commonInput, projectId: z.string().uuid().optional() }).strict();
const stopInput = z.object(commonInput).strict();
const unavailable = (message: string): never => { throw new TRPCError({ code: 'PRECONDITION_FAILED', message }); };

function selectedProject(plan: Record<string, unknown>): string | undefined {
    const grants = plan.projectGrants;
    if (!Array.isArray(grants) || grants.length !== 1 || !grants[0] || typeof grants[0] !== 'object') return undefined;
    return typeof grants[0].projectId === 'string' ? grants[0].projectId : undefined;
}

async function recordIntent(database: typeof db, userId: string, operation: 'start' | 'stop',
    input: z.infer<typeof launchInput>) {
    try {
        return await database.transaction(async tx => {
            // All writers use this order; same-computer requests serialize
            // without creating duplicate start jobs or extending a revision.
            const [computer] = await tx.select().from(computers)
                .where(and(eq(computers.id, input.computerId), eq(computers.userId, userId), isNull(computers.deletedAt)))
                .limit(1).for('update');
            if (!computer) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            if (computer.provider !== 'aws-ec2') unavailable('An AWS computer is required');
            const [installation] = await tx.select().from(appInstallations)
                .where(and(eq(appInstallations.id, input.installationId), eq(appInstallations.computerId, computer.id),
                    isNull(appInstallations.uninstalledAt))).limit(1).for('update');
            if (!installation) throw new TRPCError({ code: 'NOT_FOUND', message: 'Installation not found' });
            const [latest] = await tx.select().from(appRuntimeCommands)
                .where(eq(appRuntimeCommands.installationId, installation.id))
                .orderBy(desc(appRuntimeCommands.generation)).limit(1);
            const [receipt] = await tx.select({ command: appRuntimeCommands, status: appJobs.status })
                .from(appRuntimeRequests)
                .innerJoin(appRuntimeCommands, eq(appRuntimeCommands.jobId, appRuntimeRequests.jobId))
                .innerJoin(appJobs, eq(appJobs.id, appRuntimeRequests.jobId))
                .where(and(eq(appRuntimeRequests.installationId, installation.id), eq(appRuntimeRequests.requestId, input.clientRequestId)))
                .limit(1);
            const result = (command: Command, status: typeof appJobs.$inferSelect.status, reused: boolean, isLatest: boolean) => ({
                installationId: installation.id, jobId: command.jobId, generation: command.generation,
                operation: command.operation, status, reused, isLatestCommand: isLatest,
            });
            // An old request never schedules work, even after Stop, revocation,
            // host replacement, or expiry. Its receipt describes job history.
            if (receipt) {
                if (receipt.command.operation !== operation
                    || (operation === 'start' && selectedProject(receipt.command.plan) !== input.projectId)) {
                    throw new TRPCError({ code: 'CONFLICT', message: 'Request already used for different intent' });
                }
                return result(receipt.command, receipt.status, true, receipt.command.jobId === latest?.jobId);
            }

            let plan: Record<string, unknown>;
            let releaseId: string;
            let computerGeneration: number;
            let computerState = 'unknown';
            if (operation === 'stop') {
                // Stopping uses previously recorded scope. A revoked release,
                // grant or configuration cannot force the owner to keep it on.
                if (!latest) unavailable('No application runtime has been requested');
                plan = latest.plan;
                releaseId = latest.releaseId;
                computerGeneration = latest.computerGeneration;
            } else {
                if (installation.status !== 'installed') unavailable('Application installation is not complete');
                const [app] = await tx.select().from(apps).where(eq(apps.id, installation.appId)).limit(1).for('share');
                if (!app) unavailable('Application is unavailable');
                const [publisher] = await tx.select({ id: appPublishers.id }).from(appPublishers)
                    .where(and(eq(appPublishers.id, app.publisherId), eq(appPublishers.status, 'active'))).limit(1).for('share');
                if (!publisher) unavailable('Application publisher is unavailable');
                if (app.visibility === 'grant-only') {
                    const [grant] = await tx.select({ appId: appGrants.appId }).from(appGrants)
                        .where(and(eq(appGrants.appId, app.id), eq(appGrants.userId, userId), isNull(appGrants.revokedAt)))
                        .limit(1).for('share');
                    if (!grant) throw new TRPCError({ code: 'FORBIDDEN', message: 'Application access is not granted' });
                }
                const [release] = await tx.select().from(appReleases)
                    .where(and(eq(appReleases.id, installation.releaseId), eq(appReleases.appId, app.id), eq(appReleases.status, 'approved')))
                    .limit(1).for('share');
                if (!release) unavailable('Application release is unavailable');
                const scope = and(eq(appServices.installationId, installation.id), eq(appServices.computerId, computer.id));
                const services = await tx.select().from(appServices).where(scope).for('share');
                const leases = await tx.select().from(appPortLeases)
                    .where(and(eq(appPortLeases.installationId, installation.id), eq(appPortLeases.computerId, computer.id), isNull(appPortLeases.releasedAt)))
                    .for('share');
                const grants = await tx.select().from(appFolderGrants)
                    .where(and(eq(appFolderGrants.installationId, installation.id), eq(appFolderGrants.computerId, computer.id),
                        eq(appFolderGrants.grantedBy, userId), isNull(appFolderGrants.revokedAt))).for('share');
                plan = compileRuntimePlan({ installationId: installation.id, app, release, services, leases, grants,
                    projectId: input.projectId }) as unknown as Record<string, unknown>;
                releaseId = release.id;
                const [runtime] = await tx.select().from(computerRuntimes)
                    .where(eq(computerRuntimes.computerId, computer.id)).limit(1).for('update');
                const [writer] = await tx.select().from(computerInstances)
                    .where(and(eq(computerInstances.computerId, computer.id), isNull(computerInstances.fencedAt)))
                    .limit(1).for('update');
                if (!runtime || !runtime.dataVolumeId || !runtime.availabilityZone || runtime.region !== 'us-east-1'
                    || runtime.desiredState === 'retired' || !writer || ['failed', 'stopping'].includes(writer.observedState)) {
                    unavailable('Computer runtime is not prepared');
                }
                computerGeneration = writer.generation;
                computerState = writer.observedState;
            }

            const [previousJob] = latest ? await tx.select({ status: appJobs.status }).from(appJobs)
                .where(eq(appJobs.id, latest.jobId)).limit(1) : [];
            const pending = previousJob && ['queued', 'running'].includes(previousJob.status);
            const canReuse = latest && previousJob && latest.operation === operation
                && latest.computerGeneration === computerGeneration && latest.authGeneration === installation.authGeneration
                && sameRuntimePlan(latest.plan, plan)
                && (pending || (previousJob.status === 'succeeded' && (operation === 'stop' || computerState === 'running')));
            // A completed start is reusable desired intent, not a health or
            // lease assertion. The dispatcher must observe actual runtime
            // expiry and record Stop; neither Open nor polling guesses from
            // wall time or renews the host's same-generation deadline.
            let command: Command;
            if (canReuse) command = latest;
            else {
                if (latest?.generation === 2_147_483_647) unavailable('Application command history is full');
                const [job] = await tx.insert(appJobs).values({
                    installationId: installation.id, computerId: computer.id, requestedBy: userId,
                    operation, idempotencyKey: `runtime:${input.clientRequestId}`,
                }).returning({ id: appJobs.id });
                if (!job) throw new Error('app_job_not_recorded');
                await tx.insert(appOutbox).values({ jobId: job.id });
                const [created] = await tx.insert(appRuntimeCommands).values({
                    jobId: job.id, installationId: installation.id, computerId: computer.id, appId: installation.appId,
                    releaseId, computerGeneration, generation: (latest?.generation ?? 0) + 1,
                    authGeneration: installation.authGeneration, operation, plan,
                }).returning();
                if (!created) throw new Error('app_command_not_recorded');
                command = created;
            }
            await tx.insert(appRuntimeRequests).values({ installationId: installation.id, requestId: input.clientRequestId,
                jobId: command.jobId, requestedBy: userId });
            await tx.insert(appAuditEvents).values({ actorUserId: userId, appId: installation.appId,
                releaseId: command.releaseId, installationId: installation.id, computerId: computer.id,
                action: operation === 'start' ? 'installation.launch-requested' : 'installation.stop-requested' });
            if (operation === 'start') {
                await prepareApplicationComputerStart(tx, { computerId: computer.id, computerGeneration,
                    userId, appJobId: command.jobId, deployments: env.EZIL_LIFECYCLE_DEPLOYMENTS,
                    osAccessMode: env.EZIL_OS_ACCESS_MODE });
            }
            return result(command, canReuse ? previousJob!.status : 'queued', Boolean(canReuse), true);
        });
    } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof RuntimePlanError) unavailable(`Application cannot launch: ${error.message}`);
        if (error instanceof ApplicationComputerStartError) unavailable(error.code);
        // No raw SQL, provider metadata, plans or input-bearing database errors
        // are attached as a cause or exposed through tRPC error formatting.
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Application request could not be recorded' });
    }
}

export const launchAppProcedure = protectedProcedure.input(launchInput).mutation(({ ctx, input }) => {
    requireMarketplaceApi();
    requireAppRuntimeCommands();
    return recordIntent(ctx.db, ctx.user.id, 'start', input);
});

export const stopAppProcedure = protectedProcedure.input(stopInput).mutation(({ ctx, input }) => {
    requireMarketplaceApi();
    requireAppRuntimeCommands();
    return recordIntent(ctx.db, ctx.user.id, 'stop', input);
});

/** Database observation only: polling never starts a computer, re-enqueues an
 * outbox event, or renews a runtime deadline. Job success is not app health. */
export const appRuntimeJobStatusProcedure = protectedProcedure.input(z.object({
    computerId: z.string().uuid(), jobId: z.string().uuid(),
}).strict()).query(async ({ ctx, input }) => {
    requireMarketplaceApi();
    requireAppRuntimeCommands();
    const [job] = await ctx.db.select({ jobId: appJobs.id, installationId: appRuntimeCommands.installationId,
        generation: appRuntimeCommands.generation, operation: appRuntimeCommands.operation, status: appJobs.status,
        createdAt: appJobs.createdAt, completedAt: appJobs.completedAt })
        .from(appRuntimeCommands).innerJoin(appJobs, eq(appJobs.id, appRuntimeCommands.jobId))
        .innerJoin(computers, eq(computers.id, appRuntimeCommands.computerId))
        .where(and(eq(computers.id, input.computerId), eq(computers.userId, ctx.user.id), isNull(computers.deletedAt),
            eq(appJobs.id, input.jobId))).limit(1);
    if (!job) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application job not found' });
    return job;
});

import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { RepositorySubmissionV1Schema, validateRepositoryInspection } from '@/server/app-platform/repository-submission';
import { appAdmins, appAuditEvents, appJobs, appOutbox, appPublishers, appSubmissions } from '@/server/db/schema';
import { requireMarketplaceApi, requireSubmissionIntake } from './marketplace-flags';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const idInput = z.object({ id: z.string().uuid() }).strict();
const visibleErrorCodes = new Set([
    'invalid-submission', 'unsupported-host', 'unsupported-path', 'not-found',
    'rate-limited', 'source-unavailable', 'invalid-response',
    'response-too-large', 'inspection-failed', 'cancelled',
]);

/** These calls only record durable, attributable intent. The outbox worker
 * must independently recheck authorization, cancellation and source pins;
 * creating a submission cannot run source or approve a release. */
export const appSubmissionsRouter = createTRPCRouter({
    create: protectedProcedure.input(RepositorySubmissionV1Schema)
        .mutation(async ({ ctx, input }) => {
            requireMarketplaceApi();
            requireSubmissionIntake();
            return ctx.db.transaction(async (tx) => {
                const [admin] = await tx.select({ userId: appAdmins.userId }).from(appAdmins)
                    .where(and(eq(appAdmins.userId, ctx.user.id), isNull(appAdmins.revokedAt)))
                    .limit(1).for('share');
                if (!admin) {
                    const [publisher] = await tx.select({ id: appPublishers.id }).from(appPublishers)
                        .where(and(eq(appPublishers.ownerUserId, ctx.user.id), eq(appPublishers.status, 'active')))
                        .limit(1).for('share');
                    if (!publisher) throw new TRPCError({ code: 'FORBIDDEN', message: 'Publisher access required' });
                }

                const [created] = await tx.insert(appSubmissions).values({
                    submittedBy: ctx.user.id,
                    repositoryUrl: input.repositoryUrl,
                    requestedCommitSha: input.requestedCommitSha ?? null,
                    idempotencyKey: input.clientRequestId,
                }).onConflictDoNothing({ target: [appSubmissions.submittedBy, appSubmissions.idempotencyKey] })
                    .returning({ id: appSubmissions.id, status: appSubmissions.status });
                if (!created) {
                    const [existing] = await tx.select({
                        id: appSubmissions.id,
                        status: appSubmissions.status,
                        repositoryUrl: appSubmissions.repositoryUrl,
                        requestedCommitSha: appSubmissions.requestedCommitSha,
                    }).from(appSubmissions)
                        .where(and(eq(appSubmissions.submittedBy, ctx.user.id),
                            eq(appSubmissions.idempotencyKey, input.clientRequestId)))
                        .limit(1);
                    if (!existing || existing.repositoryUrl !== input.repositoryUrl
                        || existing.requestedCommitSha !== (input.requestedCommitSha ?? null)) {
                        throw new TRPCError({ code: 'CONFLICT', message: 'Request ID already used' });
                    }
                    const [job] = await tx.select({ id: appJobs.id }).from(appJobs)
                        .where(and(eq(appJobs.submissionId, existing.id), eq(appJobs.operation, 'inspect')))
                        .limit(1);
                    if (!job) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Submission job missing' });
                    return { id: existing.id, status: existing.status, jobId: job.id };
                }

                const [job] = await tx.insert(appJobs).values({
                    submissionId: created.id,
                    requestedBy: ctx.user.id,
                    operation: 'inspect',
                    idempotencyKey: input.clientRequestId,
                }).returning({ id: appJobs.id });
                if (!job) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Submission job missing' });
                await tx.insert(appOutbox).values({ jobId: job.id });
                await tx.insert(appAuditEvents).values({
                    actorUserId: ctx.user.id,
                    action: 'submission.created',
                    submissionId: created.id,
                });
                return { id: created.id, status: created.status, jobId: job.id };
            });
        }),

    status: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
        requireMarketplaceApi();
        const [owned] = await ctx.db.select({
            id: appSubmissions.id,
            repositoryUrl: appSubmissions.repositoryUrl,
            requestedCommitSha: appSubmissions.requestedCommitSha,
            resolvedCommitSha: appSubmissions.resolvedCommitSha,
            status: appSubmissions.status,
            inspection: appSubmissions.inspection,
            errorCode: appSubmissions.errorCode,
        }).from(appSubmissions)
            .where(and(eq(appSubmissions.id, input.id), eq(appSubmissions.submittedBy, ctx.user.id)))
            .limit(1);
        let submission = owned;
        if (!submission) {
            const [admin] = await ctx.db.select({ userId: appAdmins.userId }).from(appAdmins)
                .where(and(eq(appAdmins.userId, ctx.user.id), isNull(appAdmins.revokedAt))).limit(1);
            if (admin) {
                [submission] = await ctx.db.select({
                    id: appSubmissions.id,
                    repositoryUrl: appSubmissions.repositoryUrl,
                    requestedCommitSha: appSubmissions.requestedCommitSha,
                    resolvedCommitSha: appSubmissions.resolvedCommitSha,
                    status: appSubmissions.status,
                    inspection: appSubmissions.inspection,
                    errorCode: appSubmissions.errorCode,
                }).from(appSubmissions).where(eq(appSubmissions.id, input.id)).limit(1);
            }
        }
        if (!submission) throw new TRPCError({ code: 'NOT_FOUND', message: 'Submission not found' });
        const inspection = submission.inspection === null
            ? null : validateRepositoryInspection(submission.inspection);
        if (inspection && !inspection.success) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Invalid inspection result' });
        }
        return {
            ...submission,
            inspection: inspection?.data ?? null,
            errorCode: submission.errorCode && visibleErrorCodes.has(submission.errorCode)
                ? submission.errorCode : submission.errorCode ? 'inspection-failed' : null,
        };
    }),

    cancel: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
        requireMarketplaceApi();
        return ctx.db.transaction(async (tx) => {
            const [admin] = await tx.select({ userId: appAdmins.userId }).from(appAdmins)
                .where(and(eq(appAdmins.userId, ctx.user.id), isNull(appAdmins.revokedAt)))
                .limit(1).for('share');
            const [submission] = await tx.select({
                id: appSubmissions.id,
                submittedBy: appSubmissions.submittedBy,
                status: appSubmissions.status,
            }).from(appSubmissions)
                .where(and(eq(appSubmissions.id, input.id),
                    ...(admin ? [] : [eq(appSubmissions.submittedBy, ctx.user.id)])))
                .limit(1).for('update');
            if (!submission) throw new TRPCError({ code: 'NOT_FOUND', message: 'Submission not found' });
            if (submission.status === 'cancelled') return { id: submission.id, status: 'cancelled' as const };
            if (submission.status !== 'queued' && submission.status !== 'inspecting') {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Submission cannot be cancelled in this state' });
            }
            await tx.update(appSubmissions).set({ status: 'cancelled', updatedAt: new Date() })
                .where(eq(appSubmissions.id, submission.id));
            await tx.update(appJobs).set({ status: 'cancelled', completedAt: new Date() })
                .where(and(eq(appJobs.submissionId, submission.id), inArray(appJobs.status, ['queued'])));
            await tx.insert(appAuditEvents).values({
                actorUserId: ctx.user.id,
                action: 'submission.cancelled',
                submissionId: submission.id,
            });
            return { id: submission.id, status: 'cancelled' as const };
        });
    }),
});

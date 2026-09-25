import { TRPCError } from '@trpc/server';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import { env } from '@/env';
import { validateComputerAppManifest } from '@/server/app-platform/computer-app-manifest';
import {
    appGrants, appInstallations, appPublications, appPublishers, appReleases, apps,
} from '@/server/db/schema';
import { liveOwnedComputer } from './computer-store';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/** The API is deployed only after 0003 and 0004 have been applied. Keeping
 * the flag closed means a code deploy cannot accidentally query absent tables. */
export function requireMarketplaceApi(): void {
    if (env.EZIL_APP_MARKETPLACE_API_ENABLED !== 'true') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Marketplace is not enabled' });
    }
}

const visibleTo = (userId: string) => or(
    eq(apps.visibility, 'all-authenticated'),
    and(eq(appGrants.userId, userId), isNull(appGrants.revokedAt)),
);

/** A publication is catalog data, never an installation or a running app. */
export const appsRouter = createTRPCRouter({
    catalog: protectedProcedure.query(async ({ ctx }) => {
        requireMarketplaceApi();
        return ctx.db.select({
            id: apps.id,
            slug: apps.slug,
            name: apps.name,
            summary: apps.summary,
            category: apps.category,
            logoAssetKey: apps.logoAssetKey,
            publisher: appPublishers.displayName,
            releaseId: appReleases.id,
            version: appReleases.version,
        }).from(apps)
            .innerJoin(appPublishers, and(eq(appPublishers.id, apps.publisherId), eq(appPublishers.status, 'active')))
            .innerJoin(appPublications, eq(appPublications.appId, apps.id))
            .innerJoin(appReleases, and(eq(appReleases.id, appPublications.releaseId),
                eq(appReleases.appId, apps.id), eq(appReleases.status, 'approved')))
            .leftJoin(appGrants, and(eq(appGrants.appId, apps.id), eq(appGrants.userId, ctx.user.id)))
            .where(visibleTo(ctx.user.id))
            .orderBy(asc(apps.name))
            .limit(100);
    }),

    details: protectedProcedure.input(z.object({ appId: z.string().uuid() }).strict())
        .query(async ({ ctx, input }) => {
            requireMarketplaceApi();
            const [row] = await ctx.db.select({
                id: apps.id,
                slug: apps.slug,
                name: apps.name,
                summary: apps.summary,
                category: apps.category,
                logoAssetKey: apps.logoAssetKey,
                publisher: appPublishers.displayName,
                releaseId: appReleases.id,
                version: appReleases.version,
                manifest: appReleases.manifest,
            }).from(apps)
                .innerJoin(appPublishers, and(eq(appPublishers.id, apps.publisherId), eq(appPublishers.status, 'active')))
                .innerJoin(appPublications, eq(appPublications.appId, apps.id))
                .innerJoin(appReleases, and(eq(appReleases.id, appPublications.releaseId),
                    eq(appReleases.appId, apps.id), eq(appReleases.status, 'approved')))
                .leftJoin(appGrants, and(eq(appGrants.appId, apps.id), eq(appGrants.userId, ctx.user.id)))
                .where(and(eq(apps.id, input.appId), visibleTo(ctx.user.id)))
                .limit(1);
            if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Application not found' });
            const parsed = validateComputerAppManifest(row.manifest);
            if (!parsed.success) {
                // The trusted release record has drifted from its contract;
                // fail closed without returning raw policy or secret refs.
                throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Invalid application release' });
            }
            const manifest = parsed.data;
            return {
                id: row.id, slug: row.slug, name: row.name, summary: row.summary,
                category: row.category, logoAssetKey: row.logoAssetKey,
                publisher: row.publisher, releaseId: row.releaseId, version: row.version,
                source: manifest.source.kind === 'github'
                    ? { kind: 'github' as const, url: manifest.source.url, commitSha: manifest.source.commitSha }
                    : { kind: 'oci' as const },
                launchMode: manifest.launch.mode,
                configuration: manifest.configuration,
                requestedFolders: manifest.persistence.mode === 'computer-volume'
                    ? manifest.persistence.sharedFolders.map(({ folder, access, scope }) => ({ folder, access, scope }))
                    : [],
                resources: manifest.resources,
            };
        }),

    installed: protectedProcedure.input(z.object({ computerId: z.string().uuid() }).strict())
        .query(async ({ ctx, input }) => {
            requireMarketplaceApi();
            const computer = await ctx.db.query.computers.findFirst({
                columns: { id: true, provider: true },
                where: liveOwnedComputer(ctx.user.id, input.computerId),
            });
            if (!computer) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            if (computer.provider !== 'aws-ec2') return [];
            return ctx.db.select({
                id: appInstallations.id,
                appId: apps.id,
                appName: apps.name,
                appSlug: apps.slug,
                logoAssetKey: apps.logoAssetKey,
                releaseId: appReleases.id,
                version: appReleases.version,
                releaseStatus: appReleases.status,
                installStatus: appInstallations.status,
                installedAt: appInstallations.installedAt,
            }).from(appInstallations)
                .innerJoin(apps, eq(apps.id, appInstallations.appId))
                .innerJoin(appReleases, and(eq(appReleases.id, appInstallations.releaseId),
                    eq(appReleases.appId, apps.id)))
                .where(and(eq(appInstallations.computerId, computer.id), isNull(appInstallations.uninstalledAt)))
                .orderBy(asc(apps.name));
        }),
});

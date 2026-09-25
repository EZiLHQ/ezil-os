import { and, eq, isNull, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { appFolderGrants, appGrants, appInstallations, appPortLeases, appPublishers,
    appReleases, appRuntimeCommands, apps, appServices, osAccess } from '@/server/db/schema';
import { compileRuntimePlan, RuntimePlanError, sameRuntimePlan, type RuntimePlan } from './runtime-plan';

type Transaction = Parameters<Parameters<typeof db['transaction']>[0]>[0];
type Command = typeof appRuntimeCommands.$inferSelect;
export type OsAccessMode = 'invite' | 'open';

/** Service-only callers hold the computer and installation locks first.
 * These reads retain current authority locks until their transaction commits. */
export async function hasCurrentOsAccess(tx: Transaction, owner: string, mode: OsAccessMode): Promise<boolean> {
    // Supabase owns these columns; read without changing the migration model.
    // Hold identity/ban and authorization rows through the bounded delivery.
    const users = await tx.execute<{ email: string | null }>(sql`SELECT email FROM auth.users WHERE id=${owner}
        AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until <= clock_timestamp()) FOR SHARE`);
    const user = users[0];
    if (!user) return false;
    if (mode === 'invite') {
        if (!user.email) return false;
        const [access] = await tx.select().from(osAccess).where(eq(osAccess.email, user.email.trim().toLowerCase())).limit(1).for('share');
        if (!access || access.revokedAt) return false;
    }
    return true;
}

export async function currentInstallationRelease(tx: Transaction, installation: typeof appInstallations.$inferSelect, owner: string) {
    const [app] = await tx.select().from(apps).where(eq(apps.id, installation.appId)).limit(1).for('share');
    if (!app) return null;
    const [publisher] = await tx.select().from(appPublishers)
        .where(and(eq(appPublishers.id, app.publisherId), eq(appPublishers.status, 'active'))).limit(1).for('share');
    if (!publisher) return null;
    if (app.visibility === 'grant-only') {
        const [grant] = await tx.select().from(appGrants).where(and(eq(appGrants.appId, app.id),
            eq(appGrants.userId, owner), isNull(appGrants.revokedAt))).limit(1).for('share');
        if (!grant) return null;
    }
    const [release] = await tx.select().from(appReleases).where(and(eq(appReleases.id, installation.releaseId),
        eq(appReleases.appId, app.id), eq(appReleases.status, 'approved'))).limit(1).for('share');
    if (!release) return null;
    return { app, release };
}

const selectedProject = (command: Command): string | undefined => {
    const grants = command.plan.projectGrants;
    return Array.isArray(grants) && grants.length === 1 && typeof grants[0]?.projectId === 'string' ? grants[0].projectId : undefined;
};
export async function currentStartPlan(tx: Transaction, command: Command, installation: typeof appInstallations.$inferSelect,
    owner: string, mode: OsAccessMode): Promise<RuntimePlan | null> {
    if (installation.status !== 'installed' || installation.uninstalledAt || installation.releaseId !== command.releaseId
        || installation.authGeneration !== command.authGeneration) return null;
    if (!await hasCurrentOsAccess(tx, owner, mode)) return null;
    const authority = await currentInstallationRelease(tx, installation, owner);
    if (!authority) return null;
    const { app, release } = authority;
    const services = await tx.select().from(appServices).where(and(eq(appServices.installationId, installation.id),
        eq(appServices.computerId, command.computerId))).for('share');
    const leases = await tx.select().from(appPortLeases).where(and(eq(appPortLeases.installationId, installation.id),
        eq(appPortLeases.computerId, command.computerId), isNull(appPortLeases.releasedAt))).for('share');
    const grants = await tx.select().from(appFolderGrants).where(and(eq(appFolderGrants.installationId, installation.id),
        eq(appFolderGrants.computerId, command.computerId), eq(appFolderGrants.grantedBy, owner), isNull(appFolderGrants.revokedAt))).for('share');
    try {
        const plan = compileRuntimePlan({ installationId: installation.id, app, release, services, leases, grants,
            projectId: selectedProject(command) });
        return sameRuntimePlan(plan, command.plan) ? plan : null;
    } catch (error) { if (error instanceof RuntimePlanError) return null; throw error; }
}

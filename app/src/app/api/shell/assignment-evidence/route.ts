import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { readEvidencePilot } from '@/server/assignment-evidence/contract';
import { evidenceJson, evidenceUnavailable, handleEvidenceRequest } from '@/server/assignment-evidence/http';
import { evidenceStore } from '@/server/assignment-evidence/store';
import { retainedIdentity } from '@/server/auth/retained-identity';
import { grantForStandaloneGit } from '@/server/git/access';
import { isCrossOriginWrite } from '@/utils/request-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

async function request(req: Request): Promise<Response> {
    const pilot = readEvidencePilot(process.env);
    if (!pilot || isCrossOriginWrite(req)) return evidenceUnavailable();

    try {
        const ctx = await createTRPCContext({ headers: new Headers(req.headers) });
        if (!ctx.user || ctx.delegation || ctx.user.id !== pilot.ownerId) return evidenceUnavailable();
        return await handleEvidenceRequest(req, {
            pilot,
            ownerId: ctx.user.id,
            store: evidenceStore(ctx.db),
            authorizeStart: async (target, signal) => {
                try {
                    // Recheck current owner and actual Git permissions for this exact scoped repository.
                    await appRouter.createCaller(ctx).computer.get({ id: target.computerId });
                    const identity = await retainedIdentity(target.ownerId);
                    const grant = await grantForStandaloneGit(identity, target.repositoryUrl, { signal });
                    return grant.repository.id === target.repositoryId && grant.repository.ref === target.ref
                        && grant.git.scope === 'write';
                } catch {
                    return false;
                }
            },
        });
    } catch {
        console.warn('[assignment-evidence] authorized staging request failed');
        return evidenceJson({ error: 'unavailable' }, 503);
    }
}

export { request as GET, request as POST };

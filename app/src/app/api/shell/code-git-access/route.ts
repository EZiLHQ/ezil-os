import { TRPCError } from '@trpc/server';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { retainedIdentity, clearProjectIdentity } from '@/server/auth/retained-identity';
import { grantForStandaloneGit, GitAccessError } from '@/server/git/access';
import { parseRepositoryUrl, repositoryIdFor } from '@/server/git/repo-url';
import { awsStandaloneGitEnabled, standaloneGitUrlEnabled } from '@/server/git/staging';
import { newCorrelationId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { controlTargetFor } from '@/server/lib/compute/aws-control-auth';
import { PlacementOwnerError, type PlacementExecutor } from '@/server/lib/compute/placement';
import { requestRepoOpen } from '@/server/lib/compute/repo-open';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

export const maxDuration = 70;
// The runtime stages/verifies the public CLI (up to 20 s), then requires at least 20 s for the operation.
const GIT_ACCESS_RUNTIME_TIMEOUT_MS = 50_000;
const refuse = (code: string, message: string, status: number) => shellJson({ error: { code, message } }, status);
const refreshIdentity = () => refuse('IDENTITY_REFRESH_REQUIRED', 'Reopen this repository to confirm your EZiL ID for Git.', 409);

/** Renew only an existing checkout on a running computer. Never mints a Code URL or starts a computer. */
export async function POST(req: Request) {
    try {
        const headers = new Headers(req.headers);
        headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({ headers });
        if (!ctx.user) return shellUnauthenticated();
        let body: unknown;
        try { body = await req.json(); } catch { return refuse('BAD_REQUEST', 'Expected a JSON body.', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).sort().join(',') !== 'computerId,repository') return refuse('BAD_REQUEST', 'Expected a computer and repository.', 400);
        const { computerId, repository } = body as { computerId: unknown; repository: unknown };
        if (typeof computerId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(computerId)
            || !repository || typeof repository !== 'object' || Array.isArray(repository)
            || Object.keys(repository).join(',') !== 'url') return refuse('BAD_REQUEST', 'Expected a computer and repository.', 400);
        const parsed = parseRepositoryUrl((repository as { url: unknown }).url);
        if (!parsed.ok || parsed.host !== 'github.ezil.work') return refuse('BAD_REQUEST', 'Use an EZiL Git repository address.', 400);
        const caller = appRouter.createCaller(ctx, { signal: req.signal });
        await caller.computer.get({ id: computerId });
        const computer = { userId: ctx.user.id, computerId };
        const target = async () => {
            try { return await controlTargetFor(ctx.db as unknown as PlacementExecutor, computer); }
            catch (error) {
                if (error instanceof PlacementOwnerError) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
                throw error;
            }
        };
        const controls = await target();
        if (!standaloneGitUrlEnabled() || (controls.auth.kind === 'v2' && controls.auth.claims.provider === 'aws-ec2'
            && !awsStandaloneGitEnabled())) return refuse('repo_url_not_enabled', 'Git access is not available on this computer.', 409);
        const identity = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!identity) return refreshIdentity();
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(65_000)]);
        let packet;
        try { packet = await grantForStandaloneGit(identity, parsed.canonicalURL, { signal }); }
        catch (error) {
            if (error instanceof GitAccessError && error.code === 'identity_refused') {
                await clearProjectIdentity().catch(() => {});
                return refreshIdentity();
            }
            if (error instanceof GitAccessError && error.code === 'not_found')
                return refuse('repo_not_found', 'Git access to this repository is no longer available.', 403);
            return refuse('repo_url_unavailable', 'Git access could not be renewed. Try again.', 503);
        }
        const current = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!current || current.sessionId !== identity.sessionId || current.subject !== identity.subject
            || current.issuer !== identity.issuer) return refreshIdentity();
        if (JSON.stringify(await target()) !== JSON.stringify(controls))
            return refuse('repo_access_not_renewed', 'This computer changed. Reopen the repository to reconnect Git.', 409);
        const config = resolveCloudflareGuacamoleConfig();
        const result = await requestRepoOpen(config.workerUrl, process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
            controls, computer, { repositoryId: repositoryIdFor(parsed.canonicalURL), canonicalURL: parsed.canonicalURL,
                ref: packet.repository.ref, git: packet.git, privatePacket: packet,
                ...(current.gitAuthor ? { gitAuthor: current.gitAuthor } : {}), refreshOnly: true, timeoutMs: GIT_ACCESS_RUNTIME_TIMEOUT_MS },
            { signal, correlationId: newCorrelationId(), awsStandaloneEnabled: awsStandaloneGitEnabled(), revalidateTarget: target });
        if (!result.ok) return refuse('repo_access_not_renewed', 'Git access could not be renewed. Reopen this repository to reconnect.', 409);
        if (JSON.stringify(await target()) !== JSON.stringify(controls))
            return refuse('repo_access_not_renewed', 'This computer changed. Reopen the repository to reconnect Git.', 409);
        return shellJson({ ok: true, scope: packet.git.scope, expiresAt: packet.git.expiresAt });
    } catch (error) { return shellErrorResponse(error, 'POST /api/shell/code-git-access'); }
}

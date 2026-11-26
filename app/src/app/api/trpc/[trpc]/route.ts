import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { isDelegationHeader } from '@/server/api/delegation-auth';
import { editorDelegationEnabled, editorMutationPath, MAX_EDITOR_DELEGATION_BYTES, type TrpcDelegationRequest } from '@/server/api/editor-delegation';
import { mcpIdentityBootstrapAudience, onboardingDelegationEnabled, onboardingMutationPath } from '@/server/api/onboarding-delegation';
import { appRouter } from '@/server/api/root';
import { mcpIdentityBootstrapPath } from '@/server/api/mcp-identity-bootstrap';
import { createTRPCContext } from '@/server/api/trpc';

/**
 * `maxDuration` is NOT inherited from any platform default — it must be
 * declared explicitly on the route or Vercel's default (10-15s) kills a
 * request before it finishes (docs/PLATFORM-NOTES.md §13). Set to 300s
 * because `cloudflareGuacamole.previewUrl` can involve a Cloudflare
 * container cold start (~22s typical, ~210s client-side abort budget — see
 * `server/lib/cloudflare-guacamole-provider.ts`) and this route must
 * outlive that budget, not race it.
 */
export const maxDuration = 300;

/**
 * Whether a request carries a body. A delegated read must not: its assertion binds the URL alone. Absent
 * Content-Length (or "0") and Transfer-Encoding with no stream means none.
 */
const hasBody = (req: Request) => req.body !== null || req.headers.has('transfer-encoding')
    || (req.headers.get('content-length') ?? '0') !== '0';

const route = (req: Request, delegationRequest: TrpcDelegationRequest) =>
    fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: appRouter,
        // The actual request line, for an `EZiL-Delegation` request only to bind against (GET reads). It does not
        // change cookie or Bearer handling.
        createContext: () => createTRPCContext({ headers: req.headers, delegationRequest }),
        onError:
            process.env.NODE_ENV === 'development'
                ? ({ path, error }) => {
                      console.error(`[tRPC] ${path ?? '<no-path>'} failed: ${error.message}`);
                  }
                : undefined,
    });

async function readDelegatedBody(req: Request): Promise<Uint8Array | undefined> {
    if (!req.body || Number(req.headers.get('content-length') ?? 0) > MAX_EDITOR_DELEGATION_BYTES) return;
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks);
            size += value.byteLength;
            if (size > MAX_EDITOR_DELEGATION_BYTES) return;
            chunks.push(value);
        }
    } catch {
        return;
    } finally {
        void reader.cancel().catch(() => {});
    }
}

const handler = async (req: Request) => {
    const line = { method: req.method, url: req.url, hasBody: hasBody(req) };
    if (req.method !== 'POST' || !isDelegationHeader(req.headers.get('authorization'))) return route(req, line);
    const url = new URL(req.url);
    const signedMutation = (editorDelegationEnabled(process.env) && editorMutationPath(url))
        || (onboardingDelegationEnabled(process.env) && onboardingMutationPath(url))
        || (mcpIdentityBootstrapAudience(process.env) && mcpIdentityBootstrapPath(url));
    if (!signedMutation) return route(req, line);
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers.get('content-type') ?? '')) {
        return Response.json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } }, { status: 415 });
    }
    const bytes = await readDelegatedBody(req);
    if (!bytes?.byteLength) return Response.json({ error: { code: 'PAYLOAD_TOO_LARGE' } }, { status: 413 });
    const bounded = new Request(req.url, { method: req.method, headers: req.headers, body: Buffer.from(bytes) });
    return route(bounded, { ...line, editorBody: bytes });
};

export { handler as GET, handler as POST };

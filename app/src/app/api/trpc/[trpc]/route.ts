import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { DELEGATION_MAX_BODY_BYTES, isDelegationHeader } from '@/server/api/delegation-auth';
import { appRouter } from '@/server/api/root';
import { createTRPCContext, type DelegationRequest } from '@/server/api/trpc';

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

/** The body, read with a hard byte limit whatever Content-Length says; null when it is over. */
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
    if (Number(req.headers.get('content-length') ?? 0) > max) return null;
    if (!req.body) return new Uint8Array();
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks);
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
}

const route = (req: Request, acceptDelegation: DelegationRequest) =>
    fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: appRouter,
        // The one transport that may accept an EZiL MCP delegation, bound to this request line
        // (and a POST's exact bytes); every call here passes `delegationGate` (see `createTRPCContext`).
        createContext: () => createTRPCContext({ headers: req.headers, acceptDelegation }),
        onError:
            process.env.NODE_ENV === 'development'
                ? ({ path, error }) => {
                      console.error(`[tRPC] ${path ?? '<no-path>'} failed: ${error.message}`);
                  }
                : undefined,
    });

/**
 * A delegated POST is bound to its exact raw body (`inp`). Its body is read
 * here, at most DELEGATION_MAX_BODY_BYTES however the length is declared (or
 * not), and tRPC then parses exactly those bytes, so nothing larger is ever
 * buffered for a delegated caller. Other requests are untouched.
 */
const handler = async (req: Request) => {
    const request: DelegationRequest = { method: req.method, url: req.url, contentType: req.headers.get('content-type') };
    if (req.method !== 'POST' || !isDelegationHeader(req.headers.get('authorization'))) return route(req, request);
    let raw: Uint8Array | null;
    try {
        raw = await readBounded(req, DELEGATION_MAX_BODY_BYTES);
    } catch {
        raw = null;
    }
    if (raw === null) return Response.json({ error: { code: 'PAYLOAD_TOO_LARGE' } }, { status: 413 });
    const bounded = new Request(req.url, { method: 'POST', headers: req.headers, body: Buffer.from(raw) });
    return route(bounded, { ...request, raw });
};

export { handler as GET, handler as POST };

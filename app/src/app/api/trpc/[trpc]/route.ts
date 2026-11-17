import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { appRouter } from '@/server/api/root';
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

const handler = (req: Request) =>
    fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: appRouter,
        // The actual request line, for an `EZiL-Delegation` request only to bind against (GET reads). It does not
        // change cookie or Bearer handling.
        createContext: () => createTRPCContext({ headers: req.headers, delegationRequest: { method: req.method, url: req.url, hasBody: hasBody(req) } }),
        onError:
            process.env.NODE_ENV === 'development'
                ? ({ path, error }) => {
                      console.error(`[tRPC] ${path ?? '<no-path>'} failed: ${error.message}`);
                  }
                : undefined,
    });

export { handler as GET, handler as POST };

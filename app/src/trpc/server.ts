import 'server-only';

import { headers } from 'next/headers';
import { cache } from 'react';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';

/**
 * Server-side tRPC caller for Server Components — calls procedures
 * in-process (no HTTP round trip), reusing the same context/router the
 * `/api/trpc` route handler builds for the browser.
 */
const createContext = cache(async () => {
    const heads = new Headers(await headers());
    heads.set('x-trpc-source', 'rsc');
    return createTRPCContext({ headers: heads });
});

export const api = appRouter.createCaller(createContext);

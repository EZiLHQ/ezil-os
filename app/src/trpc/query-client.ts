import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';

import { retryTransientOnly } from './retry-policy';

/**
 * One `QueryClient` factory shared by the browser provider (`react.tsx`)
 * and the RSC prefetch helper — kept in its own module so both sides use
 * identical defaults (in particular the superjson (de)hydration, so a
 * `Date` field like `lastOpenedAt` survives the server -> client handoff).
 */
export function makeQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30 * 1000,
                // Retry only what a second identical attempt could fix. The
                // library default (`retry: 3`) retries deterministic 4xx
                // failures too — so e.g. an expired session on
                // `computer.list` spent four attempts and ~7s of backoff
                // before "Session expired" reached the screen. Same budget,
                // applied only to transient failures. See ./retry-policy.ts.
                retry: retryTransientOnly(),
            },
            dehydrate: {
                serializeData: superjson.serialize,
                shouldDehydrateQuery: (query) =>
                    defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
            },
            hydrate: {
                deserializeData: superjson.deserialize,
            },
        },
    });
}

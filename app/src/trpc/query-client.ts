import { defaultShouldDehydrateQuery, QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';

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

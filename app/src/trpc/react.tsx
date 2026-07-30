'use client';

import { useState } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { httpBatchLink, loggerLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import superjson from 'superjson';

import type { AppRouter } from '@/server/api/root';
import { makeQueryClient } from './query-client';

export const api = createTRPCReact<AppRouter>();

let clientQueryClientSingleton: QueryClient | undefined;

/** Server always makes a new client; the browser reuses one singleton. */
function getQueryClient() {
    if (typeof window === 'undefined') {
        return makeQueryClient();
    }
    clientQueryClientSingleton ??= makeQueryClient();
    return clientQueryClientSingleton;
}

function getBaseUrl() {
    if (typeof window !== 'undefined') return '';
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return 'http://localhost:3000';
}

export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
    const queryClient = getQueryClient();

    const [trpcClient] = useState(() =>
        api.createClient({
            links: [
                loggerLink({
                    enabled: (op) =>
                        process.env.NODE_ENV === 'development' ||
                        (op.direction === 'down' && op.result instanceof Error),
                }),
                httpBatchLink({
                    url: `${getBaseUrl()}/api/trpc`,
                    transformer: superjson,
                }),
            ],
        }),
    );

    return (
        <QueryClientProvider client={queryClient}>
            <api.Provider client={trpcClient} queryClient={queryClient}>
                {children}
            </api.Provider>
        </QueryClientProvider>
    );
}

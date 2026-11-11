import { agentSessionRouter } from './routers/agent-session';
import { billingRouter } from './routers/billing';
import { cloudflareGuacamoleRouter } from './routers/cloudflare-guacamole';
import { computerRouter } from './routers/computer';
import { createCallerFactory, createTRPCRouter } from './trpc';

export const appRouter = createTRPCRouter({
    agentSession: agentSessionRouter,
    billing: billingRouter,
    computer: computerRouter,
    cloudflareGuacamole: cloudflareGuacamoleRouter,
});

export type AppRouter = typeof appRouter;

/** Server-side caller factory — used by RSC/server components (src/trpc/server.ts). */
export const createCaller = createCallerFactory(appRouter);

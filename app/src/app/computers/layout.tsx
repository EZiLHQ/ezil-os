import { type Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { createTRPCContext } from '@/server/api/trpc';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';

export const metadata: Metadata = {
    title: 'EZiL OS — Your computers',
    description: 'Your computers',
};

/**
 * Auth gate for `/computers`. Unauthenticated visitors are bounced to
 * `/login` with a `returnUrl` back to `/computers`.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computers/layout.tsx`
 * (authored post-Onlook-import, listed as safe to carry).
 *
 * 🔴 Resolved through `createTRPCContext` rather than a second
 * `createClient()` + `getUser()` of its own. That is the same one auth round
 * trip this layout already paid (`createTRPCContext` does exactly that call),
 * and it means the page gate and `protectedProcedure` resolve the caller the
 * same way — see `server/api/trpc.ts`.
 */
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
    const headersList = await headers();
    const ctx = await createTRPCContext({ headers: new Headers(headersList) });

    if (!ctx.user) {
        const pathname = headersList.get('x-pathname') || Routes.COMPUTERS;
        redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(pathname)}`);
    }

    return <>{children}</>;
}

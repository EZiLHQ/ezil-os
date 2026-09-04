import { type Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { OS_ACCESS_NOT_INVITED } from '@/server/api/os-access';
import { createTRPCContext } from '@/server/api/trpc';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';

export const metadata: Metadata = {
    title: 'EZiL OS — Your computers',
    description: 'Your computers',
};

/**
 * Auth + access gate for `/computers`. Unauthenticated visitors are bounced to
 * `/login` with a `returnUrl` back to `/computers`; signed-in visitors who are
 * not on the EZiL OS allow-list are bounced to `/login?error=not_invited`.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computers/layout.tsx`
 * (authored post-Onlook-import, listed as safe to carry).
 *
 * 🔴 Resolved through `createTRPCContext` rather than a second
 * `createClient()` + `getUser()` of its own. That is the same one auth round
 * trip this layout already paid (`createTRPCContext` does exactly that call),
 * and it means the page gate and `protectedProcedure` read the SAME access
 * decision from the same implementation. A layout that re-derived "is this
 * person allowed" locally is how a second authorization implementation gets
 * born — see `server/api/trpc.ts`.
 *
 * 🔴 Two redirects, two reasons, and they are not interchangeable. Sending a
 * refused-but-signed-in user to `?returnUrl=/computers` would send them back
 * here the moment they signed in again — a loop. `/login` renders for a
 * signed-in user (it performs no redirect of its own), so `?error=not_invited`
 * terminates.
 */
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
    const headersList = await headers();
    const ctx = await createTRPCContext({ headers: new Headers(headersList) });

    if (!ctx.user) {
        const pathname = headersList.get('x-pathname') || Routes.COMPUTERS;
        redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(pathname)}`);
    }

    if (!(await ctx.access()).allowed) {
        redirect(`${Routes.LOGIN}?error=${OS_ACCESS_NOT_INVITED}`);
    }

    return <>{children}</>;
}

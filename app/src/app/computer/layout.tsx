import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { OS_ACCESS_NOT_INVITED } from '@/server/api/os-access';
import { createTRPCContext } from '@/server/api/trpc';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';

/**
 * Auth + access gate for `/computer/*`. Unauthenticated visitors are bounced
 * to login, and signed-in visitors who are not on the EZiL OS allow-list to
 * `/login?error=not_invited`, before the per-computer ownership check in
 * `[id]/page.tsx` ever runs.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computer/layout.tsx`
 * (authored post-Onlook-import, listed as safe to carry).
 *
 * 🔴 Resolved through `createTRPCContext`, for the same reason as
 * `../computers/layout.tsx`: one authorization implementation, one auth round
 * trip, and the decision this layout reads is the decision
 * `protectedProcedure` will read.
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

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { createTRPCContext } from '@/server/api/trpc';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';

/**
 * Auth gate for `/computer/*`. Unauthenticated visitors are bounced to login
 * before the per-computer ownership check in `[id]/page.tsx` ever runs.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computer/layout.tsx`
 * (authored post-Onlook-import, listed as safe to carry).
 *
 * 🔴 Resolved through `createTRPCContext`, for the same reason as
 * `../computers/layout.tsx`: one auth round trip, resolved the same way
 * `protectedProcedure` resolves it.
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

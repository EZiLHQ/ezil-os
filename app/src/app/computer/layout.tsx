import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { Routes, getReturnUrlQueryParam } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * Auth gate for `/computer/*`. Unauthenticated visitors are bounced to
 * login before the per-computer ownership check in `[id]/page.tsx` ever
 * runs.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computer/layout.tsx`
 * (authored post-Onlook-import, listed as safe to carry).
 */
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
    const supabase = await createClient();
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    if (error || !user) {
        const headersList = await headers();
        const pathname = headersList.get('x-pathname') || Routes.COMPUTERS;
        redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(pathname)}`);
    }

    return <>{children}</>;
}

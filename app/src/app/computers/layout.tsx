import { type Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { Routes, getReturnUrlQueryParam } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

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
 */
export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
    const supabase = await createClient();
    const {
        data: { user: authUser },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !authUser) {
        const headersList = await headers();
        const pathname = headersList.get('x-pathname') || Routes.COMPUTERS;
        redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(pathname)}`);
    }

    return <>{children}</>;
}

import { notFound } from 'next/navigation';

import { isShellAppId } from '@/utils/constants';
import OsPage from '../../os/page';

/**
 * `/app/<appId>` — the EZiL OS shell, opened at one app (docs/APP-ROUTES.md).
 *
 * The SAME document as `/os`, rendered by `/os`'s own page: same boot
 * payload, same sign-in gate, same `?computer=` handling, same hydration
 * contract. It is not a redirect, because the path is the point: the shell
 * reads `/app/code` and opens Code, a reload stays on it, and Back/Forward
 * move between apps. The shell rewrites the older `/os?app=<id>` to this
 * form in place.
 *
 * An id the shell registry does not know is a 404 here, before any session
 * lookup. A known id that this boot cannot show (a native-only app on the
 * web) renders the shell with nothing opened, exactly as `/os?app=<id>` did.
 *
 * Route segment config is declared here, not inherited from the imported
 * page: Next reads it from this file.
 */

export const metadata = {
    title: 'EZiL OS',
    description: 'Your computer, in your browser.',
};

/** Never prerender or cache: the payload is per-user and can create a row. */
export const dynamic = 'force-dynamic';

export default async function AppPage({ params, searchParams }: {
    params: Promise<{ appId: string }>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { appId } = await params;
    if (!isShellAppId(appId)) notFound();
    return OsPage({ params: Promise.resolve({ appId }), searchParams });
}

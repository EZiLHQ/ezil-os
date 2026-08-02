import { redirect } from 'next/navigation';

import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * `/` has no content of its own — this app has no marketing page or chat
 * editor to land on. An authenticated visitor goes straight to their
 * computers; anyone else goes to `/login`.
 *
 * 🔴 Deliberately still `Routes.COMPUTERS`, NOT `Routes.OS`, even though
 * login itself now defaults there (see `safeReturnUrl`). This route is
 * reachable by a client-side `<Link href={Routes.HOME}>` — the logo on
 * `/login` — so a `redirect()` here runs as an App Router soft navigation
 * for anyone who lands on it that way, not a document load. `/os` is a
 * separate application delivered as `<script src>` tags that only execute on
 * a real document load (see `login/actions.ts` and docs/PLATFORM-NOTES.md
 * §17); sending an authenticated visitor here to `Routes.OS` would reproduce
 * that dead-page defect from a link this file does not control. `/computers`
 * is a plain React route, so a soft nav to it is harmless. If `/` ever needs
 * to land on `/os` too, fix the sender (e.g. drop the `<Link>` on `/login`
 * for a real `<a>`) before changing this line, not after.
 */
export default async function HomePage() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    redirect(user ? Routes.COMPUTERS : Routes.LOGIN);
}

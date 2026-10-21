import { redirect } from 'next/navigation';

import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * `/` has no content of its own — this app has no marketing page or chat
 * editor to land on. An authenticated visitor goes straight into their OS;
 * anyone else goes to `/login`.
 *
 * 🔴 Now `Routes.OS`, matching login's own default (see `safeReturnUrl`).
 * This used to be deliberately `Routes.COMPUTERS` instead: the only known
 * client-side sender to `/` was `<Link href={Routes.HOME}>` — the logo on
 * `/login` — and a `redirect()` here runs as an App Router SOFT navigation
 * for anyone who lands on it that way, not a document load. `/os` is a
 * separate application delivered as `<script src>` tags that only execute on
 * a real document load (see `login/actions.ts` and docs/PLATFORM-NOTES.md
 * §17), so sending a soft-nav visitor to `Routes.OS` used to reproduce that
 * dead-page defect.
 *
 * That sender is now fixed: `/login`'s logo is a plain `<a href={Routes.HOME}>`
 * (see `login/page.tsx`), so reaching `/` always means a real document load,
 * and this redirect always executes as one too — there is no other known
 * client-side path to `/`. `entry-contract.test.ts` pins that the logo stays
 * an `<a>`, not a `<Link>`; if it is ever converted back, that test fails
 * before this route can regress into the dead-page defect again.
 * `/computers` remains reachable as the escape hatch from `/os` and
 * `/computer/[id]`, just no longer the default landing spot for `/`.
 */
export default async function HomePage() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    redirect(user ? Routes.OS : Routes.LOGIN);
}

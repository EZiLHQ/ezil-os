import { redirect } from 'next/navigation';

import { auth0Enabled } from '@/server/auth/auth0';
import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

import { couponBillingPath } from './coupon-entry';

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
// No parameter default: Next's generated PageProps check refuses a props type that admits `undefined`.
export default async function HomePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    // A promoter link goes straight to Billing: signed in, there; signed out, through the normal EZiL ID sign-in
    // that returns there, with no separate landing page. See `coupon-entry.ts`.
    const billing = couponBillingPath(searchParams ? await searchParams : undefined);
    if (billing !== null) {
        if (user) redirect(billing);
        const query = new URLSearchParams({ returnUrl: billing });
        redirect(auth0Enabled() ? `/auth/auth0/login?${query}` : `${Routes.LOGIN}?${query}`);
    }

    redirect(user ? Routes.OS : Routes.LOGIN);
}

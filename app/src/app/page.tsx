import { redirect } from 'next/navigation';

import { readBillingConfig } from '@/server/billing/config';
import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';
import MarketingHome from './(marketing)/_components/home-page';

export const dynamic = 'force-dynamic';

/**
 * Signed-in visitors still enter their OS. The public home page is opt-in,
 * read per request so an unset flag preserves the original login redirect.
 *
 * 🔴 WHY THE PLAIN-ANCHOR RULE MATTERS HERE. `/os` is a separate application
 * delivered as `<script src>` tags that only execute on a real document load
 * (`login/actions.ts`, docs/PLATFORM-NOTES.md §17). A `redirect()` reached by
 * App Router SOFT navigation (e.g. a `<Link href="/">`) would land a signed-in
 * visitor on a dead `/os` page — the defect `entry-contract.test.ts` pins
 * against by requiring every link to `/`, `/os` and `/login` (login logo,
 * home and pricing CTAs) to be a plain `<a>`.
 *
 * Entry links must stay plain anchors: the shell's script tags only execute
 * on a document load, so a Next soft navigation through this redirect would
 * leave the OS blank. The sender-side tests pin that contract.
 */
export default async function HomePage() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (user) redirect(Routes.OS);

    const config = readBillingConfig();
    if (!config.pricingPageEnabled) redirect(Routes.LOGIN);

    return <MarketingHome largeStorageEnabled={config.largeStorageEnabled} />;
}

import { redirect } from 'next/navigation';

import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * `/` has no content of its own — this app has no marketing page or chat
 * editor to land on. An authenticated visitor goes straight to their
 * computers; anyone else goes to `/login`.
 */
export default async function HomePage() {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    redirect(user ? Routes.COMPUTERS : Routes.LOGIN);
}

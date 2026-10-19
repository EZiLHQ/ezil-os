import { notFound } from 'next/navigation';

import OsPage from '../../os/page';

/**
 * `/app/<name>` — open EZiL OS with one app in front.
 *
 * The document is exactly `/os` (same boot payload, hydration handshake and
 * watchdog: it renders that page). Which app opens is the shell's decision,
 * made once from the URL in `shell/ezil/deep-link.js`, and only for an app
 * this computer offers; the shell then shows `/os` in the address bar. A
 * signed-out visitor goes through `/login` and comes back here with the query
 * intact (see `os/page.tsx`); a Works launch code in the fragment does not
 * survive a Google sign-in, which is the contract's "open again from Works".
 *
 * This route only rejects names that cannot be a registry id, so a typo is an
 * honest 404 rather than a desktop that silently opened nothing.
 */
export const metadata = {
    title: 'EZiL OS',
    description: 'Your computer, in your browser.',
};

/** Never prerender or cache: the payload is per-user and can create a row. */
export const dynamic = 'force-dynamic';

/** Lowercase words joined by single hyphens, as in `shell/ezil/apps/registry.js`'s `APPS`. */
const APP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
    const { name } = await params;
    if (name.length > 40 || !APP_ID.test(name)) notFound();
    return <OsPage />;
}

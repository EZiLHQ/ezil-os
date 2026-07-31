import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { bootPayloadScript, buildShellBootPayload } from '@/server/shell/boot-payload';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';

/**
 * `/os` — the host page for the EZiL OS shell.
 *
 * It renders a document, not an application. Everything a user sees after the
 * first paint is drawn by `public/os/bundle.min.js` (built from `shell/` — a
 * fork of Puter's GUI, see ATTRIBUTIONS.md); this file's entire job is to put
 * that bundle on screen fast and hand it a boot payload so it never has to ask
 * the server who the user is.
 *
 * ── The budget: paint in under 200ms ────────────────────────────────────────
 * The rule that makes it achievable is that this page NEVER AWAITS THE
 * CONTAINER. A cold desktop boot is ~22s (docs/PLATFORM-NOTES.md §11), so any
 * page that waits for `cloudflareGuacamole.previewUrl` before its first byte
 * is a page with a 22-second TTFB. This page calls only:
 *
 *   - `computer.getOrCreateDefault` — one indexed read for a returning user;
 *   - `cloudflareGuacamole.isConfigured` — a pure environment-variable read,
 *     no network at all;
 *
 * and it runs them CONCURRENTLY with the session lookup, so the wall clock is
 * one Supabase auth round trip plus one database round trip, not three in
 * series. Booting the desktop is the shell's job, over
 * `POST /api/shell/desktop`, after the page is already on screen.
 *
 * ── Two known costs, both deliberate ────────────────────────────────────────
 * 1. This page inherits the root layout (`src/app/layout.tsx`), so React and
 *    `TRPCReactProvider` are still shipped and hydrated even though this page
 *    has no client component of its own. Removing them means giving `/os` its
 *    own root layout, which in Next's App Router requires moving EVERY route
 *    into route groups — a change that touches `/computers` and
 *    `/computer/[id]`, which have to keep working as the fallback. It is the
 *    right follow-up, but not a change to make in the same breath as landing
 *    the shell.
 * 2. `<script src>` tags rendered by React execute on a real document load,
 *    but NOT when React inserts them during a client-side navigation. So the
 *    entry point into `/os` must be a full page load (a plain `<a href>` or a
 *    redirect), never a `<Link>` prefetch-and-swap. Nothing links here yet;
 *    whoever flips the entry point owns that constraint.
 */

export const metadata = {
    title: 'EZiL OS',
    description: 'Your computer, in your browser.',
};

/** Never prerender or cache: the payload is per-user and can create a row. */
export const dynamic = 'force-dynamic';

export default async function Page() {
    // The tRPC context is built here rather than reusing `src/trpc/server.ts`'s
    // `api` for one reason: this page needs the resolved user for the payload
    // AND for the auth gate, and `createTRPCContext` has already resolved it.
    // Going through `api` would mean a SECOND, independent
    // `supabase.auth.getUser()` — a whole extra network round trip to Supabase
    // Auth, on a page whose entire budget is 200ms. Same context, same
    // `protectedProcedure`, same ownership filters; just resolved once.
    const heads = new Headers(await headers());
    heads.set('x-trpc-source', 'rsc-os');
    const ctx = await createTRPCContext({ headers: heads });

    if (!ctx.user) {
        // Same gate as `src/app/computers/layout.tsx` and
        // `src/app/computer/layout.tsx`. The pathname is known statically here,
        // so it is used directly rather than read back from `x-pathname`.
        redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(Routes.OS)}`);
    }
    const user = ctx.user;
    const caller = appRouter.createCaller(ctx);

    // Concurrently, and neither touches a container: `getOrCreateDefault` is
    // one indexed read for a returning user, `isConfigured` reads environment
    // variables and returns.
    const [computerResult, providerResult] = await Promise.all([
        caller.computer.getOrCreateDefault().catch((err: unknown) => {
            console.error('[os] could not open a computer', {
                userId: user.id,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }),
        // A provider lookup failure is NOT fatal: the shell renders its honest
        // "desktop not configured" state and the page still paints.
        caller.cloudflareGuacamole.isConfigured().catch(() => null),
    ]);

    if (!computerResult) {
        // Signed in, but we could not produce a computer. Say so and send them
        // to the list, which is the fallback surface and does not depend on
        // any of this. Rendering the shell with no computer would be a desktop
        // that can never connect to anything.
        return <CouldNotOpen />;
    }

    const payload = buildShellBootPayload({
        user,
        computer: computerResult.computer,
        isNew: computerResult.created,
        provider: providerResult,
    });

    return (
        <>
            {/*
              * A plain <link>, not a bundler `import`, because this file is a
              * build output of `shell/build-shell.sh` served from `public/` —
              * it is versioned with the shell, not with Next's CSS pipeline,
              * and importing it would inject the whole desktop's stylesheet
              * into the app's shared chunk. `precedence` lets React 19 hoist
              * it into <head>, so the fetch starts with the document rather
              * than after the body is parsed.
              */}
            {/* eslint-disable-next-line @next/next/no-css-tags */}
            <link rel="stylesheet" href="/os/bundle.min.css" precedence="default" />

            {/*
              * The shell's mount point. `suppressHydrationWarning` because the
              * bundle below may populate this element BEFORE React hydrates —
              * from React's point of view the server HTML and the live DOM
              * would then disagree, and that disagreement is the intended
              * behaviour here, not a bug to warn about.
              */}
            <div id="ezil-os-root" suppressHydrationWarning />

            {/*
              * Order is load-bearing: the payload must exist before the bundle
              * runs, and the icons before the bundle that draws them. The
              * inline script executes during parse, and `defer` preserves
              * document order between the two external ones while keeping
              * them off the parser's critical path. NOT `async` — `async`
              * would let the bundle run before its icons.
              */}
            <script dangerouslySetInnerHTML={{ __html: bootPayloadScript(payload) }} />
            <script src="/os/icons.js" defer />
            <script src="/os/bundle.min.js" defer />
        </>
    );
}

function CouldNotOpen() {
    return (
        <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-black p-4 text-center text-offwhite">
            <h1 className="text-2xl font-semibold">Couldn&apos;t open your computer</h1>
            <p className="text-gray-400">
                We couldn&apos;t reach your computer just now. Your files are unaffected — try again,
                or open it from your list.
            </p>
            <Link
                href={Routes.COMPUTERS}
                className="inline-flex items-center gap-2 rounded-md bg-teal px-4 py-2 text-sm font-medium text-black hover:opacity-90"
            >
                Your computers
            </Link>
        </main>
    );
}

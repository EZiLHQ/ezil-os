import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { appRouter } from '@/server/api/root';
import { OS_ACCESS_NOT_INVITED } from '@/server/api/os-access';
import { createTRPCContext } from '@/server/api/trpc';
import { bootPayloadScript, buildShellBootPayload } from '@/server/shell/boot-payload';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';
import { BootWatchdog } from './boot-watchdog';
import { HydrationSignal } from './hydration-signal';

/**
 * `/os` — the host page for the EZiL OS shell.
 *
 * It renders a document, not an application. Everything a user sees after the
 * first paint is drawn by `public/os/bundle.min.js` (built from `shell/` — a
 * fork of Puter's GUI, see ATTRIBUTIONS.md); this file's entire job is to put
 * that bundle on screen fast and hand it a boot payload so it never has to ask
 * the server who the user is.
 *
 * ── The budget, and what it actually costs ──────────────────────────────────
 * The rule that keeps it bounded is that this page NEVER AWAITS THE CONTAINER.
 * A cold desktop boot is ~22s (docs/PLATFORM-NOTES.md §11), so any page that
 * waits for `cloudflareGuacamole.previewUrl` before its first byte is a page
 * with a 22-second TTFB. This page calls only:
 *
 *   - `computer.getOrCreateDefault` — one indexed read for a returning user;
 *   - `cloudflareGuacamole.isConfigured` — a pure environment-variable read,
 *     no network at all;
 *
 * concurrently with each other (they cannot start before the session lookup —
 * both need the resolved user), so the wall clock is one Supabase auth round
 * trip plus one database round trip, not three in series. Booting the desktop
 * is the shell's job, over `POST /api/shell/desktop`, after the page is
 * already on screen.
 *
 * 🔴 MEASURED, `next start` on the dev host, median of 8 warm loads, an aim of
 * <200ms: TTFB 414ms; desktop + taskbar + window on screen at 488ms. The two
 * remaining terms are both pure network and both irreducible in this file:
 * `supabase.auth.getUser()` is 154ms and the computer lookup is 240ms against
 * a Supabase instance a long way from this host (a bare `select 1` on the same
 * pool is 120ms). 154 + 240 accounts for 394ms of the 414ms.
 *
 * So <200ms is NOT reachable here by rearranging awaits — the arithmetic is
 * out of room. It needs one of: local JWT verification instead of the Auth
 * round trip (this project already issues ES256 tokens, so
 * `supabase.auth.getClaims()` would verify in-process — a change to the app's
 * revocation semantics, not to this page); a cached/co-located database; or an
 * app deployed in the database's region, where that 240ms is single digits.
 * Do not claim the target is met until one of those has been measured.
 *
 * 🔴 THAT 414ms IS STALE, AND KNOWINGLY SO. It was measured before the access
 * gate below existed. The gate adds ONE MORE SERIAL database round trip — a
 * primary-key read of `ezil_os_access` that cannot be folded into the
 * `Promise.all`, because its whole purpose is to happen before the call that
 * writes. On the same host that made `select 1` cost 120ms, expect roughly
 * that much on top; in `open` mode it costs nothing at all (the mode
 * short-circuits before any query — see `server/api/os-access.ts`). Nobody has
 * re-measured the number, so treat 414ms as a floor, not as the current
 * figure, and re-measure before quoting it.
 *
 * ── Three known costs, all deliberate ───────────────────────────────────────
 * 1. This page inherits the root layout (`src/app/layout.tsx`), so React and
 *    `TRPCReactProvider` are still shipped and hydrated even though this page
 *    has no UI of its own. That is what makes the hydration handshake below
 *    necessary. Removing them means giving `/os` its own root layout, which in
 *    Next's App Router requires moving EVERY route into route groups — a
 *    change that touches `/computers` and `/computer/[id]`, which have to keep
 *    working as the fallback. It is the right follow-up, but not a change to
 *    make in the same breath as landing the shell.
 * 2. 🔴 React hydrates this document, and until it has, the shell may not
 *    touch `<body>` or `#ezil-os-root`. See the mount point below and
 *    `hydration-signal.tsx`. This is not a style preference: getting it wrong
 *    produced a permanently blank page on 4 of 5 loads under load.
 * 3. 🔴 `<script src>` tags rendered by React execute on a real document load,
 *    but NOT when React inserts them during a client-side navigation. So the
 *    entry point into `/os` must be a full page load, never a `<Link>`
 *    prefetch-and-swap and never a server action's `redirect()` (which the
 *    App Router performs as a client-side navigation — this is what broke
 *    `/login?returnUrl=%2Fos`; see docs/PLATFORM-NOTES.md §17).
 *
 *    That constraint is now enforced in two independent places, because one
 *    of them is a convention and conventions do not survive contact with a
 *    new contributor:
 *      - the SENDERS use document loads. `login/actions.ts` returns the
 *        destination instead of redirecting to it and the form navigates with
 *        `window.location.assign`; `/auth/callback` is a route handler whose
 *        302 the browser follows itself.
 *      - the ARRIVAL checks. `<BootWatchdog>` below notices a page that was
 *        entered by a client-side navigation and has no boot payload, and
 *        reloads exactly once — and if the shell still does not appear, it
 *        SAYS SO instead of leaving the wallpaper up. A future `<Link>` here
 *        would cost one reload, not a dead page.
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

    /*
     * 🔴 THE ACCESS GATE, AND ITS POSITION IS THE POINT.
     *
     * `getOrCreateDefault` below is a MUTATION: for a user with no computer it
     * inserts one. So this check cannot live after it, cannot live inside the
     * `Promise.all`, and cannot be folded into the `catch` that turns a failed
     * lookup into `<CouldNotOpen />` — every one of those orders creates a
     * computer row for a principal who may not use the product, and then tells
     * them no. MEASURED with the check removed (`trpc-access.test.ts`'s
     * mutation): a refused stranger's request reaches
     * `select ... from "ezil_computers" ... order by slot` — the first step of
     * `getOrCreateDefaultComputer`, whose next step on an empty result is the
     * insert.
     *
     * `ctx.access()` is the same single implementation `protectedProcedure`
     * uses, memoised on this context — so the two `caller.*` calls below reuse
     * this decision rather than re-querying (`server/api/trpc.ts`). A refused
     * user would be refused by them anyway; this gate is what stops the
     * refusal happening AFTER the write.
     */
    if (!(await ctx.access()).allowed) {
        redirect(`${Routes.LOGIN}?error=${OS_ACCESS_NOT_INVITED}`);
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
              * The shell's mount point — and its wallpaper, rendered here on
              * the server rather than appended by the bundle.
              *
              * 🔴 `data-awaits-hydration="react"` is a CONTRACT, not a hint.
              * It tells the shell that this page is a React document and that
              * it must not touch `<body>` or this element until
              * `<HydrationSignal>` below says React has committed. Without the
              * handshake the shell mutates first, React finds a tree it did
              * not render, reports minified error #418 and REGENERATES THE
              * WHOLE TREE — deleting the desktop and leaving a blank white
              * page. MEASURED on this production build with 900ms of latency
              * on `/_next/static/chunks/**`: 4 of 5 loads destroyed.
              * `suppressHydrationWarning` suppresses the warning, not the
              * regeneration; it is kept only to silence the innerHTML compare.
              *
              * `dangerouslySetInnerHTML` (with a constant string) is how React
              * is told this subtree is not its business: an element with it
              * gets no child fibers, so React neither hydrates nor reconciles
              * whatever the shell builds inside. The markup itself is the
              * `.desktop.ezil-desktop` root the shell would otherwise create —
              * `mount_desktop_root()` in `shell/ezil/boot.js` adopts an
              * existing one — so the wallpaper is painted from the HTML, with
              * no JavaScript at all, instead of after the 616KB bundle runs.
              * 🔴 The class pair is duplicated from `shell/ezil/ui/
              * ezil-shell.css`; change it here and there together.
              */}
            <div
                id="ezil-os-root"
                data-awaits-hydration="react"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{ __html: '<div class="desktop ezil-desktop"></div>' }}
            />
            <HydrationSignal />

            {/*
              * 🔴 The wallpaper above is served whether or not the shell ever
              * boots, so on its own it is a full-screen claim that the OS is
              * on its way — the same "asserting health it has not confirmed"
              * failure this project closed on the desktop frame. This is what
              * makes that claim falsifiable: it draws nothing while the boot
              * is working, and replaces the silence with a real, worded
              * failure and a way out if it is not. Renders `null` until then.
              */}
            <BootWatchdog />

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

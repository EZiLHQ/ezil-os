import Link from 'next/link';

import { OS_ACCESS_NOT_INVITED } from '@/server/api/os-access';
import { MAX_COMPUTERS_PER_USER, RETURN_URL_PARAM, Routes, safeReturnUrl } from '@/utils/constants';
import { signOut } from './actions';
import { DesktopVisual } from './desktop-visual';
import { LoginForm } from './login-form';

/**
 * `/login` — re-skinned per EBuilder's `ezil-login` worktree (commit
 * 912247a): sells "your computer, in your browser" instead of the pre-pivot
 * "AI builds your app" pitch, and deliberately avoids promising a populated
 * workspace (a new computer boots empty). Design/copy carried; the
 * component tree, auth wiring, and styling primitives are written fresh for
 * this repo's own (much smaller) dependency surface.
 *
 * 🔴 The logo below is a plain `<a href={Routes.HOME}>`, NOT a `<Link>`.
 * `/` now redirects an authenticated visitor into `Routes.OS`, and `/os`
 * only boots on a real document load (see `page.tsx` at the root and
 * `login/entry-contract.test.ts`). A Next `<Link>` here would turn that
 * redirect into an App Router soft navigation, which never executes `/os`'s
 * `<script src>` tags — the exact dead-page defect this repo already fixed
 * once for the sign-in path. Keep this an `<a>`; `entry-contract.test.ts`
 * fails if it becomes a `<Link>` again.
 *
 * 🔴 THIS PAGE NEVER REDIRECTS, and that is what terminates the loop.
 * `/` sends a signed-in visitor to `/os`; `/os` refuses a visitor who is not
 * on the EZiL OS allow-list and sends them here with `?error=not_invited`.
 * If this page bounced a signed-in user anywhere — to `/`, to `/os`, to
 * `/computers` — those two redirects would chase each other forever and the
 * browser would show ERR_TOO_MANY_REDIRECTS instead of an explanation. So a
 * refused user gets a rendered page, a plain sentence, and a way out (sign
 * out). `access-gate.test.ts` pins the absence of a redirect here.
 */
export default async function LoginPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    // Narrowed here, at the edge, so the value handed to the form (and from
    // there to `window.location.assign`) can only ever be a path on this
    // origin. See `safeReturnUrl`.
    const returnUrl = safeReturnUrl(params[RETURN_URL_PARAM]);
    const error = params.error;
    // Compared against the constant the gate throws and the page gates
    // redirect with, so a rename cannot half-land.
    const notInvited =
        (Array.isArray(error) ? error[0] : error) === OS_ACCESS_NOT_INVITED;

    return (
        <div className="flex h-screen w-screen justify-center bg-black">
            <div className="m-6 hidden w-full md:block">
                <DesktopVisual />
            </div>
            <div className="flex h-full w-full max-w-xl flex-col justify-between space-y-8 overflow-auto bg-charcoal/40 p-16">
                <div className="flex items-center space-x-2">
                    <a href={Routes.HOME} className="text-lg font-semibold text-offwhite transition-opacity hover:opacity-80">
                        EZiL
                    </a>
                </div>
                {notInvited ? (
                    <NotInvited />
                ) : (
                    <div className="space-y-8">
                        <div className="space-y-4">
                            <h2 className="text-title2 leading-tight text-offwhite">
                                Sign in to open your computer
                            </h2>
                            <p className="text-regular text-gray-400">
                                One account, up to {MAX_COMPUTERS_PER_USER} computers — open an existing
                                one or start a new one.
                            </p>
                        </div>
                        <LoginForm returnUrl={returnUrl} />
                    </div>
                )}
                <p className="text-small text-gray-400">
                    By continuing you agree to our{' '}
                    <Link
                        href="https://ezil.org/html/terms-and-conditions.html"
                        target="_blank"
                        className="text-gray-300 underline transition-colors duration-200 hover:text-offwhite"
                    >
                        Terms
                    </Link>{' '}
                    and{' '}
                    <Link
                        href="https://ezil.org/html/privacy-policy.html"
                        target="_blank"
                        className="text-gray-300 underline transition-colors duration-200 hover:text-offwhite"
                    >
                        Privacy Policy
                    </Link>
                    .
                </p>
            </div>
        </div>
    );
}

/**
 * The `?error=not_invited` state: signed in to the shared Supabase project,
 * not allowed to use this product.
 *
 * 🔴 SIGN OUT IS NOT DECORATION. A refused visitor holds a valid session; with
 * no way to drop it, every route they try refuses them and the only exit is
 * clearing cookies by hand. `signOut()` is a server action that ends the
 * session and redirects to this page with no `error` param, where the sign-in
 * form renders again — so it is also the "wrong account" escape hatch.
 */
function NotInvited() {
    return (
        <div className="space-y-8">
            <div className="space-y-4">
                <h2 className="text-title2 leading-tight text-offwhite">You&apos;re not on the list</h2>
                <p className="text-regular text-gray-400">
                    This computer is invite-only. Ask a maintainer for an invitation.
                </p>
                <p className="text-small text-gray-500">
                    You are signed in, but this account is not allowed to open a computer here. If
                    you have another account, sign out and try that one.
                </p>
            </div>
            <form action={signOut}>
                <button
                    type="submit"
                    className="w-full rounded-md border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-offwhite transition-colors hover:bg-white/10"
                >
                    Sign out
                </button>
            </form>
        </div>
    );
}

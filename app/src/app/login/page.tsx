import Link from 'next/link';

import { MAX_COMPUTERS_PER_USER, RETURN_URL_PARAM, Routes, safeReturnUrl } from '@/utils/constants';
import { DesktopVisual } from './desktop-visual';
import { LoginForm } from './login-form';

/**
 * `/login` — re-skinned per EBuilder's `ezil-login` worktree (commit
 * 912247a): sells "your computer, in your browser" instead of the pre-pivot
 * "AI builds your app" pitch, and deliberately avoids promising a populated
 * workspace (a new computer boots empty). Design/copy carried; the
 * component tree, auth wiring, and styling primitives are written fresh for
 * this repo's own (much smaller) dependency surface.
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

    return (
        <div className="flex h-screen w-screen justify-center bg-black">
            <div className="m-6 hidden w-full md:block">
                <DesktopVisual />
            </div>
            <div className="flex h-full w-full max-w-xl flex-col justify-between space-y-8 overflow-auto bg-charcoal/40 p-16">
                <div className="flex items-center space-x-2">
                    <Link href={Routes.HOME} className="text-lg font-semibold text-offwhite transition-opacity hover:opacity-80">
                        EZiL
                    </Link>
                </div>
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

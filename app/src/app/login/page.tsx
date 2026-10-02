import Link from 'next/link';
import type { Viewport } from 'next';

import { RETURN_URL_PARAM, Routes, safeReturnUrl } from '@/utils/constants';
import { LockClock } from './lock-clock';
import { LoginForm } from './login-form';

/** `/login?method=email` opens the email and password panel straight away. */
const METHOD_PARAM = 'method';

// The login form scrolls with the Android keyboard; the desktop keeps its
// separate overlay policy from the root layout.
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    interactiveWidget: 'resizes-content',
};

/**
 * What a failed sign-in says. The `error` query value is matched against known
 * codes and never shown itself: it can carry provider text, and anyone can put
 * anything in a link to this page.
 */
function noticeFor(error: string | string[] | undefined): string | null {
    if (error === undefined) return null;
    if (error === 'auth_callback_failed') return 'Sign-in did not finish. Please try again.';
    return 'We could not sign you in. Please try again.';
}

/**
 * `/login` — the lock screen.
 *
 * Drawn as a computer waiting for its owner: the desktop's own "Horizon"
 * wallpaper, the time, a profile picture and one button. "Continue with
 * Google" signs in an existing account and creates a new one, so there is
 * nothing to choose between. Email and password stay available, one click
 * away, for accounts that were invited with one.
 *
 * The profile picture is a generic silhouette, never the visitor's: this page
 * does not look anyone up (see the next note), so it has no one to show.
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
 * 🔴 THIS PAGE NEVER REDIRECTS. `/` and every protected page send visitors
 * here; if this page bounced a signed-in user anywhere — to `/`, to `/os`, to
 * `/computers` — a page that sends them back would make the two chase each
 * other until the browser shows ERR_TOO_MANY_REDIRECTS. `open-access.test.ts`
 * pins the absence of a redirect here.
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
    const notice = noticeFor(params.error);

    return (
        <main className="ezil-lock">
            <div className="ezil-lock-wallpaper" aria-hidden="true" />

            <header className="ezil-lock-brand">
                <a href={Routes.HOME} className="rounded-sm text-sm font-semibold tracking-wide text-white/85 transition-colors hover:text-white">
                    EZiL OS
                </a>
            </header>

            <LockClock />

            <section className="ezil-lock-profile" aria-labelledby="lock-title">
                <div className="ezil-lock-avatar" aria-hidden="true">
                    <svg viewBox="0 0 64 64" className="h-[82%] w-[82%] text-white/75">
                        <circle cx="32" cy="23" r="12" fill="currentColor" />
                        <path d="M8 64c0-14 10.7-24 24-24s24 10 24 24z" fill="currentColor" />
                    </svg>
                </div>

                <h1 id="lock-title" className="ezil-lock-title">
                    Your computer awaits.
                </h1>
                <p className="mt-1.5 text-center text-small text-white/65">
                    Sign in or get started with Google.
                </p>

                {notice && (
                    <p role="alert" className="ezil-lock-error">
                        {notice}
                    </p>
                )}

                <LoginForm returnUrl={returnUrl} startWithEmail={params[METHOD_PARAM] === 'email'} />
            </section>

            <footer className="ezil-lock-footer">
                By continuing, you agree to our{' '}
                <Link
                    href="/terms"
                    className="underline decoration-white/30 underline-offset-2 transition-colors hover:text-white"
                >
                    Terms
                </Link>{' '}
                and acknowledge our{' '}
                <Link
                    href="/privacy"
                    className="underline decoration-white/30 underline-offset-2 transition-colors hover:text-white"
                >
                    Privacy Policy
                </Link>
                .
            </footer>
        </main>
    );
}

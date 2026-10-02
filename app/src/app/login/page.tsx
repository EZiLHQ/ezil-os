import Link from 'next/link';

import { RETURN_URL_PARAM, Routes, safeReturnUrl } from '@/utils/constants';
import { LockClock } from './lock-clock';
import { LoginForm } from './login-form';

/** `/login?method=email` opens the email and password panel straight away. */
const METHOD_PARAM = 'method';

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
 * other until the browser shows ERR_TOO_MANY_REDIRECTS. `access-gate.test.ts`
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
        <main className="ezil-lock-wallpaper relative font-sans flex min-h-dvh w-full flex-col overflow-hidden text-white">
            <div className="ezil-lock-glow pointer-events-none absolute inset-0" aria-hidden="true" />

            <header className="relative z-10 flex items-center justify-between px-5 pt-5 sm:px-8 sm:pt-6">
                <a href={Routes.HOME} className="text-sm font-semibold tracking-wide text-white/85 transition-opacity hover:opacity-70">
                    EZiL OS
                </a>
            </header>

            <div className="relative z-10 flex flex-1 flex-col items-center justify-between px-4 pt-6 pb-6 sm:pt-10">
                <LockClock />

                <section className="ezil-lock-rise flex w-full max-w-sm flex-col items-center pb-4" aria-labelledby="lock-title">
                    <div className="relative h-24 w-24 sm:h-28 sm:w-28">
                        <div className="ezil-lock-ring absolute -inset-[3px] rounded-full opacity-90" aria-hidden="true" />
                        <div className="absolute inset-0 flex items-end justify-center overflow-hidden rounded-full bg-gradient-to-b from-[#1b2340] to-[#0b0f1d]">
                            <svg viewBox="0 0 64 64" className="h-[82%] w-[82%] text-white/55" aria-hidden="true">
                                <circle cx="32" cy="23" r="12" fill="currentColor" />
                                <path d="M8 64c0-14 10.7-24 24-24s24 10 24 24z" fill="currentColor" />
                            </svg>
                        </div>
                    </div>

                    <h1 id="lock-title" className="mt-5 text-xl font-semibold text-white">
                        Welcome to EZiL OS
                    </h1>
                    <p className="mt-1.5 text-center text-small text-white/65">
                        Your computer, in your browser. New here? Continue with Google and your account is created on the way in.
                    </p>

                    {notice && (
                        <p role="alert" className="mt-4 rounded-full bg-red-500/15 px-4 py-1.5 text-small text-red-200">
                            {notice}
                        </p>
                    )}

                    <LoginForm returnUrl={returnUrl} startWithEmail={params[METHOD_PARAM] === 'email'} />
                </section>

                <p className="text-center text-mini text-white/45">
                    By continuing you agree to our{' '}
                    <Link
                        href="https://ezil.org/html/terms-and-conditions.html"
                        target="_blank"
                        className="underline decoration-white/30 underline-offset-2 transition-colors hover:text-white"
                    >
                        Terms
                    </Link>{' '}
                    and{' '}
                    <Link
                        href="https://ezil.org/html/privacy-policy.html"
                        target="_blank"
                        className="underline decoration-white/30 underline-offset-2 transition-colors hover:text-white"
                    >
                        Privacy Policy
                    </Link>
                    .
                </p>
            </div>
        </main>
    );
}

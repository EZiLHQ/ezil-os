'use client';

import { useActionState, useEffect, useState } from 'react';

import { signInWithGoogle, signInWithPassword, type AuthActionResult } from './actions';

const initialState: AuthActionResult = {};

/**
 * Sign IN only. There is no sign-up mode, no "Create account" toggle and no
 * `new-password` branch. See `actions.ts` and `entry-contract.test.ts`.
 *
 * One button does everything a newcomer needs: "Continue with Google" signs
 * in an existing account, and the first sign-in creates the account inside
 * Supabase's OAuth flow, not through any sign-up call here. Email and password
 * are for accounts that already have one (for example one created with
 * `bun tools/invite.ts add <email>`); that panel stays folded away until asked
 * for, or opens straight away from `/login?method=email`.
 */
export function LoginForm({ returnUrl, startWithEmail }: { returnUrl: string; startWithEmail: boolean }) {
    /** Set once we have started leaving; keeps the buttons from re-arming. */
    const [leaving, setLeaving] = useState(false);
    const [emailOpen, setEmailOpen] = useState(startWithEmail);

    // Back from Google's account chooser restores this page from the
    // back/forward cache exactly as it was left: mid-departure, buttons held
    // down. Re-arm them, or the only way forward is a reload.
    useEffect(() => {
        const rearm = (event: PageTransitionEvent) => {
            if (event.persisted) setLeaving(false);
        };
        window.addEventListener('pageshow', rearm);
        return () => window.removeEventListener('pageshow', rearm);
    }, []);

    const [state, formAction, isPending] = useActionState(async (
        _prev: AuthActionResult,
        formData: FormData,
    ) => {
        const result = await signInWithPassword(formData);
        if (result.redirectTo) {
            setLeaving(true);
            /*
             * 🔴 A DOCUMENT LOAD, deliberately — this is the whole point of
             * the action returning a value instead of calling `redirect()`.
             *
             * `redirect()` from a server action is performed by Next's App
             * Router as a client-side navigation. `/os` is the host document
             * for a separate jQuery application delivered as `<script src>`
             * tags, and a script element React inserts during a client-side
             * navigation NEVER EXECUTES. The result is a page with the
             * wallpaper on it and no OS behind it, forever. See
             * `actions.ts`'s `signInWithPassword` and
             * docs/PLATFORM-NOTES.md §17.
             *
             * `assign` rather than `replace` so Back still returns to the
             * login page the user came from. The value is already narrowed to
             * a same-origin path by `safeReturnUrl` on the server; it is not
             * re-derived from anything the client controls.
             */
            window.location.assign(result.redirectTo);
        }
        return result;
    }, initialState);

    const busy = isPending || leaving;

    return (
        <div className="mt-6 flex w-full flex-col items-center">
            <form
                className="w-full max-w-[18rem]"
                action={() => {
                    // The server action ends in a redirect to Google, so this
                    // page is about to unload; hold the button down until it
                    // does rather than letting a second click start a second
                    // flow.
                    setLeaving(true);
                    void signInWithGoogle(returnUrl);
                }}
            >
                <button
                    type="submit"
                    disabled={leaving}
                    className="group flex h-12 w-full items-center justify-center gap-2.5 rounded-full bg-white px-5 text-[0.9375rem] font-semibold text-[#0b0f1d] shadow-[0_10px_40px_-8px_rgba(0,200,208,0.55)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_44px_-6px_rgba(112,86,255,0.6)] focus-visible:ring-4 focus-visible:ring-teal/50 focus-visible:outline-none active:translate-y-0 disabled:translate-y-0 disabled:opacity-80"
                >
                    {leaving && !emailOpen ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#0b0f1d]/25 border-t-[#0b0f1d]" aria-hidden="true" />
                    ) : (
                        <GoogleIcon className="h-[1.125rem] w-[1.125rem]" />
                    )}
                    Continue with Google
                </button>
            </form>

            {!emailOpen && (
                <button
                    type="button"
                    onClick={() => setEmailOpen(true)}
                    className="mt-4 text-small text-white/60 underline-offset-4 transition-colors hover:text-white hover:underline"
                >
                    Sign in with email and password
                </button>
            )}

            {emailOpen && (
                <form
                    action={formAction}
                    className="mt-5 w-full space-y-3 rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-black/40 backdrop-blur-xl"
                >
                    <input type="hidden" name="returnUrl" value={returnUrl} />
                    <div className="space-y-1.5">
                        <label htmlFor="email" className="text-small text-white/60">
                            Email
                        </label>
                        <input
                            id="email"
                            name="email"
                            type="email"
                            required
                            autoComplete="email"
                            autoFocus={!startWithEmail}
                            className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-teal"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="password" className="text-small text-white/60">
                            Password
                        </label>
                        <input
                            id="password"
                            name="password"
                            type="password"
                            required
                            autoComplete="current-password"
                            className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-teal"
                        />
                    </div>
                    {state.error && <p role="alert" className="text-small text-red-300">{state.error}</p>}
                    <button
                        type="submit"
                        disabled={busy}
                        className="w-full rounded-lg bg-white/90 px-4 py-2.5 text-sm font-semibold text-[#0b0f1d] transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? 'Please wait…' : 'Sign in'}
                    </button>
                    <p className="text-mini text-white/45">
                        Email and password work for existing accounts. New accounts start with Continue with Google.
                    </p>
                </form>
            )}
        </div>
    );
}

function GoogleIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" {...props}>
            <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.85C3.99 20.53 7.7 23 12 23z"
            />
            <path
                fill="#FBBC05"
                d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.05H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.95l3.66-2.85z"
            />
            <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.85c.87-2.6 3.3-4.52 6.16-4.52z"
            />
        </svg>
    );
}

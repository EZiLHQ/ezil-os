'use client';

import { unstable_rethrow } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { signInWithGoogle, signInWithPassword } from './actions';

/** Google handles both new and existing accounts; passwords only sign in. */
export function LoginForm({ returnUrl, startWithEmail }: { returnUrl: string; startWithEmail: boolean }) {
    const [pending, setPending] = useState<'google' | 'password' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [emailOpen, setEmailOpen] = useState(startWithEmail);
    // Synchronous guard: even two submissions before React renders cannot race.
    const attempt = useRef<symbol | null>(null);
    const disclosure = useRef<HTMLButtonElement>(null);
    const email = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const rearm = (event: PageTransitionEvent) => {
            if (!event.persisted) return;
            // Ignore late results from the visit before Back/Forward restored us.
            attempt.current = null;
            setPending(null);
        };
        window.addEventListener('pageshow', rearm);
        return () => window.removeEventListener('pageshow', rearm);
    }, []);

    async function submit(method: 'google' | 'password', formData?: FormData) {
        if (attempt.current) return;
        const current = Symbol();
        attempt.current = current;
        setPending(method);
        setError(null);

        try {
            if (method === 'google') {
                await signInWithGoogle(returnUrl);
            } else {
                const result = await signInWithPassword(formData!);
                if (attempt.current !== current) return;
                if (result.redirectTo) {
                    // A document load is required to execute the OS shell's
                    // scripts. Never replace this with App Router navigation.
                    // The server already narrowed this with safeReturnUrl.
                    window.location.assign(result.redirectTo);
                    return;
                }
                setError(result.error ?? 'We could not sign you in. Please try again.');
            }
        } catch (cause) {
            if (attempt.current !== current) return;
            // OAuth succeeds by throwing Next's redirect signal. Let Next
            // handle it; only ordinary failures should re-enable the form.
            unstable_rethrow(cause);
            setError('We could not sign you in. Please try again.');
        }
        if (attempt.current === current) {
            attempt.current = null;
            setPending(null);
        }
    }

    const busy = pending !== null;

    return (
        <div className="ezil-lock-auth">
            <form action={() => submit('google')} className="w-full">
                <button type="submit" disabled={busy} className="ezil-lock-google">
                    <GoogleIcon className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
                    {pending === 'google' ? 'Connecting to Google…' : 'Continue with Google'}
                </button>
            </form>

            {error && <p role="alert" className="ezil-lock-error">{error}</p>}
            <span role="status" className="sr-only">
                {pending === 'google' ? 'Connecting to Google.' : pending === 'password' ? 'Signing in.' : ''}
            </span>

            <button
                ref={disclosure}
                type="button"
                disabled={busy}
                aria-expanded={emailOpen}
                aria-controls="email-sign-in"
                onClick={() => {
                    if (attempt.current) return;
                    setEmailOpen(!emailOpen);
                    setError(null);
                    // The disclosed form stays mounted, preserving typed values.
                    // Wait for the hidden attribute to update before focusing it.
                    if (!emailOpen) requestAnimationFrame(() => email.current?.focus());
                    else disclosure.current?.focus();
                }}
                className="ezil-lock-disclosure"
            >
                {emailOpen ? 'Hide email sign-in' : 'Sign in with email and password'}
                <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
                    <path d={emailOpen ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
            </button>

            <form
                method="post"
                id="email-sign-in"
                hidden={!emailOpen}
                aria-label="Email sign-in"
                onSubmit={event => {
                    event.preventDefault();
                    void submit('password', new FormData(event.currentTarget));
                }}
                className="ezil-lock-email"
            >
                <input type="hidden" name="returnUrl" value={returnUrl} />
                <div className="space-y-1.5">
                    <label htmlFor="email" className="text-small text-white/80">Email</label>
                    <input
                        ref={email}
                        id="email"
                        name="email"
                        type="email"
                        required
                        autoComplete="email"
                        autoCapitalize="none"
                        spellCheck={false}
                        disabled={busy}
                        className="ezil-lock-input"
                    />
                </div>
                <div className="mt-3 space-y-1.5">
                    <label htmlFor="password" className="text-small text-white/80">Password</label>
                    <input
                        id="password"
                        name="password"
                        type="password"
                        required
                        autoComplete="current-password"
                        disabled={busy}
                        className="ezil-lock-input"
                    />
                </div>
                <button type="submit" disabled={busy} className="ezil-lock-password">
                    {pending === 'password' ? 'Signing in…' : 'Sign in'}
                </button>
                <p className="mt-3 text-center text-xs leading-relaxed text-white/65">
                    Email and password work for existing accounts. New accounts start with Continue with Google.
                </p>
            </form>
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

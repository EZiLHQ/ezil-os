'use client';

import { useActionState, useState } from 'react';

import {
    signInWithGoogle,
    signInWithPassword,
    signUpWithPassword,
    type AuthActionResult,
} from './actions';

const initialState: AuthActionResult = {};

export function LoginForm({ returnUrl }: { returnUrl: string }) {
    const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
    const [signUpDone, setSignUpDone] = useState(false);

    const action = mode === 'sign-in' ? signInWithPassword : signUpWithPassword;
    const [state, formAction, isPending] = useActionState(async (
        _prev: AuthActionResult,
        formData: FormData,
    ) => {
        const result = await action(formData);
        if (mode === 'sign-up' && !result.error) {
            setSignUpDone(true);
        }
        return result;
    }, initialState);

    return (
        <div className="space-y-6">
            <form
                action={() => {
                    void signInWithGoogle(returnUrl);
                }}
            >
                <button
                    type="submit"
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-offwhite transition-colors hover:bg-white/10"
                >
                    <GoogleIcon className="h-4 w-4" />
                    Continue with Google
                </button>
            </form>

            <div className="flex items-center gap-4">
                <div className="h-px flex-1 bg-white/10" />
                <span className="text-small text-gray-500">or</span>
                <div className="h-px flex-1 bg-white/10" />
            </div>

            {signUpDone ? (
                <p className="rounded-md border border-teal/30 bg-teal/10 p-3 text-sm text-teal">
                    Check your email to confirm your account, then sign in below.
                </p>
            ) : (
                <form action={formAction} className="space-y-3">
                    <input type="hidden" name="returnUrl" value={returnUrl} />
                    <div className="space-y-1.5">
                        <label htmlFor="email" className="text-small text-gray-400">
                            Email
                        </label>
                        <input
                            id="email"
                            name="email"
                            type="email"
                            required
                            autoComplete="email"
                            className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-offwhite outline-none focus:border-teal"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="password" className="text-small text-gray-400">
                            Password
                        </label>
                        <input
                            id="password"
                            name="password"
                            type="password"
                            required
                            minLength={mode === 'sign-up' ? 8 : undefined}
                            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                            className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-offwhite outline-none focus:border-teal"
                        />
                    </div>
                    {state.error && <p className="text-small text-red-400">{state.error}</p>}
                    <button
                        type="submit"
                        disabled={isPending}
                        className="w-full rounded-md bg-teal px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {isPending
                            ? 'Please wait…'
                            : mode === 'sign-in'
                              ? 'Sign in'
                              : 'Create account'}
                    </button>
                </form>
            )}

            <p className="text-small text-gray-400">
                {mode === 'sign-in' ? "Don't have an account? " : 'Already have an account? '}
                <button
                    type="button"
                    onClick={() => {
                        setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                        setSignUpDone(false);
                    }}
                    className="text-offwhite underline hover:text-teal"
                >
                    {mode === 'sign-in' ? 'Create one' : 'Sign in'}
                </button>
            </p>
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

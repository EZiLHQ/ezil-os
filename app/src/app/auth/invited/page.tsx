'use client';

import { useEffect, useState } from 'react';

import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/client';
import { parseAuthFragment } from './fragment';

/**
 * `/auth/invited` — where an invited person becomes a user who can sign in.
 *
 * ── The two ways someone arrives here ───────────────────────────────────────
 * 1. **With a fragment.** Supabase's DEFAULT invite email. Invites are not
 *    PKCE, so `/auth/v1/verify` completes as an implicit grant and redirects
 *    to `redirect_to` (this page — see `tools/invite.ts`) with
 *    `#access_token=…&refresh_token=…`. A fragment never reaches a server, and
 *    `@supabase/ssr`'s browser client is hard-coded to `flowType: "pkce"`, so
 *    it will not pick the fragment up on its own — it throws instead. See
 *    `./fragment.ts` for both citations. This page reads it and calls
 *    `setSession` explicitly.
 * 2. **With no fragment but a session.** The `{{ .TokenHash }}` email template
 *    (a founder-side dashboard change), which lands on `/auth/confirm`; that
 *    route verifies server-side, writes the cookies, and redirects here.
 *
 * Either way the user is now signed in and has NO PASSWORD — the account was
 * created by the invite. This page is the only place that asks for one.
 *
 * ── 🔴 `window.location.assign`, never `router.push` ────────────────────────
 * The destination is `/os`, which is the host document for a separate jQuery
 * application delivered as `<script src>` tags. A `<script>` React inserts
 * during a client-side navigation NEVER EXECUTES, so a soft nav lands the user
 * on a permanently dead page (docs/PLATFORM-NOTES.md §17,
 * `login/entry-contract.test.ts`). The same contract the login form obeys.
 *
 * ── 🔴 The fragment is read in an effect, not during render ─────────────────
 * `window` does not exist on the server, and a first paint that differs
 * between server and client is the hydration hazard of
 * docs/PLATFORM-NOTES.md §14. The first frame is a neutral "checking" state on
 * both sides; the effect then decides. It also strips the tokens out of the
 * address bar with `history.replaceState` as soon as they are consumed, so
 * they do not survive in history, a bookmark or a `Referer`.
 */

type Phase =
    | { name: 'checking' }
    | { name: 'set-password' }
    | { name: 'saving' }
    | { name: 'failed'; message: string };

const MIN_PASSWORD = 8;

export default function InvitedPage() {
    const [phase, setPhase] = useState<Phase>({ name: 'checking' });
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [formError, setFormError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const supabase = createClient();

        const settle = (next: Phase) => {
            if (!cancelled) setPhase(next);
        };

        /** Remove `#access_token=…` from the address bar once it is spent. */
        const stripFragment = () => {
            window.history.replaceState(
                window.history.state,
                '',
                window.location.pathname + window.location.search,
            );
        };

        void (async () => {
            const fragment = parseAuthFragment(window.location.hash);

            if (fragment.kind === 'error') {
                stripFragment();
                settle({
                    name: 'failed',
                    message:
                        fragment.description ??
                        'That invitation link is no longer valid. Ask a maintainer for a new one.',
                });
                return;
            }

            if (fragment.kind === 'session') {
                const { error } = await supabase.auth.setSession({
                    access_token: fragment.accessToken,
                    refresh_token: fragment.refreshToken,
                });
                stripFragment();
                if (error) {
                    settle({ name: 'failed', message: error.message });
                    return;
                }
                settle({ name: 'set-password' });
                return;
            }

            // No fragment. Either `/auth/confirm` already established the
            // session (the `{{ .TokenHash }}` template), or this page was
            // opened on its own and there is nothing to do here.
            const { data } = await supabase.auth.getSession();
            if (data.session) {
                settle({ name: 'set-password' });
                return;
            }
            window.location.assign(Routes.LOGIN);
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setFormError(null);

        if (password.length < MIN_PASSWORD) {
            setFormError(`Use at least ${MIN_PASSWORD} characters.`);
            return;
        }
        if (password !== confirm) {
            setFormError('Those two passwords are different.');
            return;
        }

        setPhase({ name: 'saving' });
        const supabase = createClient();
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
            setPhase({ name: 'set-password' });
            setFormError(error.message);
            return;
        }

        // 🔴 A document load. See the header.
        window.location.assign(Routes.OS);
    }

    return (
        <main className="flex h-screen w-screen items-center justify-center bg-black p-6">
            <div className="w-full max-w-md space-y-6 rounded-lg bg-charcoal/40 p-8">
                <h1 className="text-title2 leading-tight text-offwhite">Welcome to EZiL OS</h1>

                {phase.name === 'checking' && (
                    <p className="text-regular text-gray-400">Checking your invitation…</p>
                )}

                {phase.name === 'failed' && (
                    <div className="space-y-4">
                        <p className="text-regular text-red-400">{phase.message}</p>
                        <a
                            href={Routes.LOGIN}
                            className="inline-flex items-center rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-offwhite transition-colors hover:bg-white/10"
                        >
                            Back to sign in
                        </a>
                    </div>
                )}

                {(phase.name === 'set-password' || phase.name === 'saving') && (
                    <form onSubmit={onSubmit} className="space-y-4">
                        <p className="text-regular text-gray-400">
                            Choose a password and your computer is ready.
                        </p>
                        <div className="space-y-1.5">
                            <label htmlFor="password" className="text-small text-gray-400">
                                Password
                            </label>
                            <input
                                id="password"
                                name="password"
                                type="password"
                                required
                                minLength={MIN_PASSWORD}
                                autoComplete="new-password"
                                value={password}
                                onChange={event => setPassword(event.target.value)}
                                className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-offwhite outline-none focus:border-teal"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor="confirm" className="text-small text-gray-400">
                                Confirm password
                            </label>
                            <input
                                id="confirm"
                                name="confirm"
                                type="password"
                                required
                                minLength={MIN_PASSWORD}
                                autoComplete="new-password"
                                value={confirm}
                                onChange={event => setConfirm(event.target.value)}
                                className="w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-offwhite outline-none focus:border-teal"
                            />
                        </div>
                        {formError && <p className="text-small text-red-400">{formError}</p>}
                        <button
                            type="submit"
                            disabled={phase.name === 'saving'}
                            className="w-full rounded-md bg-teal px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            {phase.name === 'saving' ? 'Please wait…' : 'Set password and continue'}
                        </button>
                    </form>
                )}
            </div>
        </main>
    );
}

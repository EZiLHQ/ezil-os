'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { Routes, safeReturnUrl } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

export interface AuthActionResult {
    error?: string;
    /**
     * Where the caller should go now that a session exists — a same-origin
     * path, already narrowed by `safeReturnUrl`.
     *
     * 🔴 A VALUE, not a `redirect()`. See `signInWithPassword` for why; the
     * client half of the contract is in `login-form.tsx`, which navigates
     * with `window.location.assign` so the destination arrives as a real
     * document load.
     */
    redirectTo?: string;
}

/** Resolves the site origin for OAuth/email redirect targets. */
async function siteOrigin(): Promise<string> {
    const h = await headers();
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
    return `${proto}://${host}`;
}

/**
 * Email/password sign-in. Hands `returnUrl` (or `/computers`) back to the
 * caller instead of navigating there itself.
 *
 * ── 🔴 WHY THIS DOES NOT CALL `redirect()` ──────────────────────────────────
 * It used to. `redirect()` inside a server action is not an HTTP redirect: the
 * action's response carries the location back to the client and Next's App
 * Router performs it as a CLIENT-SIDE NAVIGATION. For a React route that is
 * fine and fast. For `/os` it is fatal.
 *
 * `/os` is not a React route. It is the host document for a separate
 * jQuery/webpack application (`public/os/bundle.min.js`, built from `shell/`),
 * delivered as an inline boot payload plus two `<script src>` tags. A
 * `<script>` element that React inserts during a client-side navigation is
 * NEVER EXECUTED by the browser — the HTML spec only runs scripts that are
 * parser-inserted or explicitly created and appended by script. So React puts
 * the tags in the tree, the browser ignores them, and nothing boots.
 *
 * 🔴 MEASURED on the production build, real Chromium, real Supabase login via
 * `/login?returnUrl=%2Fos`, 30 seconds after landing:
 *     navName      "http://localhost:3030/login?returnUrl=%2Fos"  (no document load)
 *     bundleFetched 0     window.ezil undefined   __EZIL_BOOT__ undefined
 *     taskbar false   windows 0   visibleText ""
 * — a permanently dead page that only a manual reload recovers. Reproduced
 * identically from a `router.push('/os')`, i.e. from what any future
 * `<Link href="/os">` would do. See docs/PLATFORM-NOTES.md §17.
 *
 * ── Why every destination, not just `/os` ───────────────────────────────────
 * A list of "routes that need a document load" is a list that goes stale the
 * first time someone adds a surface that is not a React route. The rule here
 * has no list in it: **the destination of a successful authentication is
 * always a document load.** It is also the more correct thing to do
 * independently — the session cookies just changed, and a fresh document is
 * the only way to guarantee nothing renders against the old ones. Login is a
 * once-per-session transition; it can afford one round trip.
 *
 * The OAuth path already works this way: `signInWithGoogle` leaves the origin
 * entirely and `/auth/callback` is a route handler whose 302 the browser
 * follows as a document load.
 */
export async function signInWithPassword(formData: FormData): Promise<AuthActionResult> {
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const returnUrl = safeReturnUrl(String(formData.get('returnUrl') ?? ''));

    if (!email || !password) {
        return { error: 'Email and password are required.' };
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        return { error: error.message };
    }

    return { redirectTo: returnUrl };
}

/** Email/password sign-up. */
export async function signUpWithPassword(formData: FormData): Promise<AuthActionResult> {
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const returnUrl = safeReturnUrl(String(formData.get('returnUrl') ?? ''));

    if (!email || !password) {
        return { error: 'Email and password are required.' };
    }
    if (password.length < 8) {
        return { error: 'Password must be at least 8 characters.' };
    }

    const supabase = await createClient();
    const origin = await siteOrigin();
    const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl)}` },
    });
    if (error) {
        return { error: error.message };
    }

    return { error: undefined };
}

/**
 * Starts the Google OAuth flow. Supabase returns a provider authorization
 * URL rather than establishing a session directly — we redirect the browser
 * there, and `/auth/callback` exchanges the resulting code for a session.
 */
export async function signInWithGoogle(returnUrl: string): Promise<never> {
    const supabase = await createClient();
    const origin = await siteOrigin();

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: `${origin}/auth/callback?returnUrl=${encodeURIComponent(safeReturnUrl(returnUrl))}`,
        },
    });

    if (error || !data.url) {
        redirect(`${Routes.LOGIN}?error=${encodeURIComponent(error?.message ?? 'oauth_failed')}`);
    }

    redirect(data.url);
}

export async function signOut(): Promise<never> {
    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect(Routes.LOGIN);
}

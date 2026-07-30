'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

export interface AuthActionResult {
    error?: string;
}

/** Resolves the site origin for OAuth/email redirect targets. */
async function siteOrigin(): Promise<string> {
    const h = await headers();
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
    return `${proto}://${host}`;
}

/** Email/password sign-in. Lands the caller on `returnUrl` or `/computers`. */
export async function signInWithPassword(formData: FormData): Promise<AuthActionResult> {
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const returnUrl = String(formData.get('returnUrl') ?? '') || Routes.COMPUTERS;

    if (!email || !password) {
        return { error: 'Email and password are required.' };
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        return { error: error.message };
    }

    redirect(returnUrl);
}

/** Email/password sign-up. */
export async function signUpWithPassword(formData: FormData): Promise<AuthActionResult> {
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const returnUrl = String(formData.get('returnUrl') ?? '') || Routes.COMPUTERS;

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
            redirectTo: `${origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl || Routes.COMPUTERS)}`,
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

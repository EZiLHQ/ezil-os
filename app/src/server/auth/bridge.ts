import 'server-only';

import { createClient } from '@/utils/supabase/server';

import { Auth0Error, type Auth0Identity } from './auth0';
import { enrollStagingAiMember } from './staging-ai-enrollment';
import { createAdminClient } from './supabase-admin';

/**
 * A silent (`prompt=none`) sign-in only refreshes the retained identity of whoever is signed in to the OS; it must
 * never switch the OS account to whoever holds the id.ezil.work session (review #3). Call it before
 * `bridgeAuth0Identity`, whose `verifyOtp` replaces the session cookies.
 *
 * - No Supabase session: there is no account to switch away from.
 * - The signed-in user's linked `app_metadata.auth0_sub` must be this Auth0 subject.
 * - A user not linked yet must have this verified email: the bridge would link exactly that account, not another.
 * - Anything else is `account_conflict`; a session that cannot be read is `session_failed`. Either way the caller
 *   sends the person to the sign-in page, never into the other account.
 */
export async function refuseSilentAccountSwitch(identity: Auth0Identity): Promise<void> {
    let claims: Record<string, unknown> | undefined;
    try {
        const { data, error } = await (await createClient()).auth.getClaims();
        if (error) throw error;
        claims = data?.claims as Record<string, unknown> | undefined;
    } catch { throw new Auth0Error('session_failed'); }
    if (!claims) return;
    const metadata = claims.app_metadata;
    const linked = metadata && typeof metadata === 'object' ? (metadata as { auth0_sub?: unknown }).auth0_sub : undefined;
    if (linked !== undefined && linked !== null) {
        if (linked !== identity.sub) throw new Auth0Error('account_conflict');
        return;
    }
    if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== identity.email.toLowerCase()) throw new Auth0Error('account_conflict');
}

/** The caller must first verify the Auth0 ID token, including verified email. */
export async function bridgeAuth0Identity(identity: Auth0Identity): Promise<void> {
    const admin = createAdminClient().auth.admin;
    const email = identity.email.toLowerCase();
    let user;
    // Supabase admin has no email lookup API. Do not silently search only page 1.
    const perPage = 1000;
    for (let page = 1; ; page += 1) {
        const { data, error } = await admin.listUsers({ page, perPage });
        if (error || !data) throw new Auth0Error('session_failed');
        user = data.users.find(candidate => candidate.email?.toLowerCase() === email);
        if (user || data.users.length < perPage) break;
    }
    if (!user) {
        const { data, error } = await admin.createUser({ email, email_confirm: true, app_metadata: { auth0_sub: identity.sub } });
        if (error || !data.user) throw new Auth0Error('session_failed');
        user = data.user;
    } else {
        const subject = user.app_metadata.auth0_sub;
        if (subject !== undefined && subject !== null && subject !== identity.sub) throw new Auth0Error('account_conflict');
        if (subject == null) {
            const { error } = await admin.updateUserById(user.id, {
                app_metadata: { ...user.app_metadata, auth0_sub: identity.sub },
            });
            if (error) throw new Auth0Error('session_failed');
        }
        // Round 5 D1: the caller verified this email at Auth0, so confirm the Supabase copy
        // (GoTrue omits email_confirmed_at when unset). Otherwise enrollment refuses with
        // email_unconfirmed. Best effort: a failure never blocks the sign-in.
        if (!user.email_confirmed_at) {
            try {
                const { error } = await admin.updateUserById(user.id, { email_confirm: true });
                if (error) console.warn('[auth0] email confirmation unavailable');
            } catch {
                console.warn('[auth0] email confirmation unavailable');
            }
        }
    }
    // The guarded SQL updates JWT app metadata before GoTrue mints the session.
    // Enrollment is best effort (coded `ai-enroll` log); it never replaces the link or OTP
    // checks below. On success it also wakes this user's outbox rows waiting on the account.
    await enrollStagingAiMember(user.id, identity.sub);
    const { data, error } = await admin.generateLink({ type: 'magiclink', email });
    if (error || !data?.properties?.hashed_token || data.user?.id !== user.id
        || data.user.app_metadata.auth0_sub !== identity.sub) throw new Auth0Error('session_failed');
    // generateLink does not send mail. Redeem only on the normal SSR client so
    // its setAll writes the existing Supabase cookies consumed by ctx.user.
    const supabase = await createClient();
    const result = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: data.properties.hashed_token });
    if (result.error || !result.data.session || result.data.user?.id !== user.id) {
        await supabase.auth.signOut({ scope: 'local' });
        throw new Auth0Error('session_failed');
    }
}

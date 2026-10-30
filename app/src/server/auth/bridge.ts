import 'server-only';

import { createClient } from '@/utils/supabase/server';

import { Auth0Error, type Auth0Identity } from './auth0';
import { enrollAiMember } from './ai-enrollment';
import { createAdminClient } from './supabase-admin';

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
    }
    // The guarded SQL updates JWT app metadata before GoTrue mints the session.
    // Enrollment is best effort; it never replaces the link or OTP checks below.
    await enrollAiMember(user.id, identity.sub);
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

// tabs/account.js — EZiL-authored. Not Puter code.
//
// Who is signed in, and the one place to sign out. Settings → Account is the
// only Sign out in the shell: it is a deliberate, two-step action (open
// Settings, choose Account), not something one stray click in the Start menu
// can do.
//
// Everything shown comes from the boot payload's `user` (built server-side by
// `toShellBootUser` in `app/src/server/shell/boot-payload.ts` from the
// verified Supabase session). Nothing is fetched and nothing is invented: a
// value the identity provider did not give is shown as absent, not guessed.
// The avatar is the user's initials, drawn locally — no request to a
// third-party image host just to render a profile picture.

import { signOut } from '../../../auth.js';
import { payload as bootPayload } from '../../../session.js';

/** The signed-in user: from the launch context, else from the page's boot payload. */
function userFrom (ctx) {
    return ctx?.payload?.user ?? ctx?.user ?? bootPayload()?.user ?? null;
}

const ACCOUNT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="8.5" r="3.75"/><path d="M4.75 19.5a7.25 7.25 0 0 1 14.5 0"/></svg>';

const PROVIDER_LABELS = { google: 'Google', email: 'Email and password', github: 'GitHub', azure: 'Microsoft' };

/** "Ada Lovelace" → "AL"; "ada@x.dev" → "A". Letters and digits only; never empty. */
export function initialsFor (name, email) {
    const source = (name ?? '').trim() || (email ?? '').split('@')[0] || '';
    const words = source.split(/[\s._-]+/)
        .map(word => word.replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean);
    const letters = words.length >= 2 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 1);
    return letters.toUpperCase();
}

export function providerLabel (provider) {
    if ( ! provider ) return null;
    return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function memberSince (iso) {
    const time = Date.parse(iso ?? '');
    if ( ! Number.isFinite(time) ) return null;
    return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function detailRow (label, value, { mono = false } = {}) {
    const shown = value
        ? `<span class="ezil-account-value${mono ? ' mono' : ''}">${html_encode(value)}</span>`
        : '<span class="ezil-account-value ezil-settings-muted">—</span>';
    return `<div class="ezil-account-row"><span class="ezil-account-label">${html_encode(label)}</span>${shown}</div>`;
}

function render ($win, user) {
    const $pane = $win.find('[data-pane="account"]');
    if ( $pane.length === 0 ) return;
    if ( ! user?.id ) {
        $pane.find('[data-role="account-body"]').html(
            '<p class="ezil-settings-muted">This session has no signed-in account.</p>');
        return;
    }
    const displayName = user.name || (user.email ? user.email.split('@')[0] : 'Your account');
    const provider = providerLabel(user.provider);
    const since = memberSince(user.createdAt);

    $pane.find('[data-role="account-body"]').html(`
        <section class="ezil-account-card ezil-account-profile">
            <div class="ezil-account-avatar" aria-hidden="true">${html_encode(initialsFor(user.name, user.email))}</div>
            <div class="ezil-account-identity">
                <div class="ezil-account-name" data-role="account-name">${html_encode(displayName)}</div>
                <div class="ezil-account-email" data-role="account-email">${html_encode(user.email ?? 'No email on this account')}</div>
                ${provider ? `<span class="ezil-settings-pill ezil-account-provider">Signed in with ${html_encode(provider)}</span>` : ''}
            </div>
        </section>

        <h4>Profile</h4>
        <section class="ezil-account-card ezil-account-details">
            ${detailRow('Name', user.name)}
            ${detailRow('Email', user.email)}
            ${detailRow('Sign-in method', provider)}
            ${detailRow('Member since', since)}
            ${detailRow('Account ID', user.id, { mono: true })}
        </section>

        <h4>Session</h4>
        <section class="ezil-account-card ezil-account-signout">
            <div class="ezil-account-signout-copy">
                <div class="ezil-account-signout-title">Sign out of EZiL OS</div>
                <p>Ends the session in this browser. Your computers and their files stay as they are.</p>
            </div>
            <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="sign-out">Sign out</button>
        </section>`);
}

export default {
    id: 'account',
    label: 'Account',
    icon: ACCOUNT_ICON,

    /** Only a session with a signed-in account has an Account tab. */
    available (ctx) {
        if ( ctx?.desktopState?.provider === 'native-macos' ) return false;
        return Boolean(userFrom(ctx)?.id);
    },

    html () {
        return `
            <div class="ezil-settings-account">
                <h3>Account</h3>
                <p class="ezil-settings-lead">The account this OS is signed in with.</p>
                <div data-role="account-body"></div>
            </div>`;
    },

    init ($win, ctx) {
        // `ctx` is boot.js's launch context: `{ payload, computer, desktopState }`.
        render($win, userFrom(ctx));
        $win.find('[data-pane="account"]').on('click', '[data-action="sign-out"]', function () {
            // One click is enough to leave: disable so a double click cannot
            // submit twice while the page unloads.
            $(this).prop('disabled', true).text('Signing out…');
            signOut();
        });
    },
};

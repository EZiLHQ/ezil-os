import { classifyGatewayError } from './classify.js';
import { billingEnabled, text } from './text.js';
import { formatUsdMicro, walletBalances, walletSummary } from './wallet-badge.js';
import { billingIcon, injectBillingStyles } from './style-dialog.js';

let headlineSequence = 0;

function bounded (value, fallback, max) {
    return Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

/**
 * One refused draft per controller; close/open never clears or resends it.
 * startCheckout('topup'|'subscribe') resolves when checkout closes/returns.
 * Its result is ignored. Only refreshWallet() (a server GET) updates balances.
 * Keep this controller when closing a dialog. The host owns draft persistence
 * across full-page navigation and must provide a fresh request ID on resend.
 */
export function createBillingPopup ({
    config, draft, onResend, startCheckout, refreshWallet, wallet = null,
    document: doc = globalThis.document, formatLegacyWallet,
    maxPollTries = 5, pollIntervalMs = 1500, requestTimeoutMs = 10000,
} = {}) {
    const enabled = billingEnabled(config);
    const tries = bounded(maxPollTries, 5, 10);
    const interval = bounded(pollIntervalMs, 1500, 5000);
    const timeout = bounded(requestTimeoutMs, 10000, 30000);
    let element = null;
    let previousFocus = null;
    let failure = { status: 0, body: null };
    let destroyed = false;
    let sending = false;
    let checking = false;
    let checkoutState = 'idle';
    let notice = '';
    let balanceRefreshed = false;
    const headlineId = `ezil-billing-headline-${++headlineSequence}`;

    function node (tag, copy) {
        const el = doc.createElement(tag);
        if ( copy ) el.textContent = copy;
        return el;
    }

    function button (action, label, handler, disabled = false) {
        const el = node('button', label);
        el.type = 'button';
        el.dataset.action = action;
        el.disabled = disabled;
        el.className = 'ezil-billing-button';
        el.addEventListener('click', event => {
            if ( event.detail > 1 || el.disabled ) return;
            handler();
        });
        return el;
    }

    function close () {
        if ( ! element ) return;
        const old = element;
        element = null;
        if ( typeof old.close === 'function' ) old.close();
        old.remove();
        if ( previousFocus?.isConnected ) previousFocus.focus();
    }

    async function resend () {
        if ( sending || checking || destroyed || ! element || ! onResend || ! canResend() ) return;
        sending = true;
        notice = '';
        render();
        try {
            await onResend(draft);
            close();
        } catch {
            notice = text('billing_dlg_resend_failed');
        } finally {
            sending = false;
            render();
        }
    }

    function canResend () {
        const required = failure.body?.error?.requiredUsdMicro ?? failure.body?.requiredUsdMicro;
        // Legacy refusals have no USD requirement. Never convert their balances.
        if ( required === undefined ) return true;
        if ( typeof required !== 'string' || !/^\d+$/.test(required) || ! balanceRefreshed ) return false;
        const balances = walletBalances(wallet);
        return !! balances && balances.included + balances.purchased >= BigInt(required);
    }

    function updateWallet (next) {
        wallet = next;
        balanceRefreshed = true;
        render();
    }

    async function readWallet () {
        const abort = new AbortController();
        let timer;
        try {
            return await Promise.race([
                Promise.resolve().then(() => refreshWallet({ signal: abort.signal })),
                new Promise((_, reject) => {
                    timer = setTimeout(() => { abort.abort(); reject(new Error('wallet timeout')); }, timeout);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async function checkout (action) {
        if ( checking || sending || destroyed || ! element || ! startCheckout || ! refreshWallet ) return;
        checking = true;
        checkoutState = 'pending';
        notice = text('billing_dlg_waiting');
        const before = wallet;
        render();
        try {
            await startCheckout(action);
            // A return URL (even ?success=true) is never evidence of funding.
            for ( let attempt = 0; attempt < tries && ! destroyed; attempt++ ) {
                if ( attempt > 0 ) await new Promise(resolve => setTimeout(resolve, interval));
                if ( destroyed ) break;
                try {
                    const next = await readWallet();
                    if ( destroyed ) break;
                    wallet = next;
                    balanceRefreshed = true;
                    const previous = walletBalances(before);
                    const current = walletBalances(next);
                    const changed = previous && current && (action === 'subscribe'
                        ? (before.plan === 'free' && next.plan === 'subscriber') || current.included > previous.included
                        : current.purchased > previous.purchased);
                    if ( changed ) {
                        checkoutState = 'updated';
                        notice = text('billing_dlg_updated');
                        break;
                    }
                } catch {
                    // Transient reads consume an attempt, never confirm payment.
                }
            }
            if ( checkoutState !== 'updated' ) {
                checkoutState = 'unconfirmed';
                notice = text('billing_dlg_unconfirmed');
            }
        } catch {
            checkoutState = 'failed';
            notice = text('billing_dlg_checkout_failed');
        } finally {
            checking = false;
            render();
        }
    }

    function render () {
        if ( ! element || destroyed ) return;
        const focusedAction = element.contains(doc.activeElement) ? doc.activeElement?.dataset?.action : null;
        const kind = classifyGatewayError(failure.status, failure.body);
        const error = failure.body?.error ?? {};
        const plan = wallet?.plan ?? error.plan ?? failure.body?.plan;
        element.replaceChildren();
        const header = node('div');
        header.className = 'ezil-billing-header';
        const headline = node('h2', text(kind === 'subscribe' ? 'billing_dlg_subscribe_headline' : 'billing_dlg_topup_headline'));
        headline.id = headlineId;
        headline.className = 'ezil-billing-headline';
        const dismiss = button('dismiss', '×', close);
        dismiss.classList.add('ezil-billing-dismiss');
        dismiss.setAttribute('aria-label', text('billing_dlg_close'));
        header.append(headline, dismiss);
        element.append(header);
        const balances = walletBalances(wallet);
        const required = error.requiredUsdMicro ?? failure.body?.requiredUsdMicro;
        const subline = node('p', text('billing_dlg_draft_kept'));
        subline.className = 'ezil-billing-subline';
        if ( balances && required !== undefined && formatUsdMicro(required) !== '—' ) {
            subline.textContent = `${text('billing_dlg_required', { amount: formatUsdMicro(required) })} ${subline.textContent}`;
        }
        element.append(subline);
        if ( balances ) {
            const list = node('dl');
            list.className = 'ezil-billing-balances';
            for ( const bucket of ['included', 'purchased'] ) {
                const column = node('div');
                column.className = 'ezil-billing-bucket';
                const amount = node('dd', formatUsdMicro(String(balances[bucket])));
                amount.className = 'ezil-billing-amount';
                const note = node('dd');
                note.className = 'ezil-billing-note';
                const end = wallet?.included?.periodEnd;
                if ( bucket === 'purchased' ) note.textContent = text('billing_dlg_purchased_note');
                else if ( end && Number.isFinite(Date.parse(end)) ) {
                    note.textContent = text('billing_dlg_renews', { date: new Intl.DateTimeFormat(doc.documentElement.lang || 'en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(end)) });
                }
                column.append(node('dt', text(`billing_dlg_${bucket}`)), amount, note);
                list.append(column);
            }
            element.append(list);
        } else {
            element.append(node('p', walletSummary(wallet, formatLegacyWallet).label));
        }
        const status = node('p', notice);
        status.className = 'ezil-billing-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const busy = checking || sending;
        if ( checking ) {
            const spinner = billingIcon(doc, 'refresh');
            spinner.classList.add('ezil-billing-spinner');
            status.prepend(spinner);
            element.append(status);
            const confirmation = node('p', text('billing_dlg_confirmation'));
            confirmation.className = 'ezil-billing-payment-note';
            element.append(confirmation);
        } else {
            const cards = node('div');
            cards.className = 'ezil-billing-cards';
            function card (action, title, detail, primary) {
                const el = button(action, '', () => { void checkout(action); }, busy || ! startCheckout || ! refreshWallet);
                el.className = `ezil-billing-card${primary ? ' ezil-billing-card-primary' : ''}`;
                const label = node('span', text(title));
                label.className = 'ezil-billing-card-title';
                const description = node('span', detail);
                description.className = 'ezil-billing-card-detail';
                const arrow = node('span', '›');
                arrow.className = 'ezil-billing-card-arrow';
                arrow.setAttribute('aria-hidden', 'true');
                el.append(label, description, arrow);
                cards.append(el);
            }
            const serverActions = Array.isArray(error.actions) ? error.actions : null;
            if ( kind === 'topup' && (serverActions ? serverActions.includes('topup') : true) ) {
                card('topup', 'billing_dlg_topup', text('billing_dlg_topup_detail'), true);
            }
            if ( serverActions ? serverActions.includes('subscribe') : kind === 'subscribe' || plan === 'free' ) {
                const configuredGrant = config?.SUBSCRIPTION_INCLUDED_USD_MICRO;
                const grant = Number.isSafeInteger(configuredGrant) && configuredGrant >= 0 ? String(configuredGrant) : configuredGrant;
                const detail = formatUsdMicro(grant) === '—' ? text('billing_dlg_upgrade_detail')
                    : text('billing_dlg_upgrade_credit', { amount: formatUsdMicro(grant) });
                card('subscribe', 'billing_dlg_upgrade', detail, kind === 'subscribe');
            }
            element.append(cards, status);
        }
        const footer = node('div');
        footer.className = 'ezil-billing-footer';
        const send = button('resend', text('billing_dlg_resend'), () => { void resend(); }, busy || ! onResend || ! canResend());
        send.classList.add('ezil-billing-primary');
        send.append(billingIcon(doc, 'refresh'));
        footer.append(button('close', text('billing_dlg_close'), close), send);
        element.append(footer);
        if ( focusedAction ) {
            const target = element.querySelector(`[data-action="${focusedAction}"]:not(:disabled)`)
                ?? element.querySelector('[data-action="close"]');
            target.focus();
        }
    }

    function open (next) {
        if ( ! enabled || destroyed ) return false;
        if ( next ) {
            if ( next.status !== 402 || ! ['topup', 'subscribe'].includes(classifyGatewayError(next.status, next.body)) ) return false;
            failure = { status: next.status, body: next.body };
            balanceRefreshed = false;
            if ( ! checking ) { checkoutState = 'idle'; notice = ''; }
            if ( next.wallet !== undefined ) wallet = next.wallet;
            else {
                const error = next.body?.error;
                const balance = error?.balance ?? next.body?.balance;
                if ( balance?.includedUsdMicro !== undefined && balance?.purchasedUsdMicro !== undefined ) {
                    wallet = {
                        version: 2, unit: 'usd_micro', plan: error?.plan ?? next.body?.plan ?? wallet?.plan,
                        included: { balance: balance.includedUsdMicro, periodEnd: wallet?.included?.periodEnd }, purchased: { balance: balance.purchasedUsdMicro },
                    };
                }
            }
        }
        if ( ! element ) {
            injectBillingStyles(doc);
            previousFocus = doc.activeElement;
            element = node('dialog');
            element.className = 'ezil-billing-popup';
            element.setAttribute('role', 'dialog');
            element.setAttribute('aria-modal', 'true');
            element.setAttribute('aria-labelledby', headlineId);
            element.addEventListener('cancel', event => { event.preventDefault(); close(); });
            doc.body.append(element);
            render();
            if ( typeof element.showModal === 'function' ) element.showModal();
            else element.setAttribute('open', '');
        } else render();
        (element.querySelector('.ezil-billing-card-primary:not(:disabled)') ?? element.querySelector('[data-action="close"]'))?.focus();
        return true;
    }

    return {
        open, close, updateWallet,
        get draft () { return draft; },
        get wallet () { return wallet; },
        get element () { return element; },
        get checkoutState () { return checkoutState; },
        destroy () { destroyed = true; close(); },
    };
}

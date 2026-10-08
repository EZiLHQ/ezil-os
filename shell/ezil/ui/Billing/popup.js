import { classifyGatewayError } from './classify.js';
import { billingEnabled, billingReason, text } from './text.js';
import { formatUsdMicro, walletBalances, walletSummary } from './wallet-badge.js';

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
        el.className = 'ezil-settings-btn';
        el.style.cssText = 'padding:8px 12px;cursor:pointer;';
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
        if ( sending || checking || destroyed || ! element || ! onResend ) return;
        sending = true;
        notice = '';
        render();
        try {
            await onResend(draft);
            close();
        } catch {
            notice = text('billing_resend_failed');
        } finally {
            sending = false;
            render();
        }
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
        notice = text('billing_checking_wallet');
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
                    const previous = walletBalances(before);
                    const current = walletBalances(next);
                    const changed = previous && current && (action === 'subscribe'
                        ? (before.plan === 'free' && next.plan === 'subscriber') || current.included > previous.included
                        : current.purchased > previous.purchased);
                    if ( changed ) {
                        checkoutState = 'updated';
                        notice = text('billing_wallet_updated');
                        break;
                    }
                } catch {
                    // Transient reads consume an attempt, never confirm payment.
                }
            }
            if ( checkoutState !== 'updated' ) {
                checkoutState = 'unconfirmed';
                notice = text('billing_payment_unconfirmed');
            }
        } catch {
            checkoutState = 'failed';
            notice = text('billing_checkout_failed');
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
        element.append(node('h2', billingReason(kind, failure.body)));
        const balances = walletBalances(wallet);
        if ( balances ) {
            const list = node('dl');
            for ( const bucket of ['included', 'purchased'] ) {
                list.append(node('dt', text(`billing_${bucket}`)), node('dd', formatUsdMicro(String(balances[bucket]))));
            }
            element.append(list);
        } else {
            element.append(node('p', walletSummary(wallet, formatLegacyWallet).label));
        }
        const required = error.requiredUsdMicro ?? failure.body?.requiredUsdMicro;
        if ( balances && required !== undefined && formatUsdMicro(required) !== '—' ) {
            element.append(node('p', text('billing_required', { amount: formatUsdMicro(required) })));
        }
        const retryAfter = error.retryAfterSeconds ?? failure.body?.retryAfterSeconds;
        if ( kind === 'retry_later' && Number.isFinite(retryAfter) && retryAfter >= 0 ) {
            element.append(node('p', text('billing_retry_after', { seconds: Math.ceil(retryAfter) })));
        }
        element.append(node('p', text('billing_draft_kept')));
        const status = node('p', notice);
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        element.append(status);
        const actions = node('div');
        actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        const busy = checking || sending;
        if ( kind === 'topup' || kind === 'subscribe' ) {
            const serverActions = Array.isArray(error.actions) ? error.actions : null;
            if ( serverActions ? serverActions.includes('topup') : kind === 'topup' ) {
                actions.append(button('topup', text('billing_topup'), () => { void checkout('topup'); }, busy || ! startCheckout || ! refreshWallet));
            }
            if ( serverActions ? serverActions.includes('subscribe') : kind === 'subscribe' || plan === 'free' ) {
                actions.append(button('subscribe', text('billing_upgrade'), () => { void checkout('subscribe'); }, busy || ! startCheckout || ! refreshWallet));
            }
        }
        if ( ['topup', 'subscribe', 'provider'].includes(kind) ) {
            actions.append(button('resend', text(kind === 'provider' ? 'billing_retry' : 'billing_resend'), () => { void resend(); }, busy || ! onResend));
        }
        if ( kind === 'retry_later' ) actions.append(button('later', text('billing_try_later'), close));
        actions.append(button('close', text('billing_close'), close));
        element.append(actions);
        if ( focusedAction ) element.querySelector(`[data-action="${focusedAction}"]`)?.focus();
    }

    function open (next) {
        if ( ! enabled || destroyed ) return false;
        if ( next ) {
            failure = { status: next.status, body: next.body };
            if ( next.wallet !== undefined ) wallet = next.wallet;
            else {
                const error = next.body?.error;
                const balance = error?.balance ?? next.body?.balance;
                if ( balance?.includedUsdMicro !== undefined && balance?.purchasedUsdMicro !== undefined ) {
                    wallet = {
                        version: 2, unit: 'usd_micro', plan: error?.plan ?? next.body?.plan ?? wallet?.plan,
                        included: { balance: balance.includedUsdMicro }, purchased: { balance: balance.purchasedUsdMicro },
                    };
                }
            }
        }
        if ( ! element ) {
            previousFocus = doc.activeElement;
            element = node('dialog');
            element.className = 'ezil-billing-popup';
            element.setAttribute('aria-label', text('billing_dialog'));
            element.style.cssText = 'position:fixed;inset:0;margin:auto;width:min(440px,calc(100vw - 32px));box-sizing:border-box;max-height:90vh;overflow:auto;padding:24px;border:1px solid #888;border-radius:12px;background:Canvas;color:CanvasText;z-index:2147483647;';
            element.addEventListener('cancel', event => { event.preventDefault(); close(); });
            doc.body.append(element);
            render();
            if ( typeof element.showModal === 'function' ) element.showModal();
            else element.setAttribute('open', '');
            element.querySelector('button:not(:disabled)')?.focus();
        } else render();
        return true;
    }

    return {
        open, close,
        get draft () { return draft; },
        get wallet () { return wallet; },
        get element () { return element; },
        get checkoutState () { return checkoutState; },
        destroy () { destroyed = true; close(); },
    };
}

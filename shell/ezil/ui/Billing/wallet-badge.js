import { billingEnabled, text } from './text.js';
import { ensurePanelStyles } from './style-panels.js';

let nextPopoverId = 0;

function integer (value) {
    if ( typeof value !== 'string' || !/^\d+$/.test(value) ) return null;
    return BigInt(value);
}

// Display cents rounded down: never advertise more spendable money than exists.
// Keep the entire calculation in BigInt, including values beyond MAX_SAFE_INTEGER.
export function formatUsdMicro (value) {
    const amount = integer(value);
    if ( amount === null ) return '—';
    const cents = amount / 10000n;
    return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function walletBalances (wallet) {
    if ( wallet?.version !== 2 || wallet.unit !== 'usd_micro' ) return null;
    const included = integer(wallet.included?.balance);
    const purchased = integer(wallet.purchased?.balance);
    return included === null || purchased === null ? null : { included, purchased };
}

export function walletSummary (wallet, formatLegacyWallet) {
    const balances = walletBalances(wallet);
    if ( balances ) {
        const included = formatUsdMicro(String(balances.included));
        const purchased = formatUsdMicro(String(balances.purchased));
        return {
            label: text('billing_balance', { amount: formatUsdMicro(String(balances.included + balances.purchased)) }),
            detail: `${text('billing_included')}: ${included} · ${text('billing_purchased')}: ${purchased}`,
        };
    }
    if ( wallet?.version === 1 ) {
        // C3 leaves legacy fields unspecified. Never reinterpret them as USD.
        const raw = wallet.balanceMicrocredits ?? wallet.balance_microcredits;
        const label = formatLegacyWallet?.(wallet)
            ?? (integer(raw) !== null ? text('billing_microcredits', { amount: raw }) : text('billing_legacy_wallet'));
        return { label, detail: text('billing_legacy_wallet') };
    }
    return { label: text('billing_balance_unavailable'), detail: text('billing_balance_unavailable') };
}

export async function fetchWallet ({ fetchImpl = globalThis.fetch, walletUrl = '/v1/wallet', signal } = {}) {
    const response = await fetchImpl(walletUrl, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
    if ( ! response.ok ) throw new Error(text('billing_balance_unavailable'));
    return response.json();
}

export function createWalletBadge ({
    config, document: doc = globalThis.document, wallet = null, formatLegacyWallet,
    onTopup, onUpgrade, periodGrantUsdMicro = '20000000',
} = {}) {
    const element = billingEnabled(config) ? doc.createElement('button') : null;
    const popoverId = `ezil-billing-wallet-${++nextPopoverId}`;
    let popover = null;

    function close () {
        popover?.remove();
        popover = null;
        element?.setAttribute('aria-expanded', 'false');
        doc?.removeEventListener('keydown', onKeydown);
        doc?.removeEventListener('pointerdown', onOutside);
    }

    function onKeydown (event) {
        if ( event.key !== 'Escape' ) return;
        event.preventDefault();
        close();
        element.focus();
    }

    function onOutside (event) {
        if ( ! element.contains(event.target) && ! popover?.contains(event.target) ) close();
    }

    function progress (included, compact = false) {
        const grant = integer(periodGrantUsdMicro);
        const remaining = grant > 0n ? (included < grant ? included : grant) * 10000n / grant : 0n;
        const percent = Number(remaining) / 100;
        const bar = doc.createElement('span');
        bar.className = 'ezil-billing-progress';
        if ( compact ) bar.setAttribute('aria-hidden', 'true');
        else {
            bar.setAttribute('role', 'progressbar');
            bar.setAttribute('aria-label', text('billing_wallet_remaining'));
            bar.setAttribute('aria-valuemin', '0');
            bar.setAttribute('aria-valuemax', '100');
            bar.setAttribute('aria-valuenow', String(percent));
        }
        const fill = doc.createElement('span');
        fill.className = 'ezil-billing-progress-fill';
        fill.style.width = `${percent}%`;
        bar.append(fill);
        return bar;
    }

    function renderPopover () {
        const balances = walletBalances(wallet);
        if ( ! popover || ! balances ) return;
        const focusedAction = popover.contains(doc.activeElement) ? doc.activeElement.dataset.action : null;
        popover.replaceChildren();
        for ( const bucket of ['included', 'purchased'] ) {
            const row = doc.createElement('div');
            row.className = 'ezil-billing-wallet-row';
            const label = doc.createElement('span');
            label.className = 'ezil-billing-wallet-label';
            label.textContent = text(`billing_wallet_${bucket}`);
            const amount = doc.createElement('span');
            amount.className = 'ezil-billing-money';
            amount.textContent = formatUsdMicro(String(balances[bucket]));
            row.append(label, amount);
            let note = '';
            if ( bucket === 'included' ) {
                row.append(progress(balances.included));
                const date = wallet.included.periodEnd ? new Date(wallet.included.periodEnd) : null;
                if ( date && ! Number.isNaN(date.getTime()) ) {
                    note = text('billing_wallet_renews', { date: date.toLocaleDateString(doc.documentElement.lang || undefined, {
                        month: 'short', day: 'numeric', timeZone: 'UTC',
                    }) });
                }
            } else note = text('billing_wallet_used_after');
            if ( note ) {
                const detail = doc.createElement('span');
                detail.className = 'ezil-billing-wallet-note';
                detail.textContent = note;
                row.append(detail);
            }
            popover.append(row);
        }
        const footer = doc.createElement('div');
        footer.className = 'ezil-billing-wallet-footer';
        for ( const [action, callback] of [['topup', onTopup], ['upgrade', onUpgrade]] ) {
            if ( action === 'upgrade' && wallet.plan !== 'free' ) continue;
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = `ezil-billing-button${action === 'upgrade' ? ' ezil-billing-button-primary' : ''}`;
            button.dataset.action = action;
            button.textContent = text(`billing_wallet_${action}`);
            button.disabled = typeof callback !== 'function';
            button.addEventListener('click', event => {
                if ( button.disabled || ! popover || event.detail > 1 ) return;
                close();
                element.focus();
                callback();
            });
            footer.append(button);
        }
        popover.append(footer);
        if ( focusedAction ) (popover.querySelector(`[data-action="${focusedAction}"]:not(:disabled)`) ?? popover).focus();
    }

    function open () {
        if ( popover ) { close(); return; }
        if ( ! walletBalances(wallet) ) return;
        popover = doc.createElement('div');
        popover.id = popoverId;
        popover.className = 'ezil-billing-wallet-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', text('billing_wallet_details'));
        popover.tabIndex = -1;
        renderPopover();
        doc.body.append(popover);
        const rect = element.getBoundingClientRect();
        const width = doc.defaultView.innerWidth;
        const height = doc.defaultView.innerHeight;
        popover.style.left = `${Math.max(8, Math.min(rect.left, width - popover.offsetWidth - 8))}px`;
        popover.style.top = `${Math.max(8, Math.min(rect.bottom + 6, height - popover.offsetHeight - 8))}px`;
        element.setAttribute('aria-expanded', 'true');
        doc.addEventListener('keydown', onKeydown);
        doc.addEventListener('pointerdown', onOutside);
        (popover.querySelector('button:not(:disabled)') ?? popover).focus();
    }

    function update (next) {
        wallet = next;
        if ( ! element ) return;
        const summary = walletSummary(wallet, formatLegacyWallet);
        element.replaceChildren();
        const balances = walletBalances(wallet);
        element.disabled = ! balances;
        if ( balances ) {
            const label = doc.createElement('span');
            label.className = 'ezil-billing-sr-only';
            label.textContent = text('billing_wallet_balance_label');
            const amount = doc.createElement('span');
            amount.className = 'ezil-billing-money';
            amount.textContent = formatUsdMicro(String(balances.included + balances.purchased));
            element.append(label, amount, progress(balances.included, true));
            renderPopover();
        } else {
            close();
            element.textContent = summary.label;
        }
        element.title = summary.detail;
        element.setAttribute('aria-label', `${summary.label}. ${summary.detail}`);
    }
    if ( element ) {
        ensurePanelStyles(doc);
        element.type = 'button';
        element.className = 'ezil-billing-wallet-badge ezil-billing-money';
        element.setAttribute('aria-expanded', 'false');
        element.setAttribute('aria-haspopup', 'dialog');
        element.setAttribute('aria-controls', popoverId);
        element.addEventListener('click', open);
        update(wallet);
    }
    return { element, update, destroy: () => { close(); element?.removeEventListener('click', open); element?.remove(); } };
}

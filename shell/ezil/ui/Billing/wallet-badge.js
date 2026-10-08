import { billingEnabled, text } from './text.js';

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

export function createWalletBadge ({ config, document: doc = globalThis.document, wallet = null, formatLegacyWallet } = {}) {
    const element = billingEnabled(config) ? doc.createElement('span') : null;
    function update (next) {
        wallet = next;
        if ( ! element ) return;
        const summary = walletSummary(wallet, formatLegacyWallet);
        element.textContent = summary.label;
        element.title = summary.detail;
        element.setAttribute('aria-label', `${summary.label}. ${summary.detail}`);
    }
    if ( element ) {
        element.className = 'ezil-wallet-badge';
        element.setAttribute('role', 'status');
        element.setAttribute('aria-live', 'polite');
        update(wallet);
    }
    return { element, update, destroy: () => element?.remove() };
}

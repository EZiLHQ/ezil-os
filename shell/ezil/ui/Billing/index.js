import { classifyGatewayError } from './classify.js';
import { createBillingPopup } from './popup.js';
import { createWalletBadge, fetchWallet } from './wallet-badge.js';
import { billingEnabled } from './text.js';

export { classifyGatewayError } from './classify.js';
export { createBillingPopup } from './popup.js';
export { createWalletBadge, fetchWallet, formatUsdMicro, walletBalances, walletSummary } from './wallet-badge.js';
export { mountComputeSize } from './compute-size.js';

/**
 * Chat integration (no global fetch interception):
 *
 * const billing = attachToChat({
 *     config: { WALLET_V2_ENABLED: serverConfig.WALLET_V2_ENABLED },
 *     fetchImpl: authenticatedGatewayFetch, walletMount: balanceElement,
 *     startCheckout: action => checkoutAndWaitForReturn(action),
 *     onResend: (draft, { requestId }) => sendChat(draft, { requestId }),
 * });
 * await billing.ready;
 * if (!response.ok) await billing.handleResponse(response, retainedDraft);
 * // billing.popup.close()/open() preserves that exact draft; dispose on unmount.
 *
 * fetchImpl must route /v1/wallet to the authenticated gateway. An optional
 * refreshWallet({signal}) may supply the same server read. Checkout must resolve
 * on return/close; it cannot attest payment. For full-page checkout the host
 * must persist and restore the draft, then fetch the wallet on return. This
 * adapter neither reads return-URL flags nor initiates chat requests itself.
 * onResend receives a NEW requestId on every explicit attempt; the host must
 * send it using the gateway's request-ID field, never the refused request ID.
 * formatLegacyWallet can format the host's existing v1 schema without conversion.
 * With the flag absent/false, there are no DOM changes, reads, or callbacks.
 *
 * Settings uses the same flag in its launch ctx.config. Supply ctx.computeSize
 * with getShapes() -> shape[], changeShape({computerId, shape}), and onUpgrade().
 * getShapes defaults to the existing tRPC caller for compute.shapes. The change
 * callback must perform the server-authorized restart/checkpoint operation;
 * the picker always obtains the restart confirmation before invoking it.
 */
export function attachToChat ({
    config, fetchImpl = globalThis.fetch, walletUrl = '/v1/wallet', walletMount,
    refreshWallet: readWallet, onResend, startCheckout, formatLegacyWallet,
    document: doc = globalThis.document,
    createRequestId = () => globalThis.crypto.randomUUID(),
    ...popupOptions
} = {}) {
    const enabled = billingEnabled(config);
    const badge = createWalletBadge({ config, document: doc, formatLegacyWallet });
    if ( badge.element && walletMount ) walletMount.append(badge.element);
    let wallet = null;
    let popup = null;
    let disposed = false;
    let refreshSequence = 0;

    async function refreshWallet ({ signal } = {}) {
        if ( ! enabled || disposed ) return null;
        const sequence = ++refreshSequence;
        const next = await (readWallet ? readWallet({ signal }) : fetchWallet({ fetchImpl, walletUrl, signal }));
        if ( ! disposed && ! signal?.aborted && sequence === refreshSequence ) {
            wallet = next;
            badge.update(next);
        }
        return next;
    }

    function handleGatewayError (status, body, draft) {
        if ( ! enabled || disposed || classifyGatewayError(status, body) === 'unknown' ) return false;
        popup?.destroy();
        popup = createBillingPopup({
            ...popupOptions, config, document: doc, wallet, draft,
            startCheckout, refreshWallet, formatLegacyWallet,
            onResend: onResend ? savedDraft => onResend(savedDraft, { requestId: createRequestId() }) : undefined,
        });
        return popup.open({ status, body });
    }

    return {
        ready: enabled ? refreshWallet().catch(() => null) : Promise.resolve(null),
        badge, refreshWallet, handleGatewayError,
        async handleResponse (response, draft) {
            if ( ! enabled || disposed || response.ok ) return false;
            let body;
            try { body = await response.clone().json(); } catch { return false; }
            return handleGatewayError(response.status, body, draft);
        },
        get popup () { return popup; },
        dispose () { disposed = true; popup?.destroy(); badge.destroy(); },
    };
}

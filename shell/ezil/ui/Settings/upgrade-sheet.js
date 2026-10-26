// upgrade-sheet.js — EZiL-authored. Payment stays inside the desktop;
// only the server's summary can confirm the purchased plan.
import { openSheetFrame } from './sheet-frame.js';
import { dollars, stdHoursLabel, sizeLabel, planName, errorCopy } from './billing-format.js';

let stripePromise = null;

/** Keep return-link parsing independent of boot and preserve unrelated keys. */
export function parseBillingDeepLink (search) {
    const params = new URLSearchParams(search);
    if ( params.get('settings') !== 'billing' ) return null;
    const upgrade = params.get('upgrade');
    const openUpgrade = upgrade === 'standard' ? 'standard_monthly_v3'
        : upgrade === 'premium' ? 'premium_monthly_v3'
        : upgrade === 'compute' ? 'compute_monthly_v2' : upgrade === 'pro';
    params.delete('settings');
    params.delete('upgrade');
    const remaining = params.toString();
    return { initialTab: 'billing', openUpgrade, search: remaining ? `?${remaining}` : '' };
}

/** A failed download is evicted so Retry can reuse the existing payment session. */
export async function defaultLoadStripe (publishableKey, { signal } = {}) {
    if ( ! stripePromise ) {
        stripePromise = new Promise((resolve, reject) => {
            if ( typeof window.Stripe === 'function' ) { resolve(window.Stripe); return; }
            const script = document.createElement('script');
            script.src = 'https://js.stripe.com/v3';
            script.async = true;
            let timer;
            const finish = (error) => {
                window.clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                script.onload = null;
                script.onerror = null;
                if ( error ) { script.remove(); reject(error); }
                else resolve(window.Stripe);
            };
            const abort = () => finish(new Error('Payment form closed.'));
            script.onload = () => finish(typeof window.Stripe === 'function' ? null : new Error('Payment form unavailable.'));
            script.onerror = () => finish(new Error('Payment form unavailable.'));
            timer = window.setTimeout(() => finish(new Error('Payment form took too long to load.')), 15000);
            signal?.addEventListener('abort', abort, { once: true });
            if ( signal?.aborted ) abort();
            else document.head.append(script);
        }).catch(error => { stripePromise = null; throw error; });
    }
    const Stripe = await stripePromise;
    return Stripe(publishableKey);
}

/** The shell client returns an envelope; injected clients may return wire data. */
function unwrap (result) {
    if ( result?.ok === false ) throw new Error(errorCopy(result.message));
    return result?.ok === true ? result.data : result;
}

/**
 * One sheet per document also means one checkout on a double click. Closing
 * releases that reservation immediately; late responses cannot mount into a
 * later sheet that happens to use the same Stripe element id.
 */
/** How often an open payment form re-checks its session (see watchSession). */
const WATCH_INTERVAL_MS = 4000;
export const CONFIRM_POLL_MS = 1500;
export const CONFIRM_DEADLINE_MS = 60000;

// Retain the legacy string/envelope during rollout. Missing paymentStatus is
// unconfirmed, never paid; the session's lifecycle and receipt are separate.
const checkoutStatus = result => {
    const data = unwrap(result);
    return {
        status: typeof data === 'string' ? data : data?.status,
        paymentStatus: ['paid', 'unpaid', 'no_payment_required'].includes(data?.paymentStatus) ? data.paymentStatus : null,
    };
};

// Checkout completion also covers delayed bank payments. Only the webhook-backed
// summary below establishes the plan; neither this status nor onComplete is paid.
const PAYMENT_PENDING_COPY = 'Payment confirmation is pending. Bank payments can take a few days. Your plan updates after payment is confirmed.';

// Stripe.js v3 mounts these Financial Connections, Link and embedded checkout
// modal frames in body portals. Validate their URL only; never inspect their DOM.
function isStripeModalFrame (iframe) {
    try {
        if ( iframe.hasAttribute('srcdoc') ) return false;
        const url = new URL(iframe.getAttribute('src'));
        return url.origin === 'https://js.stripe.com' && ! url.username && ! url.password
            && (/^\/v3\/(?:linked-accounts|universal-link-modal)-inner-[a-f0-9]{32}\.html$/.test(url.pathname)
                || /^\/v3\/embedded-checkout-modal-[a-f0-9]{40}\.html$/.test(url.pathname));
    } catch { return false; }
}

export function openUpgradeSheet ({ container, sku, offer, sizes, trpc, onDone, onClose, loadStripe = defaultLoadStripe, now = Date.now }) {
    container = container?.get?.(0) ?? container;
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const controller = new win.AbortController();
    let closed = false;
    let checkout = null;
    let releaseProviderPortals = null;
    let session = null;
    let busy = false;
    let polling = false;
    let confirming = false;
    let sessionCompleted = false;
    let paymentStatus = null;
    let confirmationCopy = null;
    let finished = false;
    let deadline = 0;
    const timers = new Set();
    const v3 = sku.endsWith('_v3');
    const name = v3 ? offer.name : planName(offer.family);
    const price = dollars(offer.priceCents, { compact: true });
    const allowance = v3 ? 'Usage included' : `${stdHoursLabel(offer.allowanceStdSeconds)} standard-hours each billing period`;
    const frame = openSheetFrame({
        container, title: `Subscribe to ${name}`, role: 'upgrade-sheet', onClose,
        canDismissBackdrop: () => ! busy && ! (confirming && ! finished),
        dispose: () => {
            closed = true;
            clearTimers();
            controller.abort();
            destroy(checkout);
            checkout = null;
            releaseProviderPortals?.();
            releaseProviderPortals = null;
        },
        onCompact: (matches, dialog) => {
            const summary = dialog.querySelector('details');
            if ( ! summary ) return;
            summary.open = ! matches;
            summary.querySelector('#ezil-upgrade-title').hidden = matches;
            summary.querySelector('.ezil-upgrade-compact-title').hidden = ! matches;
        },
    });
    if ( frame.existing ) return frame.existing;
    const { dialog, close, focusFirst } = frame;
    frame.content.innerHTML = `
        <div class="ezil-upgrade-columns">
            <details class="ezil-upgrade-summary" open>
                <summary><span id="ezil-upgrade-title"></span><span class="ezil-upgrade-compact-title" hidden></span></summary>
                <p class="ezil-upgrade-price"><span data-role="price"></span> <span>/month</span></p>
                <p class="ezil-upgrade-caption">USD · before applicable tax<br>Any applicable tax is shown before you pay</p>
                <ul class="ezil-upgrade-allowances"></ul>
                <hr>
                <div class="ezil-upgrade-total"><strong>Due today</strong><span>Total shown in the payment form</span></div>
                <p class="ezil-upgrade-caption">Renews monthly until you cancel in Settings → Billing.</p>
                <p class="ezil-upgrade-security"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg><span>Payments are processed securely by Stripe.</span></p>
            </details>
            <section class="ezil-upgrade-payment" aria-label="Secure payment">
                <div data-role="checkout-state" role="status" aria-live="polite"></div>
                <div id="ezil-embedded-checkout"></div>
            </section>
        </div>`;
    dialog.querySelector('#ezil-upgrade-title').textContent = `Subscribe to ${name}`;
    dialog.querySelector('.ezil-upgrade-compact-title').textContent = `${name} · ${price}/month · before applicable tax`;
    dialog.querySelector('[data-role="price"]').textContent = price;
    let lines;
    if ( v3 ) {
        lines = offer.bullets;
        const included = doc.createElement('p');
        included.textContent = `${allowance}. Your plan takes effect after payment. Your AWS computer is prepared then.`;
        dialog.querySelector('.ezil-upgrade-allowances').before(included);
    } else {
        const offeredSizes = offer.sizes.map(code => sizes.find(size => size.code === code));
        const cpus = offeredSizes.map(size => size.vcpu);
        const sizeCopy = offeredSizes.length === 1 ? `${sizeLabel(offeredSizes[0])} computer`
            : `${cpus.slice(0, -1).join(', ')} or ${cpus.at(-1)} vCPU computers, up to ${Math.max(...offeredSizes.map(size => size.memoryGiB))} GiB`;
        lines = [allowance, sizeCopy, 'Sessions run up to 6 hours; files and installed tools are kept'];
        if ( offer.family === 'compute' && offer.overage ) lines.push(`Optional usage beyond ${stdHoursLabel(offer.allowanceStdSeconds)} standard-hours at ${dollars(offer.overage.centsPerStdHour, { compact: true })} each — off unless you turn it on`);
    }
    for ( const line of lines ) {
        const li = doc.createElement('li');
        li.textContent = line;
        dialog.querySelector('.ezil-upgrade-allowances').append(li);
    }
    const state = dialog.querySelector('[data-role="checkout-state"]');
    const mount = dialog.querySelector('#ezil-embedded-checkout');
    frame.refreshCompact();

    function clearTimers () {
        for ( const timer of timers ) win.clearTimeout(timer);
        timers.clear();
    }
    function later (fn, delay) {
        const timer = win.setTimeout(() => { timers.delete(timer); fn(); }, delay);
        timers.add(timer);
        return timer;
    }
    let watchTimer = null;
    function stopWatching () {
        if ( watchTimer === null ) return;
        win.clearTimeout(watchTimer);
        timers.delete(watchTimer);
        watchTimer = null;
    }
    function destroy (instance) {
        try { instance?.destroy(); } catch { /* Teardown must still restore focus. */ }
    }
    function show (message, label, action, actionName = 'retry') {
        const hadFocus = state.contains(doc.activeElement);
        state.replaceChildren();
        const text = doc.createElement('p');
        text.textContent = message;
        state.append(text);
        if ( label ) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.action = actionName;
            button.addEventListener('click', () => { if ( ! closed && ! busy ) action(); });
            state.append(button);
        }
        if ( hadFocus ) focusFirst();
    }
    function returnToBilling () {
        try { onDone?.(); } finally { close(); }
    }
    function showConfirmation (timeout = false) {
        const message = paymentStatus === 'paid' ? 'Payment received. Waiting for your plan to update.'
            : paymentStatus === 'no_payment_required' ? 'No payment is required. Waiting for your plan to update.'
            : paymentStatus === 'unpaid' ? 'Your payment is processing. Bank payments can take a few days. Your plan updates after payment is confirmed.'
            : PAYMENT_PENDING_COPY;
        const copy = timeout ? `${message} Check Settings → Billing for updates.` : message;
        if ( confirmationCopy === copy ) return;
        confirmationCopy = copy;
        show(copy, 'Back to Billing', returnToBilling, 'return-to-billing');
    }
    function timedOut () {
        if ( closed || finished ) return;
        finished = true;
        clearTimers();
        if ( sessionCompleted ) showConfirmation(true);
        else show('We could not confirm your payment yet. Check Settings → Billing in a moment.', 'Back to Billing', returnToBilling, 'return-to-billing');
    }
    function success () {
        finished = true;
        clearTimers();
        mount.hidden = true;
        show(`You're on ${name}`, 'Done', returnToBilling);
        state.dataset.role = 'upgrade-success';
        state.querySelector('button').dataset.action = 'done';
        const icon = doc.createElement('span');
        icon.textContent = '✓';
        icon.setAttribute('aria-hidden', 'true');
        state.prepend(icon);
        const allowances = doc.createElement('p');
        allowances.textContent = allowance;
        state.querySelector('button').before(allowances);
        state.querySelector('button').focus();
    }
    async function poll () {
        if ( closed || finished ) return;
        if ( now() >= deadline ) { timedOut(); return; }
        try {
            if ( ! sessionCompleted || ! ['paid', 'no_payment_required'].includes(paymentStatus) ) {
                const result = checkoutStatus(await trpc.query('billing.checkoutStatus', { sessionId: session.sessionId }));
                if ( closed || finished ) return;
                if ( result.status === 'expired' ) {
                    finished = true;
                    clearTimers();
                    show('This checkout has expired. Close the sheet and try again.');
                    return;
                }
                if ( result.status === 'complete' ) {
                    sessionCompleted = true;
                    paymentStatus = result.paymentStatus;
                    confirming = true;
                    showConfirmation();
                }
                if ( ! sessionCompleted ) { later(() => { void poll(); }, CONFIRM_POLL_MS); return; }
            }
            const summary = unwrap(await trpc.query('billing.summary'));
            if ( closed || finished ) return;
            if ( now() >= deadline ) { timedOut(); return; }
            if ( summary?.plan?.sku === sku ) { success(); return; }
        } catch { /* A transient read failure must not imply that payment failed. */ }
        if ( ! closed && ! finished ) later(() => { void poll(); }, CONFIRM_POLL_MS);
    }
    /**
     * Stripe's form can lose its own confirmation (seen in a real run: "Your
     * internet connection is unstable. Your payment may have been successful…")
     * and then never calls onComplete. While the form is open the sheet also
     * asks the server about the session itself. Completion starts verification;
     * it does not establish receipt of an asynchronous bank payment. Only the
     * webhook-backed plan can make this sheet show success.
     */
    async function watchSession () {
        if ( closed || polling || finished ) return;
        try {
            const { status } = checkoutStatus(await trpc.query('billing.checkoutStatus', { sessionId: session.sessionId }));
            if ( closed || polling || finished ) return;
            if ( status === 'complete' ) { startPolling(true); return; }
        } catch { /* A failed check is retried on the next tick. */ }
        if ( ! closed && ! polling && ! finished ) watchTimer = later(watchSession, WATCH_INTERVAL_MS);
    }
    function startPolling (completed = false) {
        if ( closed || polling ) return;
        polling = true;
        stopWatching();
        // onComplete starts verification; it does not confirm receipt of funds.
        if ( completed ) { confirming = true; mount.hidden = true; show('Confirming your payment…'); }
        deadline = now() + CONFIRM_DEADLINE_MS;
        later(timedOut, CONFIRM_DEADLINE_MS);
        void poll();
    }
    async function embed () {
        if ( closed || busy ) return;
        busy = true;
        show('Loading the secure payment form…');
        try {
            // Stripe() can preload its hidden Link modal during the loader.
            releaseProviderPortals = frame.registerProviderPortals({ matchesFrame: isStripeModalFrame });
            const stripe = await loadStripe(session.publishableKey, { signal: controller.signal });
            if ( closed ) return;
            // Stripe.js renamed initEmbeddedCheckout to createEmbeddedCheckoutPage
            // (same options and return type); prefer the new name, keep the old
            // one for a cached older Stripe.js.
            const create = typeof stripe.createEmbeddedCheckoutPage === 'function'
                ? stripe.createEmbeddedCheckoutPage.bind(stripe)
                : stripe.initEmbeddedCheckout.bind(stripe);
            const instance = await create({
                fetchClientSecret: async () => session.clientSecret,
                onComplete: () => startPolling(true),
            });
            if ( closed ) { destroy(instance); return; }
            checkout = instance;
            instance.mount('#ezil-embedded-checkout');
            if ( ! polling ) show('');
            watchTimer = later(watchSession, WATCH_INTERVAL_MS);
        } catch {
            if ( closed ) return;
            destroy(checkout);
            checkout = null;
            releaseProviderPortals?.();
            releaseProviderPortals = null;
            show("Couldn't load the secure payment form — Try again", 'Try again', () => { void embed(); });
        } finally { busy = false; }
    }
    async function create () {
        if ( closed || busy ) return;
        busy = true;
        show('Preparing your checkout…');
        try {
            session = unwrap(await trpc.mutate('billing.createCheckout', { sku }));
            if ( closed ) return;
            if ( session.mode === 'redirect' ) {
                const url = new URL(session.url, win.location.href);
                if ( url.protocol !== 'https:' ) throw new Error('Could not open the secure checkout. Try again.');
                win.open(url.href, '_blank', 'noopener');
                show('Finish in the new tab', 'Open checkout', () => { win.open(url.href, '_blank', 'noopener'); });
                startPolling();
            } else if ( session.mode !== 'embedded' ) {
                throw new Error('Could not open the secure checkout. Try again.');
            }
        } catch (error) {
            if ( ! closed ) show(error?.message || 'Could not open billing. Try again.', 'Retry', () => { void create(); });
            session = null;
        } finally { busy = false; }
        if ( ! closed && session?.mode === 'embedded' ) void embed();
    }
    focusFirst();
    void create();
    return frame.handle;
}

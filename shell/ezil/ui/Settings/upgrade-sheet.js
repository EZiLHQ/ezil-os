// upgrade-sheet.js — EZiL-authored. Payment stays inside the desktop;
// only the server's summary can confirm that the webhook has granted Pro.

const sheets = new WeakMap();
let stripePromise = null;

/** Keep return-link parsing independent of boot and preserve unrelated keys. */
export function parseBillingDeepLink (search) {
    const params = new URLSearchParams(search);
    if ( params.get('settings') !== 'billing' ) return null;
    const openUpgrade = params.get('upgrade') === 'pro';
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
    if ( result?.ok === false ) throw new Error(result.message || 'Could not reach billing. Try again.');
    return result?.ok === true ? result.data : result;
}

/**
 * One sheet per document also means one checkout on a double click. Closing
 * releases that reservation immediately; late responses cannot mount into a
 * later sheet that happens to use the same Stripe element id.
 */
export function openUpgradeSheet ({ container, sku, trpc, onDone, loadStripe = defaultLoadStripe, now = Date.now }) {
    container = container?.get?.(0) ?? container;
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const existing = sheets.get(doc);
    if ( existing ) return existing;
    const opener = doc.activeElement;
    const controller = new win.AbortController();
    let closed = false;
    let checkout = null;
    let session = null;
    let busy = false;
    let polling = false;
    let confirming = false;
    let paid = false;
    let finished = false;
    let deadline = 0;
    const timers = new Set();
    const backdrop = doc.createElement('div');
    backdrop.className = 'ezil-upgrade-backdrop';
    backdrop.innerHTML = `
        <div class="ezil-upgrade-sheet" data-role="upgrade-sheet" role="dialog" aria-modal="true" aria-labelledby="ezil-upgrade-title" tabindex="-1">
            <span data-focus-edge="start" tabindex="0"></span>
            <button type="button" class="ezil-upgrade-close" data-action="close-sheet" aria-label="Close upgrade sheet">×</button>
            <div class="ezil-upgrade-columns">
                <details class="ezil-upgrade-summary" open>
                    <summary><span id="ezil-upgrade-title">Upgrade to EZiL Pro</span><span class="ezil-upgrade-compact-title" hidden>EZiL Pro · $20/month · Tax calculated at checkout</span></summary>
                    <p class="ezil-upgrade-price">$20 <span>/month</span></p>
                    <p class="ezil-upgrade-caption">USD · before applicable tax<br>Tax calculated at checkout</p>
                    <ul class="ezil-upgrade-allowances">
                        <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>20 h workspace time each month</span></li>
                        <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18M7 17h2"/></svg><span>2 GB storage today · 20 GB soon</span></li>
                        <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg><span>$3 AI credits each month — AI assistant coming soon</span></li>
                    </ul>
                    <p>Same standard computer and AI assistant as Free.</p>
                    <hr>
                    <div class="ezil-upgrade-total"><strong>Due today</strong><span>Total shown in the payment form</span></div>
                    <p class="ezil-upgrade-caption">Renews monthly until you cancel in Settings → Billing.</p>
                    <p class="ezil-upgrade-security"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg><span>Payments are processed securely by Stripe.</span></p>
                </details>
                <section class="ezil-upgrade-payment" aria-label="Secure payment">
                    <div data-role="checkout-state" role="status" aria-live="polite"></div>
                    <div id="ezil-embedded-checkout"></div>
                </section>
            </div>
            <span data-focus-edge="end" tabindex="0"></span>
        </div>`;
    // The viewport owns the payment geometry; Settings only owns its lifetime.
    const oldOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';
    doc.body.append(backdrop);
    const dialog = backdrop.querySelector('[role="dialog"]');
    const state = dialog.querySelector('[data-role="checkout-state"]');
    const mount = dialog.querySelector('#ezil-embedded-checkout');
    const summary = dialog.querySelector('details');
    const compact = win.matchMedia?.('(max-width: 759px)');
    const onCompact = event => {
        backdrop.classList.toggle('is-compact', event.matches);
        summary.open = ! event.matches;
        summary.querySelector('#ezil-upgrade-title').hidden = event.matches;
        summary.querySelector('.ezil-upgrade-compact-title').hidden = ! event.matches;
    };
    const onResize = () => onCompact({ matches: win.innerWidth < 760 });
    onResize();
    compact?.addEventListener('change', onCompact);
    win.addEventListener('resize', onResize);

    // Inert siblings keep pointer and assistive-technology navigation in the
    // modal, including when the caller supplies a pane rather than a window.
    const inert = [];
    for ( let node = backdrop; node.parentElement; node = node.parentElement ) {
        for ( const sibling of node.parentElement.children ) {
            if ( sibling !== node && ! sibling.hasAttribute('inert') ) {
                sibling.setAttribute('inert', '');
                inert.push(sibling);
            }
        }
        if ( node.parentElement === doc.body ) break;
    }
    const focusable = () => [...dialog.querySelectorAll('button, summary, a[href], iframe, [tabindex]')]
        .filter(el => ! el.disabled && ! el.hidden && el.tabIndex >= 0 && ! el.dataset.focusEdge
            && ! el.closest('[hidden]'));
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    const focusLast = () => (focusable().at(-1) ?? dialog).focus();
    const onFocus = event => {
        if ( ! dialog.contains(event.target) || event.target.dataset.focusEdge === 'end' ) focusFirst();
        else if ( event.target.dataset.focusEdge === 'start' ) focusLast();
    };
    const onKey = event => {
        if ( event.key === 'Escape' ) {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
        } else if ( event.key === 'Tab' ) {
            const elements = focusable();
            const first = elements[0];
            const last = elements.at(-1);
            if ( event.shiftKey && doc.activeElement === first ) { event.preventDefault(); focusLast(); }
            else if ( ! event.shiftKey && doc.activeElement === last ) { event.preventDefault(); focusFirst(); }
        }
    };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', onFocus, true);
    const observer = new win.MutationObserver(() => {
        if ( ! backdrop.isConnected || ! container.isConnected ) close();
    });
    observer.observe(doc.body, { childList: true, subtree: true });

    function clearTimers () {
        for ( const timer of timers ) win.clearTimeout(timer);
        timers.clear();
    }
    function later (fn, delay) {
        const timer = win.setTimeout(() => { timers.delete(timer); fn(); }, delay);
        timers.add(timer);
    }
    function destroy (instance) {
        try { instance?.destroy(); } catch { /* Teardown must still restore focus. */ }
    }
    function close () {
        if ( closed ) return;
        closed = true;
        clearTimers();
        controller.abort();
        destroy(checkout);
        checkout = null;
        observer.disconnect();
        compact?.removeEventListener('change', onCompact);
        win.removeEventListener('resize', onResize);
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('focusin', onFocus, true);
        for ( const sibling of inert ) sibling.removeAttribute('inert');
        backdrop.remove();
        doc.body.style.overflow = oldOverflow;
        sheets.delete(doc);
        if ( opener?.isConnected ) opener.focus();
    }
    function show (message, label, action) {
        const hadFocus = state.contains(doc.activeElement);
        state.replaceChildren();
        const text = doc.createElement('p');
        text.textContent = message;
        state.append(text);
        if ( label ) {
            const button = doc.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.action = 'retry';
            button.addEventListener('click', action);
            state.append(button);
        }
        if ( hadFocus ) focusFirst();
    }
    function timedOut () {
        if ( closed || finished ) return;
        finished = true;
        clearTimers();
        show(paid ? 'Payment received — your plan updates in a moment.'
            : 'We could not confirm your payment yet. Check Settings → Billing in a moment.');
    }
    function success (summary) {
        finished = true;
        clearTimers();
        mount.hidden = true;
        show("You're on EZiL Pro", 'Done', () => {
            try { onDone?.(); } finally { close(); }
        });
        state.dataset.role = 'upgrade-success';
        state.querySelector('button').dataset.action = 'done';
        const icon = doc.createElement('span');
        icon.textContent = '✓';
        icon.setAttribute('aria-hidden', 'true');
        state.prepend(icon);
        const allowances = doc.createElement('p');
        const storage = Number(summary.meters?.storage?.capBytes) >= 20000000000
            ? '20 GB storage' : '2 GB storage today · 20 GB soon';
        allowances.textContent = `20 h workspace time · ${storage} · $3 AI credits each month. AI assistant coming soon.`;
        state.querySelector('button').before(allowances);
        state.querySelector('button').focus();
    }
    async function poll () {
        if ( closed || finished ) return;
        if ( now() >= deadline ) { timedOut(); return; }
        try {
            if ( ! paid ) {
                const status = unwrap(await trpc.query('billing.checkoutStatus', { sessionId: session.sessionId }));
                if ( closed || finished ) return;
                if ( status.status === 'expired' ) {
                    finished = true;
                    clearTimers();
                    show('This checkout has expired. Close the sheet and try again.');
                    return;
                }
                if ( status.status !== 'complete' ) { later(() => { void poll(); }, 1500); return; }
                paid = true;
                confirming = true;
                show('Confirming your payment…');
            }
            const summary = unwrap(await trpc.query('billing.summary'));
            if ( closed || finished ) return;
            if ( now() >= deadline ) { timedOut(); return; }
            if ( summary?.plan?.id === 'pro' ) { success(summary); return; }
        } catch { /* A transient read failure must not imply that payment failed. */ }
        if ( ! closed && ! finished ) later(() => { void poll(); }, 1500);
    }
    function startPolling (completed = false) {
        if ( closed || polling ) return;
        polling = true;
        // onComplete starts verification; checkoutStatus still confirms receipt.
        if ( completed ) { confirming = true; mount.hidden = true; show('Confirming your payment…'); }
        deadline = now() + 30000;
        later(timedOut, 30000);
        void poll();
    }
    async function embed () {
        if ( closed || busy ) return;
        busy = true;
        show('Loading the secure payment form…');
        try {
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
        } catch {
            if ( closed ) return;
            destroy(checkout);
            checkout = null;
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
    const handle = { close };
    sheets.set(doc, handle);
    // A stray click outside the form must not dismiss receipt verification.
    backdrop.addEventListener('click', event => {
        if ( event.target === backdrop && ! (confirming && ! finished) ) close();
    });
    dialog.querySelector('[data-action="close-sheet"]').addEventListener('click', close);
    focusFirst();
    void create();
    return handle;
}

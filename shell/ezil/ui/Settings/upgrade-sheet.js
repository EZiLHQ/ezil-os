// upgrade-sheet.js — EZiL-authored. Payment stays inside the desktop;
// the server confirms payment, and only its summary confirms a purchased plan.
import { openSheetFrame } from './sheet-frame.js';
import { dollars, stdHoursLabel, sizeLabel, planName, errorCopy, planBullets, accountCredits, TRIAL_SKU, trialDayLabel, trialMomentLabel, paidAccess } from './billing-format.js';

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
    if ( params.get('section') === 'ai-credits' ) {
        params.delete('section');
        // The recovery hint travels with the section (Billing reads both before the address bar is cleaned).
        if ( params.get('reason') === 'insufficient_credits' ) params.delete('reason');
    }
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

/** The shell client returns an envelope; injected clients may return wire data. The server's code rides on `code`. */
function unwrap (result) {
    if ( result?.ok === false ) throw Object.assign(new Error(errorCopy(result.message)), { code: result.message });
    return result?.ok === true ? result.data : result;
}

/**
 * A `billing.quoteTrial` reply the sheet may disclose: Standard, $0 today, one readable end that is also the first
 * charge, a positive amount. Anything else is refused rather than shown, so no guessed date reaches the person.
 */
function trialQuote (data) {
    const ok = data && typeof data === 'object' && data.sku === TRIAL_SKU && data.todayCents === 0 && data.currency === 'usd'
        && data.interval === 'month' && Number.isSafeInteger(data.amountCents) && data.amountCents > 0
        && typeof data.trialEndsAt === 'string' && Number.isFinite(Date.parse(data.trialEndsAt))
        && Date.parse(data.firstChargeAt ?? '') === Date.parse(data.trialEndsAt);
    return ok ? { trialEndsAt: data.trialEndsAt, firstChargeAt: data.firstChargeAt, amountCents: data.amountCents } : null;
}
const TRIAL_ERRORS = new Set(['trial_unavailable', 'trial_quote_stale', 'trial_checkout_complete']);

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
const PAYMENT_PENDING_COPY = 'Payment confirmation is pending. Bank payments can take a few days.';

// A top-up is done only when the server says its receipt reached the AI ledger
// (`billing.topupStatus` fulfillment `credited`); a paid session is not credits.
const FULFILLMENTS = ['awaiting_payment', 'processing', 'credited', 'review'];
const topupStatus = result => {
    const data = unwrap(result);
    return {
        status: data?.status,
        paymentStatus: ['paid', 'unpaid', 'no_payment_required'].includes(data?.paymentStatus) ? data.paymentStatus : null,
        fulfillment: FULFILLMENTS.includes(data?.fulfillment) ? data.fulfillment : 'processing',
        credits: Number.isSafeInteger(data?.credits) && data.credits > 0 ? data.credits : null,
    };
};
const TOPUP_REVIEW_COPY = "Payment received, but your credits couldn't be added automatically. You don't need to pay again. Contact support if they don't appear soon.";
// Paid, not credited by the deadline: the webhook may have parked it before any receipt, so promise nothing.
const TOPUP_TIMEOUT_COPY = "Payment received, but we couldn't confirm your AI credits yet. You don't need to pay again. Check Settings → Billing for your balance, and contact support if the credits don't appear.";

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

/**
 * `trial: true` (Standard only) is the free month: the sheet first asks `billing.quoteTrial` for the exact end, shows
 * it in the viewer's zone with what is charged and when (a passive terms line above the payment form, no extra
 * confirmation step), and opens `billing.createCheckout({ sku, trial: { trialEndsAt } })` with that same end. Payment
 * then runs exactly as the Standard checkout does ($0 today). A stale end is re-quoted once automatically; a second
 * one stops at an explicit Retry.
 */
export function openUpgradeSheet ({ container, sku, offer, pack, sizes, trpc, onDone, onClose, onCancel, userId = null, loadStripe = defaultLoadStripe, now = Date.now, trial = false, timeZone }) {
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
    let fulfillment = null;
    let creditedCredits = null;
    const timers = new Set();
    const v3 = sku.endsWith('_v3');
    const trialMode = ! pack && trial === true && sku === TRIAL_SKU;
    /** The disclosed quote (`trialQuote`); null until `billing.quoteTrial` answers. Checkout echoes its end exactly. */
    let quote = null;
    /** A stale quote is re-quoted automatically once per open; the next one waits for an explicit Retry. */
    let staleRetried = false;
    const name = pack ? 'AI credits' : v3 ? offer.name : planName(offer.family);
    const price = trialMode ? '$0' : dollars(pack ? pack.totalCents : offer.priceCents, { compact: true });
    const allowance = pack ? `${pack.aiCredits.toLocaleString('en-US')} AI credits`
        : v3 ? 'Usage included' : `${stdHoursLabel(offer.allowanceStdSeconds)} standard-hours each billing period`;
    const title = pack ? 'Add AI credits' : trialMode ? 'Start your free month' : `Subscribe to ${name}`;
    const trialAmount = () => dollars(quote?.amountCents ?? offer.priceCents);
    const trialMoment = (full = false) => quote ? trialMomentLabel(quote.trialEndsAt, { timeZone, full }) : null;
    const paymentUpdate = pack ? 'Your AI credits update after payment is confirmed.' : 'Your plan updates after payment is confirmed.';
    const frame = openSheetFrame({
        container, title, role: 'upgrade-sheet', onClose,
        canDismissBackdrop: () => ! busy && ! (confirming && ! finished),
        dispose: () => {
            // Closed before Stripe finished the session: say so in Billing, without claiming nothing was paid.
            if ( pack && ! finished && ! sessionCompleted ) { try { onCancel?.(); } catch { /* Closing must still tear down. */ } }
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
                <p class="ezil-upgrade-price"><span data-role="price"></span>${pack ? '' : trialMode ? ' <span>today</span>' : ' <span>/month</span>'}</p>
                ${trialMode ? '<p class="ezil-upgrade-caption" data-role="trial-then"></p>'
                    : '<p class="ezil-upgrade-caption">USD · before applicable tax<br>Any applicable tax is shown before you pay</p>'}
                <ul class="ezil-upgrade-allowances"></ul>
                <hr>
                <div class="ezil-upgrade-total"><strong>Due today</strong><span>${trialMode ? '$0.00' : 'Total shown in the payment form'}</span></div>
                <p class="ezil-upgrade-caption"${trialMode ? ' data-role="trial-renews"' : ''}>${pack ? 'One-time payment. ' + paymentUpdate : trialMode ? '' : 'Renews monthly until you cancel in Settings → Billing.'}</p>
                <p class="ezil-upgrade-security"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg><span>Payments are processed securely by Stripe.</span></p>
            </details>
            <section class="ezil-upgrade-payment" aria-label="Secure payment">
                ${trialMode ? '<div data-role="trial-terms" aria-live="polite" hidden></div>' : ''}
                <div data-role="checkout-state" role="status" aria-live="polite"></div>
                <div id="ezil-embedded-checkout"></div>
            </section>
        </div>`;
    dialog.querySelector('#ezil-upgrade-title').textContent = title;
    dialog.querySelector('.ezil-upgrade-compact-title').textContent = trialMode
        ? `${name} · $0 today, then ${dollars(offer.priceCents, { compact: true })}/month · before applicable tax`
        : `${name} · ${price}${pack ? '' : '/month'} · before applicable tax`;
    dialog.querySelector('[data-role="price"]').textContent = price;
    let lines;
    if ( pack ) lines = [allowance, ...(Number.isFinite(pack.discountPercent) && pack.discountPercent > 0 ? [`Includes ${pack.discountPercent}% off`] : [])];
    else if ( v3 ) {
        // Round 3 (plan §6.4, M8): the bullets in plan order, then "What happens next" beside the payment form.
        lines = planBullets(offer).bullets;
        const next = doc.createElement('section');
        next.className = 'ezil-billing-next';
        next.setAttribute('aria-label', 'What happens next');
        const heading = doc.createElement('h3');
        heading.textContent = 'What happens next';
        const list = doc.createElement('dl');
        const credits = Number.isSafeInteger(offer.aiCredits?.amount) && offer.aiCredits.amount > 0 ? offer.aiCredits.amount.toLocaleString('en-US') : null;
        const computer = (offer.machineChoice ?? []).length > 1 ? 'Your own AWS computer. Choose 2, 4 or 8 vCPU in Settings → Computer.' : 'Your own AWS computer, set up when you first open it.';
        // Standard trial: nothing is paid today; the first charge is the quoted end (filled in by renderTrialTerms).
        for ( const [term, detail, role] of trialMode ? [
            ['Today', `$0. Your free month of ${offer.name} starts once you add a payment method.`],
            ['First charge', '', 'trial-first-charge'],
            ['Cancel', '', 'trial-cancel-by'],
            ['Your computer', computer],
        ] : [
            ['Today', credits ? `${offer.name} starts after payment and ${credits} AI credits are added.` : `${offer.name} starts after payment.`],
            ['Your computer', computer],
            ['Renews', 'Every month until you cancel in Settings → Billing.'],
        ] ) {
            const row = doc.createElement('div');
            const dt = doc.createElement('dt'), dd = doc.createElement('dd');
            dt.textContent = term;
            dd.textContent = detail;
            if ( role ) dd.dataset.role = role;
            row.append(dt, dd);
            list.append(row);
        }
        next.append(heading, list);
        dialog.querySelector('.ezil-upgrade-allowances').after(next);
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
    /** The quote's dates in the summary column (viewer's zone). Before a quote, only what is already certain. */
    function renderTrialTerms () {
        if ( ! trialMode ) return;
        const amount = trialAmount();
        const set = (role, text) => { const node = dialog.querySelector(`[data-role="${role}"]`); if ( node ) node.textContent = text; };
        set('trial-then', quote ? `Then ${amount}/month from ${trialDayLabel(quote.trialEndsAt, { timeZone })} · USD · before applicable tax`
            : `Then ${amount}/month · USD · before applicable tax`);
        // A date, never a minute: Stripe collects the first charge about an hour after the end shown beside the form.
        set('trial-first-charge', quote ? `${amount} from ${trialDayLabel(quote.trialEndsAt, { timeZone })}, then every month until you cancel.` : 'Shown before you continue.');
        set('trial-cancel-by', quote ? `Cancel before ${trialDayLabel(quote.trialEndsAt, { timeZone })} in Settings → Billing and you pay nothing.`
            : 'Cancel before your free month ends and you pay nothing.');
        set('trial-renews', `A payment method is required. ${amount} is charged monthly from the end of your free month unless you cancel.`);
    }
    /**
     * The passive terms line above the payment form (never cleared by `show()`/`embed()`, so it stays visible in the
     * compact layout where the summary column is collapsed): the exact quoted end in the viewer's zone and what is
     * charged from then. No button: the checkout opens on its own. `changed` adds the new-date notice.
     */
    /** Terminal and error states say nothing was started or charged: the quoted terms must not sit beside them. */
    function hideTrialTerms () {
        const box = dialog.querySelector('[data-role="trial-terms"]');
        if ( box ) box.hidden = true;
        // The wide summary column shows the quoted date too: drop the quote so it does not sit beside the error either.
        if ( quote ) { quote = null; renderTrialTerms(); }
    }
    function showTrialTerms (changed = false) {
        const box = dialog.querySelector('[data-role="trial-terms"]');
        if ( ! box || ! quote ) return;
        box.replaceChildren();
        const line = (text, role) => {
            const p = doc.createElement('p');
            if ( text ) p.textContent = text;
            p.dataset.role = role;
            box.append(p);
            return p;
        };
        if ( changed ) line("Your free month's end date changed. The new date is below.", 'trial-changed');
        const ends = line('', 'trial-ends');
        const time = doc.createElement('time');
        time.dateTime = quote.trialEndsAt;
        time.textContent = trialMoment(true);
        ends.append('Your free month ends on ', time, '.');
        line(`A payment method is required. ${trialAmount()} is charged monthly from that date unless you cancel. Cancel any time before then in Settings → Billing and you pay nothing.`, 'trial-charge');
        box.hidden = false;
    }
    /** `billing.quoteTrial`: claim this person's trial and fix the end shown above. `changed`: the last one went stale. */
    async function requote (changed = false) {
        if ( closed || busy ) return;
        busy = true;
        show(changed ? 'Checking the new date for your free month…' : 'Checking your free month…');
        let next = null, failure = null;
        try {
            next = trialQuote(unwrap(await trpc.mutate('billing.quoteTrial')));
            if ( ! next ) failure = new Error(errorCopy('unavailable'));
        } catch (error) { failure = error; }
        finally { busy = false; }
        if ( closed ) return;
        if ( next ) {
            quote = next;
            renderTrialTerms();
            showTrialTerms(changed);
            // No confirmation step: the quote is disclosed above the form and checkout opens with exactly that end.
            void create();
            return;
        }
        // Not this person's to start (or already starting): back to Billing, which re-reads the offer.
        hideTrialTerms();
        if ( failure?.code === 'trial_unavailable' || failure?.code === 'trial_checkout_complete' ) show(failure.message, 'Back to Billing', returnToBilling, 'return-to-billing');
        else show(failure?.message || errorCopy('unavailable'), 'Retry', () => { void requote(changed); });
    }
    function showConfirmation (timeout = false) {
        const waiting = pack ? 'Adding your AI credits…' : 'Waiting for your plan to update.';
        // Standard trial: $0 today is not a payment; never "payment received" or "paid" for a free month.
        const message = trialMode && paymentStatus === 'no_payment_required' ? `Your free month is starting. ${waiting}`
            : trialMode && paymentStatus === null ? 'Confirmation is pending. Your free month starts once it is confirmed.'
            : paymentStatus === 'paid' ? `Payment received. ${waiting}`
            : paymentStatus === 'no_payment_required' ? `No payment is required. ${waiting}`
            : paymentStatus === 'unpaid' ? `Your payment is processing. Bank payments can take a few days. ${paymentUpdate}`
            : `${PAYMENT_PENDING_COPY} ${paymentUpdate}`;
        const copy = timeout && pack && paymentStatus === 'paid' && fulfillment !== 'credited' ? TOPUP_TIMEOUT_COPY
            : timeout ? `${message} Check Settings → Billing for updates.` : message;
        if ( confirmationCopy === copy ) return;
        confirmationCopy = copy;
        show(copy, 'Back to Billing', returnToBilling, 'return-to-billing');
    }
    function timedOut () {
        if ( closed || finished ) return;
        finished = true;
        clearTimers();
        if ( sessionCompleted ) showConfirmation(true);
        else show(`We could not confirm your ${trialMode ? 'free month' : 'payment'} yet. Check Settings → Billing in a moment.`, 'Back to Billing', returnToBilling, 'return-to-billing');
    }
    function success (summary = null) {
        finished = true;
        clearTimers();
        mount.hidden = true;
        const credits = creditedCredits ?? pack?.aiCredits;
        // A free month is named only when the summary reports it live; otherwise the plan is ordinary Standard.
        const freeMonth = trialMode && ['trialing', 'ending'].includes(summary?.plan?.trial?.state);
        show(pack ? `${Number(credits).toLocaleString('en-US')} AI credits added` : freeMonth ? `Your free month of ${name} has started` : `You're on ${name}`, 'Done', returnToBilling);
        state.dataset.role = 'upgrade-success';
        state.querySelector('button').dataset.action = 'done';
        const icon = doc.createElement('span');
        icon.textContent = '✓';
        icon.setAttribute('aria-hidden', 'true');
        state.prepend(icon);
        const allowances = doc.createElement('p');
        // The refreshed balance is the server's, for the signed-in person only; otherwise point to Billing.
        const view = pack && summary?.version === 3 ? accountCredits(summary.ai?.account, { userId }) : null;
        allowances.textContent = pack ? view && ! view.stale ? `Your balance is now ${view.left} credits.` : 'Check your AI credits in Billing.'
            : freeMonth && quote ? `First charge ${trialAmount()} from ${trialDayLabel(quote.trialEndsAt, { timeZone })} unless you cancel before then.` : allowance;
        if ( pack ) allowances.dataset.role = 'topup-new-balance';
        state.querySelector('button').before(allowances);
        state.querySelector('button').focus();
    }
    /** Top-ups: the session, then the receipt's delivery, then one fresh summary for the new balance. */
    async function pollTopup () {
        if ( fulfillment !== 'credited' ) {
            const result = topupStatus(await trpc.query('billing.topupStatus', { sessionId: session.sessionId }));
            if ( closed || finished ) return;
            if ( result.status === 'expired' ) {
                finished = true;
                clearTimers();
                show('This checkout expired before payment, so you were not charged. Close this and try again.');
                return;
            }
            if ( result.status === 'complete' ) {
                sessionCompleted = true;
                paymentStatus = result.paymentStatus;
                confirming = true;
            }
            fulfillment = result.fulfillment;
            creditedCredits = result.credits;
            if ( fulfillment === 'review' ) {
                finished = true;
                clearTimers();
                show(TOPUP_REVIEW_COPY, 'Back to Billing', returnToBilling, 'return-to-billing');
                return;
            }
            if ( sessionCompleted ) showConfirmation();
            if ( fulfillment !== 'credited' ) { later(() => { void poll(); }, CONFIRM_POLL_MS); return; }
        }
        const summary = unwrap(await trpc.query('billing.summary'));
        if ( closed || finished ) return;
        if ( now() >= deadline ) { timedOut(); return; }
        if ( summary?.enabled === true && summary.version === 3 ) { success(summary); return; }
        later(() => { void poll(); }, CONFIRM_POLL_MS);
    }
    async function poll () {
        if ( closed || finished ) return;
        if ( now() >= deadline ) { timedOut(); return; }
        if ( pack ) {
            try { await pollTopup(); return; } catch { /* A transient read failure must not imply that payment failed. */ }
            if ( ! closed && ! finished ) later(() => { void poll(); }, CONFIRM_POLL_MS);
            return;
        }
        try {
            if ( ! sessionCompleted || ! ['paid', 'no_payment_required'].includes(paymentStatus) ) {
                const result = checkoutStatus(await trpc.query('billing.checkoutStatus', { sessionId: session.sessionId }));
                if ( closed || finished ) return;
                if ( result.status === 'expired' ) {
                    finished = true;
                    clearTimers();
                    hideTrialTerms();
                    show(trialMode ? 'This checkout expired, so nothing was charged. Close this and start your free month again.' : 'This checkout has expired. Close the sheet and try again.');
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
            // The purchased SKU is not access by itself: a v3 plan also needs paid access (a paid standing or a live
            // free month). A v2 summary has no standing; its SKU check stands.
            if ( summary?.plan?.sku === sku && (summary.version !== 3 || paidAccess(summary)) ) { success(summary); return; }
        } catch { /* A transient read failure must not imply that payment failed. */ }
        if ( ! closed && ! finished ) later(() => { void poll(); }, CONFIRM_POLL_MS);
    }
    /**
     * Stripe's form can lose its own confirmation (seen in a real run: "Your
     * internet connection is unstable. Your payment may have been successful…")
     * and then never calls onComplete. While the form is open the sheet also
     * asks the server about the session itself. Completion starts verification;
     * it does not establish receipt of an asynchronous bank payment. Only the
     * webhook-backed plan can confirm a subscription; top-ups confirm delivered credits.
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
        if ( completed ) { confirming = true; mount.hidden = true; show(trialMode ? 'Confirming your free month…' : 'Confirming your payment…'); }
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
        // Standard trial: no checkout before the exact end is quoted and shown above the form; a successful quote comes back here.
        if ( trialMode && ! quote ) { await requote(); return; }
        busy = true;
        show('Preparing your checkout…');
        let stale = false;
        try {
            // A quoted top-up sends exactly what was quoted (a preset or a custom amount, pinned to its total); a trial
            // echoes exactly the end it disclosed.
            session = unwrap(await trpc.mutate(pack ? 'billing.createTopupCheckout' : 'billing.createCheckout',
                pack?.checkout ?? (trialMode ? { sku, trial: { trialEndsAt: quote.trialEndsAt } } : { sku })));
            if ( closed ) return;
            if ( pack ) session = { ...session, mode: 'embedded' };
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
            session = null;
            // Standard trial: a stale quote is re-quoted and its NEW end shown before anything else; a refused or
            // already-starting trial goes back to Billing, never to a paid checkout.
            if ( trialMode && error?.code === 'trial_quote_stale' ) {
                // One automatic re-quote per open; a second stale end stops at an explicit Retry (no checkout loop).
                if ( staleRetried ) {
                    if ( ! closed ) {
                        // The date shown is the one that just went stale: hide it until Retry quotes a fresh one.
                        hideTrialTerms();
                        show("Your free month's end date changed again. Try again to see the new date.", 'Retry', () => { quote = null; void create(); });
                    }
                } else { staleRetried = true; stale = true; }
            } else if ( closed ) { /* Nothing to show. */ }
            else if ( trialMode && TRIAL_ERRORS.has(error?.code) ) { hideTrialTerms(); show(error.message, 'Back to Billing', returnToBilling, 'return-to-billing'); }
            else show(error?.message || 'Could not open billing. Try again.', 'Retry', () => { void create(); });
        } finally { busy = false; }
        if ( stale && ! closed ) {
            quote = null;
            dialog.querySelector('[data-role="trial-terms"]').hidden = true;
            renderTrialTerms();
            void requote(true);
            return;
        }
        if ( ! closed && session?.mode === 'embedded' ) void embed();
    }
    renderTrialTerms();
    focusFirst();
    void create();
    return frame.handle;
}

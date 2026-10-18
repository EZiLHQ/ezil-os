// Billing v2 mutations share one modal lifetime with embedded checkout.
import { openSheetFrame } from './sheet-frame.js';
import { dollars, dateLabel, dateTimeLabel, stdHoursLabel, sizeLabel, planName, errorCopy, webUrl } from './billing-format.js';

const COMPUTE = 'compute_monthly_v2';
const STANDARD = 'standard_monthly_v2';
const money = cents => dollars(cents, { compact: true });

function billingSheet (options, kind, title) {
    const { summary, trpc, onDone } = options;
    if ( summary?.enabled !== true || summary.version !== 2 || summary.actions?.[kind] !== true ) throw new Error('unavailable');
    let busy = false;
    let completed = false;
    let paymentPending = false;
    const frame = openSheetFrame({ ...options, sheet: kind, title, canDismissBackdrop: () => ! busy && ! paymentPending });
    if ( frame.existing ) return frame;
    const { doc, content, dialog } = frame;
    dialog.classList.add('ezil-billing-sheet');
    function node (tag, text, parent = body) {
        const element = doc.createElement(tag);
        if ( text != null ) element.textContent = text;
        parent.append(element);
        return element;
    }
    node('h2', title, content);
    const body = node('div', null, content);
    body.dataset.role = 'sheet-body';
    body.setAttribute('aria-live', 'polite');
    const error = node('p', '', content);
    error.dataset.role = 'sheet-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    function button (text, action, handler, parent = body) {
        const element = node('button', text, parent);
        element.type = 'button';
        element.dataset.action = action;
        element.addEventListener('click', () => {
            if ( ! frame.closed && ! element.disabled ) handler();
        });
        return element;
    }
    async function request (method, input, onSuccess, onFailure) {
        if ( frame.closed || busy || completed ) return;
        busy = true;
        error.hidden = true;
        error.textContent = '';
        const controls = [...body.querySelectorAll('button, input')].map(el => [el, el.disabled]);
        controls.forEach(([el]) => { el.disabled = true; });
        body.setAttribute('aria-busy', 'true');
        try {
            const result = await trpc.mutate(method, input);
            if ( frame.closed ) return;
            if ( ! result?.ok ) throw new Error(result?.message);
            onSuccess(result.data);
        } catch (failure) {
            if ( frame.closed ) return;
            error.textContent = errorCopy(failure?.message, summary.overage?.maxCapCents);
            error.hidden = false;
            onFailure?.();
        } finally {
            if ( ! frame.closed ) {
                busy = false;
                body.setAttribute('aria-busy', 'false');
                controls.forEach(([el, disabled]) => { if ( body.contains(el) ) el.disabled = disabled; });
            }
        }
    }
    function result (messages, { invoice, pending = false } = {}) {
        completed = true;
        paymentPending = pending;
        body.replaceChildren();
        for ( const message of messages ) node('p', message);
        if ( invoice ) {
            try {
                const url = webUrl(invoice);
                const link = node('a', 'Open invoice ↗');
                link.href = url;
                link.target = '_blank';
                link.rel = 'noopener';
                link.dataset.action = 'open-invoice';
            } catch { /* An invalid provider URL must never become a link. */ }
        }
        button('Done', 'done', () => {
            try { onDone?.(); } finally { frame.close(); }
        }).focus();
    }
    return Object.assign(frame, { body, node, button, request, result, isBusy: () => busy });
}

export function openComputeUpgradeSheet (options) {
    const sheet = billingSheet(options, 'upgrade', 'Upgrade to EZiL Compute');
    if ( sheet.existing ) return sheet.existing;
    const { body, node, button, request, result } = sheet;
    function preview () {
        if ( sheet.closed || sheet.isBusy() ) return;
        body.replaceChildren();
        node('p', 'Checking the price…');
        void request('billing.previewUpgrade', { toSku: COMPUTE }, data => {
            body.replaceChildren();
            const table = node('table', null);
            table.className = 'ezil-billing-sheet-lines';
            table.setAttribute('aria-label', 'Upgrade price breakdown');
            const rows = node('tbody', null, table);
            for ( const line of data.lines ) {
                const row = node('tr', null, rows);
                node('th', line.description, row).scope = 'row';
                node('td', dollars(line.amountCents).replace(/^-/, '−'), row);
            }
            node('p', `Due now ${money(data.amountDueCents)}`).className = 'ezil-billing-sheet-total';
            node('p', 'USD. Any applicable tax appears on the invoice.').className = 'ezil-upgrade-caption';
            node('p', `Adds ${stdHoursLabel(data.grantStdSeconds, { round: 'down' })} standard-hours for the rest of this period (until ${dateLabel(data.periodEnd)}). Your usage so far carries over.`);
            node('p', 'Your plan changes once payment is confirmed.');
            button(`Pay ${money(data.amountDueCents)} and upgrade`, 'confirm', () => {
                void request('billing.confirmUpgrade', { toSku: COMPUTE, prorationDate: data.prorationDate }, confirmation => {
                    if ( confirmation.status === 'applied' ) result(["You're on EZiL Compute"]);
                    else if ( confirmation.status === 'requires_action' ) result([
                        'Confirm the payment with your bank to finish.',
                        'Your plan changes once payment is confirmed.',
                    ], { invoice: confirmation.hostedInvoiceUrl, pending: true });
                    else if ( confirmation.status === 'payment_failed' ) result([
                        "The payment didn't go through.",
                        confirmation.expiresAt
                            ? `Your upgrade is held until ${dateTimeLabel(confirmation.expiresAt)}. Pay the invoice or update your payment method before then.`
                            : 'Pay the invoice or update your payment method to finish your upgrade.',
                    ], { invoice: confirmation.hostedInvoiceUrl, pending: true });
                    else throw new Error('unavailable');
                });
            });
        }, () => {
            body.replaceChildren();
            button('Retry', 'retry', preview);
        });
    }
    preview();
    return sheet.handle;
}

export function openDowngradeSheet (options) {
    const sheet = billingSheet(options, 'downgrade', 'Switch to Standard at period end');
    if ( sheet.existing ) return sheet.existing;
    const { summary } = options;
    const standard = summary.catalog.offers.find(offer => offer.sku === STANDARD);
    const compute = summary.catalog.offers.find(offer => offer.sku === COMPUTE);
    const size = summary.catalog.sizes.find(size => size.code === standard.sizes[0]);
    const removed = compute.sizes.filter(code => ! standard.sizes.includes(code))
        .map(code => summary.catalog.sizes.find(size => size.code === code).vcpu).join(' and ');
    sheet.node('p', `You keep EZiL Compute until ${dateLabel(summary.plan.periodEnd)}. From then: ${stdHoursLabel(standard.allowanceStdSeconds)} standard-hours each billing period on a ${sizeLabel(size)} computer; ${removed} vCPU and overage end.`);
    sheet.button(`Switch on ${dateLabel(summary.plan.periodEnd)}`, 'confirm', () => {
        void sheet.request('billing.scheduleDowngrade', { toSku: STANDARD }, data => {
            sheet.result([`Scheduled. You switch to Standard on ${dateLabel(data.effectiveAt)}.`]);
        });
    });
    return sheet.handle;
}

export function openCancelSheet (options) {
    const sheet = billingSheet(options, 'cancel', `Cancel ${planName(options.summary.plan.family)}`);
    if ( sheet.existing ) return sheet.existing;
    sheet.node('p', `Your plan stays active until ${dateLabel(options.summary.plan.periodEnd)}, then moves to Free. You can resume any time before then.`);
    const actions = sheet.node('div', null);
    actions.className = 'ezil-billing-sheet-actions';
    sheet.button('Cancel plan', 'confirm', () => {
        void sheet.request('billing.cancelAtPeriodEnd', { cancel: true }, data => {
            sheet.result([`Your plan ends ${dateLabel(data.cancelsAt)}.`]);
        });
    }, actions).className = 'ezil-billing-sheet-danger';
    sheet.button('Keep plan', 'keep', sheet.close, actions).className = 'ezil-billing-sheet-secondary';
    return sheet.handle;
}

export function openOverageSheet (options) {
    const sheet = billingSheet(options, 'overage', 'Usage beyond your allowance');
    if ( sheet.existing ) return sheet.existing;
    const { summary } = options;
    const overage = summary.overage;
    const offer = summary.catalog.offers.find(offer => offer.sku === COMPUTE);
    const largest = summary.catalog.sizes.filter(size => offer.sizes.includes(size.code)).sort((a, b) => b.vcpu - a.vcpu)[0];
    const { node, button } = sheet;
    node('p', `When your ${stdHoursLabel(offer.allowanceStdSeconds)} standard-hours are used up, keep working at ${money(overage.centsPerStdHour)} per standard-hour, up to a monthly cap you set. Usage is billed separately after each billing period, on its own invoice.`);
    const label = node('label', 'Monthly cap (USD)');
    label.className = 'ezil-billing-cap';
    const input = node('input', null, label);
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = String(overage.maxCapCents / 100);
    input.step = '1';
    input.required = true;
    input.value = String((overage.enabled ? overage.capCents : overage.defaultCapCents) / 100);
    input.setAttribute('aria-describedby', 'ezil-cap-range ezil-cap-hours');
    node('p', `Whole dollars, $0 to ${money(overage.maxCapCents)}.`).id = 'ezil-cap-range';
    const helper = node('p', '');
    helper.id = 'ezil-cap-hours';
    const consent = node('label', null);
    consent.className = 'ezil-billing-consent';
    const checkbox = node('input', null, consent);
    checkbox.type = 'checkbox';
    const consentText = node('span', '', consent);
    const cap = () => {
        const value = Number(input.value);
        return /^\d+$/.test(input.value) && Number.isSafeInteger(value * 100) && value >= 0 && value * 100 <= overage.maxCapCents
            ? value * 100 : null;
    };
    const submit = button(overage.enabled ? 'Save cap' : 'Turn on overage', 'confirm', () => {
        const capCents = cap();
        if ( capCents === null || ! checkbox.checked ) return;
        void sheet.request('billing.setOverage', { enabled: true, capCents, termsVersion: overage.termsVersion }, data => {
            sheet.result([`Overage is on, up to ${money(data.capCents)} a period.`]);
        });
    });
    function update () {
        const capCents = cap();
        submit.disabled = sheet.isBusy() || capCents === null || ! checkbox.checked;
        input.setAttribute('aria-invalid', String(capCents === null));
        consentText.textContent = `I agree that usage beyond my allowance is billed separately after each billing period, up to my cap of ${capCents === null ? '—' : money(capCents)}.`;
        const seconds = capCents === null ? null : Math.floor(capCents * 3600 / overage.centsPerStdHour);
        helper.textContent = seconds === null ? 'Enter a whole-dollar cap within the range above.'
            : `Up to ${stdHoursLabel(seconds)} extra standard-hours (≈ ${stdHoursLabel(Math.floor(seconds / largest.weight))} h at ${largest.vcpu} vCPU).`;
    }
    input.addEventListener('input', update);
    checkbox.addEventListener('change', update);
    update();
    return sheet.handle;
}

// topup-sheet.js — EZiL-authored. "Add AI credits": one focused dialog with the
// signed-in person's balance, the catalog's presets and a whole-dollar custom
// amount. Every price comes from the summary and is re-quoted by the server
// (`billing.quoteTopup`) before payment; payment and fulfilment stay with
// upgrade-sheet.js, which shows credits only once the server confirms them.
import { openSheetFrame } from './sheet-frame.js';
import { dollars, errorCopy, creditsLabel, microOf, staleCreditsCopy, trialOfferOf } from './billing-format.js';

const MICRO = 1000000n;
const count = value => Number.isSafeInteger(value) && value >= 0;
const whole = value => Number(value).toLocaleString('en-US');
const money = cents => dollars(cents, { compact: true });

const ERRORS = {
    quote_changed: 'The price changed. Check the new total, then continue.',
    unknown_pack: "That amount isn't available right now. Choose another amount.",
    ai_enrollment_required: 'AI credits activate when you sign in with EZiL ID.',
};

/** Top-up failures in the dialog's words; a refused amount is never "could not reach billing". */
export function topupErrorCopy (result) {
    const message = result?.message;
    if ( Object.hasOwn(ERRORS, message) ) return ERRORS[message];
    if ( result?.code === 'BAD_REQUEST' ) return ERRORS.unknown_pack;
    return errorCopy(message);
}

/**
 * What this summary lets the person buy, or null: v3, `actions.topup`, an enrolled AI account, and at least
 * one well-formed USD preset or a valid custom tariff. Nothing here is a price of its own: presets are the
 * server's catalog packs and the custom tariff is `catalog.customTopup` (bounds, whole dollars, cents per credit).
 */
export function topupOffer (summary) {
    if ( summary?.enabled !== true || summary.version !== 3 || summary.actions?.topup !== true ) return null;
    if ( (summary.ai?.enrollment ?? 'enrolled') !== 'enrolled' ) return null;
    const packs = (Array.isArray(summary.catalog?.packs) ? summary.catalog.packs : []).filter(pack => typeof pack?.sku === 'string'
        && count(pack.aiCredits) && pack.aiCredits > 0 && count(pack.totalCents) && (pack.currency ?? 'usd') === 'usd'
        && (pack.discountPercent === undefined || (Number.isFinite(pack.discountPercent) && pack.discountPercent >= 0 && pack.discountPercent < 100)));
    const tariff = summary.catalog?.customTopup;
    const custom = tariff && count(tariff.minCents) && count(tariff.maxCents) && count(tariff.centsPerCredit)
        && tariff.minCents > 0 && tariff.minCents % 100 === 0 && tariff.maxCents >= tariff.minCents && tariff.centsPerCredit > 0
        ? { minCents: tariff.minCents, maxCents: tariff.maxCents, centsPerCredit: tariff.centsPerCredit } : null;
    return packs.length || custom ? { packs, custom } : null;
}

/**
 * A typed custom amount: whole US dollars within the tariff's bounds. "$1,250", "1250" and "1250.00" are the
 * same amount; "12.50" is refused for precision, "1e3", "-5" and "12abc" for format. Returns `{ cents, credits }`
 * or `{ error: 'empty' | 'format' | 'precision' | 'range' }`.
 */
export function parseCustomAmount (text, custom) {
    const raw = String(text ?? '').trim().replace(/^\$\s*/, '');
    if ( ! raw ) return { error: 'empty' };
    const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replaceAll(',', '') : raw;
    const match = /^(\d+)(?:\.(\d+))?$/.exec(plain);
    if ( ! match ) return { error: 'format' };
    if ( match[2] && /[1-9]/.test(match[2]) ) return { error: 'precision' };
    const digits = match[1].replace(/^0+(?=\d)/, '');
    if ( digits.length > 12 ) return { error: 'range' };
    const cents = Number(digits) * 100;
    if ( ! Number.isSafeInteger(cents) || cents < custom.minCents || cents > custom.maxCents ) return { error: 'range' };
    if ( cents % custom.centsPerCredit !== 0 ) return { error: 'precision' };
    return { cents, credits: cents / custom.centsPerCredit };
}

function customHint (custom) {
    return `Whole dollars, ${money(custom.minCents)} to ${money(custom.maxCents)}. ${whole(100 / custom.centsPerCredit)} credits per dollar, no discount.`;
}

function customError (error, custom) {
    if ( error === 'empty' ) return 'Enter an amount in US dollars.';
    if ( error === 'precision' ) return 'Use whole dollars, without cents.';
    if ( error === 'range' ) return `Enter between ${money(custom.minCents)} and ${money(custom.maxCents)}.`;
    return 'Enter a number of dollars, like 50.';
}

/**
 * The balance this dialog may show: the signed-in person's own `ai.account` (exact microcredits), else that
 * person's last readable one marked stale, else the older plain balance. Another user's block is never used.
 */
function balanceOf (summary, { userId = null, lastAccount = null } = {}) {
    const mine = value => value && typeof value === 'object' && microOf(value.remainingMicro) !== null
        && (typeof value.userId !== 'string' || typeof userId !== 'string' || value.userId === userId) ? value : null;
    const current = mine(summary.ai?.account), previous = current ? null : mine(lastAccount);
    const shown = current ?? previous;
    if ( shown ) return { micro: microOf(shown.remainingMicro), label: creditsLabel(shown.remainingMicro), stale: ! current, asOf: shown.asOf ?? null };
    if ( 'account' in (summary.ai ?? {}) ) return null;
    const plain = summary.ai?.balance;
    return typeof plain === 'number' && Number.isFinite(plain) && plain >= 0 ? { micro: BigInt(Math.floor(plain)) * MICRO, label: creditsLabel(null, plain), stale: false } : null;
}

/**
 * The upgrade the recovery dialog may offer beside Add credits, from the same eligibility the Billing tab uses:
 * Free (or files held on AWS) → Standard checkout, Standard → Premium. Premium is the top tier: none.
 */
export function topupUpgrade (summary) {
    const { plan, actions, catalog } = summary;
    const offer = sku => catalog?.offers?.find(item => item.sku === sku) ?? null;
    const credits = item => count(item?.aiCredits?.amount) && item.aiCredits.amount > 0 && item.aiCredits.per === 'period'
        ? `${item.name} adds ${whole(item.aiCredits.amount)} AI credits every month.` : '';
    const held = summary.computer?.standing === 'files_on_aws';
    if ( (plan?.sku === 'free_v3' || held) && actions?.checkout === true && offer('standard_monthly_v3') ) {
        const standard = offer('standard_monthly_v3');
        // Standard trial: the same free month the Billing tab offers this viewer ($0 today; the sheet confirms the date).
        if ( trialOfferOf(summary) ) return { action: 'trial', sku: standard.sku, label: 'Start your free month', note: credits(standard) };
        return { action: 'checkout', sku: standard.sku, label: `Upgrade to ${standard.name}`, note: credits(standard) };
    }
    if ( plan?.sku === 'standard_monthly_v3' && actions?.upgrade === true && offer('premium_monthly_v3') ) {
        const premium = offer('premium_monthly_v3');
        return { action: 'upgrade', sku: premium.sku, label: `Upgrade to ${premium.name}`, note: credits(premium) };
    }
    return null;
}

/**
 * Options: `container`, `summary`, `trpc`, `userId`, `lastAccount`, `preselect` (a pack SKU or 'custom'),
 * `reason` ('insufficient_credits' from the recovery link, else null), `checkout({ pack })` (hands the server's
 * quote to the payment sheet), `upgrade(choice)` and `onClose`. Returns the sheet handle, or the open one.
 */
export function openTopupSheet (options) {
    const { summary, trpc } = options;
    const offer = topupOffer(summary);
    if ( ! offer ) throw new Error('unavailable');
    const balance = balanceOf(summary, options);
    const recovering = options.reason === 'insufficient_credits' || balance?.micro === 0n;
    const upgrade = recovering ? topupUpgrade(summary) : null;
    const title = recovering ? "You're out of AI credits" : 'Add AI credits';
    let busy = false;
    const frame = openSheetFrame({ container: options.container, title, role: 'billing-sheet', sheet: 'topup', onClose: options.onClose,
        canDismissBackdrop: () => ! busy, canDismiss: () => ! busy, closeLabel: 'Close Add AI credits' });
    if ( frame.existing ) return frame.existing;
    const { doc, content, dialog } = frame;
    dialog.classList.add('ezil-billing-sheet', 'ezil-topup-sheet');
    const el = (tag, attrs = {}, parent = null, text = null) => {
        const node = doc.createElement(tag);
        for ( const [key, value] of Object.entries(attrs) ) {
            if ( key === 'className' ) node.className = value;
            else if ( key === 'dataset' ) Object.assign(node.dataset, value);
            else node.setAttribute(key, value);
        }
        if ( text != null ) node.textContent = text;
        parent?.append(node);
        return node;
    };
    const heading = el('h2', { id: 'ezil-topup-title' }, content, title);
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.removeAttribute('aria-label');
    if ( recovering ) {
        el('p', { className: 'ezil-topup-lead', dataset: { role: 'topup-recovery' } }, content,
            'Add credits to keep using EZiL AI in Code and Chat. Your conversation stays where it is; send your last message again once credits are added.');
    }
    const form = el('form', { className: 'ezil-topup-form', novalidate: '' }, content);
    const current = el('p', { className: 'ezil-topup-balance', dataset: { role: 'topup-balance' } }, form);
    el('span', {}, current, 'Current balance');
    el('strong', {}, current, balance ? `${balance.label} credits` : 'Not available right now');
    if ( balance?.stale ) el('span', { className: 'ezil-billing-note' }, current, staleCreditsCopy(balance.asOf));

    const group = el('fieldset', { className: 'ezil-topup-amounts' }, form);
    el('legend', {}, group, 'Choose an amount');
    const grid = el('div', { className: 'ezil-topup-options' }, group);
    const radios = [];
    function option (value, lines, extra = {}) {
        const label = el('label', { className: 'ezil-topup-option', dataset: { option: value, ...extra } }, grid);
        const radio = el('input', { type: 'radio', name: 'ezil-topup-amount', value }, label);
        const text = el('span', { className: 'ezil-topup-option-text' }, label);
        el('strong', {}, text, lines[0]);
        const meta = el('span', { className: 'ezil-topup-option-meta' }, text);
        if ( lines[1] ) el('span', {}, meta, lines[1]);
        if ( lines[2] ) el('span', { className: 'ezil-topup-save' }, meta, lines[2]);
        radios.push(radio);
        return radio;
    }
    for ( const pack of offer.packs ) {
        option(pack.sku, [`${whole(pack.aiCredits)} credits`, money(pack.totalCents), pack.discountPercent ? `Save ${pack.discountPercent}%` : ''], { sku: pack.sku });
    }
    const customRadio = offer.custom ? option('custom', ['Custom amount', 'Whole dollars']) : null;
    const customBox = offer.custom ? el('div', { className: 'ezil-topup-custom', dataset: { role: 'topup-custom' } }, form) : null;
    let input = null, inputError = null;
    if ( customBox ) {
        el('label', { for: 'ezil-topup-custom-input' }, customBox, 'Amount in US dollars');
        const wrap = el('div', { className: 'ezil-topup-input' }, customBox);
        el('span', { 'aria-hidden': 'true' }, wrap, '$');
        input = el('input', { id: 'ezil-topup-custom-input', type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
            maxlength: '16', 'aria-describedby': 'ezil-topup-custom-hint ezil-topup-custom-error', placeholder: String(offer.custom.minCents / 100) }, wrap);
        // The whole field (with its "$") is the target, not only the text box inside it.
        wrap.addEventListener('pointerdown', event => { if ( event.target !== input && ! input.disabled ) { event.preventDefault(); input.focus(); } });
        el('p', { id: 'ezil-topup-custom-hint', className: 'ezil-upgrade-caption' }, customBox, customHint(offer.custom));
        inputError = el('p', { id: 'ezil-topup-custom-error', className: 'ezil-topup-error', dataset: { role: 'topup-custom-error' } }, customBox);
        inputError.hidden = true;
    }

    const summaryList = el('dl', { className: 'ezil-topup-summary', dataset: { role: 'topup-summary' }, 'aria-live': 'polite' }, form);
    const row = (term, role) => {
        const item = el('div', { dataset: { role } }, summaryList);
        el('dt', {}, item, term);
        return el('dd', {}, item);
    };
    const added = row('Credits added', 'topup-added');
    const after = row('New balance', 'topup-new-balance');
    const discountRow = row('Discount', 'topup-discount');
    const total = row('Total', 'topup-total');
    total.parentElement.classList.add('ezil-topup-total');
    el('p', { className: 'ezil-upgrade-caption' }, form,
        'One-time payment in USD. Any applicable tax is shown in the payment form. Credits are added after your payment is confirmed.');
    const notice = el('p', { className: 'ezil-topup-error', dataset: { role: 'topup-notice' }, role: 'alert' }, form);
    notice.hidden = true;
    const actions = el('div', { className: 'ezil-billing-sheet-actions' }, form);
    const submit = el('button', { type: 'submit', dataset: { action: 'topup-continue' } }, actions, 'Continue');
    if ( upgrade ) {
        const button = el('button', { type: 'button', className: 'ezil-billing-sheet-secondary', dataset: { action: 'topup-upgrade', sku: upgrade.sku } }, actions, upgrade.label);
        button.addEventListener('click', () => {
            if ( frame.closed || busy ) return;
            frame.close();
            options.upgrade?.(upgrade);
        });
        if ( upgrade.note ) el('p', { className: 'ezil-upgrade-caption', dataset: { role: 'topup-upgrade-note' } }, form, upgrade.note);
    }

    // The server's word on a price replaces the summary's for that choice (a stale catalog, a changed tariff).
    const quoted = new Map();
    function selection () {
        const radio = radios.find(item => item.checked);
        if ( ! radio ) return { error: 'none' };
        if ( radio.value !== 'custom' ) {
            const pack = offer.packs.find(item => item.sku === radio.value);
            const quote = quoted.get(pack.sku);
            return { input: { sku: pack.sku }, aiCredits: quote?.aiCredits ?? pack.aiCredits, totalCents: quote?.totalCents ?? pack.totalCents,
                creditCents: quote?.creditCents ?? pack.creditCents ?? pack.totalCents, discountPercent: quote?.discountPercent ?? pack.discountPercent ?? 0 };
        }
        const parsed = parseCustomAmount(input.value, offer.custom);
        if ( parsed.error ) return { error: parsed.error, custom: true };
        const quote = quoted.get(`custom:${parsed.cents}`);
        return { input: { customAmountCents: parsed.cents }, aiCredits: quote?.aiCredits ?? parsed.credits, totalCents: quote?.totalCents ?? parsed.cents,
            creditCents: quote?.creditCents ?? parsed.cents, discountPercent: quote?.discountPercent ?? 0 };
    }
    function render ({ showError = false } = {}) {
        const choice = selection();
        for ( const radio of radios ) radio.closest('label').classList.toggle('is-selected', radio.checked);
        if ( customBox ) {
            customBox.hidden = ! customRadio.checked;
            const invalid = customRadio.checked && choice.error && choice.error !== 'none';
            input.setAttribute('aria-invalid', String(Boolean(invalid && (showError || choice.error !== 'empty'))));
            inputError.hidden = ! (invalid && (showError || choice.error !== 'empty'));
            inputError.textContent = inputError.hidden ? '' : customError(choice.error, offer.custom);
        }
        const ready = ! choice.error;
        added.textContent = ready ? `+${whole(choice.aiCredits)}` : '—';
        after.textContent = ready && balance && ! balance.stale ? creditsLabel(String(balance.micro + BigInt(choice.aiCredits) * MICRO)) : '—';
        after.parentElement.hidden = ! balance || balance.stale;
        const saving = ready && choice.discountPercent > 0 && choice.creditCents > choice.totalCents ? choice.creditCents - choice.totalCents : 0;
        discountRow.parentElement.hidden = ! saving;
        discountRow.textContent = saving ? `−${money(saving)} (${choice.discountPercent}%)` : '';
        total.textContent = ready ? `${money(choice.totalCents)} USD` : '—';
        submit.textContent = ready ? `Continue to payment · ${money(choice.totalCents)}` : 'Continue to payment';
        submit.disabled = busy || ! ready;
        return choice;
    }
    function fail (copy) {
        notice.textContent = copy;
        notice.hidden = false;
    }
    function setBusy (value) {
        busy = value;
        form.setAttribute('aria-busy', String(value));
        for ( const control of [...radios, input].filter(Boolean) ) control.disabled = value;
        if ( value ) { submit.disabled = true; submit.textContent = 'Checking the price…'; }
    }
    async function proceed () {
        if ( frame.closed || busy ) return;
        const choice = render({ showError: true });
        if ( choice.error ) {
            if ( choice.custom ) input.focus();
            return;
        }
        notice.hidden = true;
        setBusy(true);
        let result;
        try {
            result = await trpc.query('billing.quoteTopup', choice.input);
        } catch {
            result = { ok: false };
        }
        if ( frame.closed ) return;
        setBusy(false);
        const quote = result?.ok === true ? result.data : null;
        const custom = 'customAmountCents' in choice.input;
        const valid = quote && count(quote.aiCredits) && quote.aiCredits > 0 && count(quote.totalCents) && quote.currency === 'usd'
            && typeof quote.sku === 'string' && (custom || quote.sku === choice.input.sku) && quote.custom === custom
            && (! custom || quote.totalCents === choice.input.customAmountCents);
        if ( ! valid ) {
            fail(result?.ok === true ? errorCopy('unavailable') : topupErrorCopy(result));
            render();
            submit.focus();
            return;
        }
        if ( quote.aiCredits !== choice.aiCredits || quote.totalCents !== choice.totalCents || (quote.discountPercent ?? 0) !== choice.discountPercent ) {
            quoted.set(custom ? `custom:${choice.input.customAmountCents}` : choice.input.sku, quote);
            fail(ERRORS.quote_changed);
            render();
            submit.focus();
            return;
        }
        frame.close();
        options.checkout?.({ pack: { sku: quote.sku, aiCredits: quote.aiCredits, totalCents: quote.totalCents, creditCents: quote.creditCents,
            discountPercent: quote.discountPercent ?? 0, currency: 'usd',
            checkout: { ...choice.input, expectedTotalCents: quote.totalCents, expectedCredits: quote.aiCredits } } });
    }
    form.addEventListener('submit', event => { event.preventDefault(); void proceed(); });
    form.addEventListener('change', event => {
        if ( event.target === customRadio && ! busy ) input.focus();
        notice.hidden = true;
        render();
    });
    input?.addEventListener('input', () => {
        if ( customRadio && ! customRadio.checked ) customRadio.checked = true;
        notice.hidden = true;
        render();
    });
    const initial = (options.preselect === 'custom' ? customRadio : radios.find(radio => radio.value === options.preselect)) ?? radios[0];
    initial.checked = true;
    render();
    (initial === customRadio ? input : initial).focus();
    return frame.handle;
}

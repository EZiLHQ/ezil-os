// Versioned billing views. The summary owns plan details and action availability.
import TabAccount from './account.js';
import { payload as bootPayload, currentComputer } from '../../../session.js';
import { isNative } from '../../../native-runtime.js';
import trpc from '../trpc.js';
import { openUpgradeSheet } from '../upgrade-sheet.js';
import { openComputeUpgradeSheet, openDowngradeSheet, openCancelSheet, openOverageSheet, openPlanPickerSheet } from '../billing-sheets.js';
import { dollars, dateLabel, durationLabel, stdHoursLabel, sizeLabel, planName, errorCopy, webUrl, creditsLabel, hoursLeftLines } from '../billing-format.js';

const BILLING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/></svg>';
const STATES = new Set(['ok', 'low', 'exhausted', 'over_cap', 'unavailable']);
const ATTENTION = new Set(['low', 'exhausted', 'over_cap']);
const windows = new WeakMap();
let upgradeSheetOpener = openUpgradeSheet;
let sheetOpeners = { upgrade: openComputeUpgradeSheet, downgrade: openDowngradeSheet, cancel: openCancelSheet, overage: openOverageSheet, choose: openPlanPickerSheet };

export function setUpgradeSheetOpener (fn) { upgradeSheetOpener = fn; }
export function setBillingSheetOpeners (openers) { sheetOpeners = { ...sheetOpeners, ...openers }; }

const encode = value => html_encode(String(value));
const sizeFor = (summary, code) => summary.catalog.sizes.find(size => size.code === code);
const offerFor = (summary, sku) => summary.catalog.offers.find(offer => offer.sku === sku);
const paragraph = (copy, className = '') => `<p class="${className}">${encode(copy)}</p>`;
const includedTime = seconds => durationLabel(seconds >= 3600 ? Math.floor(seconds / 3600) * 3600 : seconds);

function actionHtml (action, label, primary = false, sku) {
    return `<button type="button" class="ezil-settings-btn${primary ? ' ezil-settings-btn-primary' : ''}" data-action="${action}"${sku ? ` data-sku="${encode(sku)}"` : ''}>${encode(label)}</button>`;
}

function gigabytes (bytes) {
    const tenths = (BigInt(bytes) + 50_000_000n) / 100_000_000n;
    return `${tenths / 10n}.${tenths % 10n} GB`;
}

function percent (used, cap) {
    if ( cap <= 0n ) return 0;
    return Number(used <= 0n ? 0n : used >= cap ? 100n : used * 100n / cap);
}

function updated (iso) {
    if ( ! iso ) return 'Not measured yet.';
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    return minutes < 1 ? 'Updated just now' : minutes < 60 ? `Updated ${minutes} min ago` : `Updated ${dateLabel(iso)}`;
}

function sizesLine (summary, codes, memory = true) {
    const sizes = codes.map(code => sizeFor(summary, code));
    if ( sizes.length === 1 ) return sizeLabel(sizes[0]);
    const cpus = sizes.map(size => size.vcpu);
    return `${cpus.slice(0, -1).join(', ')} or ${cpus.at(-1)} vCPU${memory ? ` · up to ${Math.max(...sizes.map(size => size.memoryGiB))} GiB` : ''}`;
}

function paymentHtml ({ plan, actions, version }) {
    if ( ! plan.paymentIssue ) return '';
    const banners = {
        payment_failed: [`Your last payment didn't go through. Update your payment method to keep ${version === 3 ? plan.name : 'your plan'}.`, actions.portal ? actionHtml('portal', version === 3 ? 'Update payment' : 'Update payment method') : ''],
        requires_action: ['Your bank needs you to confirm a payment.', '<button type="button" class="ezil-settings-btn" data-action="open-invoice" data-kind="subscription">Confirm payment</button>'],
        overage_unpaid: ['Overage is paused until your usage invoice is paid. Your computer stops at your included allowance; saved files are kept.', '<button type="button" class="ezil-settings-btn" data-action="open-invoice" data-kind="overage">Pay usage invoice</button>'],
    };
    const [copy, action] = banners[plan.paymentIssue];
    return `<aside class="ezil-billing-card ezil-billing-payment ${plan.paymentIssue === 'requires_action' ? 'is-warn' : 'is-danger'}" role="status" data-role="payment-banner" data-issue="${encode(plan.paymentIssue)}">${paragraph(copy)}${action}</aside>`;
}

function planHtml (summary) {
    const { plan, compute, actions, estimate } = summary;
    const resume = plan.status === 'cancels';
    const planActions = [
        actions.upgrade ? actionHtml('upgrade', 'Upgrade to Compute', ! (resume && actions.cancel)) : '',
        actions.downgrade ? actionHtml('downgrade', 'Switch to Standard') : '',
        actions.cancel ? actionHtml(resume ? 'resume' : 'cancel', resume ? 'Resume plan' : 'Cancel plan', resume) : '',
    ].join('');
    const offer = offerFor(summary, plan.sku);
    const allowance = stdHoursLabel(offer?.allowanceStdSeconds ?? compute.allowanceStdSeconds);
    const codes = plan.family === 'free' ? ['free-cf'] : offer?.sizes ?? compute.allowedSizes;
    const price = plan.family === 'free' ? '$0' : offer ? `${dollars(offer.priceCents, { compact: true })}/month`
        : estimate.subscriptionCents != null ? `${dollars(estimate.subscriptionCents, { compact: true })}/month` : '';
    const status = { free: 'Current', active: 'Active', cancels: `Cancels ${dateLabel(plan.cancelsAt)}`, past_due: 'Payment failed', incomplete: 'Payment incomplete', upgrade_pending: 'Upgrade pending' }[plan.status];
    return `<section class="ezil-billing-card ezil-billing-plan" data-role="plan-card" data-family="${encode(plan.family)}" aria-label="Current plan">
        <div class="ezil-billing-plan-heading"><h4>${encode(planName(plan.family))}</h4>
            <span class="ezil-settings-pill" data-role="plan-status" data-status="${encode(plan.status)}">${encode(status)}</span><span class="ezil-billing-price">${encode(price)}</span></div>
        ${paragraph(`${allowance}${plan.family === 'free' ? ' h each month' : ' standard-hours each billing period'} · ${sizesLine(summary, codes, plan.family !== 'compute')}`)}
        ${plan.status === 'active' && plan.renewsAt ? paragraph(`Renews ${dateLabel(plan.renewsAt)}`, 'ezil-billing-status') : ''}
        ${plan.status === 'cancels' ? paragraph(`Your plan ends ${dateLabel(plan.cancelsAt)}. You can resume before then.`, 'ezil-billing-status') : ''}
        ${plan.scheduledChange ? paragraph(`Switches to Standard on ${dateLabel(plan.scheduledChange.effectiveAt)}.`) : ''}
        ${plan.pendingUpgrade ? paragraph(`Compute starts once payment is confirmed. This upgrade expires ${dateLabel(plan.pendingUpgrade.expiresAt)}.`) : ''}
        ${plan.family === 'pro_legacy' ? paragraph('Your original Pro plan, honoured as sold.') : ''}
        ${plan.family !== 'free' ? paragraph('USD · before applicable tax', 'ezil-billing-note') : ''}
        <div class="ezil-billing-actions" data-role="plan-actions">${planActions}</div></section>`;
}

function pickerHtml (summary) {
    if ( ! summary.actions.checkout ) return '';
    const offers = [...summary.catalog.offers].sort((a, b) => Number(a.family === 'compute') - Number(b.family === 'compute'));
    return `<section class="ezil-billing-picker" data-role="plan-picker"><h3>Choose a plan</h3><div class="ezil-billing-offers">${offers.map(offer => {
        const allowance = stdHoursLabel(offer.allowanceStdSeconds);
        return `<article class="ezil-billing-card"><h4>${encode(planName(offer.family))}</h4>
            <p class="ezil-billing-offer-price"><strong>${encode(dollars(offer.priceCents, { compact: true }))}</strong><span>/month · before tax</span></p>
            <ul class="ezil-billing-offer-allowances"><li>${encode(`${allowance} standard-hours each billing period`)}</li><li>${encode(sizesLine(summary, offer.sizes))}</li></ul>
            ${offer.family === 'compute' && offer.overage ? paragraph(`Optional usage beyond ${allowance} standard-hours at ${dollars(offer.overage.centsPerStdHour)} each — off unless you turn it on.`, 'ezil-billing-offer-note') : ''}
            ${actionHtml('checkout', `Choose ${offer.family === 'standard' ? 'Standard' : 'Compute'}`, true, offer.sku)}</article>`;
    }).join('')}</div></section>`;
}

function meterHtml (id, label, state, usage, allowance, value, timing, note, extra = '') {
    const safeState = STATES.has(state) ? state : 'unavailable';
    return `<section class="ezil-billing-meter is-${safeState}" data-meter="${id}" aria-label="${label}">
        <h4>${label}</h4>${paragraph(usage, 'ezil-billing-usage')}${paragraph(allowance, 'ezil-billing-allowance')}
        ${safeState === 'unavailable' ? '' : `<div class="ezil-billing-progress" role="progressbar" aria-label="${label}"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${encode(`${usage} ${allowance}`)}">
            <span style="width: ${value}%"></span></div>`}
        ${paragraph(timing, 'ezil-billing-timing')}${extra}${paragraph(note, 'ezil-billing-note')}</section>`;
}

function computeHtml (summary) {
    const { compute, plan } = summary;
    const free = plan.family === 'free';
    const usage = free ? durationLabel(compute.usedStdSeconds) : stdHoursLabel(compute.usedStdSeconds, { round: 'up' });
    const over = compute.usedStdSeconds - compute.allowanceStdSeconds;
    const allowance = `of ${stdHoursLabel(compute.allowanceStdSeconds)}${free ? ' h' : ' standard-hours'}${over > 0 ? ` · ${stdHoursLabel(over, { round: 'up' })} over` : ''}`;
    const sizes = compute.allowedSizes.map(code => sizeFor(summary, code));
    const weights = sizes.filter(size => size.weight > 1).map(size => `${size.vcpu} vCPU uses ${size.weight} per hour`).join('; ');
    const note = free ? '' : '1 standard-hour = 1 hour at 2 vCPU.' + (plan.family === 'compute' && weights ? ` ${weights}.` : '');
    const empty = sizes.every(size => (compute.remainingActualSecondsBySize[size.code] ?? 0) === 0);
    const remaining = `<p data-role="size-hours">${empty ? 'No included time left this period.' : `Included time left: ${sizes.map(size => `<span data-size="${encode(size.code)}">${encode(`≈ ${includedTime(compute.remainingActualSecondsBySize[size.code] ?? 0)} at ${size.vcpu} vCPU`)}</span>`).join(' · ')}`}</p>`;
    return compute.allowedSizes.length ? meterHtml('compute', 'Compute', compute.state, usage, allowance,
        percent(BigInt(compute.usedStdSeconds), BigInt(compute.allowanceStdSeconds)), `Resets ${dateLabel(compute.resetsAt)} (UTC)`, note, remaining) : '';
}

function selectorHtml (summary) {
    const { plan, compute, actions } = summary;
    if ( plan.family !== 'compute' ) {
        const size = sizeFor(summary, plan.family === 'free' ? 'free-cf' : 'std-2');
        return `<section class="ezil-billing-card ezil-billing-sizes" data-role="size-selector"><h4>Computer size</h4>
            <div class="ezil-billing-size" data-role="size-locked"><span><strong>${encode(sizeLabel(size))}</strong><span>${encode(`Included with ${planName(plan.family)}`)}</span></span></div>
            ${actions.upgrade ? `<div class="ezil-billing-actions">${actionHtml('upgrade', 'Upgrade to Compute for 4 or 8 vCPU')}</div>` : ''}
            <p data-role="size-status" aria-live="polite"></p></section>`;
    }
    return `<fieldset class="ezil-billing-card ezil-billing-sizes" data-role="size-selector"><legend>Computer size</legend>
        <div class="ezil-billing-size-options">${compute.allowedSizes.map(code => {
        const size = sizeFor(summary, code);
        return `<label class="ezil-billing-size"><input type="radio" name="ezil-billing-size" value="${encode(code)}"${code === compute.selectedSize ? ' checked' : ''}${! actions.selectSize ? ' disabled' : ''}>
            <span><strong>${encode(sizeLabel(size))}</strong><span>${encode(`Uses ${size.weight} standard-hour${size.weight === 1 ? '' : 's'} per hour`)}</span><span>${encode(`≈ ${includedTime(compute.remainingActualSecondsBySize[code] ?? 0)} included left`)}</span></span></label>`;
    }).join('')}</div>
        <p data-role="size-status" aria-live="polite"></p></fieldset>`;
}

function overageHtml (summary) {
    const { overage, actions } = summary;
    if ( ! overage?.available ) return '';
    const allowance = stdHoursLabel(offerFor(summary, 'compute_monthly_v2').allowanceStdSeconds);
    const changed = overage.enabled && overage.acceptedVersion !== overage.termsVersion;
    return `<section class="ezil-billing-card ezil-billing-overage" data-role="overage" data-enabled="${overage.enabled}"><h4>Usage beyond your allowance</h4>
        ${overage.enabled ? paragraph(`On · up to ${dollars(overage.capCents)} a period at ${dollars(overage.centsPerStdHour)} per standard-hour.`) + paragraph(`Accrued this period: ${dollars(overage.accruedCents)}.`)
            : paragraph(`Off. When your ${allowance} standard-hours are used up, your computer saves and pauses until the next period.`)}
        ${changed ? paragraph('The overage terms changed. Review them to keep overage on.', 'ezil-billing-warning') : ''}
        ${overage.pausedReason ? `<p class="ezil-billing-warning" data-role="overage-paused" data-reason="${encode(overage.pausedReason)}">${encode(overage.pausedReason === 'cap_reached'
            ? `Overage reached your ${dollars(overage.capCents)} cap. Your computer saves and pauses until the next period, or raise the cap.`
            : "Overage is off because a usage invoice wasn't paid.")}</p>` : ''}
        ${actions.overage ? `<div class="ezil-billing-actions">${actionHtml('overage', changed ? 'Review terms' : overage.enabled ? 'Change cap' : 'Turn on…')}${overage.enabled ? actionHtml('overage-off', 'Turn off') : ''}</div>` : ''}</section>`;
}

function estimateHtml ({ plan, estimate, overage }) {
    if ( plan.family === 'free' ) return '';
    return `<section class="ezil-billing-card ezil-billing-estimate" data-role="estimate"><h4>Next charges</h4>
        ${paragraph(estimate.subscriptionCents != null && estimate.nextChargeAt != null
        ? `Next charge on ${dateLabel(estimate.nextChargeAt)}: ${dollars(estimate.subscriptionCents)} subscription before tax.` : 'No upcoming subscription charge.')}
        ${plan.family === 'compute' && overage && (overage.enabled || overage.accruedCents > 0) ? paragraph(`Usage so far: ${dollars(estimate.accruedOverageCents)}, billed separately.`) : ''}
        ${overage?.enabled ? paragraph(`At your cap: up to ${dollars(estimate.worstCaseOverageCents)}, billed separately.`) : ''}</section>`;
}

function nudgeCopy ({ compute, storage, ai, catalog }) {
    const messages = [];
    if ( ATTENTION.has(compute.state) ) messages.push(compute.state === 'low'
        ? `Included compute is running low: ≈ ${durationLabel(compute.remainingActualSecondsBySize[compute.selectedSize] ?? 0)} left at ${sizeLabel(catalog.sizes.find(size => size.code === compute.selectedSize))}.`
        : 'Included compute is used up for this period.');
    if ( ATTENTION.has(storage.state) ) messages.push(storage.state === 'over_cap' ? 'Saved storage is over your allowance.' : 'Saved storage is nearly full.');
    if ( ATTENTION.has(ai.state) ) messages.push(ai.state === 'low' ? 'AI credits are running low.' : 'AI credits are used up.');
    return messages.join(' ');
}

function nudgeHtml (summary) {
    const copy = nudgeCopy(summary);
    return copy ? `<aside class="ezil-billing-nudge" data-role="billing-nudge" role="status">${paragraph(copy)}${summary.actions.upgrade
        ? actionHtml('upgrade', 'Upgrade to Compute') : summary.plan.family === 'compute' && summary.actions.overage && summary.overage?.available && ! summary.overage.enabled
            ? actionHtml('overage', 'Turn on overage…') : ''}</aside>` : '';
}

const whole = value => Number(value).toLocaleString('en-US');

/** AI credits row (plan §6.3): this period's plan credits, then purchased, starter and renewal on their own lines. */
function aiCreditsV3Html ({ ai, actions, catalog }) {
    const state = STATES.has(ai.state) ? ai.state : 'unavailable';
    const packs = actions.topup === true ? catalog.packs ?? [] : [];
    const included = ai.included && Number.isSafeInteger(ai.included.remaining) ? ai.included : null;
    const main = included
        ? `<strong>${encode(whole(included.remaining))}</strong> <span>${encode(`of ${whole(included.granted)} left this period · resets ${dateLabel(included.periodEnd)}`)}</span>`
        : ai.balance == null ? 'Not available' : `<strong>${encode(creditsLabel(null, ai.balance))}</strong> <span>credits left</span>`;
    const purchased = ai.purchased && Number.isSafeInteger(ai.purchased.remaining) && ai.purchased.remaining > 0
        ? paragraph(`+ ${whole(ai.purchased.remaining)} purchased · expire ${dateLabel(ai.purchased.expiresAt, true)}`, 'ezil-billing-credit-line') : '';
    const starter = ai.starter && Number.isSafeInteger(ai.starter.remaining) && ai.starter.remaining > 0
        ? paragraph(`${whole(ai.starter.remaining)} starter credits left`, 'ezil-billing-credit-line') : '';
    const renewal = ai.pendingFromRenewal && Number.isSafeInteger(ai.pendingFromRenewal.credits) && ai.pendingFromRenewal.credits > 0
        ? paragraph(`${whole(ai.pendingFromRenewal.credits)} more from ${dateLabel(ai.pendingFromRenewal.at)}`, 'ezil-billing-credit-line') : '';
    return `<section id="ai-credits" class="ezil-billing-card ezil-billing-ai-credits is-${state}" data-role="meter-ai" aria-labelledby="ai-credits-heading">
        <h4 id="ai-credits-heading" tabindex="-1">AI credits</h4>
        <p class="ezil-billing-credit-balance">${main}</p>${purchased}${starter}${renewal}
        ${paragraph('Used by EZiL AI in Code and Chat.', 'ezil-billing-note')}
        ${packs.length ? `<div class="ezil-billing-actions">${packs.map(pack => actionHtml('topup', `Add ${creditsLabel(null, pack.aiCredits)} credits — ${dollars(pack.totalCents, { compact: true })}`, false, pack.sku)).join('')}</div>` : ''}
    </section>`;
}

/**
 * Computer time row (plan §6.3, D3): hours left at the CURRENT configuration
 * from `billing.usage`, the same time at the other configurations, and why.
 * Never "standard-hour" or "compute hours" (scanCopy).
 */
export function timeV3Html ({ computer, fairUse }, usage = null) {
    const lines = hoursLeftLines(usage?.period, computer.machineChoice);
    const fairCopy = { ok: 'Within fair use', near: 'Nearly at fair use', paused: `Paused until ${dateLabel(fairUse.resetsAt)}.` }[fairUse.status];
    const weighted = computer.machineChoice.filter(machine => machine.weight > 1);
    const why = weighted.length ? `Bigger configurations use your monthly time sooner: ${weighted.map(machine => `${machine.vcpu} vCPU counts ${machine.weight === 2 ? 'double' : machine.weight === 4 ? 'four times' : `${machine.weight} times`}`).join(', ')}.` : '';
    return `<section class="ezil-billing-card" data-role="meter-time" aria-labelledby="time-heading"><h4 id="time-heading">Computer time</h4>
        ${paragraph(lines ? `${lines.main} · resets ${dateLabel(fairUse.resetsAt)}` : `Resets ${dateLabel(fairUse.resetsAt)}`, 'ezil-billing-usage')}
        ${lines?.equivalents ? paragraph(lines.equivalents, 'ezil-billing-credit-line') : ''}
        <p class="ezil-billing-fair-use" data-role="fair-use" data-status="${encode(fairUse.status)}" role="status">${encode(fairCopy)}</p>
        ${why ? paragraph(why, 'ezil-billing-note') : ''}</section>`;
}

/** Storage row (plan §6.3, D4): the provisioned disk; a used figure only once something measures it. */
function storageV3Html ({ computer }) {
    const disk = computer.disk;
    const gb = Number.isFinite(disk?.provisionedGiB) ? disk.provisionedGiB : null;
    const used = typeof disk?.usedBytes === 'string' && /^\d+$/.test(disk.usedBytes) ? Number(disk.usedBytes) / 1e9 : null;
    return `<section class="ezil-billing-card" data-role="meter-storage" aria-labelledby="storage-heading"><h4 id="storage-heading">Storage</h4>
        ${paragraph(gb === null ? 'Your files are saved with your computer.' : used !== null ? `${used.toLocaleString('en-US', { maximumFractionDigits: 1 })} of ${gb} GB used` : `${gb} GB disk for your projects`, 'ezil-billing-usage')}
        ${gb !== null ? paragraph('The same disk on every configuration.', 'ezil-billing-note') : ''}</section>`;
}

function aiV3Html (ai) {
    const spending = ai?.spendingState ?? 'unavailable';
    const copy = {
        available: ai?.balanceState === 'exhausted' ? 'No AI credits remain.'
            : ai?.balanceState === 'low' ? 'AI credits are running low.' : 'AI spending is not paused.',
        paused_operations: 'AI spending is paused by operations.',
        paused_reconciliation: 'AI spending is paused while pending requests are reconciled.',
        paused_policy: 'AI spending is paused by an account policy.',
        unavailable: 'AI spending status is unavailable.',
    }[spending] ?? 'AI spending status is unavailable.';
    const limits = ai?.limits, policy = limits?.policy, counters = limits?.counters;
    const number = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Not reported';
    const credits = value => value == null ? 'Not reported' : `${creditsLabel(value)} credits`;
    const detail = (label, value) => `<div><dt>${encode(label)}</dt><dd>${encode(value)}</dd></div>`;
    const recent = ai?.recentUsage;
    return `<section class="ezil-billing-card" data-role="ai-usage" aria-label="AI credits and usage">
        <h4>AI usage</h4>
        ${paragraph(`Balance: ${ai?.balanceMicro != null || ai?.balance != null ? `${creditsLabel(ai.balanceMicro, ai.balance)} credits` : 'Not reported'}`, 'ezil-billing-usage')}
        <p role="status" data-role="ai-spending" data-state="${encode(spending)}">${encode(copy)}</p>
        ${paragraph(`Held for requests: ${credits(ai?.heldMicro)}`)}
        ${limits?.pauses?.some(p => ['model', 'client'].includes(p.scope)) ? paragraph('Some models or clients are paused.') : ''}
        <h4>AI limits</h4>
        ${!limits ? paragraph('AI limits are unavailable.') : `<dl data-role="ai-limits">
            ${detail('Requests per minute', `${number(policy?.rpm)} · service ceiling: ${number(limits.ceilings?.rpm)}`)}
            ${detail('Concurrent requests', `${number(policy?.concurrency)} · service ceiling: ${number(limits.ceilings?.concurrency)}`)}
            ${detail('Tokens per minute', number(policy?.tpm))}
            ${detail('Output tokens per request', number(policy?.maxOutputTokens))}
            ${detail('Daily commitment / budget', `${credits(counters?.dayMicro)} / ${credits(policy?.dailyBudgetMicro)}`)}
            ${detail('Monthly commitment / budget', `${credits(counters?.monthMicro)} / ${credits(policy?.monthlyBudgetMicro)}`)}
            ${detail('Open / pending requests', `${number(counters?.inflight)} / ${number(counters?.pending)}`)}
        </dl>`}
        ${paragraph('Commitments include held credits. Unreported limits are unknown.')}
        <h4>Recent AI requests</h4>
        ${!recent ? paragraph('Recent AI usage is unavailable.') : !recent.rows.length ? paragraph('No requests in this result.')
            : `<ul data-role="ai-recent">${recent.rows.map(row => `<li>${encode(dateLabel(row.at, true))} · ${encode({ reserved: 'Reserved', pending: 'Pending', settled: 'Settled' }[row.status] ?? 'Unknown')}
                · charged: ${encode(credits(row.chargedMicro))} · held: ${encode(credits(row.heldMicro))}</li>`).join('')}</ul>`}
        ${paragraph(`Recent requests${recent ? ` (up to ${recent.limit})` : ''} are not a billing-period total.`)}
    </section>`;
}

/** Plan action by state (plan §6.3): one primary per state. */
function planActionsV3 ({ plan, actions }) {
    if ( plan.status === 'cancels' ) return actions.cancel ? actionHtml('resume', `Keep ${plan.name}`, true) : '';
    const main = plan.sku === 'free_v3' ? actions.checkout ? actionHtml('choose', 'Upgrade', true) : ''
        : plan.sku === 'standard_monthly_v3' ? actions.upgrade ? actionHtml('upgrade', 'Upgrade to Premium', true) : ''
            : actions.downgrade ? actionHtml('downgrade', 'Change plan') : actions.upgrade ? actionHtml('upgrade', 'Change plan') : '';
    return main + (actions.cancel ? actionHtml('cancel', 'Cancel plan') : '');
}

export function summaryV3Html (summary, usage = null) {
    const { plan, computer, actions } = summary;
    const status = { free: 'Current', active: 'Current', cancels: 'Ends soon', past_due: 'Past due', incomplete: 'Payment incomplete', upgrade_pending: 'Upgrade pending' }[plan.status];
    const hours = computer.sessionMaxSeconds === null ? null : computer.sessionMaxSeconds / 3600;
    const price = plan.sku === 'free_v3' ? '$0' : plan.renewal && ! ['cancels', 'past_due'].includes(plan.status)
        ? `${dollars(plan.renewal.amountCents, { compact: true })}/month · renews ${dateLabel(plan.renewal.at, true)}` : '';
    const choices = computer.machineChoice.length > 1;
    return `<header class="ezil-billing-header"><div><h3>Billing</h3><p class="ezil-settings-lead">Your plan and payments.</p></div>
        <div class="ezil-billing-actions">${actions.portal ? actionHtml('portal', 'Manage payment') : ''}${actionHtml('invoices', 'Invoices')}</div></header>
        ${paymentHtml(summary)}
        <section class="ezil-billing-card ezil-billing-plan" data-role="plan-card" data-version="3" aria-label="Current plan">
            <div class="ezil-billing-plan-heading"><h4>${encode(plan.name)}</h4><span class="ezil-settings-pill" data-role="plan-status" data-status="${encode(plan.status)}">${encode(status)}</span></div>
            ${price ? paragraph(price, 'ezil-billing-status') : ''}
            ${plan.status === 'cancels' ? `<aside role="status" data-role="cancels-banner">${paragraph(`${plan.name} ends on ${dateLabel(plan.cancelsAt)}. Your files are kept.`)}</aside>` : ''}
            ${plan.status === 'past_due' && ! plan.paymentIssue ? `<aside role="status" data-role="payment-banner">${encode(`Your last payment didn't go through. Update your payment method to keep ${plan.name}.`)}</aside>` : ''}
            ${plan.scheduledChange ? paragraph(`Changes to ${offerFor(summary, plan.scheduledChange.toSku)?.name ?? 'Standard'} on ${dateLabel(plan.scheduledChange.effectiveAt)}.`) : ''}
            ${plan.pendingUpgrade ? paragraph(`Premium starts once payment is confirmed. This upgrade expires ${dateLabel(plan.pendingUpgrade.expiresAt)}.`) : ''}
            <div class="ezil-billing-actions" data-role="plan-actions">${planActionsV3(summary)}</div>
        </section>
        <section class="ezil-billing-card" data-role="your-computer"><h4>Your computer</h4>
            ${paragraph(choices ? `Next start: ${computer.vcpu} vCPU · ${computer.memoryGiB} GB` : `${computer.vcpu} vCPU · ${computer.memoryGiB} GB`)}
            ${paragraph(hours === null ? 'No session time limit' : `Sessions up to ${hours} hour${hours === 1 ? '' : 's'}`)}
            ${plan.sku !== 'free_v3' ? paragraph('Your own computer on AWS (India)') : ''}
            ${choices ? `<div class="ezil-billing-actions">${actionHtml('computer-tab', 'Change configuration')}</div>` : ''}
        </section>
        <div class="ezil-billing-v3-meters" data-role="billing-meters">${aiCreditsV3Html(summary)}<div data-role="time-slot">${timeV3Html(summary, usage)}</div>${storageV3Html(summary)}</div>
        ${aiV3Html(summary.ai)}
        <p class="ezil-billing-note">Prices before tax.</p>
        <p class="ezil-billing-action-error" data-role="billing-action-error" role="alert"></p>
        <section class="ezil-billing-invoices" data-role="invoices" aria-label="Invoices"><h3 tabindex="-1">Invoices</h3>
            <div data-role="invoice-rows" aria-busy="true"><p class="ezil-billing-note">Loading invoices…</p></div></section>`;
}

function summaryHtml (summary) {
    const { storage, ai, actions, compute } = summary;
    const unavailable = ai.state === 'unavailable';
    const balance = BigInt(ai.trialMicro) + BigInt(ai.includedMicro) + BigInt(ai.purchasedMicro);
    return `<header class="ezil-billing-header"><div><h3>Plan &amp; usage</h3><p class="ezil-settings-lead">Your plan, compute and what renews when.</p></div>
        ${actions.portal ? actionHtml('portal', 'Manage billing') : ''}</header>
        ${paymentHtml(summary)}${planHtml(summary)}${pickerHtml(summary)}${computeHtml(summary)}${selectorHtml(summary)}
        <section class="ezil-billing-card ezil-billing-session"><p data-role="session-note">${encode(`Sessions run up to ${compute.session.maxSeconds / 3600} hours, then your work is saved and the computer restarts. Files and installed tools are kept; running processes start fresh.`)}</p>
            ${compute.session.activeDeadline ? '<p data-role="session-countdown" aria-live="polite"></p>' : ''}</section>
        ${overageHtml(summary)}${estimateHtml(summary)}
        <div class="ezil-billing-meters">
            ${meterHtml('storage', 'Saved storage', storage.state, gigabytes(storage.usedBytes), `of ${gigabytes(storage.capBytes)}`,
                percent(BigInt(storage.usedBytes), BigInt(storage.capBytes)), updated(storage.measuredAt), "Saved project files across your computers — not the computer's working disk.")}
            ${meterHtml('ai', 'AI credits', ai.state, unavailable ? 'Coming soon' : `${dollars(balance / 10_000n)} left`, unavailable ? '' : 'Available balance',
                balance > 0n ? 100 : 0, unavailable ? 'AI assistant coming soon' : ai.includedExpiresAt ? `Included credit expires ${dateLabel(ai.includedExpiresAt)}` : 'No included credit expiry.', '')}
        </div>${nudgeHtml(summary)}
        <p class="ezil-billing-action-error" data-role="billing-action-error" role="alert"></p>
        <section class="ezil-billing-invoices" data-role="invoices" aria-label="Invoices"><h3>Invoices</h3>
            <div data-role="invoice-rows" aria-busy="true"><p class="ezil-billing-note">Loading invoices…</p></div></section>`;
}

function invoicesHtml (rows) {
    if ( rows.length === 0 ) return '<p class="ezil-billing-note" data-role="invoices-empty">No invoices yet.</p>';
    return `<ul class="ezil-billing-invoice-list">${[...rows].sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 12).map(row => {
        let url = '';
        try { url = webUrl(row.url); } catch { /* A missing link must not hide an invoice. */ }
        const description = row.description || `EZiL ${row.kind}`;
        const status = row.status.replaceAll('_', ' ');
        return `<li class="ezil-billing-invoice"><div class="ezil-billing-invoice-heading"><time datetime="${encode(row.created)}">${dateLabel(row.created, true)}</time>
            <span class="ezil-settings-pill" data-role="invoice-kind" data-kind="${encode(row.kind)}">${encode({ subscription: 'Subscription', overage: 'Usage', other: 'Other' }[row.kind])}</span></div>
            <span class="ezil-billing-invoice-description">${encode(description)}</span>
            <div class="ezil-billing-invoice-details"><span class="ezil-billing-invoice-amount">${encode(dollars(row.status === 'paid' ? row.amountPaidCents : row.amountDueCents))}</span><span class="ezil-billing-invoice-status">${encode(status.charAt(0).toUpperCase() + status.slice(1))}</span>
            <span class="ezil-billing-invoice-link">${url ? `<a href="${encode(url)}" target="_blank" rel="noopener" aria-label="${encode(`View invoice ${description} (opens in a new tab)`)}">View ↗</a>` : '<span class="ezil-billing-note">Link unavailable</span>'}</span></div></li>`;
    }).join('')}</ul>`;
}

function loadingHtml () {
    return `<header class="ezil-billing-header"><div><h3>Billing</h3><p class="ezil-settings-lead">Your plan and payments.</p></div></header>
        <p role="status">Loading billing…</p><div class="ezil-billing-meters" aria-hidden="true">${Array.from({ length: 3 }, () => '<div class="ezil-billing-meter ezil-billing-skeleton"><span></span><span></span><span></span></div>').join('')}</div>`;
}

function stopCountdown (state) {
    if ( state.timer != null ) clearInterval(state.timer);
    state.timer = null;
}

function startCountdown ($win, state) {
    stopCountdown(state);
    if ( state.summary.version !== 2 ) return;
    const session = state.summary.compute.session;
    if ( ! session.activeDeadline || ! state.active ) return;
    const update = () => {
        if ( ! $win.get(0).isConnected ) { stopCountdown(state); return; }
        const seconds = Math.max(0, Math.floor((Date.parse(session.activeDeadline) - Date.now()) / 1000));
        $win.find('[data-role="session-countdown"]').text(seconds > 0
            ? `This session saves and restarts in ${durationLabel(seconds)}.` : 'This session is saving and restarting now.')
            .toggleClass('ezil-billing-warning', seconds <= session.warnSeconds[0]);
    };
    update();
    state.timer = setInterval(update, 30000);
}

async function load ($win, state) {
    if ( state.loading || state.pending || state.sheet || state.closed ) return;
    stopCountdown(state);
    state.loading = true;
    state.summary = null;
    state.history = [];
    const request = ++state.request;
    const $body = $win.find('[data-role="billing-body"]');
    $body.attr('aria-busy', 'true').html(loadingHtml());
    const history = trpc.query('billing.history').catch(() => ({ ok: false }));
    try {
        const result = await trpc.query('billing.summary');
        if ( request !== state.request || ! state.active || state.closed || ! $win.get(0).isConnected ) return;
        if ( ! result.ok ) throw new Error('summary failed');
        if ( result.data?.enabled === false || ! [2, 3].includes(result.data?.version) ) {
            $body.html('<p>Billing isn\'t available yet.</p>');
        } else {
            $body.html(result.data.version === 3 ? summaryV3Html(result.data) : summaryHtml(result.data));
            state.summary = result.data;
            startCountdown($win, state);
            if ( result.data.version === 3 ) void loadUsage($win, state, request);
        }
    } catch {
        if ( request !== state.request || ! state.active || state.closed ) return;
        $body.html('<div class="ezil-billing-card ezil-settings-error" role="alert">Couldn\'t load billing. Try again. <button type="button" class="ezil-settings-btn" data-action="retry">Retry</button></div>');
    } finally {
        if ( request === state.request ) {
            state.loading = false;
            $body.attr('aria-busy', 'false');
        }
    }
    if ( state.summary && ! state.autoOpened ) {
        state.autoOpened = true;
        const sku = state.openUpgrade;
        if ( state.openSection === 'ai-credits' ) {
            const card = $body.find('#ai-credits').get(0);
            card?.scrollIntoView?.({ block: 'nearest' });
            card?.querySelector('h4')?.focus({ preventScroll: true });
        } else if ( typeof sku === 'string' && offerFor(state.summary, sku) && state.summary.actions.checkout ) openSheet($win, state, 'checkout', sku);
        else if ( ['compute_monthly_v2', 'premium_monthly_v3'].includes(sku) && state.summary.actions.upgrade ) openSheet($win, state, 'upgrade');
        else if ( sku === true && state.summary.actions.checkout ) {
            if ( state.summary.version === 3 ) openSheet($win, state, 'choose');
            const picker = $body.find('[data-role="plan-picker"]').get(0);
            picker?.scrollIntoView?.({ block: 'nearest' });
            picker?.querySelector('button')?.focus();
        }
    }
    const result = await history;
    if ( request !== state.request || state.closed || ! $win.get(0).isConnected ) return;
    const $rows = $body.find('[data-role="invoice-rows"]');
    try {
        if ( ! result.ok ) throw new Error('history failed');
        state.history = result.data;
        $rows.html(invoicesHtml(state.history));
    } catch {
        $rows.html('<p class="ezil-billing-note" role="status">Couldn\'t load invoices. <button type="button" class="ezil-settings-btn" data-action="retry">Retry</button></p>');
    }
    $rows.attr('aria-busy', 'false');
    // History can finish during a portal/size mutation; newly added Retry must obey it too.
    if ( state.pending ) $rows.find('button').prop('disabled', true);
}

/** The time row needs `billing.usage` (hours at the current configuration); it fills in when that answers. */
async function loadUsage ($win, state, request) {
    const computerId = currentComputer()?.id;
    const result = await trpc.query('billing.usage', computerId ? { computerId } : undefined).catch(() => ({ ok: false }));
    if ( request !== state.request || state.closed || ! state.summary || ! $win.get(0).isConnected ) return;
    const usage = result?.ok && result.data?.enabled === true && result.data.period ? result.data : null;
    if ( usage ) $win.find('[data-role="time-slot"]').html(timeV3Html(state.summary, usage));
}

function actionError ($win, copy) { $win.find('[data-role="billing-action-error"]').text(copy); }

function openSheet ($win, state, action, sku) {
    if ( state.pending || state.sheet || state.closed || state.summary?.actions[action === 'choose' ? 'checkout' : action] !== true ) return;
    const summary = state.summary;
    const offer = action === 'checkout' ? offerFor(summary, sku) : null;
    const pack = action === 'topup' ? summary.catalog.packs?.find(pack => pack.sku === sku) : null;
    if ( action === 'checkout' && (! offer || offer.sku === 'free_v3') ) return;
    if ( action === 'topup' && (summary.version !== 3 || ! pack) ) return;
    const container = $win.find('.window-body').get(0);
    const token = {};
    state.sheet = token;
    let observer;
    const onClose = () => {
        observer?.disconnect();
        if ( state.sheet === token ) state.sheet = null;
    };
    const onDone = () => { onClose(); void load($win, state); };
    actionError($win, '');
    try {
        // After an upgrade, "Switch to 4 vCPU · 16 GB" hands over to the Computer tab, which owns the switch.
        const onSwitch = size => {
            window.dispatchEvent(new CustomEvent('ezil:computer-switch-request', { detail: { size } }));
            $win.find('.ezil-settings-tab[data-tab="computers"]').trigger('click');
        };
        const options = { container, trpc, onDone, onClose, onSwitch, checkout: params => openSheet($win, state, 'checkout', params.sku) };
        token.handle = action === 'topup' ? upgradeSheetOpener({ ...options, sku, pack })
            : action === 'checkout' ? upgradeSheetOpener({ ...options, sku, offer, sizes: summary.catalog.sizes })
            : sheetOpeners[action]({ ...options, summary });
        // The v1 checkout sheet predates onClose. New billing sheets use the callback.
        const checkoutRoot = action === 'checkout' && container.ownerDocument.querySelector('[data-role="upgrade-sheet"]');
        if ( checkoutRoot && state.sheet === token ) {
            observer = new MutationObserver(() => {
                if ( ! checkoutRoot.isConnected ) onClose();
            });
            observer.observe(container.ownerDocument.body, { childList: true, subtree: true });
        }
        token.cleanup = onClose;
    } catch {
        onClose();
        actionError($win, 'Could not open billing. Try again.');
    }
}

function invoiceUrl (state, kind) {
    const candidates = kind === 'subscription' ? [state.summary.plan.pendingUpgrade?.hostedInvoiceUrl] : [];
    candidates.push(...[...state.history].filter(row => row.status === 'open' && row.kind === kind)
        .sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).map(row => row.url));
    for ( const url of candidates ) {
        try { return webUrl(url); } catch { /* Try the next eligible invoice before the portal. */ }
    }
    return null;
}

async function act ($win, state, action, value) {
    if ( state.pending || state.sheet || ! state.summary || state.closed ) return;
    const summary = state.summary;
    const flag = { resume: 'cancel', 'overage-off': 'overage', size: 'selectSize', 'open-invoice': 'portal' }[action] ?? action;
    const machineAction = action === 'machine' && summary.version === 3 && summary.plan.sku === 'premium_monthly_v3';
    if ( action === 'machine' && (! machineAction || value === summary.computer.size || ! summary.computer.machineChoice.some(machine => machine.size === value)) ) return;
    if ( action !== 'open-invoice' && ! machineAction && summary.actions[flag] !== true ) return;
    if ( action === 'size' && (value === summary.compute.selectedSize || ! summary.compute.allowedSizes.includes(value)) ) return;
    const $pane = $win.find('[data-pane="billing"]');
    const previousSize = machineAction ? summary.computer.size : summary.compute?.selectedSize;
    const focused = $pane.get(0).ownerDocument.activeElement;
    const controls = $pane.find('button, input[type="radio"]').get().map(element => [element, element.disabled]);
    state.pending = true;
    controls.forEach(([element]) => { element.disabled = true; });
    actionError($win, '');
    if ( action === 'size' ) $pane.find('[data-role="size-status"]').text('Saving…');
    if ( machineAction ) $pane.find('[data-role="machine-status"]').text('Saving…');
    let reload = false;
    try {
        let result;
        if ( action === 'portal' || action === 'open-invoice' ) {
            let url = action === 'open-invoice' ? invoiceUrl(state, value) : null;
            if ( ! url ) {
                if ( ! summary.actions.portal ) throw new Error('unavailable');
                result = await trpc.mutate('billing.portal');
                if ( ! result.ok ) throw new Error(result.message);
                url = webUrl(result.data.url);
            }
            if ( ! state.closed && $win.get(0).isConnected ) window.open(url, '_blank', 'noopener');
        } else {
            if ( action === 'resume' ) result = await trpc.mutate('billing.cancelAtPeriodEnd', { cancel: false });
            else if ( action === 'overage-off' ) result = await trpc.mutate('billing.setOverage', { enabled: false, capCents: summary.overage.capCents, termsVersion: summary.overage.termsVersion });
            else if ( action === 'size' ) result = await trpc.mutate('billing.selectSize', { size: value });
            else if ( machineAction ) result = await trpc.mutate('billing.selectMachine', { size: value });
            if ( ! result?.ok ) throw new Error(result?.message);
            if ( state.closed || ! $win.get(0).isConnected ) return;
            if ( machineAction ) {
                const machine = summary.computer.machineChoice.find(machine => machine.size === result.data.size);
                if ( ! machine || result.data.effective !== 'next_open' ) throw new Error('unavailable');
                Object.assign(summary.computer, { size: machine.size, vcpu: machine.vcpu, memoryGiB: machine.memoryGiB });
                $pane.find('[data-role="machine-status"]').text(`Your files stay on your disk. Your next session starts on ${machine.vcpu} vCPU · ${machine.memoryGiB} GB — about 30 seconds after you stop and reopen your computer.`);
            } else if ( action === 'size' ) {
                summary.compute.selectedSize = result.data.selectedSize;
                $pane.find('[data-role="size-status"]').text('Size saved.');
                $pane.find('[data-role="billing-nudge"] > p').text(nudgeCopy(summary));
            } else reload = true;
        }
    } catch (error) {
        if ( state.closed || ! $win.get(0).isConnected ) return;
        if ( machineAction ) {
            summary.computer.size = previousSize;
            $pane.find('[data-role="machine-status"]').text(errorCopy(error.message));
        } else if ( action === 'size' ) {
            summary.compute.selectedSize = previousSize;
            $pane.find('[data-role="size-status"]').text(errorCopy(error.message));
        } else actionError($win, errorCopy(error.message, summary.overage?.maxCapCents));
    } finally {
        state.pending = false;
        controls.forEach(([element, disabled]) => { element.disabled = disabled; });
        $pane.find('[data-role="invoices"] button').prop('disabled', false);
        $pane.find('input[name="ezil-billing-size"]').each(function () { this.checked = this.value === summary.compute?.selectedSize; });
        $pane.find('input[name="ezil-billing-machine"]').each(function () { this.checked = this.value === summary.computer?.size; });
        if ( machineAction && ! state.closed && focused?.isConnected ) focused.focus();
    }
    if ( reload ) await load($win, state);
}

export default {
    id: 'billing', label: 'Billing', icon: BILLING_ICON,
    available (ctx) {
        return ! isNative(ctx) && TabAccount.available(ctx)
            && (ctx?.payload?.features ?? bootPayload()?.features)?.billing === true;
    },
    html () {
        return `<div class="ezil-settings-billing"><div data-role="billing-body" aria-live="polite">${loadingHtml()}</div>
            <footer class="ezil-billing-footer"><a href="mailto:contact@ezil.work">Support</a>
                <a href="/refunds" target="_blank" rel="noopener">Refund policy</a><a href="/pricing" target="_blank" rel="noopener">Plans</a></footer></div>`;
    },
    init ($win) {
        const state = { loading: false, pending: false, summary: null, history: [], sheet: null, request: 0, autoOpened: false, openUpgrade: false, openSection: null, timer: null, active: false, closed: false };
        windows.set($win.get(0), state);
        const $pane = $win.find('[data-pane="billing"]');
        $pane.on('click', 'button[data-action]', function () {
            if ( this.disabled ) return;
            const action = this.dataset.action;
            if ( action === 'retry' ) void load($win, state);
            else if ( action === 'invoices' ) {
                const heading = $pane.find('[data-role="invoices"] h3').get(0);
                heading?.scrollIntoView?.({ block: 'start' });
                heading?.focus({ preventScroll: true });
            } else if ( action === 'computer-tab' ) $win.find('.ezil-settings-tab[data-tab="computers"]').trigger('click');
            else if ( ['checkout', 'topup', 'choose', 'upgrade', 'downgrade', 'cancel', 'overage'].includes(action) ) openSheet($win, state, action, this.dataset.sku);
            else void act($win, state, action, this.dataset.kind);
        });
        $pane.on('change', 'input[name="ezil-billing-size"]', function () {
            if ( ! this.disabled && this.checked ) void act($win, state, 'size', this.value);
        });
        $win.on('remove.billing', () => {
            state.closed = true;
            state.request++;
            stopCountdown(state);
            state.sheet?.handle?.close();
            state.sheet?.cleanup?.();
        });
    },
    onActivate ($win, ctx = {}) {
        const state = windows.get($win.get(0));
        if ( state ) {
            state.active = true;
            state.openUpgrade ||= ctx.openUpgrade;
            const params = new URLSearchParams(window.location.search);
            if ( ! state.autoOpened && params.get('settings') === 'billing' && params.get('section') === 'ai-credits' ) state.openSection = 'ai-credits';
            void load($win, state);
        }
    },
    onDeactivate ($win) {
        const state = $win && windows.get($win.get(0));
        if ( state ) { state.active = false; state.request++; state.loading = false; stopCountdown(state); }
    },
};

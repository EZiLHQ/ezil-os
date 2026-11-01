// Versioned billing views. The summary owns plan details and action availability.
import TabAccount from './account.js';
import { payload as bootPayload, currentComputer } from '../../../session.js';
import { isNative } from '../../../native-runtime.js';
import trpc from '../trpc.js';
import { openUpgradeSheet } from '../upgrade-sheet.js';
import { openComputeUpgradeSheet, openDowngradeSheet, openCancelSheet, openOverageSheet, openPlanPickerSheet } from '../billing-sheets.js';
import { openConfirmSheet } from '../sheet-frame.js';
import { dollars, dateLabel, durationLabel, stdHoursLabel, sizeLabel, planName, errorCopy, webUrl, hoursLeftLines, heldClosedSize, heldClosedText, RENEWING_COPY } from '../billing-format.js';
import { settingsAliasSearch } from '../../../app-link.js';

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

const STANDINGS = new Set(['paid', 'grace', 'plan_ending', 'files_on_aws', 'free']);
/** Round 4: the server's standing (`computer.standing`, STANDING-CONTRACT), or null when not reported. */
function standingOf (summary) {
    const value = summary?.computer?.standing;
    return STANDINGS.has(value) ? value : null;
}

/** Round 4 copy (D16-D18). Same function as `computers.js` `standingCopy`; billing-test pins the two equal. */
export function standingCopy (standing, data) {
    const plan = data?.plan ?? {};
    const day = iso => Number.isFinite(Date.parse(iso ?? '')) ? dateLabel(iso, true) : null;
    if ( standing === 'grace' ) {
        const by = day(plan.graceEndsAt);
        return `Your payment didn't go through — update it${by ? ` by ${by}` : ''} to keep your ${data?.computer?.filesOn === 'cloudflare' ? 'plan' : 'AWS computer'}.`;
    }
    if ( standing === 'plan_ending' ) {
        const on = day(plan.planEndsAt ?? plan.cancelsAt);
        const name = plan.name || 'Your plan';
        const ends = on ? `${name} ends on ${on}.` : `${name} ends at the end of this period.`;
        return data?.computer?.filesOn === 'cloudflare' ? `${ends} Your files are kept.`
            : `${ends} After that your files stay on your AWS computer until they are moved to your Free computer; nothing is deleted.`;
    }
    if ( standing === 'files_on_aws' ) {
        // Round 6 (R4-02): a held 4 or 8 vCPU computer does not open on Free (the hold never resizes).
        const closed = heldClosedSize(data?.computer);
        return closed ? heldClosedText(closed.vcpu)
            : 'Your files are still on your AWS (India) computer. It opens on the Free plan with Free limits; upgrade for no session time limit.';
    }
    return '';
}

function paymentHtml (summary) {
    const { plan, actions, version } = summary;
    // Round 4 (D17): in grace the paid computer stays usable until the date; the banner says so.
    if ( version === 3 && standingOf(summary) === 'grace' && plan.paymentIssue !== 'requires_action' ) {
        return `<aside class="ezil-billing-card ezil-billing-payment is-danger" role="status" data-role="payment-grace">${paragraph(standingCopy('grace', summary))}${actions.portal ? actionHtml('portal', 'Fix payment') : ''}</aside>`;
    }
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

// ── Billing v3 (round 5, decision D6) ───────────────────────────────────────
// One column, in this order: header, ONE state banner (only past_due, cancels,
// incomplete, upgrade_pending, fair use paused), the current plan with "Your
// computer", one usage card whose three rows all mean "left", the three plans,
// the AI top-up disclosure, invoices, footer. At most ONE primary button per
// page state (settings-design-test pins every state). Operator internals (AI
// limits, holds, recent requests) are not on the user surface; the machine
// picker lives on the Computer tab only. Credits are whole numbers, never dollars.

const whole = value => Number.isFinite(Number(value)) ? Math.floor(Number(value)).toLocaleString('en-US') : '—';
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const PLAN_RANK = { free_v3: 0, standard_monthly_v3: 1, premium_monthly_v3: 2 };
/** Sizes for plan cards whose configurations are not the user's (mirrors v2 `SIZES`). */
const SIZE_INFO = { 'free-cf': { vcpu: 2, memoryGiB: 6, weight: 1 }, 'std-2': { vcpu: 2, memoryGiB: 8, weight: 1 }, 'cmp-4': { vcpu: 4, memoryGiB: 16, weight: 2 }, 'cmp-8': { vcpu: 8, memoryGiB: 32, weight: 4 } };
const sizeInfoV3 = (summary, code) => summary.computer.machineChoice.find(m => m.size === code) ?? SIZE_INFO[code] ?? null;
const percentOf = (part, total) => total > 0 ? Math.max(0, Math.min(100, Math.floor(part * 100 / total))) : 0;

function linkAction (action, label, extra = '') {
    return `<button type="button" class="ezil-billing-link" data-action="${action}"${extra}>${encode(label)}</button>`;
}

/** The EZiL ID link (`actions.ezilId`): an http(s) URL or a same-site path, opened in this tab. */
function ezilIdHref (value) {
    if ( typeof value !== 'string' || ! value ) return null;
    if ( value.startsWith('/') && ! value.startsWith('//') ) return value;
    try { return webUrl(value); } catch { return null; }
}

/** One meter row. `percent` is the share LEFT (null: no bar); tone comes from the server state. */
function meterRowV3 ({ role, id, label, value, percent = null, tone = 'ok', notes = [], extra = '' }) {
    const bar = percent === null ? '' : `<div class="ezil-billing-gauge" role="meter" aria-label="${encode(`${label}: ${value}`)}"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${encode(value)}"><span style="width: ${percent}%"></span></div>`;
    return `<div class="ezil-billing-meter-row is-${tone}" data-role="${role}"${id ? ` id="${id}"` : ''}>
        <div class="ezil-billing-meter-head"><h4${id ? ' tabindex="-1"' : ''}>${encode(label)}</h4><span class="ezil-billing-meter-value">${encode(value)}</span></div>
        ${bar}${notes.filter(Boolean).map(note => typeof note === 'string' ? paragraph(note, 'ezil-billing-note') : note.html).join('')}${extra}</div>`;
}

/**
 * Computer time (D3): REAL hours at the current configuration from `billing.usage`, the bar is
 * the share of this period's time LEFT, and the warning follows the server's fair-use state.
 * Never "standard-hour" or "compute hours" (scanCopy).
 */
export function timeV3Html ({ computer, fairUse, plan }, usage = null) {
    // Renewal gap: the new period's time is granted once its invoice is paid. Never "0 h left" or used up meanwhile.
    if ( fairUse.status === 'renewing' ) return meterRowV3({ role: 'meter-time', label: 'Computer time', value: 'Pending', notes: [
        { html: `<p class="ezil-billing-note ezil-billing-fair-use" data-role="fair-use" data-status="renewing" role="status">${encode(RENEWING_COPY)}</p>` },
    ] });
    // `usage` null: billing.usage has not answered yet; false: it answered without a reading.
    const period = usage?.period ?? null;
    // Round 6 (R1-06): Free (also held on AWS) says the month's allowance, "About 5 of 8 hours left this month";
    // review: so does a paid plan past its payment grace (the standing runs the computer as Free).
    const lines = hoursLeftLines(period, computer.machineChoice, { monthly: plan?.sku === 'free_v3' || ['files_on_aws', 'free'].includes(computer.standing) });
    const hours = lines ? period.remainingHoursAtCurrent : null;
    const value = hours === null ? usage === null ? 'Checking…' : 'Not measured yet' : hours === 0 && period.remainingStandardSeconds > 0 ? 'Less than 1 h left' : `${whole(hours)} h left`;
    const percent = lines && safeCount(period.remainingStandardSeconds) && safeCount(period.allowanceStandardSeconds) && period.allowanceStandardSeconds > 0
        ? percentOf(period.remainingStandardSeconds, period.allowanceStandardSeconds) : null;
    const tone = fairUse.status === 'paused' ? 'danger' : fairUse.status === 'near' ? 'warn' : 'ok';
    // Hotfix r5 (ACCEPT #3): advise a smaller configuration only when the plan allows one that counts less time.
    const currentSize = period?.currentSize ?? computer.size;
    // A size the plan no longer offers (a downgrade, until the next start) still has its own weight.
    const currentWeight = (computer.machineChoice.find(machine => machine.size === currentSize) ?? SIZE_INFO[currentSize])?.weight;
    const smaller = Number.isFinite(currentWeight) && computer.machineChoice.some(machine => machine.weight < currentWeight);
    const fair = { ok: 'Within fair use', near: smaller ? '! Running low. A smaller configuration makes your time last longer.' : '! Running low.', paused:`■ Used up. You can start your computer again on ${dateLabel(fairUse.resetsAt)}.` }[fairUse.status] ?? '';
    const weighted = computer.machineChoice.filter(machine => machine.weight > 1);
    const why = weighted.length ? `Bigger configurations use your monthly time sooner: ${weighted.map(machine => `${machine.vcpu} vCPU counts ${machine.weight === 2 ? 'double' : machine.weight === 4 ? 'four times' : `${machine.weight} times`}`).join(', ')}.` : '';
    return meterRowV3({ role: 'meter-time', label: 'Computer time', value, percent, tone, notes: [
        lines ? lines.main : '', // the reset date is in the usage card's header
        lines?.equivalents ?? '',
        { html: `<p class="ezil-billing-note ezil-billing-fair-use" data-role="fair-use" data-status="${encode(fairUse.status)}" role="status">${encode(fair)}</p>` },
        why,
    ] });
}

/** AI credits (D1 + founder 2026-10-29): whole numbers, denominator = the plan's grant for the period. */
function aiMeterV3 (summary) {
    const { ai, actions, plan } = summary;
    const enrollment = ai.enrollment ?? 'enrolled';
    const waiting = ai.waiting && safeCount(ai.waiting.credits) && ai.waiting.credits > 0 ? ai.waiting.credits : null;
    if ( enrollment === 'needs_ezil_id' ) {
        const href = ezilIdHref(actions.ezilId);
        return meterRowV3({ role: 'meter-ai', id: 'ai-credits', label: 'AI credits', value: waiting ? `${whole(waiting)} credits waiting` : 'Not active yet', notes: [
            'AI credits activate when you sign in with EZiL ID. Use the same email as this account.',
        ], extra: href ? `<div class="ezil-billing-actions"><a class="ezil-settings-btn" data-action="ezil-id" href="${encode(href)}">Sign in with EZiL ID</a></div>` : '' });
    }
    if ( enrollment === 'activating' ) {
        return meterRowV3({ role: 'meter-ai', id: 'ai-credits', label: 'AI credits', value: 'Setting up your AI credits…',
            notes: [waiting ? `${whole(waiting)} credits are added when this finishes.` : ''] });
    }
    const grant = ai.grant && safeCount(ai.grant.amount) && ai.grant.amount > 0 ? ai.grant : null;
    const included = ai.included && safeCount(ai.included.remaining) && safeCount(ai.included.granted) ? ai.included : null;
    const pending = ai.pendingFromRenewal && safeCount(ai.pendingFromRenewal.credits) && ai.pendingFromRenewal.credits > 0 ? ai.pendingFromRenewal : null;
    // Round 4 D17: in the payment grace this period's plan credits arrive with the payment — never "0 of 0 left".
    const awaitingPayment = plan?.paymentIssue != null && included !== null && included.granted === 0 && pending !== null;
    const tone = ai.state === 'exhausted' ? 'danger' : ai.state === 'low' ? 'warn' : 'ok';
    const state = { low: '! Running low', exhausted: '■ No credits left' }[ai.state] ?? '';
    const purchased = ai.purchased && safeCount(ai.purchased.remaining) ? ai.purchased : null;
    const starter = ai.starter && safeCount(ai.starter.remaining) ? ai.starter : null;
    // Round 6 (R4-05): credits kept from an earlier plan or period (a cancel keeps them until they expire), named and dated.
    const previous = ai.previous && safeCount(ai.previous.remaining) && ai.previous.remaining > 0 && Number.isFinite(Date.parse(ai.previous.expiresAt ?? '')) ? ai.previous : null;
    let value, percent = null, split = null;
    if ( awaitingPayment ) value = `0 of ${whole(pending.credits)} this period`;
    else if ( included && included.granted > 0 ) { value = `${whole(included.remaining)} of ${whole(included.granted)} left`; percent = percentOf(included.remaining, included.granted); }
    else if ( typeof ai.balance === 'number' && Number.isFinite(ai.balance) && ai.balance >= 0 ) {
        const balance = Math.floor(ai.balance);
        if ( grant && balance <= grant.amount ) { value = `${whole(balance)} of ${whole(grant.amount)} left`; percent = percentOf(balance, grant.amount); }
        else {
            // Round 6 (R1-10): above the grant there is no denominator, so no bar (it was full by construction).
            value = `${whole(balance)} left`;
            // ADV-1: the split comes only from the server's breakdown, and only when it adds up to
            // the balance. Never balance minus grant (that assumes the grant is unspent).
            if ( grant && purchased && purchased.remaining > 0 && (starter?.remaining ?? 0) + purchased.remaining + (previous?.remaining ?? 0) === balance ) split = { plan: starter?.remaining ?? 0, extra: purchased.remaining };
        }
    } else value = '—';
    const extras = [
        purchased && purchased.remaining > 0 ? split ? `Extra credits expire ${dateLabel(purchased.expiresAt, true)}` : `+ ${whole(purchased.remaining)} purchased · expire ${dateLabel(purchased.expiresAt, true)}` : '',
        starter && starter.remaining > 0 && ! split ? `${whole(starter.remaining)} starter credits left` : '',
        // Review: on a paid plan these may be this plan's last period or a cancelled earlier plan's, so the label fits both.
        previous ? `${whole(previous.remaining)} from ${plan?.sku === 'free_v3' ? 'your previous plan' : 'an earlier billing period'} · expire ${dateLabel(previous.expiresAt, true)}` : '',
        pending && ! awaitingPayment ? `${whole(pending.credits)} more from ${dateLabel(pending.at)}` : '',
    ];
    // Round 6 (R1-10): the one-time starter grant is said once, by the starter line when the server reports it.
    // Review: and never beside a balance it does not explain (above the grant, or credits from a previous plan),
    // where "100 credits to start" would read as part of a balance that no longer holds them.
    const beyondStarter = previous !== null || (grant !== null && typeof ai.balance === 'number' && Math.floor(ai.balance) > grant.amount);
    const grantNote = grant ? grant.per === 'period' ? `Your plan adds ${whole(grant.amount)} credits each month.`
        : (starter && starter.remaining > 0) || beyondStarter ? '' : `${whole(grant.amount)} credits to start.` : '';
    split = split ? `${whole(split.plan)} from your plan + ${whole(split.extra)} extra` : '';
    return meterRowV3({ role: 'meter-ai', id: 'ai-credits', label: 'AI credits', value, percent, tone, notes: [
        state, awaitingPayment ? 'Added once your payment goes through.' : '', split, value === '—' ? "We couldn't read your credits. Try again later." : '',
        // The usage card's header already names the period's reset date; repeat it only when credits reset on another day.
        ...extras, included && dateLabel(included.periodEnd, true) !== dateLabel(summary.fairUse?.resetsAt, true) ? `Resets ${dateLabel(included.periodEnd)}.` : grantNote,
        'Used by EZiL AI in Code and Chat.',
    ] });
}

const GIB = 2 ** 30;
/** Disk bytes in the disk's own unit (GiB, shown as "GB" like the disk size itself). */
const diskText = bytes => bytes >= GIB ? `${(bytes / GIB).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`
    : `${Math.floor(bytes / 2 ** 20).toLocaleString('en-US')} MB`;
/** Storage (D3): the computer's REAL disk; a used figure and a bar only once something measures it. */
function storageMeterV3 ({ computer }) {
    const disk = computer.disk;
    const gb = Number.isFinite(disk?.provisionedGiB) && disk.provisionedGiB > 0 ? disk.provisionedGiB : null;
    const usedBytes = typeof disk?.usedBytes === 'string' && /^\d+$/.test(disk.usedBytes) ? Number(disk.usedBytes) : null;
    if ( gb === null ) return meterRowV3({ role: 'meter-storage', label: 'Storage', value: 'Files saved', notes: ['Your files are saved between sessions.'] });
    if ( usedBytes === null ) return meterRowV3({ role: 'meter-storage', label: 'Storage', value: `${gb} GB`, notes: [`${gb} GB disk for your projects`] });
    // ADV-2: the disk is provisionedGiB × 2^30 bytes (the server's cap), so used and left use the same unit.
    const capBytes = gb * GIB;
    const leftBytes = Math.max(0, capBytes - usedBytes);
    const percent = percentOf(leftBytes, capBytes);
    return meterRowV3({ role: 'meter-storage', label: 'Storage', value: `${diskText(leftBytes)} left`, percent,
        tone: percent === 0 ? 'danger' : percent <= 20 ? 'warn' : 'ok', notes: [`${diskText(usedBytes)} used of your ${gb} GB disk`] });
}

/** The one state banner, or null. It carries the page's only primary in its state. */
function bannerV3 (summary) {
    const { plan, actions, fairUse } = summary;
    const standing = standingOf(summary);
    const banner = (role, tone, title, body, cta, alert = false) => ({ primary: !! cta, html: `<aside class="ezil-billing-banner is-${tone}" data-role="${role}" role="${alert ? 'alert' : 'status'}">
        <div><p class="ezil-billing-banner-title">${encode(title)}</p>${body ? paragraph(body) : ''}</div>${cta}</aside>` });
    if ( plan.paymentIssue === 'requires_action' ) {
        return banner('payment-banner', 'warn', 'Your bank needs you to confirm a payment.', '',
            '<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open-invoice" data-kind="subscription">Confirm payment</button>');
    }
    // ADV-3: the server reports every incomplete subscription as payment_failed (summary.ts); the plan
    // never started, so the ask is to finish that payment, not to keep a plan.
    if ( plan.status === 'incomplete' && standing !== 'grace' ) {
        const to = offerFor(summary, plan.pendingUpgrade?.toSku ?? plan.sku)?.name ?? plan.name;
        const expires = plan.pendingUpgrade?.expiresAt ? ` This link expires ${dateLabel(plan.pendingUpgrade.expiresAt)}.` : '';
        return banner('upgrade-pending', 'warn', `${to} starts once payment is confirmed.${expires}`, '',
            '<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open-invoice" data-kind="subscription">Finish payment</button>');
    }
    if ( standing === 'grace' || plan.paymentIssue === 'payment_failed' ) {
        return banner(standing === 'grace' ? 'payment-grace' : 'payment-banner', 'danger', "Your last payment didn't go through",
            standing === 'grace' ? standingCopy('grace', summary) : `Update your payment method to keep ${plan.name} and your computer.`,
            actions.portal ? actionHtml('portal', 'Update payment method', true) : '', true);
    }
    if ( plan.pendingUpgrade || plan.status === 'upgrade_pending' || plan.status === 'incomplete' ) {
        const to = offerFor(summary, plan.pendingUpgrade?.toSku)?.name ?? 'Premium';
        const expires = plan.pendingUpgrade?.expiresAt ? ` This link expires ${dateLabel(plan.pendingUpgrade.expiresAt)}.` : '';
        return banner('upgrade-pending', 'warn', `${to} starts once payment is confirmed.${expires}`, '',
            '<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open-invoice" data-kind="subscription">Finish payment</button>');
    }
    if ( plan.status === 'cancels' || standing === 'plan_ending' ) {
        const on = plan.planEndsAt ?? plan.cancelsAt;
        return banner(standing === 'plan_ending' ? 'plan-ending' : 'cancels-banner', 'warn', `Your plan ends on ${dateLabel(on, true)}`,
            standing === 'plan_ending' ? standingCopy('plan_ending', summary) : `You keep ${plan.name} and your computer until then. After that you move to Free. Your files are kept.`,
            actions.cancel ? actionHtml('resume', 'Resume plan', true) : '');
    }
    if ( fairUse.status === 'paused' ) {
        return banner('fair-use-paused', 'danger', 'Computer time is used up.', `You can start your computer again on ${dateLabel(fairUse.resetsAt, true)}.`, upgradeCta(summary, true));
    }
    return null;
}

/** The plan's upgrade CTA: Free → Standard (checkout), Standard → Premium (upgrade). */
function upgradeCta (summary, primary) {
    const { plan, actions } = summary;
    if ( (plan.sku === 'free_v3' || standingOf(summary) === 'files_on_aws') && actions.checkout && offerFor(summary, 'standard_monthly_v3') ) return actionHtml('checkout', 'Upgrade to Standard', primary, 'standard_monthly_v3');
    if ( plan.sku === 'standard_monthly_v3' && actions.upgrade ) return actionHtml('upgrade', 'Upgrade to Premium', primary);
    return '';
}

/** The current-plan card's primary when there is no banner. Premium: Add AI credits only when low or used up. */
function planPrimaryV3 (summary) {
    const upgrade = upgradeCta(summary, true);
    if ( upgrade ) return upgrade;
    const { plan, ai } = summary;
    if ( plan.sku === 'premium_monthly_v3' && ['low', 'exhausted'].includes(ai.state) && topupPacks(summary).length ) {
        return '<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open-topup">Add AI credits</button>';
    }
    return '';
}

const topupPacks = ({ ai, actions, catalog }) => (ai.enrollment ?? 'enrolled') === 'enrolled' && actions.topup === true ? catalog.packs ?? [] : [];

function yourComputerV3 (summary) {
    const { computer, plan } = summary;
    const standing = standingOf(summary);
    const free = plan.sku === 'free_v3' || standing === 'free' || standing === 'files_on_aws';
    const hours = computer.sessionMaxSeconds === null ? null : computer.sessionMaxSeconds / 3600;
    const gb = Number.isFinite(computer.disk?.provisionedGiB) && computer.disk.provisionedGiB > 0 ? computer.disk.provisionedGiB : null;
    // Round 6 (R1-11): one provider string, "AWS (India)", on every tab; the Free limits are the session line below.
    const held = standing === 'files_on_aws';
    // Round 6 (R4-02): a held 4 or 8 vCPU computer is shown at its own size, and says it can't open on Free.
    const closed = held ? heldClosedSize(computer) : null;
    const where = free && ! held ? 'Cloudflare' : 'AWS (India)';
    const size = ! closed ? `${computer.vcpu} vCPU · ${computer.memoryGiB} GB memory`
        : `${closed.vcpu} vCPU${Number.isFinite(closed.memoryGiB) && closed.memoryGiB > 0 ? ` · ${closed.memoryGiB} GB memory` : ''}`;
    const parts = [size, gb ? `${gb} GB disk` : 'files saved between sessions', where];
    return `<div class="ezil-billing-computer" data-role="your-computer">
        <p><span class="ezil-billing-note">Your computer</span> <strong>${encode(parts.join(' · '))}</strong></p>
        ${paragraph(closed ? "Can't open on the Free plan at this size" : hours === null ? 'No session time limit' : `Sessions up to ${hours} hour${hours === 1 ? '' : 's'}${held ? ' on Free' : ''}`, 'ezil-billing-note')}
        ${linkAction('computer-tab', held ? 'Computer details ›' : 'Change configuration ›')}</div>`;
}

function currentPlanV3 (summary, banner) {
    const { plan } = summary;
    const standing = standingOf(summary);
    const status = { free: 'Free', active: 'Active', cancels: 'Ends soon', past_due: 'Past due', incomplete: 'Payment incomplete', upgrade_pending: 'Upgrade pending' }[plan.status] ?? 'Active';
    const offer = offerFor(summary, plan.sku);
    const price = plan.sku === 'free_v3' ? '$0' : offer ? `${dollars(offer.priceCents, { compact: true })} / month`
        : plan.renewal ? `${dollars(plan.renewal.amountCents, { compact: true })} / month` : '';
    const renewal = plan.sku === 'free_v3' ? 'Free · no card on file'
        : plan.renewal && ['active', 'upgrade_pending'].includes(plan.status) ? `Renews on ${dateLabel(plan.renewal.at, true)} for ${dollars(plan.renewal.amountCents, { compact: true })}.` : '';
    const primary = banner?.primary ? '' : planPrimaryV3(summary);
    return `<section class="ezil-billing-card ezil-billing-plan" data-role="plan-card" data-version="3" aria-label="Current plan">
        <div class="ezil-billing-plan-grid"><div>
            <div class="ezil-billing-plan-heading"><h4>${encode(plan.name)}</h4><span class="ezil-settings-pill" data-role="plan-status" data-status="${encode(plan.status)}">${encode(status)}</span></div>
            ${price ? paragraph(price, 'ezil-billing-plan-price') : ''}${renewal ? paragraph(renewal, 'ezil-billing-status') : ''}
            ${plan.scheduledChange ? paragraph(`Changes to ${offerFor(summary, plan.scheduledChange.toSku)?.name ?? 'Standard'} on ${dateLabel(plan.scheduledChange.effectiveAt)}.`, 'ezil-billing-status') : ''}
            ${standing === 'files_on_aws' ? `<p role="status" data-role="files-held">${encode(standingCopy('files_on_aws', summary))}</p>` : ''}
        </div><div class="ezil-billing-actions" data-role="plan-actions">${primary}</div></div>
        ${yourComputerV3(summary)}</section>`;
}

function usageCardV3 (summary, usage) {
    return `<section class="ezil-billing-section" data-role="billing-usage" aria-labelledby="billing-usage-heading">
        <div class="ezil-billing-section-head"><h3 id="billing-usage-heading">This period</h3><span class="ezil-billing-note">Resets ${encode(dateLabel(summary.fairUse.resetsAt, true))}</span></div>
        <div class="ezil-billing-card ezil-billing-usage-card" data-role="billing-meters">${timeV3Html(summary, usage)}${aiMeterV3(summary)}${storageMeterV3(summary)}</div></section>`;
}

function offerCardV3 (summary, offer) {
    const { plan, actions, computer } = summary;
    const currentRank = PLAN_RANK[standingOf(summary) === 'files_on_aws' ? 'free_v3' : plan.sku];
    const rank = PLAN_RANK[offer.sku];
    const current = currentRank === rank;
    const configs = (offer.machineChoice ?? []).map(code => {
        const size = sizeInfoV3(summary, code);
        if ( ! size ) return '';
        const time = code === 'free-cf' ? `sessions up to ${offer.sessionMaxSeconds / 3600} hour${offer.sessionMaxSeconds === 3600 ? '' : 's'}`
            : `about ${whole(offer.fairUseHours / size.weight)} hours a month`;
        const now = current && code === computer.size ? ' <span class="ezil-billing-now">Now</span>' : '';
        return `<li data-size="${encode(code)}"><strong>${encode(`${size.vcpu} vCPU · ${size.memoryGiB} GB`)}</strong>${now} <span>${encode(time.charAt(0).toUpperCase() + time.slice(1))}</span></li>`;
    }).join('');
    // The current card never contradicts "Your computer": a disk made smaller than today's plan disk says so.
    const realDisk = Number.isFinite(computer.disk?.provisionedGiB) && computer.disk.provisionedGiB > 0 ? computer.disk.provisionedGiB : null;
    // Hotfix r5 (ACCEPT #4): nor does another card promise a bigger disk to a computer that keeps its own.
    const keepsOwn = ! current && realDisk !== null && computer.disk?.growsOnSwitch !== true && offer.storageGiB > realDisk;
    const storage = Number.isSafeInteger(offer.storageGiB) && offer.storageGiB > 0
        ? `${offer.storageGiB} GB disk${current && realDisk !== null && realDisk !== offer.storageGiB ? ` · yours has ${realDisk} GB` : keepsOwn ? ' for new computers' : ''}` : 'Files saved between sessions';
    const credits = offer.aiCredits?.amount ? `${whole(offer.aiCredits.amount)} AI credits ${offer.aiCredits.per === 'once' ? 'to start' : 'every month'}` : '';
    let cta = '';
    if ( current ) cta = '<span class="ezil-billing-current" data-role="current-plan">Current plan</span>';
    else if ( plan.scheduledChange?.toSku === offer.sku ) cta = paragraph(`Starts ${dateLabel(plan.scheduledChange.effectiveAt, true)}`, 'ezil-billing-note');
    else if ( currentRank !== undefined && rank > currentRank ) {
        if ( actions.checkout && currentRank === 0 ) cta = actionHtml('checkout', `Choose ${offer.name}`, false, offer.sku);
        else if ( actions.upgrade && ! plan.pendingUpgrade && offer.sku === 'premium_monthly_v3' ) cta = actionHtml('upgrade', 'Upgrade');
    } else if ( currentRank !== undefined && rank < currentRank && rank > 0 && actions.downgrade ) cta = linkAction('downgrade', `Switch to ${offer.name}`);
    return `<article class="ezil-billing-card ezil-billing-offer${current ? ' is-current' : ''}" data-role="plan-offer" data-sku="${encode(offer.sku)}"${current ? ' data-current' : ''}>
        <h4>${encode(offer.name)}</h4>
        <p class="ezil-billing-offer-price"><strong>${encode(dollars(offer.priceCents, { compact: true }))}</strong><span>${offer.priceCents ? ' / month' : ''}</span></p>
        ${paragraph(offer.tagline, 'ezil-billing-note')}
        <ul class="ezil-billing-offer-configs">${configs}</ul>
        <ul class="ezil-billing-offer-facts"><li>${encode(storage)}</li>${credits ? `<li>${encode(credits)}</li>` : ''}</ul>
        <div class="ezil-billing-offer-cta">${cta}</div></article>`;
}

function plansV3 (summary) {
    const offers = [...summary.catalog.offers].filter(offer => offer.sku in PLAN_RANK).sort((a, b) => PLAN_RANK[a.sku] - PLAN_RANK[b.sku]);
    const disk = summary.computer.disk;
    const keeps = Number.isFinite(disk?.provisionedGiB) && disk.provisionedGiB > 0 && disk.growsOnSwitch !== true
        && offers.some(offer => Number.isSafeInteger(offer.storageGiB) && offer.storageGiB > disk.provisionedGiB)
        ? ` Your computer keeps its ${disk.provisionedGiB} GB disk when you change plan.` : '';
    return `<section class="ezil-billing-section" data-role="plans" aria-labelledby="billing-plans-heading">
        <div class="ezil-billing-section-head"><h3 id="billing-plans-heading">Plans</h3></div>
        <div class="ezil-billing-offers">${offers.map(offer => offerCardV3(summary, offer)).join('')}</div>
        ${paragraph(`Storage is the disk on your computer; some space is used by the system.${keeps}`, 'ezil-billing-note')}</section>`;
}

function topupV3 (summary) {
    const packs = topupPacks(summary);
    if ( ! packs.length ) return '';
    return `<details class="ezil-billing-card ezil-billing-topup" data-role="ai-topup"><summary>Add AI credits</summary>
        <div class="ezil-billing-actions">${packs.map(pack => actionHtml('topup', `Add ${whole(pack.aiCredits)} credits — ${dollars(pack.totalCents, { compact: true })}${pack.discountPercent ? ` (save ${pack.discountPercent}%)` : ''}`, false, pack.sku)).join('')}</div></details>`;
}

export function summaryV3Html (summary, usage = null) {
    const { plan, actions } = summary;
    const banner = bannerV3(summary);
    return `<header class="ezil-billing-header"><div><h3>Billing</h3><p class="ezil-settings-lead">Your plan, usage and payments.</p></div>
        ${actions.portal ? `<div class="ezil-billing-actions">${linkAction('portal', 'Manage payment')}</div>` : ''}</header>
        ${banner?.html ?? ''}
        ${currentPlanV3(summary, banner)}
        ${usageCardV3(summary, usage)}
        ${plansV3(summary)}
        ${topupV3(summary)}
        <p class="ezil-billing-action-error" data-role="billing-action-error" role="alert"></p>
        <section class="ezil-billing-invoices" data-role="invoices" aria-label="Invoices"><h3 tabindex="-1">Invoices</h3>
            <div data-role="invoice-rows" aria-busy="true"><p class="ezil-billing-note">Loading invoices…</p></div></section>
        <div class="ezil-billing-v3-footer"><p class="ezil-billing-note">Prices before tax.</p>
            ${actions.cancel && plan.status !== 'cancels' && standingOf(summary) !== 'plan_ending' ? linkAction('cancel', 'Cancel plan') : ''}</div>`;
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
    const usage = result?.ok && result.data?.enabled === true && result.data.period ? result.data : false;
    $win.find('[data-role="meter-time"]').replaceWith(timeV3Html(state.summary, usage));
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
            : action === 'checkout' ? upgradeSheetOpener({ ...options, sku, offer, sizes: summary.catalog.sizes, summary })
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
    /** The shared sheet-frame confirmation; Settings → Computer reaches it through this module (D6). */
    confirmSheet: openConfirmSheet,
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
            else if ( action === 'open-topup' ) {
                // Premium's "Add AI credits" opens the top-up disclosure; the pack rows stay secondary.
                const details = $pane.find('[data-role="ai-topup"]').get(0);
                if ( details ) {
                    details.open = true;
                    details.scrollIntoView?.({ block: 'nearest' });
                    details.querySelector('summary')?.focus();
                }
            }
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
            // `/app/settings?tab=billing` is the same link as `/os?settings=billing`
            // (docs/APP-ROUTES.md); read both through the boot's own spelling.
            const params = new URLSearchParams(settingsAliasSearch(window.location));
            if ( ! state.autoOpened && params.get('settings') === 'billing' && params.get('section') === 'ai-credits' ) state.openSection = 'ai-credits';
            void load($win, state);
        }
    },
    onDeactivate ($win) {
        const state = $win && windows.get($win.get(0));
        if ( state ) { state.active = false; state.request++; state.loading = false; stopCountdown(state); }
    },
};

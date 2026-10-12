// tabs/billing.js — EZiL-authored. Not Puter code.
// The server owns balances and action availability. Reopening this pane asks
// for fresh usage; a failed invoice request must not hide those allowances.
import TabAccount from './account.js';
import { payload as bootPayload } from '../../../session.js';
import { isNative } from '../../../native-runtime.js';
import trpc from '../trpc.js';
import { openUpgradeSheet } from '../upgrade-sheet.js';

const BILLING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/></svg>';
const STATES = new Set(['ok', 'low', 'exhausted', 'over_cap', 'unavailable']);
const ATTENTION = new Set(['low', 'exhausted', 'over_cap']);
const windows = new WeakMap();
let upgradeSheetOpener = openUpgradeSheet;

/** Tests replace the payment surface while retaining the real tab wiring. */
export function setUpgradeSheetOpener (fn) {
    upgradeSheetOpener = fn;
}

function dateLabel (iso, year = false) {
    const time = Date.parse(iso ?? '');
    return Number.isFinite(time)
        ? new Date(time).toLocaleDateString('en-US', { ...(year ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', timeZone: 'UTC' })
        : '—';
}

/** Integer arithmetic preserves wire amounts above Number's exact range. */
function dollars (value, compact = false) {
    const cents = BigInt(value);
    const sign = cents < 0n ? '-' : '';
    const amount = cents < 0n ? -cents : cents;
    return `${sign}$${amount / 100n}${compact && amount % 100n === 0n ? '' : `.${String(amount % 100n).padStart(2, '0')}`}`;
}

function hours (seconds) {
    const minutes = Math.floor(Math.max(0, seconds) / 60);
    return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes / 60} h`;
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

function canUpgrade (summary) {
    return summary?.actions.checkout === true && (summary.plan.id === 'free' || summary.plan.status === 'past_due');
}

function actionHtml (action, label, primary = false) {
    return `<button type="button" class="ezil-settings-btn${primary ? ' ezil-settings-btn-primary' : ''}" data-action="${action}">${label}</button>`;
}

function meterHtml (id, label, state, usage, allowance, value, timing, note) {
    const safeState = STATES.has(state) ? state : 'unavailable';
    const accessible = `${usage} ${allowance}`;
    return `<section class="ezil-billing-meter is-${safeState}" data-meter="${id}" aria-label="${label}">
        <h4>${label}</h4>
        <p class="ezil-billing-usage">${html_encode(usage)}</p>
        <p class="ezil-billing-allowance">${html_encode(allowance)}</p>
        ${safeState === 'unavailable' ? '' : `<div class="ezil-billing-progress" role="progressbar" aria-label="${label}"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${html_encode(accessible)}">
            <span style="width: ${value}%"></span></div>`}
        <p class="ezil-billing-timing">${html_encode(timing)}</p>
        <p class="ezil-billing-note">${html_encode(note)}</p>
    </section>`;
}

function nudgeHtml (summary) {
    const { workspace, storage, ai } = summary.meters;
    const messages = [];
    if ( ATTENTION.has(workspace.state) ) messages.push(workspace.remainingSeconds > 0
        ? `${Math.ceil(workspace.remainingSeconds / 60)} minutes of workspace time left ${summary.plan.id === 'free' ? 'this month' : 'this period'}.`
        : 'Workspace time is used up for this period.');
    if ( ATTENTION.has(storage.state) ) messages.push(storage.state === 'over_cap'
        ? 'Saved storage is over your allowance.' : 'Saved storage is nearly full.');
    if ( ATTENTION.has(ai.state) ) messages.push(ai.state === 'low' ? 'AI credits are running low.' : 'AI credits are used up.');
    return messages.length ? `<aside class="ezil-billing-nudge" data-role="billing-nudge" role="status">
        <p>${html_encode(messages.join(' '))}</p>${canUpgrade(summary) ? actionHtml('checkout', 'Upgrade to Pro') : ''}</aside>` : '';
}

function summaryHtml (summary) {
    const { plan, meters: { workspace, storage, ai }, actions, catalog } = summary;
    const price = dollars(catalog.pro.unitAmountCents, true);
    const status = plan.status === 'past_due' ? 'Payment failed — update your card'
        : plan.status === 'cancels' ? `Ends ${dateLabel(plan.cancelsAt)}`
        : plan.status === 'active' ? `Renews ${dateLabel(plan.renewsAt)} · ${price}/month` : 'Free plan';
    const unavailable = ai.state === 'unavailable';
    const balance = BigInt(ai.trialMicro) + BigInt(ai.includedMicro) + BigInt(ai.purchasedMicro);
    // v1 has no AI spent total. Its bar expresses available balance, never
    // a fabricated percentage of usage; sub-cent balances round down.
    const aiUsage = unavailable ? 'Coming soon' : `${dollars(balance / 10_000n)} left`;
    return `<header class="ezil-billing-header">
            <div><h3>Plan &amp; usage</h3><p class="ezil-settings-lead">Your allowances and what renews when.</p></div>
            ${canUpgrade(summary) ? actionHtml('checkout', 'Upgrade to Pro', true)
                : actions.portal === true ? actionHtml('portal', 'Manage billing', true) : ''}
        </header>
        <section class="ezil-billing-card ezil-billing-plan${plan.id === 'pro' ? ' is-pro' : ''}" aria-label="Current plan">
            <div class="ezil-billing-plan-heading"><h4>${plan.id === 'pro' ? 'EZiL Pro' : 'EZiL Free'}</h4>
                <span class="ezil-settings-pill">Current</span><span class="ezil-billing-price">${plan.id === 'pro' ? `${price}/month` : '$0'}</span></div>
            <p>${html_encode(`${hours(workspace.allowanceSeconds)} workspace · ${gigabytes(storage.capBytes)} storage · ${plan.id === 'pro' ? '$3 AI credits/month' : '$0.50 AI trial'}`)}</p>
            <p class="ezil-billing-status">${html_encode(status)}</p>
            <p class="ezil-billing-note">USD · before applicable tax</p>
        </section>
        <div class="ezil-billing-meters">
            ${meterHtml('workspace', 'Workspace time', workspace.state, hours(workspace.usedSeconds), `of ${hours(workspace.allowanceSeconds)}`,
                percent(BigInt(Math.floor(workspace.usedSeconds)), BigInt(Math.floor(workspace.allowanceSeconds))),
                `Resets ${dateLabel(workspace.resetsAt)} (UTC)`, 'Counts while a computer is running. Computers stop after 10 minutes without activity.')}
            ${meterHtml('storage', 'Saved storage', storage.state, gigabytes(storage.usedBytes), `of ${gigabytes(storage.capBytes)}`,
                percent(BigInt(storage.usedBytes), BigInt(storage.capBytes)), updated(storage.measuredAt),
                "Saved project files across your computers — not the computer's working disk.")}
            ${meterHtml('ai', 'AI credits', ai.state, aiUsage,
                unavailable ? plan.id === 'pro' ? '$3 monthly credit ready' : '$0.50 trial ready' : 'Available balance',
                balance > 0n ? 100 : 0, unavailable ? 'AI assistant coming soon'
                    : ai.includedExpiresAt ? `Included credit expires ${dateLabel(ai.includedExpiresAt)}` : 'No included credit expiry.', '')}
        </div>
        ${nudgeHtml(summary)}
        ${actions.topup === true ? `<div class="ezil-billing-actions"><label class="ezil-billing-pack">AI credit pack
            <select data-role="billing-pack">${catalog.packs.map((pack, index) => `<option value="${index}">${html_encode(`${dollars(pack.creditCents)} credit + ${dollars(pack.serviceFeeCents)} service fee`)}</option>`).join('')}</select>
            </label>${actionHtml('topup', 'Add AI credits')}</div>` : ''}
        <p class="ezil-billing-action-error" data-role="billing-action-error" role="alert"></p>
        <section class="ezil-billing-invoices" data-role="invoices" aria-label="Invoices"><h3>Invoices</h3>
            <div data-role="invoice-rows" aria-busy="true"><p class="ezil-billing-note">Loading invoices…</p></div></section>`;
}

/** Only web URLs may leave the OS, including links supplied by invoice history. */
function webUrl (value) {
    const url = new URL(value);
    if ( ! ['https:', 'http:'].includes(url.protocol) ) throw new Error('invalid URL');
    return url.href;
}

function invoicesHtml (rows) {
    if ( rows.length === 0 ) return '<p class="ezil-billing-note" data-role="invoices-empty">No invoices yet.</p>';
    return `<ul class="ezil-billing-invoice-list">${[...rows].sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 12).map(row => {
        let url = '';
        try { url = webUrl(row.url); } catch { /* An unavailable link must not hide a receipt. */ }
        const description = row.description || row.number || 'EZiL Pro';
        const status = row.status.replaceAll('_', ' ');
        return `<li class="ezil-billing-invoice"><time datetime="${html_encode(row.created)}">${dateLabel(row.created, true)}</time>
            <span>${html_encode(description)}</span><span>${html_encode(dollars(row.amountPaidCents))}</span>
            <span class="ezil-billing-invoice-status">${html_encode(status.charAt(0).toUpperCase() + status.slice(1))}</span>
            ${url ? `<a href="${html_encode(url)}" target="_blank" rel="noopener" aria-label="${html_encode(`View invoice ${description} (opens in a new tab)`)}">View ↗</a>` : '<span class="ezil-billing-note">Link unavailable</span>'}</li>`;
    }).join('')}</ul>`;
}

function loadingHtml () {
    return `<header class="ezil-billing-header"><div><h3>Plan &amp; usage</h3><p class="ezil-settings-lead">Your allowances and what renews when.</p></div></header>
        <p role="status">Loading billing…</p><div class="ezil-billing-meters" aria-hidden="true">
        ${Array.from({ length: 3 }, () => '<div class="ezil-billing-meter ezil-billing-skeleton"><span></span><span></span><span></span></div>').join('')}</div>`;
}

async function load ($win, state) {
    if ( state.loading || state.pending || state.sheet ) return;
    state.loading = true;
    state.summary = null;
    const request = ++state.request;
    const $body = $win.find('[data-role="billing-body"]');
    $body.attr('aria-busy', 'true').html(loadingHtml());
    const history = trpc.query('billing.history').catch(() => ({ ok: false }));
    try {
        const result = await trpc.query('billing.summary');
        if ( ! $win.get(0).isConnected ) return;
        if ( ! result.ok ) throw new Error('summary failed');
        if ( result.data?.enabled === false ) {
            $body.html('<p>Billing isn\'t available yet.</p>');
        } else {
            $body.html(summaryHtml(result.data));
            state.summary = result.data;
        }
    } catch {
        $body.html('<div class="ezil-billing-card ezil-settings-error" role="alert">Couldn\'t load billing. Try again. <button type="button" class="ezil-settings-btn" data-action="retry">Retry</button></div>');
    } finally {
        state.loading = false;
        $body.attr('aria-busy', 'false');
    }
    if ( state.openUpgrade && ! state.autoOpened && canUpgrade(state.summary) ) {
        state.autoOpened = true;
        void act($win, state, 'checkout');
    }
    const result = await history;
    if ( request !== state.request || ! $win.get(0).isConnected ) return;
    const $rows = $body.find('[data-role="invoice-rows"]');
    try {
        if ( ! result.ok ) throw new Error('history failed');
        $rows.html(invoicesHtml(result.data));
    } catch {
        $rows.html('<p class="ezil-billing-note" role="status">Couldn\'t load invoices. <button type="button" class="ezil-settings-btn" data-action="retry">Retry</button></p>');
    }
    $rows.attr('aria-busy', 'false');
}

async function act ($win, state, action) {
    if ( state.pending || state.sheet || state.summary?.actions[action] !== true ) return;
    if ( action === 'checkout' && ! canUpgrade(state.summary) ) return;
    const $pane = $win.find('[data-pane="billing"]');
    const $error = $pane.find('[data-role="billing-action-error"]');
    state.pending = true;
    $pane.find('button, select').prop('disabled', true);
    $error.text('');
    try {
        if ( action === 'checkout' ) {
            const container = $win.find('.window-body').get(0);
            // Cancellation has no callback in the sheet port. Observe removal
            // so closing with Escape or × permits a fresh checkout next time.
            const observer = new MutationObserver(() => {
                if ( ! container.querySelector('[data-role="upgrade-sheet"]') ) {
                    state.sheet = null;
                    observer.disconnect();
                }
            });
            state.sheet = upgradeSheetOpener({ container, sku: 'pro_monthly_v1', trpc, onDone: () => {
                state.sheet = null;
                observer.disconnect();
                void load($win, state);
            } });
            observer.observe(container, { childList: true, subtree: true });
        } else {
            const sku = state.summary.catalog.packs[Number($pane.find('[data-role="billing-pack"]').val())]?.sku;
            const result = action === 'portal' ? await trpc.mutate('billing.portal') : await trpc.mutate('billing.createCheckout', { sku });
            if ( ! result.ok ) throw new Error('action failed');
            const url = webUrl(result.data.url);
            if ( $win.get(0).isConnected ) window.open(url, '_blank', 'noopener');
        }
    } catch {
        $error.text('Could not open billing. Try again.');
    } finally {
        state.pending = false;
        $pane.find('button, select').prop('disabled', false);
    }
}

export default {
    id: 'billing',
    label: 'Billing',
    icon: BILLING_ICON,

    available (ctx) {
        return ! isNative(ctx) && TabAccount.available(ctx)
            && (ctx?.payload?.features ?? bootPayload()?.features)?.billing === true;
    },

    html () {
        return `<div class="ezil-settings-billing"><div data-role="billing-body" aria-live="polite">${loadingHtml()}</div>
            <footer class="ezil-billing-footer"><a href="mailto:contact@ezil.work">Support</a>
                <a href="/refunds" target="_blank" rel="noopener">Refund policy</a>
                <a href="/pricing" target="_blank" rel="noopener">Plans</a></footer></div>`;
    },

    init ($win) {
        const state = { loading: false, pending: false, summary: null, sheet: null, request: 0, autoOpened: false, openUpgrade: false };
        windows.set($win.get(0), state);
        const $pane = $win.find('[data-pane="billing"]');
        $pane.on('click', '[data-action="retry"]', () => { void load($win, state); });
        $pane.on('click', '[data-action="checkout"], [data-action="portal"], [data-action="topup"]', function () {
            void act($win, state, this.dataset.action);
        });
    },

    onActivate ($win, ctx = {}) {
        const state = windows.get($win.get(0));
        if ( state ) {
            state.openUpgrade ||= ctx.openUpgrade === true;
            void load($win, state);
        }
    },
};

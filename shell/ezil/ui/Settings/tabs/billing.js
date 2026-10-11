// tabs/billing.js — EZiL-authored. Not Puter code.
// The server owns balances and action availability. This pane only presents
// the frozen billing contract; reopening it asks for a fresh summary.
import TabAccount from './account.js';
import { payload as bootPayload } from '../../../session.js';
import { isNative } from '../../../native-runtime.js';
import trpc from '../trpc.js';

const BILLING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/></svg>';
const STATES = new Set(['ok', 'low', 'exhausted', 'over_cap', 'unavailable']);
// A request from a closed window must never replace a reopened pane's state.
const windows = new WeakMap();

function dateLabel (iso) {
    const time = Date.parse(iso ?? '');
    return Number.isFinite(time)
        ? new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' UTC'
        : '—';
}

/** Keep decimal wire amounts exact, including balances above Number's limit. */
function dollars (cents) {
    const sign = cents < 0n ? '-' : '';
    const amount = cents < 0n ? -cents : cents;
    return `${sign}$${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

function gigabytes (bytes) {
    const tenths = (BigInt(bytes) + 50_000_000n) / 100_000_000n;
    return `${tenths / 10n}.${tenths % 10n} GB`;
}

function percent (used, cap) {
    if ( cap <= 0n ) return 0;
    return Number(used <= 0n ? 0n : used >= cap ? 100n : used * 100n / cap);
}

function meterHtml (id, label, state, usage, value, timing, note = '') {
    const safeState = STATES.has(state) ? state : 'unavailable';
    return `<section class="ezil-billing-card ezil-billing-meter is-${safeState}" data-meter="${id}">
        <h4>${html_encode(label)}</h4>
        <p class="ezil-billing-usage">${html_encode(usage)}</p>
        <div class="ezil-billing-progress" role="progressbar" aria-label="${html_encode(label)}"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}" aria-valuetext="${html_encode(usage)}">
            <span style="width: ${value}%"></span>
        </div>
        <p class="ezil-billing-timing">${html_encode(timing)}</p>
        ${note ? `<p class="ezil-billing-note">${html_encode(note)}</p>` : ''}
    </section>`;
}

function summaryHtml (summary) {
    const { plan, meters: { workspace, storage, ai }, actions, catalog } = summary;
    const status = plan.status === 'past_due' ? 'Payment failed — update your payment method to keep Pro'
        : plan.status === 'cancels' ? `Ends on ${dateLabel(plan.cancelsAt)}`
        : plan.status === 'active' ? `Renews on ${dateLabel(plan.renewsAt)}` : 'Free plan';
    const minutes = Math.floor(workspace.usedSeconds / 60);
    const reset = dateLabel(workspace.resetsAt);
    const aiUnavailable = ai.state === 'unavailable';
    const balance = BigInt(ai.trialMicro) + BigInt(ai.includedMicro) + BigInt(ai.purchasedMicro);
    // No AI allowance or spent total travels in v1. The bar reports whether
    // credit is available; its accessible value is the balance, not % spent.
    // Whole cents round down so the displayed balance never overstates credit.
    const aiUsage = aiUnavailable ? 'AI assistant coming soon' : `${dollars(balance / 10_000n)} left`;
    return `<section class="ezil-billing-card ezil-billing-plan">
            <h3>${plan.id === 'pro' ? 'EZiL Pro' : 'EZiL Free'}</h3>
            <p>${html_encode(status)}</p>
        </section>
        ${meterHtml('workspace', 'Workspace time', workspace.state,
            `${Math.floor(minutes / 60)} h ${minutes % 60} m of ${workspace.allowanceSeconds / 3600} h used · resets ${reset}`,
            percent(BigInt(Math.floor(workspace.usedSeconds)), BigInt(Math.floor(workspace.allowanceSeconds))),
            `Resets ${reset}`, 'Counts while a computer is running. Computers stop after 10 minutes without activity.')}
        ${meterHtml('storage', 'Saved storage', storage.state,
            `${gigabytes(storage.usedBytes)} of ${gigabytes(storage.capBytes)} used`,
            percent(BigInt(storage.usedBytes), BigInt(storage.capBytes)),
            storage.measuredAt ? `Measured ${dateLabel(storage.measuredAt)}` : 'Not measured yet.',
            "Saved project files across your computers — not the computer's working disk.")}
        ${meterHtml('ai', 'AI credits', ai.state, aiUsage, aiUnavailable || balance <= 0n ? 0 : 100,
            aiUnavailable ? 'Balances available when the AI assistant launches.'
                : ai.includedExpiresAt ? `Included credit expires ${dateLabel(ai.includedExpiresAt)}` : 'No included credit expiry.')}
        <div class="ezil-billing-actions">
            ${actions.checkout === true ? '<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="checkout">Upgrade to Pro — $20/month</button>' : ''}
            ${actions.portal === true ? '<button type="button" class="ezil-settings-btn" data-action="portal">Manage billing</button>' : ''}
            ${actions.topup === true ? `<label class="ezil-billing-pack">AI credit pack
                <select data-role="billing-pack">${catalog.packs.map((pack, index) => `<option value="${index}">${html_encode(`${dollars(BigInt(pack.creditCents))} credit + ${dollars(BigInt(pack.serviceFeeCents))} service fee`)}</option>`).join('')}</select>
                </label><button type="button" class="ezil-settings-btn" data-action="topup">Add AI credits</button>` : ''}
        </div>
        <p class="ezil-billing-note">Prices in USD, before applicable tax.</p>
        <p class="ezil-billing-action-error" data-role="billing-action-error" role="alert"></p>`;
}

async function load ($win, state) {
    if ( state.loading || state.pending ) return;
    state.loading = true;
    state.summary = null;
    const $body = $win.find('[data-role="billing-body"]');
    $body.attr('aria-busy', 'true').html('<div class="ezil-settings-loading" role="status">Loading billing…</div>');
    try {
        const result = await trpc.query('billing.summary');
        if ( ! result.ok ) throw new Error('summary failed');
        if ( result.data?.enabled === false ) {
            $body.html('<p>Billing isn\'t available yet.</p>');
        } else {
            $body.html(summaryHtml(result.data));
            state.summary = result.data;
        }
    } catch {
        $body.html('<div class="ezil-settings-error" role="alert">Couldn\'t load billing. Try again. <button type="button" class="ezil-settings-btn" data-action="retry">Retry</button></div>');
    } finally {
        state.loading = false;
        $body.attr('aria-busy', 'false');
    }
}

async function act ($win, state, action) {
    if ( state.pending || state.summary?.actions[action] !== true ) return;
    const $pane = $win.find('[data-pane="billing"]');
    const $error = $pane.find('[data-role="billing-action-error"]');
    const catalog = state.summary.catalog;
    const sku = action === 'checkout' ? catalog.pro.sku
        : catalog.packs[Number($pane.find('[data-role="billing-pack"]').val())]?.sku;
    state.pending = true;
    $pane.find('button, select').prop('disabled', true);
    $error.text('');
    try {
        const result = action === 'portal' ? await trpc.mutate('billing.portal')
            : await trpc.mutate('billing.createCheckout', { sku });
        if ( ! result.ok ) {
            $error.text(result.message || 'Could not open billing. Try again.');
            return;
        }
        const url = new URL(result.data.url, window.location.href);
        if ( ! ['https:', 'http:'].includes(url.protocol) ) throw new Error('invalid redirect');
        if ( $win.get(0).isConnected ) window.location.href = url.href;
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
        return `<div class="ezil-settings-billing">
            <h3>Billing</h3>
            <div data-role="billing-body" aria-live="polite"></div>
            <footer class="ezil-billing-footer">
                <a href="/pricing" target="_blank" rel="noopener">Plans</a>
                <a href="mailto:contact@ezil.work">Support</a>
                <a href="/refunds">Refunds</a>
            </footer>
        </div>`;
    },

    init ($win) {
        const state = { loading: false, pending: false, summary: null };
        windows.set($win.get(0), state);
        const $pane = $win.find('[data-pane="billing"]');
        $pane.on('click', '[data-action="retry"]', () => { void load($win, state); });
        $pane.on('click', '[data-action="checkout"], [data-action="portal"], [data-action="topup"]', function () {
            void act($win, state, this.dataset.action);
        });
    },

    onActivate ($win) {
        const state = windows.get($win.get(0));
        if ( state ) void load($win, state);
    },
};

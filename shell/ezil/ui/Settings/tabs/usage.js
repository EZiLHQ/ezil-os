// Authenticated observations. Durations and balances never advance on the client.
import trpc from '../trpc.js';
import session from '../../../session.js';
import { creditsLabel, hoursLeftLines } from '../billing-format.js';

const states = new WeakMap();
let active = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const count = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const seconds = value => {
    if (!count(value)) return 'Unavailable';
    if (value < 60) return `${Math.floor(value)} s`;
    const hours = Math.floor(value / 3600), minutes = Math.floor(value % 3600 / 60);
    return hours ? `${hours} h${minutes ? ` ${minutes} min` : ''}` : `${minutes} min`;
};
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const timestamp = (value, clock = false) => {
    if (!validDate(value)) return 'Unavailable';
    const options = clock ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' };
    return `<time datetime="${esc(value)}" title="${esc(new Date(value).toISOString())}">${esc(new Intl.DateTimeFormat(undefined, options).format(new Date(value)))}</time>`;
};
const byteCount = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const bytes = value => {
    if (!count(value)) return 'Unavailable';
    if (value < 1000000) return `${value.toLocaleString()} bytes`;
    const divisor = value < 1000000000 ? 1000000 : 1000000000;
    return `${(value / divisor).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${divisor === 1000000 ? 'MB' : 'GB'}`;
};
const row = (label, value) => `<div class="usage-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const duration = value => `<span${count(value) ? ` title="${esc(value)} seconds"` : ''}>${esc(seconds(value))}</span>`;
const ratio = (value, cap) => count(value) && count(cap) && cap > 0 ? Math.min(100, value / cap * 100) : null;
// Billing's existing /os deep links own plan changes and the AI credits flow.
/** The EZiL ID link (`actions.ezilId`): an http(s) URL or a same-site path, opened in this tab. */
const ezilIdHref = value => {
    if (typeof value !== 'string' || !value) return null;
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};
const billingLink = (label, action, primary = false, query = '') => `<a class="ezil-settings-btn${primary ? ' ezil-settings-btn-primary' : ''}" data-action="${action}" href="/os?settings=billing${query}">${esc(label)}</a>`;
const bar = (id, percent, text) => percent === null ? '' : `<div class="usage-capacity" role="progressbar" aria-labelledby="usage-${id}-label" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${esc(text)}"><span${percent > 0 ? ' class="usage-fill"' : ''} style="width:${percent}%"></span></div>`;
const meter = (id, label, value, percent, text, note, state, action = '') => `<section class="usage-section usage-${state}" data-usage="${id}" data-state="${state}" aria-labelledby="usage-${id}-label">
    <div class="usage-meter-heading"><h4 id="usage-${id}-label">${label}</h4><span class="usage-value">${value}</span></div>
    ${bar(id, percent, text)}<div class="usage-caption"><p class="usage-note">${note}</p>${action}</div></section>`;

export function usageHtml(data, summary = null, { stale = false } = {}) {
    if (data != null && data.enabled !== false && (data.enabled !== true || data.version !== 1 || !data.session || data.period?.unit !== 'standard_seconds' || !data.storage)) throw Error('Unsupported usage response');
    if (summary?.enabled !== true || summary.version !== 3) summary = null;
    const usage = data?.enabled === true ? data : null;
    const period = usage?.period ?? {}, current = usage?.session ?? {}, plan = summary?.plan, actions = summary?.actions ?? {};
    const resetsAt = validDate(period.resetsAt) ? period.resetsAt : summary?.fairUse?.resetsAt;
    // Round 5 (D6): every bar is what is LEFT. Time: the server's remaining over this period's allowance.
    const remainingSeconds = count(period.remainingStandardSeconds) ? period.remainingStandardSeconds
        : count(period.usedStandardSeconds) && count(period.allowanceStandardSeconds) ? Math.max(0, period.allowanceStandardSeconds - period.usedStandardSeconds) : null;
    const timeLeft = ratio(remainingSeconds, period.allowanceStandardSeconds);
    const timePercent = timeLeft === null ? null : Math.floor(timeLeft);
    const timeState = timePercent === null ? 'unavailable'
        : summary?.fairUse?.status === 'paused' || remainingSeconds === 0 ? 'danger'
        : summary?.fairUse?.status === 'near' ? 'warn' : 'ok';
    const paused = summary?.fairUse?.status === 'paused' || timeState === 'danger';
    const primary = plan?.status === 'past_due'
        ? actions.portal === true ? billingLink('Fix payment', 'usage-payment', true) : ''
        : plan?.sku === 'free_v3' && actions.checkout === true ? billingLink('Upgrade', 'usage-upgrade', true, '&amp;upgrade=pro')
        : plan?.sku === 'standard_monthly_v3' && actions.upgrade === true ? billingLink('Upgrade to Premium', 'usage-upgrade', true, '&amp;upgrade=premium') : '';
    const pill = plan?.status === 'past_due' ? 'Payment due' : plan?.status === 'cancels' ? `Ends ${timestamp(plan.cancelsAt)}` : plan?.status === 'upgrade_pending' ? 'Upgrade pending' : '';
    // Round 3 (D3): time left is hours at the CURRENT configuration (the server's
    // `remainingHoursAtCurrent`), never raw standard-seconds shown as hours.
    const choices = summary?.computer?.machineChoice ?? [];
    const weight = count(period.currentWeight) && period.currentWeight >= 1 ? period.currentWeight : 1;
    // An older server sends no current size: fall back to the plan's chosen size, then 2 vCPU (weight 1).
    const currentSize = period.currentSize ?? summary?.computer?.size ?? 'std-2';
    const hoursPeriod = Number.isSafeInteger(period.remainingHoursAtCurrent) ? { ...period, currentSize }
        : count(period.remainingStandardSeconds) ? { ...period, currentSize, remainingHoursAtCurrent: Math.floor(period.remainingStandardSeconds / weight / 3600) } : null;
    const lines = hoursLeftLines(hoursPeriod, choices);
    const lessThanHour = lines && hoursPeriod.remainingHoursAtCurrent === 0 && period.remainingStandardSeconds > 0;
    const left = !lines ? 'Time left unavailable' : lessThanHour ? lines.main.replace(/^About 0 hours left/, 'Less than an hour left') : lines.main;
    const timeNote = period.allowanceStandardSeconds === 0 ? 'No computer time included this period.'
        : timePercent === null ? "We couldn't read your usage. Try Refresh."
        : timeState === 'danger' ? '■ No computer time left · new sessions paused'
        : timeState === 'warn' ? `! Running low. When it runs out, this session ends and new sessions pause until ${timestamp(resetsAt)}.`
        : esc(lines?.equivalents ?? '');
    const ai = summary?.ai, grant = ai?.grant;
    // Round 5 D1: an account without EZiL ID has its credits parked; the server says so, never "Unavailable".
    const enrollment = ai ? ai.enrollment ?? 'enrolled' : null;
    const waiting = ai?.waiting && Number.isSafeInteger(ai.waiting.credits) && ai.waiting.credits > 0 ? ai.waiting.credits : null;
    const ezilHref = ezilIdHref(actions.ezilId);
    const included = ai?.included && Number.isSafeInteger(ai.included.remaining) && Number.isSafeInteger(ai.included.granted) && ai.included.granted > 0 ? ai.included : null;
    // Whole credits only (founder 2026-10-29): the label floors, and so does the number behind the bar.
    const balanceLabel = creditsLabel(ai?.balanceMicro, ai?.balance);
    const balance = included ? included.remaining : balanceLabel === 'Not reported' ? null : Number(balanceLabel.replace(/,/g, ''));
    const denominator = included ? included.granted : count(grant?.amount) && grant.amount > 0 ? grant.amount : null;
    const aboveGrant = !included && balance !== null && denominator !== null && balance > denominator;
    const aiPercent = aboveGrant ? 100 : balance === null || denominator === null ? null : Math.floor(ratio(balance, denominator));
    const aiState = enrollment && enrollment !== 'enrolled' ? 'pending' : balance === null ? 'unavailable' : balance === 0 || ai?.state === 'exhausted' ? 'danger'
        : ai?.state === 'low' ? 'warn' : 'ok';
    const grantLabel = denominator !== null ? creditsLabel(null, denominator) : null;
    // "Your plan adds N every month" only when this period's grant is not split out: right after an upgrade it was false.
    const grantNote = included ? `Resets ${timestamp(included.periodEnd)}` : grantLabel ? grant.per === 'period' ? `Your plan adds ${grantLabel} every month`
        : grant.per === 'once' ? `Includes ${grantLabel} one-time trial credits` : '' : '';
    const split = aboveGrant ? `${esc(grantLabel)} from your plan + ${esc(creditsLabel(null, balance - denominator))} extra` : '';
    const extras = [
        ai?.purchased && Number.isSafeInteger(ai.purchased.remaining) && ai.purchased.remaining > 0 ? `+ ${esc(creditsLabel(null, ai.purchased.remaining))} purchased · expire ${timestamp(ai.purchased.expiresAt)}` : '',
        ai?.starter && Number.isSafeInteger(ai.starter.remaining) && ai.starter.remaining > 0 ? `${esc(creditsLabel(null, ai.starter.remaining))} starter credits left` : '',
        ai?.pendingFromRenewal && Number.isSafeInteger(ai.pendingFromRenewal.credits) && ai.pendingFromRenewal.credits > 0 ? `${esc(creditsLabel(null, ai.pendingFromRenewal.credits))} more from ${timestamp(ai.pendingFromRenewal.at)}` : '',
    ].filter(Boolean);
    const aiNote = enrollment === 'needs_ezil_id' ? 'AI credits activate when you sign in with EZiL ID. Use the same email as this account.'
        : enrollment === 'activating' ? (waiting ? `${esc(creditsLabel(null, waiting))} credits are added when this finishes.` : '')
        : (status => [status, split, status ? '' : grantNote, ...extras])(aiState === 'unavailable' ? "We couldn't read your balance." : aiState === 'danger' ? '■ No credits left.' : aiState === 'warn' ? '! Running low' : '').filter(Boolean).join('<br>');
    const aiValue = enrollment === 'needs_ezil_id' ? waiting ? `${esc(creditsLabel(null, waiting))} credits waiting` : 'Not active yet'
        : enrollment === 'activating' ? 'Setting up your AI credits…'
        : balance === null ? 'Unavailable' : aboveGrant ? `${esc(balanceLabel)} left`
        : `${esc(included ? creditsLabel(null, included.remaining) : balanceLabel)}${grantLabel ? ` of ${esc(grantLabel)}` : ''} left`;
    const aiAction = enrollment === 'needs_ezil_id' ? ezilHref ? `<a class="ezil-settings-btn" data-action="ezil-id" href="${esc(ezilHref)}">Sign in with EZiL ID</a>` : ''
        : enrollment === 'enrolled' && actions.topup === true ? billingLink('Add credits', 'usage-add-credits', false, '&amp;section=ai-credits') : '';
    // Round 3 (D4): the provisioned disk; a used figure only when measured; Free shows no invented number.
    const storage = usage?.storage, samples = storage?.state === 'sampled' && Array.isArray(storage.samples) ? storage.samples : [];
    const disk = storage?.disk && typeof storage.disk === 'object' ? storage.disk : null;
    const diskGB = count(disk?.provisionedGiB) && disk.provisionedGiB > 0 ? disk.provisionedGiB : null;
    const sizes = samples.map(sample => byteCount(sample.bytes));
    const total = sizes.length && sizes.every(count) ? sizes.reduce((sum, size) => sum + size, 0) : null;
    const usedBytes = byteCount(disk?.usedBytes) ?? (count(total) ? total : null);
    // Round 5 (D6): the bar is the REAL disk left, only when both the disk and a used figure are known.
    // The catalog's storage cap (a 2 GB display constant) is never shown as a disk.
    const capBytes = diskGB ? diskGB * 1e9 : null;
    const leftBytes = usedBytes !== null && capBytes !== null ? Math.max(0, capBytes - usedBytes) : null;
    const storageLeft = ratio(leftBytes, capBytes);
    const storagePercent = storageLeft === null ? null : Math.floor(storageLeft);
    const storageState = storagePercent === null ? 'unavailable' : storagePercent === 0 ? 'danger' : storagePercent <= 20 ? 'warn' : 'ok';
    const measuredAt = samples.map(sample => sample.measuredAt).filter(validDate).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const freePlan = summary?.plan?.sku === 'free_v3';
    const storageValue = leftBytes !== null ? `${esc(bytes(leftBytes))} left`
        : diskGB ? `${diskGB} GB disk` : freePlan || (storage && storage.capBytes === null) ? 'Saved with your computer' : 'Not measured yet';
    const storageNote = storageState === 'danger' ? '■ Full. Delete files you no longer need.'
        : storageState === 'warn' ? '! Almost full. Delete files you no longer need.'
        : diskGB ? `${usedBytes !== null ? `${esc(bytes(usedBytes))} used of your ${diskGB} GB disk` : `${diskGB} GB disk for your projects`}${usedBytes !== null && measuredAt ? ` · measured ${timestamp(measuredAt)}` : ''}`
        : freePlan || (storage && storage.capBytes === null) ? 'Your files are saved between sessions.' : '';
    const sessionLine = !['recording', 'stale', 'ended'].includes(current.state) ? 'No session recorded yet.'
        : current.state === 'ended' ? `Last session: ${duration(current.elapsedSeconds)} · ended ${timestamp(current.endedAt)}`
        : current.state === 'stale' || stale ? 'Measuring this session…'
        : `This session: ${duration(current.elapsedSeconds)} · running${validDate(summary?.computer?.activeDeadline) ? ` · ends ${timestamp(summary.computer.activeDeadline, true)}` : ''}`;
    const weights = (summary?.computer?.machineChoice ?? []).filter(option => count(option.weight) && option.weight > 1 && count(option.vcpu));
    return `${data?.enabled === false ? '<p class="usage-note">Usage tracking is unavailable in this deployment.</p>' : ''}
    ${paused ? `<aside class="usage-banner"><strong>Computer time is used up</strong><p>You can't start a new session until ${timestamp(resetsAt)}.</p>${primary}</aside>` : ''}
    <header class="usage-plan"><div class="usage-plan-copy"><h4>${plan ? `${esc(plan.name)} plan` : 'Plan unavailable'}</h4>
        ${validDate(resetsAt) ? `<p class="usage-note">${paused ? 'Paused until' : 'Usage resets'} ${timestamp(resetsAt)}</p>` : ''}${pill ? `<span class="ezil-settings-pill">${pill}</span>` : ''}</div>
        <div class="usage-plan-actions">${paused ? '' : primary}${billingLink('Billing details ›', 'usage-billing')}</div></header>
    <div class="usage-meters">
        ${meter('compute', 'Computer time', timePercent === null ? 'Not measured' : esc(left), timePercent,
            `${left}.${lines?.equivalents ? ` ${lines.equivalents}` : ''}`, timeNote, timeState)}
        ${meter('ai', 'AI credits', aiValue, aiPercent, `${aboveGrant ? balanceLabel : included ? creditsLabel(null, included.remaining) : balanceLabel} credits left${included ? ` of ${creditsLabel(null, included.granted)} this period` : ''}.${aboveGrant ? ` ${split}.` : !included && grantNote ? ` ${grantNote.replace(/^Your plan/, 'Plan')}.` : ''}`, aiNote, aiState, aiAction)}
        ${meter('storage', 'Storage', storageValue, storagePercent,
            `${bytes(leftBytes)} left of ${diskGB} GB.`, storageNote, storageState)}
    </div>
    <p class="usage-session-line" data-usage="session">${sessionLine}</p>
    <div class="usage-details">
        <details data-usage-detail="period"><summary>How computer time works</summary><p class="usage-note">Time counts while your computer is running.</p>
            ${weights.map(option => `<p class="usage-note">${esc(option.vcpu)} vCPU counts ${esc(option.weight)} h for each hour it runs.</p>`).join('')}
            ${weights.length ? '<p class="usage-note">Bigger configurations use your monthly time sooner, so the hours left depend on the configuration you run.</p>' : ''}
            <p class="usage-note">Period: ${timestamp(period.startsAt)} – ${timestamp(resetsAt)}</p></details>
        <details data-usage-detail="storage"><summary>Storage details</summary><p class="usage-note">Storage is the disk on your computer; some space is used by the system. A used figure appears once it is measured.</p></details>
        <details data-usage-detail="session"><summary>Session details</summary><dl>${row('Started', timestamp(current.startedAt))}${row('Last update', timestamp(current.observedAt))}${current.endedAt ? row('Ended', timestamp(current.endedAt)) : ''}</dl></details>
    </div>`;
}

function stop(state) {
    if (!state) return;
    state.visible = false; state.generation++; clearTimeout(state.timer);
    document.removeEventListener('visibilitychange', state.visibility);
}
const scope = state => {
    const payload = session.payload();
    return { computerId: session.currentComputer()?.id ?? state.ctx?.computer?.id,
        ownerId: payload ? payload.user?.id : state.ctx?.payload?.user?.id };
};
const sameScope = (a, b) => a?.computerId === b?.computerId && a?.ownerId === b?.ownerId;
function paint(body, html) {
    const open = [...body.get(0).querySelectorAll('details[open]')].map(el => el.dataset.usageDetail);
    const focused = body.get(0).contains(document.activeElement) ? document.activeElement : null;
    const detail = focused?.closest('details')?.dataset.usageDetail, action = focused?.dataset.action;
    body.html(html);
    for (const el of body.get(0).querySelectorAll('details')) {
        el.open = open.includes(el.dataset.usageDetail);
        if (el.dataset.usageDetail === detail) el.querySelector('summary')?.focus();
    }
    if (action) [...body.get(0).querySelectorAll('[data-action]')].find(el => el.dataset.action === action)?.focus();
}
function freshness(value) {
    if (!validDate(value)) return 'Updated time unavailable';
    const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(value)) / 60000);
    const relative = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`;
    return `Updated <time datetime="${esc(value)}" title="${esc(new Date(value).toISOString())}">${relative}</time>`;
}
function announce(state, body) {
    const changes = [], next = {};
    for (const el of body.get(0).querySelectorAll('.usage-section')) {
        const id = el.dataset.usage, status = el.dataset.state;
        next[id] = status;
        if (state.meterStates?.[id] === status) continue;
        const message = {
            compute: { warn: 'Computer time: nearly used up.', danger: 'Computer time is used up. New sessions are paused.', ok: 'Computer time: within your allowance.' },
            ai: { warn: 'AI credits: running low.', danger: 'AI credits: no credits left.', ok: 'AI credits available.' },
            storage: { warn: 'Storage: almost full.', danger: 'Storage: full.', ok: 'Storage: within your limit.' },
        }[id]?.[status];
        if (message && (state.meterStates || status !== 'ok')) changes.push(message);
    }
    state.meterStates = next;
    if (changes.length) state.win.find('[data-role="usage-announcement"]').text(changes.join(' '));
}
const SUMMARY_MAX_AGE_MS = 5 * 60 * 1000;
async function load(state, manual = false) {
    if (!state.visible || document.hidden || !state.win.get(0).isConnected) return;
    clearTimeout(state.timer);
    const generation = ++state.generation, requested = scope(state);
    const body = state.win.find('[data-role="usage-body"]'), status = state.win.find('[data-role="usage-refresh-status"]');
    if (!sameScope(state.observedScope, requested)) {
        state.usage = null; state.summary = null; state.summaryAt = undefined; state.meterStates = null; state.observedScope = requested;
        body.html(usageHtml(null)); state.win.find('[data-role="usage-announcement"]').empty();
    }
    status.removeAttr('role').removeClass('usage-warning').text(state.usage ? 'Refreshing…' : 'Loading usage…');
    body.attr('aria-busy', 'true');
    if (state.usage?.session.state === 'recording') body.find('.usage-session-line').text('Measuring this session…');
    // billing.summary has side effects (Stripe renewal preview, Gateway balance read, free-credit enqueue):
    // read it on open, on manual Refresh, or when older than five minutes. The 30 s poll reads usage only.
    const summaryDue = manual || state.summaryAt === undefined || Date.now() - state.summaryAt > SUMMARY_MAX_AGE_MS;
    if (summaryDue) state.summaryAt = Date.now();
    const sources = summaryDue ? ['usage', 'summary'] : ['usage'];
    const pending = new Set(sources), failed = new Set();
    const currentRequest = () => {
        if (generation !== state.generation || !state.visible || document.hidden || !state.win.get(0).isConnected) return false;
        if (!sameScope(requested, scope(state))) { void load(state); return false; }
        return true;
    };
    await Promise.all(sources.map(async source => {
        let timeout;
        try {
            const result = await Promise.race([
                trpc.query(`billing.${source}`, source === 'usage' && requested.computerId ? { computerId: requested.computerId } : undefined),
                new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Timeout')), 15000); }),
            ]);
            if (!currentRequest()) return;
            if (!result.ok) throw Error('Unavailable');
            if (source === 'usage') {
                if (!result.data || (requested.computerId && result.data.session?.computerId && result.data.session.computerId !== requested.computerId)) throw Error('Usage unavailable');
                usageHtml(result.data);
            } else if (result.data?.enabled !== true || result.data.version !== 3) throw Error('Summary unavailable');
            state[source] = result.data;
        } catch {
            if (!currentRequest()) return;
            failed.add(source);
            if (source === 'summary') state.summary = null;
        } finally {
            clearTimeout(timeout);
            pending.delete(source);
        }
        if (!currentRequest()) return;
        paint(body, usageHtml(state.usage, state.summary, { stale: failed.has('usage') || pending.has('usage') }));
        if (!pending.size) {
            body.attr('aria-busy', 'false');
            status.toggleClass('usage-warning', failed.size > 0).html(failed.size
                ? state.usage ? `Couldn't refresh. Showing the last update from ${timestamp(state.usage.asOf, true)}.` : "Couldn't load usage. Try Refresh."
                : state.usage?.enabled === false ? 'Usage tracking is unavailable.' : freshness(state.usage?.asOf));
            if (manual) status.attr('role', failed.size ? 'alert' : 'status');
            announce(state, body);
            state.timer = setTimeout(() => { void load(state); }, 30000);
        }
    }));
}

export default {
    id: 'usage', label: 'Usage', icon: '<span aria-hidden="true">◷</span>',
    available: ctx => ctx?.desktopState?.provider !== 'native-macos' && Boolean(ctx?.payload?.user?.id ?? session.payload()?.user?.id),
    html: () => '<div class="ezil-settings-usage"><div class="usage-heading"><h3>Usage</h3><button type="button" class="ezil-settings-btn" data-action="refresh-usage">Refresh</button></div><p class="usage-refresh-status" data-role="usage-refresh-status"></p><p class="usage-announcement" data-role="usage-announcement" aria-live="polite" aria-atomic="true"></p><div data-role="usage-body"></div></div>',
    init(win, ctx) {
        const state = { win, ctx, generation: 0, visible: false, timer: null, usage: null, summary: null };
        state.visibility = () => { if (document.hidden) { state.generation++; clearTimeout(state.timer); } else void load(state); };
        states.set(win.get(0), state);
        win.on('click', '[data-action="refresh-usage"]', () => { void load(state, true); });
    },
    onActivate(win) {
        stop(active); active = states.get(win.get(0)); if (!active) return;
        active.visible = true;
        document.addEventListener('visibilitychange', active.visibility);
        void load(active);
    },
    onDeactivate() { stop(active); active = null; },
};

// Authenticated, read-only billing.usage observations. Never a client-side meter.
import trpc from '../trpc.js';
import session from '../../../session.js';

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
const timestamp = (value, compact = false) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Unavailable';
    const options = compact
        ? { month: 'short', day: 'numeric', year: 'numeric', timeZoneName: 'short' }
        : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
    return `<time datetime="${esc(value)}" title="${esc(new Date(value).toISOString())}">${esc(new Intl.DateTimeFormat(undefined, options).format(new Date(value)))}</time>`;
};
const bytes = value => {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return 'Unavailable';
    const size = Number(value);
    if (size < 1048576) return `${size.toLocaleString()} bytes`;
    const unit = size < 1073741824 ? 'MiB' : 'GiB';
    return `${(size / (unit === 'MiB' ? 1048576 : 1073741824)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
};
const row = (label, value) => `<div class="usage-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const duration = value => `<span${count(value) ? ` title="${esc(value)} seconds"` : ''}>${esc(seconds(value))}</span>`;

export function usageHtml(data) {
    if (data?.enabled === false) return '<p class="usage-empty">Usage tracking is unavailable in this deployment.</p>';
    if (data?.enabled !== true || data.version !== 1 || !data.session || data.period?.unit !== 'standard_seconds' || !data.storage) throw Error('Unsupported usage response');
    const current = data.session, period = data.period;
    const label = { recording: 'Meter recording', stale: 'Update delayed', ended: 'Session ended', unavailable: 'Unavailable' }[current.state] ?? 'Unavailable';
    const explanation = { recording: 'Server-recorded runtime, not connection health.', stale: 'Showing the last recorded runtime.', ended: 'Final recorded runtime for this session.', unavailable: 'No recorded session is available.' }[current.state] ?? 'No recorded session is available.';
    // V1 has no unlimited sentinel. Null/invalid caps are unknown, never zero or unlimited.
    const hasBar = count(period.usedStandardSeconds) && count(period.allowanceStandardSeconds) && period.allowanceStandardSeconds > 0;
    const percent = hasBar ? Math.min(100, period.usedStandardSeconds / period.allowanceStandardSeconds * 100) : null;
    const exceeded = hasBar && period.usedStandardSeconds > period.allowanceStandardSeconds;
    const bar = hasBar ? `<div class="usage-capacity${exceeded ? ' usage-capacity-full' : ''}" role="progressbar" aria-label="Compute allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${esc(seconds(period.usedStandardSeconds))} used of ${esc(seconds(period.allowanceStandardSeconds))} standard time"><span style="width:${percent}%"></span></div>`
        : `<p class="usage-note">${period.allowanceStandardSeconds === 0 ? 'No compute allowance in this period.' : 'Usage proportion unavailable.'}</p>`;
    const samples = data.storage.state === 'sampled' && Array.isArray(data.storage.samples) ? data.storage.samples : [];
    return `<section class="usage-section" data-usage="allowance" aria-label="Account compute allowance">
        <h4>Compute allowance <span class="usage-unit">Standard time</span></h4>
        <div class="usage-metrics"><div><span class="usage-label">Used</span><strong>${duration(period.usedStandardSeconds)}</strong></div><div><span class="usage-label">Remaining</span><strong>${duration(period.remainingStandardSeconds)}</strong></div></div>
        ${bar}<div class="usage-capacity-caption"><span>Included ${duration(period.allowanceStandardSeconds)}</span><span>Resets ${timestamp(period.resetsAt, true)}</span></div>
        ${exceeded ? '<p class="usage-warning">Recorded usage exceeds this period’s allowance.</p>' : ''}
        <details data-usage-detail="period"><summary>How standard time works</summary><p class="usage-note">Weighted compute time: larger computers use more per hour. Separate from session runtime and AI credits.</p><dl>${row('Period starts', timestamp(period.startsAt))}${row('Resets', timestamp(period.resetsAt))}</dl></details>
    </section>
    <section class="usage-section" data-usage="session" aria-label="Selected computer session">
        <h4>Computer session</h4><div class="usage-session-line"><strong class="usage-runtime">${current.state === 'unavailable' || !['recording', 'stale', 'ended'].includes(current.state) ? 'Unavailable' : duration(current.elapsedSeconds)}</strong><span class="usage-meter ${current.state === 'stale' ? 'usage-warning' : ''}">${label}</span></div>
        <p class="usage-note usage-session-note">${explanation}</p>
        <details data-usage-detail="session"><summary>Session timestamps</summary><dl>${row('Started', timestamp(current.startedAt))}${row('Last observed', timestamp(current.observedAt))}${current.endedAt ? row('Ended', timestamp(current.endedAt)) : ''}</dl><p class="usage-note">A recording meter does not confirm that Browser or Code is connected.</p></details>
    </section>
    <section class="usage-section" data-usage="secondary" aria-label="Storage and network">
        <dl>${row('Saved storage', '<span>Unavailable</span>')}${row('Storage allowance', esc(bytes(data.storage.capBytes)))}${row('Network transfer', 'Not measured')}</dl>
        <details data-usage-detail="storage"><summary>Storage measurements${samples.length ? ` (${samples.length})` : ''}</summary><p class="usage-note">Current total unavailable. Historical samples may cover only part of your storage.</p>${samples.length ? `<dl>${samples.map(sample => row(`Computer ${sample.computerId}`, `${esc(bytes(sample.bytes))}<br><span class="usage-note">Sampled ${timestamp(sample.measuredAt)}</span>`)).join('')}</dl>` : '<p class="usage-note">No storage measurements available.</p>'}<p class="usage-note">Network transfer is not measured.</p></details>
    </section><p class="usage-updated">Updated ${timestamp(data.asOf)}</p>`;
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
    const focused = body.get(0).contains(document.activeElement) ? document.activeElement.closest('details')?.dataset.usageDetail : null;
    body.html(html);
    for (const el of body.get(0).querySelectorAll('details')) {
        el.open = open.includes(el.dataset.usageDetail);
        if (el.dataset.usageDetail === focused) el.querySelector('summary')?.focus();
    }
}
async function load(state, manual = false) {
    if (!state.visible || document.hidden || !state.win.get(0).isConnected) return;
    clearTimeout(state.timer);
    const generation = ++state.generation, requested = scope(state);
    const body = state.win.find('[data-role="usage-body"]'), status = state.win.find('[data-role="usage-refresh-status"]');
    if (!sameScope(state.observedScope, requested)) { body.empty(); state.hasObservation = false; }
    status.attr('role', manual ? 'status' : null).removeClass('usage-warning').text(state.hasObservation ? 'Refreshing…' : 'Loading usage…');
    body.attr('aria-busy', 'true');
    if (state.hasObservation) {
        body.find('.usage-meter').text('Last recorded');
        body.find('.usage-session-note').text('Checking for updated usage.');
    }
    let timeout;
    try {
        const result = await Promise.race([
            trpc.query('billing.usage', requested.computerId ? { computerId: requested.computerId } : undefined),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Timeout')), 15000); }),
        ]);
        if (generation !== state.generation || !state.visible || !state.win.get(0).isConnected) return;
        if (!sameScope(requested, scope(state))) { void load(state); return; }
        if (!result.ok || (requested.computerId && result.data?.session?.computerId && result.data.session.computerId !== requested.computerId)) throw Error('Usage unavailable');
        const html = usageHtml(result.data);
        paint(body, html); state.hasObservation = true; state.observedScope = requested;
        status.text(manual ? 'Updated · refreshes every 30 s while visible' : 'Refreshes every 30 s while visible').removeClass('usage-warning');
    } catch {
        if (generation !== state.generation || !state.visible || !state.win.get(0).isConnected) return;
        if (!sameScope(requested, scope(state))) { void load(state); return; }
        body.find('.usage-meter').text('Last recorded · update failed').addClass('usage-warning');
        body.find('.usage-session-note').text('Current session status is unavailable. Runtime below is the last observation.');
        status.attr('role', 'alert').addClass('usage-warning').text(state.hasObservation
            ? 'Could not refresh. Showing the last observation below; current measurements are unavailable. Use Refresh to retry.'
            : 'Could not load usage. Measurements are unavailable. Use Refresh to retry.');
    } finally {
        clearTimeout(timeout);
        if (generation === state.generation && state.visible) {
            body.attr('aria-busy', 'false');
            state.timer = setTimeout(() => { void load(state); }, 30000);
        }
    }
}

export default {
    id: 'usage', label: 'Usage', icon: '<span aria-hidden="true">◷</span>',
    available: ctx => ctx?.desktopState?.provider !== 'native-macos' && Boolean(ctx?.payload?.user?.id ?? session.payload()?.user?.id),
    html: () => '<div class="ezil-settings-usage"><div class="usage-heading"><h3>Usage</h3><button type="button" class="ezil-settings-btn" data-action="refresh-usage">Refresh</button></div><p class="usage-refresh-status" data-role="usage-refresh-status"></p><div data-role="usage-body"></div></div>',
    init(win, ctx) {
        const state = { win, ctx, generation: 0, visible: false, timer: null, hasObservation: false };
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

// Account usage reads only the authenticated, side-effect-free billing.usage query.
import trpc from '../trpc.js';
import session from '../../../session.js';

const states = new WeakMap();
let active = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seconds = value => Number.isFinite(value) && value >= 0 ? (value < 60 ? `${Math.floor(value)} s` : `${Math.floor(value / 3600)} h ${Math.floor(value % 3600 / 60)} min`) : 'Unavailable';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Unavailable';
const bytes = value => {
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isFinite(Number(value))) return 'Unavailable';
    const count = Number(value);
    if (count < 1048576) return `${count.toLocaleString()} bytes`;
    const unit = count < 1073741824 ? 'MiB' : 'GiB';
    return `${(count / (unit === 'MiB' ? 1048576 : 1073741824)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
};
const row = (label, value) => `<p><strong>${esc(label)}:</strong> ${esc(value)}</p>`;

export function usageHtml(data) {
    if (data?.enabled === false) return '<p role="status">Usage tracking is unavailable in this deployment.</p>';
    if (data?.enabled !== true || data.version !== 1 || !data.session || data.period?.unit !== 'standard_seconds' || !data.storage) throw Error('Unsupported usage response');
    const current = data.session;
    const label = { recording: 'Meter recording', stale: 'Last observation is stale', ended: 'Session ended', unavailable: 'Unavailable' }[current.state] ?? 'Unavailable';
    return `<p role="status">Updated ${esc(date(data.asOf))}. Refreshes every 30 seconds while visible.</p>
        <h4>Current computer session</h4>
        ${row('Status', label)}
        ${row('Recorded runtime', current.state === 'unavailable' ? 'Unavailable' : seconds(current.elapsedSeconds))}
        ${row('Started', date(current.startedAt))}${row('Last observed', date(current.observedAt))}
        ${current.endedAt ? row('Ended', date(current.endedAt)) : ''}
        <p>Runtime is recorded by the server. A recording meter does not confirm that Browser or Code is connected. Stale readings stay at the last observation.</p>
        <h4>Account compute allowance</h4>
        ${row('Used', `${seconds(data.period.usedStandardSeconds)} (standard time)`)}
        ${row('Included', `${seconds(data.period.allowanceStandardSeconds)} (standard time)`)}
        ${row('Remaining', `${seconds(data.period.remainingStandardSeconds)} (standard time)`)}
        ${row('Period starts', date(data.period.startsAt))}${row('Resets', date(data.period.resetsAt))}
        <p>Standard time is weighted compute usage: larger computers consume more per hour. It is separate from session runtime and AI credits.</p>
        <h4>Saved storage</h4>${row('Allowance', bytes(data.storage.capBytes))}
        <p>Current total: unavailable. Historical samples may cover only part of your storage.</p>
        ${data.storage.state === 'sampled' && Array.isArray(data.storage.samples) && data.storage.samples.length
            ? data.storage.samples.map(sample => row(`Computer ${sample.computerId} — sampled ${date(sample.measuredAt)}`, bytes(sample.bytes))).join('')
            : '<p>No storage measurements available.</p>'}
        <h4>Network transfer</h4><p>Unavailable — network transfer is not measured.</p>`;
}

function stop(state) {
    if (!state) return;
    state.visible = false; state.generation++; clearTimeout(state.timer);
    document.removeEventListener('visibilitychange', state.visibility);
}
async function load(state) {
    if (!state.visible || document.hidden || !state.win.get(0).isConnected) return;
    clearTimeout(state.timer);
    const generation = ++state.generation;
    const computerId = session.currentComputer()?.id ?? state.ctx?.computer?.id;
    const body = state.win.find('[data-role="usage-body"]');
    body.attr('aria-busy', 'true').html('<p role="status">Loading usage…</p>');
    let timeout;
    try {
        const result = await Promise.race([
            trpc.query('billing.usage', computerId ? { computerId } : undefined),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Timeout')), 15000); }),
        ]);
        if (generation !== state.generation || !state.visible || !state.win.get(0).isConnected) return;
        if (computerId !== (session.currentComputer()?.id ?? state.ctx?.computer?.id)) { void load(state); return; }
        if (!result.ok) throw Error('Usage unavailable');
        body.html(usageHtml(result.data));
    } catch {
        if (generation !== state.generation || !state.visible || !state.win.get(0).isConnected) return;
        body.html('<p role="alert">Could not load usage. Measurements are unavailable. Use Refresh to try again.</p>');
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
    html: () => '<div class="ezil-settings-usage"><h3>Usage</h3><button type="button" class="ezil-settings-btn" data-action="refresh-usage">Refresh</button><div data-role="usage-body"></div></div>',
    init(win, ctx) {
        const state = { win, ctx, generation: 0, visible: false, timer: null };
        state.visibility = () => { if (document.hidden) { state.generation++; clearTimeout(state.timer); } else void load(state); };
        states.set(win.get(0), state);
        win.on('click', '[data-action="refresh-usage"]', () => { void load(state); });
    },
    onActivate(win) {
        stop(active); active = states.get(win.get(0)); if (!active) return;
        active.visible = true;
        document.addEventListener('visibilitychange', active.visibility);
        void load(active);
    },
    onDeactivate() { stop(active); active = null; },
};

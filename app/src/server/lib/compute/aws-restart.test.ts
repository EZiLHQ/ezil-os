import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAwsEc2Provider } from './aws-ec2';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'test-secret' };
const failure = { ok: false, outcome: 'restart_unavailable', error: 'restart_unavailable' };
const row = (over = {}) => placementRow({ computer_id: computerId, owner_user_id: userId, state: 'RUNNING', generation: 7, lease_epoch: 11, ...over });
function setup(rows = [row()], overrides = {}) {
    const fake = createFakePlacementDb({ placements: rows });
    const provider = createAwsEc2Provider({ db: fake.db, env: () => ({ ...env, ...overrides }) });
    return { fake, restart: (id = 'request-1') => provider.restart({ correlationId: id }, { computerId, userId }) };
}
const oldRuntime = 'a'.repeat(32), newRuntime = 'b'.repeat(32);
const ack = () => Response.json({ ok: true, outcome: 'restart_requested' }, { status: 202 });
const relay = (runtimeId = oldRuntime) => Response.json({ ok: true, runtimeId, expiresAt: Date.now() + 600_000 });
let fetchMock: ReturnType<typeof vi.fn>;
// The placement fake also schedules zero-delay SQL yields; drive those with the poll timers.
async function complete<T>(pending: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return pending;
}
const dispatches = () => fetchMock.mock.calls.filter(([, init]) => init.method === 'POST');
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let runtime = oldRuntime;
    fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') { runtime = runtime === oldRuntime ? newRuntime : oldRuntime; return ack(); }
        return relay(runtime);
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('provider signs current owned epoch and exact requests; only reads placement', async () => {
    const { fake, restart } = setup();
    const before = structuredClone(fake.placements);
    expect(await complete(restart())).toEqual({ ok: true, outcome: 'restart_requested' });
    expect(fetchMock.mock.calls.map(([url, init]) => [new URL(url).pathname.split('/').pop(), init.method]))
        .toEqual([['relay-refresh', 'GET'], ['restart', 'POST'], ['relay-refresh', 'GET']]);
    for (const [endpoint, init] of fetchMock.mock.calls) {
        const [, encoded, sig] = init.headers['x-ezil-auth'].split('.');
        const c = JSON.parse(Buffer.from(encoded, 'base64url').toString());
        expect(c).toMatchObject({ computerId, userId, provider: 'aws-ec2', generation: 7, leaseEpoch: 11 });
        expect(sig).toBe(createHmac('sha256', 'test-secret').update(['v2', c.ts, init.method, new URL(endpoint).pathname,
            c.sandboxId, computerId, userId, 'aws-ec2', '', 7, 11, createHash('sha256').update(init.body ?? '').digest('hex')].join('|')).digest('hex'));
        expect(init.redirect).toBe('error');
        expect(init.cache).toBe('no-store');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(dispatches()).toHaveLength(1);
    expect(fake.placements).toEqual(before);
    expect(fake.statements.every(s => s.sql.includes('placement:read') || s.sql.includes('placement:image-reservation'))).toBe(true);
});
it('double request keeps the same signed request ID', async () => {
    const { restart } = setup();
    await complete(restart()); await complete(restart());
    expect(dispatches()).toHaveLength(2);
    expect(dispatches()[0]![1].body).toBe(dispatches()[1]![1].body);
});
it('waits past the queued acknowledgment and old runtime, through downtime, for the new ready runtime', async () => {
    // The old runtime can still answer for several polls AFTER the host queues the restart.
    const reads = [relay(), relay(), relay(), new Response('offline', { status: 503 }), relay(newRuntime)];
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => init.method === 'POST' ? ack() : reads.shift());
    let settled = false;
    const pending = setup().restart().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatches()).toHaveLength(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toEqual({ ok: true, outcome: 'restart_requested' });
    expect(reads).toHaveLength(0);
    expect(dispatches()).toHaveLength(1);
});
it.each(['old runtime', 'offline', 'malformed runtime', 'HTTP error with new runtime'])('bounds the wait when polls stay %s', async mode => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let reads = 0, startedAt = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') return ack();
        if (reads++ === 0) { startedAt = Date.now(); return relay(); }
        if (mode === 'old runtime') return relay();
        if (mode === 'offline') throw new Error('LEAK');
        if (mode === 'HTTP error with new runtime') return Response.json({ ok: true, runtimeId: newRuntime }, { status: 503 });
        return relay('invalid');
    });
    let settled = false;
    const pending = setup().restart().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(179_999 - (Date.now() - startedAt));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(failure);
    expect(dispatches()).toHaveLength(1);
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(timeout.mock.calls.every(([ms]) => ms > 0 && ms <= 15_000)).toBe(true);
    expect(timeout.mock.calls.at(-1)?.[0]).toBe(2_000);
});
it('does not dispatch without a valid pre-restart runtime identity', async () => {
    fetchMock.mockResolvedValue(relay('invalid'));
    expect(await complete(setup().restart())).toEqual(failure);
    expect(dispatches()).toHaveLength(0);
});
it('an aborted poll is retried, never mistaken for readiness', async () => {
    fetchMock.mockResolvedValueOnce(relay()).mockResolvedValueOnce(ack())
        .mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError')).mockResolvedValueOnce(relay(newRuntime));
    const pending = setup().restart();
    expect(await complete(pending)).toEqual({ ok: true, outcome: 'restart_requested' });
    expect(dispatches()).toHaveLength(1);
});
it.each(['baseline', 'after dispatch'])('aborts a hung runtime read at the bounded deadline: %s', async stage => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('aborted', 'TimeoutError')), ms);
        return controller.signal;
    });
    let reads = 0, firstReadAt = 0;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') return ack();
        if (reads++ === 0) {
            firstReadAt = Date.now();
            if (stage === 'after dispatch') return relay();
        }
        return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    });
    const result = await complete(setup().restart());
    expect(result).toEqual(failure);
    expect(Date.now() - firstReadAt).toBe(stage === 'baseline' ? 15_000 : 180_000);
    expect(dispatches()).toHaveLength(stage === 'baseline' ? 0 : 1);
});
it.each([
    { EZIL_AWS_COMPUTERS_ENABLED: '0' }, { EZIL_AWS_COMPUTERS_ENABLED: ' 1 ' },
    { EZIL_AWS_KILL_SWITCH: '1' }, { EZIL_AWS_KILL_SWITCH: 'true' }, { EZIL_AWS_KILL_SWITCH: '' },
    { CLOUDFLARE_GUACAMOLE_HMAC_SECRET: '' }, { CLOUDFLARE_GUACAMOLE_WORKER_URL: '' },
    { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'http://worker.example' },
    { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://u:p@worker.example' },
    { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example?bad=1' },
])('configuration guard refuses without network: %j', async overrides => {
    expect(await complete(setup([row()], overrides).restart())).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
});
it.each([[], [row({ owner_user_id: computerId })], [row({ provider: 'cloudflare' })], [row({ state: 'STOPPED' })],
    [row({ generation: 0 })], [row({ lease_epoch: 0 })]].map(rows => ({ rows })))('placement guard refuses foreign or unavailable target: %j', async ({ rows }) => {
    expect(await complete(setup(rows).restart())).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
});
it('empty request ID refuses without dispatch', async () => {
    expect(await complete(setup().restart(''))).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
});
it.each([[200, { ok: true, outcome: 'restarted' }], [202, { ok: false, outcome: 'restart_requested' }],
    [202, { ok: true, outcome: 'LEAK' }], [503, { error: 'LEAK' }], [202, null]])('rejects non-acknowledgments without polling: %j', async (status, body) => {
    fetchMock.mockResolvedValueOnce(relay()).mockResolvedValueOnce(Response.json(body, { status: status as number }));
    expect(await complete(setup().restart())).toEqual(failure);
});
it('lost transport and invalid JSON return a redacted unavailable value', async () => {
    fetchMock.mockResolvedValueOnce(relay()).mockRejectedValueOnce(new Error('LEAK'));
    expect(await complete(setup().restart())).toEqual(failure);
    fetchMock.mockResolvedValueOnce(relay()).mockResolvedValueOnce(new Response('LEAK'));
    expect(await complete(setup().restart())).toEqual(failure);
});

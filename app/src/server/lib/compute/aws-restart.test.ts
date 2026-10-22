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
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn(async () => Response.json({ ok: true, outcome: 'restart_requested' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('provider signs current owned epoch and exact body; only reads placement', async () => {
    const { fake, restart } = setup();
    const before = structuredClone(fake.placements);
    expect(await restart()).toEqual({ ok: true, outcome: 'restart_requested' });
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    const [, encoded, sig] = init.headers['x-ezil-auth'].split('.');
    const c = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    expect(c).toMatchObject({ computerId, userId, provider: 'aws-ec2', generation: 7, leaseEpoch: 11 });
    expect(sig).toBe(createHmac('sha256', 'test-secret').update(['v2', c.ts, 'POST', new URL(endpoint).pathname,
        c.sandboxId, computerId, userId, 'aws-ec2', '', 7, 11, createHash('sha256').update(init.body).digest('hex')].join('|')).digest('hex'));
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(fake.placements).toEqual(before);
    expect(fake.statements.every(s => s.sql.includes('placement:read') || s.sql.includes('placement:image-reservation'))).toBe(true);
});
it('double request keeps the same signed request ID', async () => {
    const { restart } = setup();
    await restart(); await restart();
    expect(fetchMock.mock.calls[0]![1].body).toBe(fetchMock.mock.calls[1]![1].body);
});
it.each([
    { EZIL_AWS_COMPUTERS_ENABLED: '0' }, { EZIL_AWS_COMPUTERS_ENABLED: ' 1 ' },
    { EZIL_AWS_KILL_SWITCH: '1' }, { EZIL_AWS_KILL_SWITCH: 'true' }, { EZIL_AWS_KILL_SWITCH: '' },
    { CLOUDFLARE_GUACAMOLE_HMAC_SECRET: '' }, { CLOUDFLARE_GUACAMOLE_WORKER_URL: '' },
    { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'http://worker.example' },
    { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://u:p@worker.example' },
    { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example?bad=1' },
])('configuration guard refuses without network: %j', async overrides => {
    expect(await setup([row()], overrides).restart()).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
});
it.each([[], [row({ owner_user_id: computerId })], [row({ provider: 'cloudflare' })], [row({ state: 'STOPPED' })],
    [row({ generation: 0 })], [row({ lease_epoch: 0 })]].map(rows => ({ rows })))('placement guard refuses foreign or unavailable target: %j', async ({ rows }) => {
    expect(await setup(rows).restart()).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
});
it('empty request ID refuses without dispatch', async () => {
    expect(await setup().restart('')).toEqual(failure);
    expect(fetchMock).not.toHaveBeenCalled();
});
it.each([[200, { ok: true, outcome: 'restarted' }], [202, { ok: false, outcome: 'restart_requested' }],
    [202, { ok: true, outcome: 'LEAK' }], [503, { error: 'LEAK' }], [202, null]])('only exact queued acknowledgment is success: %j', async (status, body) => {
    fetchMock.mockResolvedValue(Response.json(body, { status: status as number }));
    expect(await setup().restart()).toEqual(failure);
});
it('lost transport and invalid JSON return a redacted unavailable value', async () => {
    fetchMock.mockRejectedValueOnce(new Error('LEAK'));
    expect(await setup().restart()).toEqual(failure);
    fetchMock.mockResolvedValueOnce(new Response('LEAK'));
    expect(await setup().restart()).toEqual(failure);
});

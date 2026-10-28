import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ signedIn: true, switchConfiguration: vi.fn() }));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: async () => ({ user: h.signedIn ? { id: '11111111-1111-4111-8111-111111111111' } : null, db: {} }) }));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({ computer: { switchConfiguration: h.switchConfiguration } }) } }));

import { maxDuration, POST } from './route';

const C1 = '22222222-2222-4222-8222-222222222222';
const post = (body: string) => POST(new Request('https://app.example/api/shell/switch', { method: 'POST', body }));

beforeEach(() => {
    h.signedIn = true;
    h.switchConfiguration.mockReset().mockResolvedValue({ ok: true, effective: 'switching', current: 'std-2', target: 'cmp-4', transitionId: 't' });
});

describe('POST /api/shell/switch', () => {
    it('forwards computerId, size and requestId and returns the value answer', async () => {
        const response = await post(JSON.stringify({ computerId: C1, size: 'cmp-4', requestId: 'click-000001' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(await response.json()).toEqual({ ok: true, effective: 'switching', current: 'std-2', target: 'cmp-4', transitionId: 't' });
        expect(h.switchConfiguration).toHaveBeenCalledWith({ computerId: C1, size: 'cmp-4', requestId: 'click-000001' });
        expect(maxDuration).toBe(300);
    });
    it('a refusal is a 200 value, never a throw', async () => {
        h.switchConfiguration.mockResolvedValue({ ok: false, reason: 'capacity_unavailable' });
        const response = await post(JSON.stringify({ computerId: C1, size: 'cmp-8', requestId: 'click-000001' }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: false, reason: 'capacity_unavailable' });
    });
    it('authenticates before reading the body; a bad body is a 400', async () => {
        h.signedIn = false;
        expect((await post('not json')).status).toBe(401);
        h.signedIn = true;
        expect((await post('not json')).status).toBe(400);
        expect(h.switchConfiguration).not.toHaveBeenCalled();
    });
});

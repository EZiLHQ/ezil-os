/**
 * `/api/shell/code-preview-url` is a transport (Phase B r9, REVERSE-MOVE-CONTRACT §5.9, opt-in trigger): it hands the
 * Code mint's body to `cloudflareGuacamole.codePreviewUrl` as given. `intent: 'open'` (the r9 shell's Code mint) is the
 * only Code ask that may start a held computer's move, so the route must forward it, verbatim, and nothing when the body
 * has none (a pre-r9 tab). The procedure's own handling is pinned through this real route in
 * `compute-dispatch-reverse.test.ts` (the U → A seam).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ signedIn: true, seen: [] as unknown[], answer: { ok: true } as unknown }));
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
vi.mock('@/server/api/trpc', () => ({
    createTRPCContext: async () => ({ user: state.signedIn ? { id: userId } : null, db: {} }),
}));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({ cloudflareGuacamole: {
    codePreviewUrl: async (input: unknown) => { state.seen.push(input); return state.answer; },
} }) } }));

import { POST } from './route';

const post = (body: unknown) => POST(new Request('https://app.example/api/shell/code-preview-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
    state.signedIn = true; state.seen = []; state.answer = { ok: true };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('POST /api/shell/code-preview-url hands the body to codePreviewUrl as given (Phase B r9, §5.9)', () => {
    it('forwards `intent` verbatim: the r9 Code mint\'s \'open\', none when the body has none (a pre-r9 tab), any other value as is', async () => {
        const moving = { ok: false, error: 'computer_moving', errorCode: 'sandbox_starting', computeMoving: true };
        state.answer = moving;
        expect(await (await post({ computerId, intent: 'open' })).json()).toEqual(moving);
        await post({ computerId });
        await post({ computerId, intent: 'warm' });
        await post({ computerId, intent: 1 });
        expect(state.seen).toStrictEqual([
            { computerId, intent: 'open' },
            { computerId, intent: undefined },
            { computerId, intent: 'warm' },
            { computerId, intent: 1 },
        ]);
    });
    it('an unsigned POST is rejected before the body is read or codePreviewUrl runs', async () => {
        state.signedIn = false;
        expect((await post({ computerId, intent: 'open' })).status).toBe(401);
        expect(state.seen).toEqual([]);
    });
    it('a body that is not JSON is a 400, and codePreviewUrl never runs', async () => {
        expect((await post('{not json')).status).toBe(400);
        expect(state.seen).toEqual([]);
    });
});

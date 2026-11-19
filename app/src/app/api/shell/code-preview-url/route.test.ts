/**
 * `/api/shell/code-preview-url` is a transport (Phase B r9, REVERSE-MOVE-CONTRACT §5.9, opt-in trigger): it hands the
 * Code mint's body to `cloudflareGuacamole.codePreviewUrl` as given. `intent: 'open'` (the r9 shell's Code mint) is the
 * only Code ask that may start a held computer's move, so the route must forward it, verbatim, and nothing when the body
 * has none (a pre-r9 tab). The procedure's own handling is pinned through this real route in
 * `compute-dispatch-reverse.test.ts` (the U → A seam).
 */
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageJobConflictError } from '@/server/lib/compute/placement';

const state = vi.hoisted(() => ({
    signedIn: true, seen: [] as unknown[], answer: { ok: true } as unknown,
    error: null as Error | null, advance: vi.fn().mockResolvedValue(false),
}));
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
vi.mock('@/server/api/trpc', () => ({
    createTRPCContext: async () => ({ user: state.signedIn ? { id: userId } : null, db: {} }),
}));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({ cloudflareGuacamole: {
    codePreviewUrl: async (input: unknown) => {
        state.seen.push(input);
        if (state.error) throw state.error;
        return state.answer;
    },
} }) } }));

vi.mock('@/server/lib/compute/aws-auto-update', () => ({ advanceAutomaticImageUpdate: state.advance }));

import { POST } from './route';

const post = (body: unknown) => POST(new Request('https://app.example/api/shell/code-preview-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
    state.signedIn = true; state.seen = []; state.answer = { ok: true }; state.error = null;
    state.advance.mockReset().mockResolvedValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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

describe('per-tab folder continuity: the own-files `codeFolder` hint', () => {
    it('is forwarded verbatim (the procedure checks it) and its answer code passes back', async () => {
        state.answer = { ok: true, codePreviewUrl: 'https://x/preview-bootstrap?token=t', codeFolder: { v: 1, outcome: 'missing' } };
        const res = await post({ computerId, intent: 'open', codeFolder: { v: 1, path: '/workspace/sports/sports-web' } });
        expect(await res.json()).toEqual(state.answer);
        // Even a malformed hint is the procedure's to answer `invalid`, never this route's 400.
        await post({ computerId, intent: 'open', codeFolder: { v: 9, path: '../etc', extra: true } });
        expect(state.seen).toStrictEqual([
            { computerId, intent: 'open', codeFolder: { v: 1, path: '/workspace/sports/sports-web' } },
            { computerId, intent: 'open', codeFolder: { v: 9, path: '../etc', extra: true } },
        ]);
    });
    it('a body without it is today\'s input exactly (no `codeFolder` key at all)', async () => {
        await post({ computerId, intent: 'open' });
        expect(state.seen).toStrictEqual([{ computerId, intent: 'open' }]);
        expect(Object.keys(state.seen[0] as object)).not.toContain('codeFolder');
    });
});

describe('automatic AWS image update on Code open', () => {
    const rebaseRequired = { ok: false, errorCode: 'computer_rebase_required' };

    it('starts only on an opted-in owner open and answers with a bounded AWS wake state', async () => {
        state.answer = rebaseRequired;
        state.advance.mockResolvedValue(true);
        vi.stubEnv('EZIL_AWS_AUTO_REBASE', '0');
        expect(await (await post({ computerId, intent: 'open' })).json()).toEqual(rebaseRequired);
        vi.stubEnv('EZIL_AWS_AUTO_REBASE', '1');
        expect(await (await post({ computerId, intent: 'warm' })).json()).toEqual(rebaseRequired);
        expect(state.advance).not.toHaveBeenCalled();

        expect(await (await post({ computerId, intent: 'open' })).json()).toMatchObject({
            ok: false, error: 'computer_updating', errorCode: 'sandbox_starting',
            computeProvider: 'aws-ec2', computeUpdating: true, computeLaunching: true,
        });
        expect(state.advance).toHaveBeenCalledExactlyOnceWith({}, computerId, userId, true);
    });

    it('continues an existing automatic job when tRPC wraps the placement fence', async () => {
        vi.stubEnv('EZIL_AWS_AUTO_REBASE', '1');
        state.error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: new ImageJobConflictError() });
        state.advance.mockResolvedValue(true);
        expect(await (await post({ computerId, intent: 'open' })).json()).toMatchObject({
            ok: false, error: 'computer_updating', errorCode: 'sandbox_starting',
        });
        expect(state.advance).toHaveBeenCalledExactlyOnceWith({}, computerId, userId, false);
    });

    it('preserves the existing refusal if the update is ineligible', async () => {
        vi.stubEnv('EZIL_AWS_AUTO_REBASE', '1');
        state.answer = rebaseRequired;
        expect(await (await post({ computerId, intent: 'open' })).json()).toEqual(rebaseRequired);
        expect(state.advance).toHaveBeenCalledExactlyOnceWith({}, computerId, userId, true);
    });
});

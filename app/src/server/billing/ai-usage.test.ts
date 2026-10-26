import { describe, expect, it, vi } from 'vitest';
import { parseAiUsage, readAiUsage } from './ai-usage';

const row = { created_at: '2026-10-26T01:00:00Z', status: 'settled', cost_micro: '1000001', uncollected_micro: '1', hold_micro: '20',
    id: 'private-id', prompt: 'private-prompt', pending_reason: 'private-reason', upstream_model: 'private-provider' };
describe('member usage projection', () => {
    it('reports actual collected charges separately from holds and strips private data', () => {
        expect(parseAiUsage({ object: 'list', data: [row, { ...row, status: 'pending', cost_micro: null }] }, 20, null)).toEqual({
            state: 'available', recentUsage: { limit: 20, before: null, rows: [
                { at: '2026-10-26T01:00:00.000Z', status: 'settled', heldMicro: '0', chargedMicro: '1000000' },
                { at: '2026-10-26T01:00:00.000Z', status: 'pending', heldMicro: '20', chargedMicro: null },
            ] },
        });
    });
    it('distinguishes an empty page from malformed data and unknown charge from zero', () => {
        expect(parseAiUsage({ object: 'list', data: [] }, 20, null).state).toBe('available');
        expect(parseAiUsage({}, 20, null).recentUsage).toBeNull();
        const result = parseAiUsage({ object: 'list', data: [{ ...row, cost_micro: 0, uncollected_micro: 0 },
            { ...row, uncollected_micro: null }] }, 20, null);
        expect(result.recentUsage?.rows.map(r => r.chargedMicro)).toEqual(['0', null]);
    });
    it.each([{ status: 'unknown' }, { status: ['settled'] }, { created_at: 'tomorrow' }])('refuses a malformed page %j', bad => {
        expect(parseAiUsage({ object: 'list', data: [{ ...row, ...bad }] }, 1, null).state).toBe('unavailable');
    });
    it('bounds the page and encodes a validated cursor without adding a payer selector', async () => {
        const read = vi.fn().mockResolvedValue({ object: 'list', data: [row] });
        const input = { config: { fundingUrl: undefined }, headers: new Headers(), userId: 'current' };
        const result = await readAiUsage(input, { limit: 50, before: '2026-10-26T04:00:00+03:00' }, read);
        expect(result.recentUsage?.before).toBe('2026-10-26T01:00:00.000Z');
        expect(read).toHaveBeenCalledExactlyOnceWith('/v1/me/usage?limit=50&before=2026-10-26T01%3A00%3A00.000Z');
        for (const limit of [0, 51, 1.5]) expect((await readAiUsage(input, { limit }, read)).state).toBe('unavailable');
        expect(read).toHaveBeenCalledOnce();
        expect(parseAiUsage({ object: 'list', data: [row, row] }, 1, null).state).toBe('unavailable');
    });
});

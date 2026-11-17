import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), after: vi.fn() }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: mocks.context }));
import { POST } from './route';
import fixture from '@/server/ai-traces/fixture.json';
it('route resolves authentication through createTRPCContext and defers database work through after', async () => {
    const db = { execute: vi.fn().mockResolvedValue([]) };
    mocks.context.mockResolvedValue({ user: { id: '30000000-0000-4000-8000-000000000001' }, db });
    const response = await POST(new Request('https://os.test/api/shell/ai-traces', { method: 'POST', body: JSON.stringify({ v: 1, traces: [fixture] }) }));
    expect(response.status).toBe(202);
    expect(mocks.context.mock.calls[0]![0].headers.get('x-trpc-source')).toBe('shell-http');
    expect(db.execute).not.toHaveBeenCalled(); expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0]![0](); expect(db.execute).toHaveBeenCalledTimes(1);
});

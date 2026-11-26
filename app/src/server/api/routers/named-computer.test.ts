import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./computer-store', () => ({ createComputerInLowestFreeSlot: h.create }));
import { createNamedComputer } from './named-computer';

const input = { userId: randomUUID(), clientId: 'qualified-client', idempotencyKey: randomUUID(), name: 'My computer' };
const computer = { id: randomUUID(), name: input.name, slot: 1 };
const digest = createHash('sha256').update(input.name, 'utf8').digest('hex');
const receipt = { computer_id: computer.id, input_digest: digest, slot: 1 };
const execute = vi.fn();
const findFirst = vi.fn();
const tx = { execute, query: { computers: { findFirst } } };
const database = { transaction: async <T>(work: (transaction: unknown) => Promise<T>) => work(tx) } as Parameters<typeof createNamedComputer>[0];

beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    findFirst.mockReset().mockResolvedValue({ id: computer.id });
    h.create.mockReset().mockResolvedValue({ ok: true, computer });
});

describe('named computer receipts', () => {
    it('uses the existing owner slot allocator and returns only a named computer', async () => {
        expect(await createNamedComputer(database, input)).toEqual({ computer });
        expect(h.create).toHaveBeenCalledWith(tx, { userId: input.userId, name: input.name });
    });

    it('returns the original creation on retry without allocating a slot again', async () => {
        execute.mockResolvedValueOnce([]).mockResolvedValueOnce([receipt]);
        expect(await createNamedComputer(database, input)).toEqual({ computer });
        expect(h.create).not.toHaveBeenCalled();
    });

    it('rejects key reuse with a different name and ends receipt access after reassignment', async () => {
        execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...receipt, input_digest: 'different' }]);
        await expect(createNamedComputer(database, input)).rejects.toMatchObject({ code: 'CONFLICT' });
        execute.mockResolvedValueOnce([]).mockResolvedValueOnce([receipt]);
        findFirst.mockResolvedValueOnce(undefined);
        await expect(createNamedComputer(database, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(h.create).not.toHaveBeenCalled();
    });
});

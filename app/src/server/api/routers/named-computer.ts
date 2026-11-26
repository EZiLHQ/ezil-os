import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';

import type { db } from '@/server/db';
import { computers } from '@/server/db/schema';

import { computerCreateError } from './computer-errors';
import { createComputerInLowestFreeSlot } from './computer-store';

type NamedComputerRequest = {
    userId: string;
    clientId: string;
    idempotencyKey: string;
    name: string;
};

type CreationReceipt = { computer_id: string; input_digest: string; slot: number };

export async function createNamedComputer(database: Pick<typeof db, 'transaction'>, input: NamedComputerRequest) {
    const inputDigest = createHash('sha256').update(input.name, 'utf8').digest('hex');
    return database.transaction(async transaction => {
        // Serialize delegated creates for the owner, including calls with different keys or clients.
        // The existing partial slot index continues to protect races with the normal OS create path.
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ezil.named-computer:' + input.userId}, 0))`);
        const [receipt] = await transaction.execute<CreationReceipt>(sql`
            SELECT computer_id, input_digest, slot FROM public.ezil_named_computer_creations
            WHERE user_id = ${input.userId}::uuid AND client_id = ${input.clientId}
              AND idempotency_key = ${input.idempotencyKey}::uuid
        `);
        if (receipt) {
            if (receipt.input_digest !== inputDigest) throw new TRPCError({ code: 'CONFLICT', message: 'idempotency_conflict' });
            // A rename or soft deletion does not change a creation receipt. A reassignment does end access.
            const owned = await transaction.query.computers.findFirst({
                where: and(eq(computers.userId, input.userId), eq(computers.id, receipt.computer_id)),
                columns: { id: true },
            });
            if (!owned) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            return { computer: { id: receipt.computer_id, name: input.name, slot: receipt.slot } };
        }

        const outcome = await createComputerInLowestFreeSlot(transaction, { userId: input.userId, name: input.name });
        if (!outcome.ok) throw computerCreateError(outcome.reason);
        const { id, name, slot } = outcome.computer;
        await transaction.execute(sql`
            INSERT INTO public.ezil_named_computer_creations (user_id, client_id, idempotency_key, computer_id, input_digest, slot)
            VALUES (${input.userId}::uuid, ${input.clientId}, ${input.idempotencyKey}::uuid, ${id}::uuid, ${inputDigest}, ${slot})
        `);
        return { computer: { id, name, slot } };
    });
}

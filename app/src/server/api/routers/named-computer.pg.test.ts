import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { createComputerInLowestFreeSlot } from './computer-store';
import { createNamedComputer } from './named-computer';

const url = process.env.NAMED_COMPUTER_TEST_DATABASE_URL;
const makeRequest = (name = 'Named desktop') => ({
    userId: randomUUID(), clientId: 'registered-client', idempotencyKey: randomUUID(), name,
});

describe.skipIf(!url)('named computer creation in disposable Postgres', () => {
    let sql: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeAll(async () => {
        const parsed = new URL(url!);
        if (!['localhost', '127.0.0.1'].includes(parsed.hostname)
            || !/^\/ezil_named_computer_test_[0-9]+$/.test(parsed.pathname)) {
            throw new Error('Use a dedicated local named-computer test database');
        }
        sql = postgres(url!, { max: 8, onnotice: () => {} });
        db = drizzle(sql, { schema });
        await sql.unsafe(`
            CREATE ROLE anon;
            CREATE ROLE authenticated;
            CREATE TABLE public.ezil_computers (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text NOT NULL,
                slot smallint NOT NULL CHECK (slot IN (1, 2)), created_at timestamptz NOT NULL DEFAULT now(),
                last_opened_at timestamptz, deleted_at timestamptz, metadata jsonb
            );
            CREATE UNIQUE INDEX ezil_computers_user_slot_uidx
                ON public.ezil_computers (user_id, slot) WHERE deleted_at IS NULL;
        `);
        const migration = readFileSync(new URL('../../../../drizzle/0037_named_computer_creation.sql', import.meta.url), 'utf8');
        await sql.unsafe(migration);
    });
    afterAll(async () => { await sql?.end(); });

    it('records one creation for parallel signed retries and preserves its original receipt through a rename', async () => {
        const request = makeRequest();
        const results = await Promise.all(Array.from({ length: 6 }, () => createNamedComputer(db, request)));
        for (const result of results) expect(result).toEqual(results[0]);
        expect(await sql`SELECT name, slot FROM public.ezil_computers WHERE user_id=${request.userId}`)
            .toEqual([{ name: request.name, slot: 1 }]);
        await sql`UPDATE public.ezil_computers SET name='Renamed' WHERE id=${results[0]!.computer.id}`;
        expect(await createNamedComputer(db, request)).toEqual(results[0]);
        await expect(createNamedComputer(db, { ...request, name: 'Different' }))
            .rejects.toMatchObject({ code: 'CONFLICT', message: 'idempotency_conflict' });
    });

    it('scopes each receipt to the registered calling client and owner while preserving the ordinary row quota', async () => {
        const request = makeRequest();
        const first = await createNamedComputer(db, request);
        const second = await createNamedComputer(db, { ...request, clientId: 'second-registered-client' });
        const other = await createNamedComputer(db, { ...request, userId: randomUUID() });
        expect([first.computer.slot, second.computer.slot, other.computer.slot]).toEqual([1, 2, 1]);
        expect(new Set([first.computer.id, second.computer.id, other.computer.id]).size).toBe(3);
        await expect(createNamedComputer(db, { ...request, idempotencyKey: randomUUID() }))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'computer_limit_reached' });
        expect(await createComputerInLowestFreeSlot(db, { userId: request.userId, name: 'Ordinary UI' }))
            .toEqual({ ok: false, reason: 'computer_limit_reached' });
        expect(await createNamedComputer(db, request)).toEqual(first);
    });

    it('does not return a recorded computer after the current owner changes', async () => {
        const request = makeRequest();
        const result = await createNamedComputer(db, request);
        await sql`UPDATE public.ezil_computers SET user_id=${randomUUID()} WHERE id=${result.computer.id}`;
        await expect(createNamedComputer(db, request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(await sql`SELECT id FROM public.ezil_computers WHERE user_id=${request.userId}`).toEqual([]);
    });

    it('rolls back allocation when the receipt cannot be inserted', async () => {
        const request = makeRequest('Rollback marker');
        await sql.unsafe("ALTER TABLE public.ezil_named_computer_creations ADD CONSTRAINT reject_marker CHECK (false) NOT VALID");
        try {
            await expect(createNamedComputer(db, request)).rejects.toThrow();
            expect(await sql`SELECT id FROM public.ezil_computers WHERE user_id=${request.userId}`).toEqual([]);
        } finally {
            await sql.unsafe('ALTER TABLE public.ezil_named_computer_creations DROP CONSTRAINT reject_marker');
        }
        expect(await createNamedComputer(db, request)).toMatchObject({ computer: { name: request.name, slot: 1 } });
    });
});

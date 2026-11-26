import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { findDefaultLiveComputer, liveComputersOf, liveOwnedComputer } from '@/server/api/routers/computer-store';

const root = path.resolve(__dirname, '../../../..');
const modulePath = process.env.EZIL_PGLITE_MODULE;

describe.skipIf(!modulePath)('exact production computer reader after additive editor migrations', () => {
    it('keeps old owned/default/deleted row behavior with special capabilities absent', async () => {
        // Prove the imported reader/schema are byte-identical to the actual production parent.
        for (const file of ['app/src/server/api/routers/computer-store.ts', 'app/src/server/db/schema/computers.ts']) {
            expect(readFileSync(path.join(root, file))).toEqual(execFileSync('git', ['show', `9bcc67af:${file}`], { cwd: root }));
        }
        const { PGlite } = await import(/* @vite-ignore */ modulePath!);
        const pg = new PGlite();
        try {
            await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
                CREATE TABLE public.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL,
                    slot smallint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), last_opened_at timestamptz,
                    deleted_at timestamptz, metadata jsonb);
                INSERT INTO public.ezil_computers(id,user_id,name,slot,deleted_at) VALUES
                ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','Existing owner',1,NULL),
                ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011','Deleted',2,now()),
                ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000012','Other owner',1,NULL);`);
            const db = drizzle(async (query, params) => ({ rows: (await pg.query(query, params, { rowMode: 'array' })).rows }), { schema });
            const owner = '00000000-0000-4000-8000-000000000011';
            const read = () => db.query.computers.findMany({ where: liveComputersOf(owner) });
            const before = await read();
            for (const id of ['0035_editor_agent_sessions', '0036_editor_control_operations', '0037_editor_protocol_2', '0039_named_computer_creation']) {
                await pg.exec(readFileSync(path.join(root, 'app/drizzle', `${id}.sql`), 'utf8'));
            }
            expect(await read()).toEqual(before);
            expect((await findDefaultLiveComputer(db, owner))?.id).toBe(before[0]!.id);
            expect(await db.query.computers.findFirst({ where: liveOwnedComputer(owner, '00000000-0000-4000-8000-000000000003') })).toBeUndefined();
            expect(await db.query.computers.findFirst({ where: liveOwnedComputer(owner, '00000000-0000-4000-8000-000000000002') })).toBeUndefined();
            expect((await pg.query("SELECT to_regclass('public.ezil_operator_entitlements') AS override")).rows[0].override).toBeNull();
        } finally { await pg.close(); }
    }, 30_000);
});

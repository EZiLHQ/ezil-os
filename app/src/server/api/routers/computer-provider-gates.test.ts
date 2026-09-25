import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    process.env.SUPABASE_DATABASE_URL ??= 'postgres://provider-gate@127.0.0.1:5432/none';
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://provider-gate.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'provider-gate-anon-key';
});

import { drizzle } from 'drizzle-orm/pg-proxy';
import type { User } from '@supabase/supabase-js';

import { appRouter } from '@/server/api/root';
import * as schema from '@/server/db/schema';
import { buildTRPCContext } from '../trpc';

const USER = '11111111-1111-1111-1111-111111111111';
const COMPUTER = '33333333-3333-3333-3333-333333333333';

function callerFor(provider: 'cloudflare' | 'aws-ec2' | null) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => {
        statements.push({ sql, params });
        if (!/^select\b/i.test(sql) || !sql.includes('ezil_computers')) {
            throw new Error(`unexpected database operation: ${sql}`);
        }
        return { rows: provider ? [[COMPUTER, provider]] : [] };
    }, { schema }) as unknown as Parameters<typeof buildTRPCContext>[0]['db'];
    const ctx = buildTRPCContext({
        db,
        user: { id: USER, email: 'owner@example.test' } as User,
        headers: new Headers(),
        mode: 'open',
    });
    return { caller: appRouter.createCaller(ctx), statements };
}

describe('computer provider gates at the real tRPC procedures', () => {
    it('keeps the existing Cloudflare status path for a Cloudflare computer', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', '');
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', '');
        try {
            const { caller, statements } = callerFor('cloudflare');
            await expect(caller.cloudflareGuacamole.status({ computerId: COMPUTER })).resolves.toMatchObject({
                ok: false,
                error: 'provider_not_configured',
                provider: 'cloudflare-guacamole',
            });
            expect(statements).toHaveLength(1);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('refuses an AWS computer before a Cloudflare status or preview call', async () => {
        const { caller, statements } = callerFor('aws-ec2');

        await expect(caller.cloudflareGuacamole.status({ computerId: COMPUTER })).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED',
        });
        await expect(caller.cloudflareGuacamole.previewUrl({
            computerId: COMPUTER,
            sessionId: COMPUTER,
        })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

        expect(statements).toHaveLength(2);
        for (const statement of statements) {
            expect(statement.sql).toMatch(/^select\b/i);
            expect(statement.params).toContain(USER);
            expect(statement.params).toContain(COMPUTER);
        }
    });

    it('does not release an AWS computer slot through Cloudflare deletion', async () => {
        const { caller, statements } = callerFor('aws-ec2');

        await expect(caller.computer.delete({ id: COMPUTER })).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED',
        });
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/^select\b/i);
    });

    it('keeps an absent or foreign computer indistinguishable', async () => {
        const { caller } = callerFor(null);
        await expect(caller.cloudflareGuacamole.status({ computerId: COMPUTER })).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });
});

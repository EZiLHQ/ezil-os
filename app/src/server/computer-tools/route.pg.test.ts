import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureTestSchema, migrationStatements } from '../agent-session/pg-test-schema';
import { inputDigest } from '../api/delegation-auth';
import { CLIENT_ID, SUPABASE_ISSUER, delegationEnv, signAssertion, signingKey, type SigningKey } from '../api/delegation.test-support';
import {
    COMPUTER_TOOLS_PROTOCOL, COMPUTER_TOOLS_STAGING_MCP, COMPUTER_TOOLS_STAGING_OS, COMPUTER_TOOLS_STAGING_WORKER,
    SCOPE_FOR_OP, type ComputerToolsOp, procedureForOp,
} from './contract';

const fixture = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ get db() { return fixture.db; } }));

const databaseUrl = process.env.DELEGATION_TEST_DATABASE_URL;
const owner = randomUUID();
const stranger = randomUUID();
const computer = randomUUID();
const routePath = `/api/mcp/computer-tools/${computer}`;
const JOB = 'JobIdAAAAAAAAAAAAAAAAA'; // 22 chars matching ^[A-Za-z0-9_-]{22}$

const jobReply = (over: Record<string, unknown> = {}) => ({
    ok: true, jobId: JOB, kind: 'terminal', name: null, requestId: null, state: 'exited', exitCode: 0, signal: null,
    stdout: 'secret-output-not-stored', stderr: '', stdoutBytes: 24, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
    startedAt: '2026-11-20T00:00:00.000Z', endedAt: '2026-11-20T00:00:01.000Z', timeoutSeconds: 120, background: false, ...over,
});

describe.skipIf(!databaseUrl)('staging computer-tools route: real delegation, placement, audit (0039)', () => {
    let client: ReturnType<typeof postgres>;
    let signer: SigningKey;
    let post: (request: Request) => Promise<Response>;
    const worker = vi.fn(async (): Promise<Response> => Response.json(jobReply()));

    beforeAll(async () => {
        client = postgres(databaseUrl!, { max: 6, prepare: false, onnotice: () => {} });
        fixture.db = drizzle(client);
        await ensureTestSchema(client);
        const [placement] = await client.unsafe("SELECT to_regclass('public.ezil_computer_placements') AS name");
        if (!placement?.name) {
            for (const file of ['0001_compute_placement', '0002_image_rebase']) {
                const source = new URL(`../../../../docs/aws-computers/sql/${file}.sql.txt`, import.meta.url);
                await client.unsafe(readFileSync(source, 'utf8'));
            }
        }
        const [audit] = await client.unsafe("SELECT to_regclass('public.ezil_computer_tool_jobs') AS name");
        if (!audit?.name) for (const statement of migrationStatements('0039_computer_tool_jobs')) await client.unsafe(statement);
        await client.unsafe(
            "INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1::uuid,'ct-owner@example.invalid',now()),($2::uuid,'ct-stranger@example.invalid',now())",
            [owner, stranger],
        );
        await client.unsafe('INSERT INTO public.ezil_computers (id,user_id,slot) VALUES ($1::uuid,$2::uuid,1)', [computer, owner]);
        await client.unsafe(
            "INSERT INTO public.ezil_computer_placements (computer_id,owner_user_id,provider,workspace_store,generation,lease_epoch,state,updated_at) VALUES ($1::uuid,$2::uuid,'cloudflare','r2',1,0,'RUNNING',now())",
            [computer, owner],
        );
        signer = await signingKey();
        post = (await import('@/app/api/mcp/computer-tools/[computerId]/route')).POST;
    });

    beforeEach(() => {
        for (const [key, value] of Object.entries({
            ...delegationEnv([signer], { EZIL_DELEGATION_ISSUER: COMPUTER_TOOLS_STAGING_MCP, EZIL_DELEGATION_AUDIENCE: COMPUTER_TOOLS_STAGING_OS }),
            EZIL_DELEGATED_COMPUTER_TOOLS: 'enabled', EZIL_DELEGATED_TERMINAL: 'enabled',
            CLOUDFLARE_GUACAMOLE_WORKER_URL: COMPUTER_TOOLS_STAGING_WORKER, CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'synthetic-worker-key',
        })) vi.stubEnv(key, value);
        worker.mockClear();
        worker.mockImplementation(async () => Response.json(jobReply()));
        vi.stubGlobal('fetch', worker);
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    afterAll(async () => { await client?.end(); });

    async function signed(op: ComputerToolsOp, bodyObj: Record<string, unknown>,
        { user = owner, scope = SCOPE_FOR_OP[op], issuer = COMPUTER_TOOLS_STAGING_MCP }: { user?: string; scope?: string; issuer?: string } = {}) {
        const raw = JSON.stringify(bodyObj);
        const material = [COMPUTER_TOOLS_PROTOCOL, 'POST', routePath, raw].join('\n');
        const n = Math.floor(Date.now() / 1000);
        const assertion = await signAssertion(signer, {
            iss: issuer, aud: COMPUTER_TOOLS_STAGING_OS, sub: user, idp_iss: SUPABASE_ISSUER, client_id: CLIENT_ID,
            scope, proc: procedureForOp(op), inp: inputDigest(material), jti: randomUUID(), iat: n, exp: n + 60,
        });
        return new Request(COMPUTER_TOOLS_STAGING_OS + routePath, {
            method: 'POST', body: raw, headers: { authorization: `EZiL-Delegation ${assertion}`, 'content-type': 'application/json' },
        });
    }
    const forwardedOps = () =>
        (worker.mock.calls as unknown as [unknown, RequestInit][]).map((c) => JSON.parse(String(c[1].body)).op as string);
    const rowsFor = (requestId: string) => client.unsafe<Record<string, unknown>[]>(
        'SELECT * FROM public.ezil_computer_tool_jobs WHERE request_id = $1::uuid ORDER BY created_at ASC', [requestId]);

    it('applied the migration: table, jti and partial-request unique indexes, RLS', async () => {
        const [table] = await client.unsafe("SELECT to_regclass('public.ezil_computer_tool_jobs') AS t");
        expect(table?.t).toBe('ezil_computer_tool_jobs');
        const idx = await client.unsafe<{ indexdef: string }[]>(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'ezil_computer_tool_jobs'");
        const defs = idx.map((r) => r.indexdef).join('\n');
        expect(defs).toMatch(/UNIQUE INDEX ezil_computer_tool_jobs_jti_key/);
        expect(defs).toMatch(/computer_id, procedure, request_id\)\s*WHERE \(\(request_id IS NOT NULL\) AND \(replay_of IS NULL\)\)/);
        const [rls] = await client.unsafe<{ relrowsecurity: boolean }[]>(
            "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ezil_computer_tool_jobs'::regclass");
        expect(rls?.relrowsecurity).toBe(true);
    });

    it('rejects a wrong scope (401) and a non-owner (404), the non-owner still auditing one row', async () => {
        const wrong = await post(await signed('exec', { op: 'exec', command: 'id', timeoutSeconds: 120, background: false, requestId: randomUUID() }, { scope: 'ezil:computer-tools:read' }));
        expect(wrong.status).toBe(401);
        expect(worker).not.toHaveBeenCalled();

        const strangerReq = randomUUID();
        const res = await post(await signed('exec', { op: 'exec', command: 'id', timeoutSeconds: 120, background: false, requestId: strangerReq }, { user: stranger }));
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('computer_not_found');
        expect(worker).not.toHaveBeenCalled();
        const rows = await rowsFor(strangerReq);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: stranger, error: 'computer_not_found', job_id: null });
    });

    it('writes exactly one row per verified call and never stores the full command, its secrets, or output', async () => {
        const requestId = randomUUID();
        const token = `ghp_${'z'.repeat(36)}`;
        const command = `export GITHUB_TOKEN=${token} && run ${'x'.repeat(100)} TAILMARKER`; // > 120 chars, with a credential
        const res = await post(await signed('exec', { op: 'exec', command, timeoutSeconds: 120, background: false, requestId }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, jobId: JOB, state: 'exited' });
        expect(forwardedOps()).toEqual(['exec']);
        const rows = await rowsFor(requestId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            user_id: owner, computer_id: computer, procedure: 'computerTools.exec', scope: 'ezil:terminal:run',
            replay_of: null, job_id: JOB, state: 'exited', exit_code: 0, error: null,
        });
        expect(rows[0]!.command_sha256).toMatch(/^[0-9a-f]{64}$/);
        const prefix = String(rows[0]!.command_prefix);
        expect(prefix.length).toBeLessThanOrEqual(120);
        expect(prefix).toContain('export'); // a readable, bounded preview survives
        const dump = JSON.stringify(rows[0]);
        expect(dump).not.toContain(token); // the credential is redacted
        expect(dump).not.toContain('TAILMARKER'); // the tail past 120 chars is never stored (full command absent)
        expect(dump).not.toContain('secret-output-not-stored'); // stdout/stderr are never written to the ledger
    });

    it('forwards a same-body replay as op "job" (never re-executing) and links replay_of to the original', async () => {
        const requestId = randomUUID();
        const bodyObj = { op: 'exec', command: 'echo hi', timeoutSeconds: 120, background: false, requestId };
        expect((await post(await signed('exec', bodyObj))).status).toBe(200);
        const replay = await post(await signed('exec', bodyObj));
        expect(replay.status).toBe(200);
        expect(forwardedOps()).toEqual(['exec', 'job']); // the replay polled, it did not re-run
        const rows = await rowsFor(requestId);
        expect(rows).toHaveLength(2);
        const original = rows.find((r) => r.replay_of === null)!;
        const replayRow = rows.find((r) => r.replay_of !== null)!;
        expect(original).toBeTruthy();
        expect(replayRow.replay_of).toBe(original.id);
        expect(replayRow.job_id).toBe(JOB);
    });

    it('a different body under a reused requestId is 409 request_conflict with a linked replay row', async () => {
        const requestId = randomUUID();
        expect((await post(await signed('exec', { op: 'exec', command: 'first', timeoutSeconds: 120, background: false, requestId }))).status).toBe(200);
        const conflict = await post(await signed('exec', { op: 'exec', command: 'second', timeoutSeconds: 120, background: false, requestId }));
        expect(conflict.status).toBe(409);
        expect((await conflict.json()).error).toBe('request_conflict');
        const rows = await rowsFor(requestId);
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.replay_of !== null)).toMatchObject({ error: 'request_conflict' });
    });

    it('two concurrent first calls never both execute: one originating row, exactly one exec forward', async () => {
        const requestId = randomUUID();
        const bodyObj = { op: 'exec', command: 'echo race', timeoutSeconds: 120, background: false, requestId };
        const [a, b] = await Promise.all([post(await signed('exec', bodyObj)), post(await signed('exec', bodyObj))]);
        expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
        const originals = await client.unsafe<Record<string, unknown>[]>(
            "SELECT id FROM public.ezil_computer_tool_jobs WHERE request_id = $1::uuid AND replay_of IS NULL", [requestId]);
        expect(originals).toHaveLength(1);
        expect(forwardedOps().filter((op) => op === 'exec')).toHaveLength(1);
        const rows = await rowsFor(requestId);
        expect(rows).toHaveLength(2);
    });
});

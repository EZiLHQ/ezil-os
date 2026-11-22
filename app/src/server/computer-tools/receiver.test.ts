import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AuditEntry, AuditOutcome, ComputerToolsAudit, LostJobRecord, OriginalRow } from './audit';
import { handleComputerTools, type ComputerToolsDeps, type ForwardResult } from './receiver';

const COMPUTER = '11111111-1111-4111-8111-111111111111';
const PATH = `/api/mcp/computer-tools/${COMPUTER}`;
const SANDBOX = 'guac-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb';
const BINDING = 'c'.repeat(64);
const JOB = 'a'.repeat(22);

const principal = { userId: 'owner-1', clientId: 'client-1', scope: 'ezil:terminal:run', procedure: 'computerTools.exec', jti: 'jti-1' };
const target = { sandboxId: SANDBOX, binding: BINDING };

const sampleJob = (over: Record<string, unknown> = {}) => ({
    ok: true, jobId: JOB, kind: 'terminal', name: null, requestId: null, state: 'exited', exitCode: 0, signal: null,
    stdout: 'hi', stderr: '', stdoutBytes: 2, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
    startedAt: '2026-11-20T00:00:00.000Z', endedAt: '2026-11-20T00:00:01.000Z', timeoutSeconds: 120, background: false, ...over,
});
const sampleCatalog = { ok: true, catalogDigest: `sha256:${'0'.repeat(64)}`, tools: [], invalid: [] };

/** An in-memory audit with the real claim/replay semantics (the atomic DB fence is pg-tested). */
function fakeAudit() {
    const originals = new Map<string, { id: string; requestSha256: string | null; jobId: string | null }>();
    const rows: (AuditEntry & { id: string; replayOf: string | null } & Partial<AuditOutcome>)[] = [];
    const lost = new Map<string, LostJobRecord>();
    const key = (e: AuditEntry) => `${e.computerId}|${e.procedure}|${e.requestId}`;
    const audit: ComputerToolsAudit = {
        claimOriginal: vi.fn(async (entry: AuditEntry): Promise<{ claimed: true; id: string } | { claimed: false; original: OriginalRow }> => {
            const k = key(entry);
            const existing = originals.get(k);
            if (existing) return { claimed: false, original: { ...existing } };
            const id = `orig-${rows.length}`;
            const rec = { id, requestSha256: entry.requestSha256, jobId: null as string | null };
            originals.set(k, rec);
            rows.push({ ...entry, id, replayOf: null });
            return { claimed: true, id };
        }),
        finalize: vi.fn(async (id: string, outcome: AuditOutcome) => {
            const row = rows.find((r) => r.id === id);
            if (row) Object.assign(row, outcome);
            for (const o of originals.values()) if (o.id === id) o.jobId = outcome.jobId;
        }),
        record: vi.fn(async (entry: AuditEntry, replayOf: string | null, outcome: AuditOutcome) => {
            rows.push({ ...entry, id: `rec-${rows.length}`, replayOf, ...outcome });
        }),
        findExecutingJob: vi.fn(async (userId: string, computerId: string, jobId: string) => lost.get(`${userId}|${computerId}|${jobId}`) ?? null),
    };
    return Object.assign(audit, { rows, lost });
}

type Audit = ReturnType<typeof fakeAudit>;

function deps(over: Partial<ComputerToolsDeps> = {}): ComputerToolsDeps & { audit: Audit } {
    const audit = (over.audit as Audit | undefined) ?? fakeAudit();
    return {
        enabled: true,
        opEnabled: () => true,
        verify: vi.fn(async () => principal as typeof principal | null),
        resolveTarget: vi.fn(async () => target as typeof target | null),
        forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 200, text: JSON.stringify(sampleJob()) })),
        audit,
        ...over,
    } as ComputerToolsDeps & { audit: Audit };
}

function request(raw: string, { method = 'POST', search = '', contentType = 'application/json' as string | null } = {}) {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['content-type'] = contentType;
    const init: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') init.body = raw;
    return new Request(`https://os-staging.ezil.work${PATH}${search}`, init);
}

const execBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ op: 'exec', command: 'ls -la', timeoutSeconds: 120, background: false, requestId: randomUUID(), ...over });
const callBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ op: 'call', name: 'hello', arguments: {}, requestId: randomUUID(), ...over });
const jobBody = (over: Record<string, unknown> = {}) => JSON.stringify({ op: 'job', jobId: JOB, ...over });

async function body(res: Response) {
    return res.json() as Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;
}

describe('computer-tools receiver — gate', () => {
    it('hides the feature (404 tools_unavailable) when the op-independent pins are absent, before verification', async () => {
        const d = deps({ enabled: false });
        const res = await handleComputerTools(request(execBody()), d);
        expect(res.status).toBe(404);
        expect(await body(res)).toEqual({ ok: false, error: 'tools_unavailable' });
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(d.verify).not.toHaveBeenCalled();
    });

    it('refuses an op whose family switch is off (404 tools_unavailable) after parsing it, before verification', async () => {
        const d = deps({ opEnabled: vi.fn(() => false) });
        const res = await handleComputerTools(request(execBody()), d);
        expect(res.status).toBe(404);
        expect(await body(res)).toEqual({ ok: false, error: 'tools_unavailable' });
        expect(d.opEnabled).toHaveBeenCalledWith('exec');
        expect(d.verify).not.toHaveBeenCalled();
    });

    it('positive control: an enabled op reaches verification', async () => {
        const d = deps();
        await handleComputerTools(request(execBody()), d);
        expect(d.verify).toHaveBeenCalledOnce();
    });
});

describe('computer-tools receiver — transport and strict body (canonicality)', () => {
    it('refuses non-POST, query string, wrong content-type (400 tools_invalid_request) before verification', async () => {
        const d = deps();
        expect((await handleComputerTools(request(execBody(), { method: 'GET' }), d)).status).toBe(400);
        expect((await handleComputerTools(request(execBody(), { search: '?x=1' }), d)).status).toBe(400);
        expect((await handleComputerTools(request(execBody(), { contentType: 'text/plain' }), d)).status).toBe(400);
        expect((await handleComputerTools(request(execBody(), { contentType: null }), d)).status).toBe(400);
        expect(d.verify).not.toHaveBeenCalled();
        const res = await handleComputerTools(request(execBody(), { method: 'GET' }), d);
        expect(await body(res)).toEqual({ ok: false, error: 'tools_invalid_request' });
    });

    it('refuses malformed JSON, unknown op, extra keys, bad types and out-of-range fields', async () => {
        const d = deps();
        const bad = [
            'not json', '[]', '{}', '{"op":"nope"}',
            '{"op":"list","extra":1}',
            JSON.stringify({ op: 'call', name: 'x', arguments: [], requestId: randomUUID() }), // arguments not an object
            JSON.stringify({ op: 'call', name: 'x', arguments: {}, requestId: 'not-a-uuid' }),
            JSON.stringify({ op: 'call', name: 'x', arguments: {} }), // missing requestId
            execBody({ timeoutSeconds: 700 }), // foreground cap is 600
            execBody({ timeoutSeconds: 4000, background: true }), // > 3600
            execBody({ cwd: '/abs' }), // leading slash
            execBody({ cwd: '../escape' }), // parent segment
            execBody({ command: '' }), // empty command
            execBody({ command: 'a\u0000b' }), // NUL
            '{"op":"job","jobId":"short"}',
            JSON.stringify({ op: 'cancel', jobId: JOB }), // missing requestId
        ];
        for (const raw of bad) {
            const res = await handleComputerTools(request(raw), d);
            expect(res.status, raw).toBe(400);
            expect((await body(res)).error, raw).toBe('tools_invalid_request');
        }
        expect(d.verify).not.toHaveBeenCalled();
    });

    it('positive control: a well-formed exec with background allows a 3600 timeout', async () => {
        const d = deps();
        expect((await handleComputerTools(request(execBody({ timeoutSeconds: 3600, background: true })), d)).status).toBe(200);
    });

    it('binds the exact request bytes and the op-derived procedure/scope', async () => {
        const d = deps();
        const raw = execBody();
        await handleComputerTools(request(raw), d);
        expect(d.verify).toHaveBeenCalledWith(
            expect.any(Headers), `EZIL-COMPUTER-TOOLS/1\nPOST\n${PATH}\n${raw}`, 'computerTools.exec', 'ezil:terminal:run',
        );
    });
});

describe('computer-tools receiver — verification and target', () => {
    it('refuses a rejected delegation with 401 tools_unauthorized, writes no audit row and never resolves a target', async () => {
        const d = deps({ verify: vi.fn(async () => null) });
        const res = await handleComputerTools(request(execBody()), d);
        expect(res.status).toBe(401);
        expect(await body(res)).toEqual({ ok: false, error: 'tools_unauthorized' });
        expect(d.resolveTarget).not.toHaveBeenCalled();
        expect(d.audit.rows).toHaveLength(0);
    });

    it('returns 404 computer_not_found and one audit row, without forwarding, for a read and a sent op', async () => {
        const dRead = deps({ resolveTarget: vi.fn(async () => null) });
        const read = await handleComputerTools(request(JSON.stringify({ op: 'list' })), dRead);
        expect(read.status).toBe(404);
        expect(await body(read)).toEqual({ ok: false, error: 'computer_not_found' });
        expect(dRead.forward).not.toHaveBeenCalled();
        expect(dRead.audit.rows).toHaveLength(1);
        expect(dRead.audit.rows[0]).toMatchObject({ error: 'computer_not_found' });

        const dSent = deps({ resolveTarget: vi.fn(async () => null) });
        const sent = await handleComputerTools(request(execBody()), dSent);
        expect(sent.status).toBe(404);
        expect(dSent.forward).not.toHaveBeenCalled();
        expect(dSent.audit.rows).toHaveLength(1);
        expect(dSent.audit.rows[0]).toMatchObject({ error: 'computer_not_found' });
    });

    it('OSRCV-6: resolves ownership before the idempotency claim, and a refused call claims no slot', async () => {
        const order: string[] = [];
        const audit = fakeAudit();
        const claim = audit.claimOriginal;
        audit.claimOriginal = vi.fn(async (entry: AuditEntry) => { order.push('claim'); return claim(entry); }) as typeof audit.claimOriginal;
        const refused = deps({ audit, resolveTarget: vi.fn(async () => { order.push('resolve'); return null; }) });
        expect((await handleComputerTools(request(execBody()), refused)).status).toBe(404);
        expect(order).toEqual(['resolve']);
        expect(audit.claimOriginal).not.toHaveBeenCalled();
        // Audited without a requestId: it never ran, so it takes no part in idempotency.
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]).toMatchObject({ requestId: null, error: 'computer_not_found' });

        // Positive control: an owned computer resolves first, then claims.
        order.length = 0;
        const owned = deps({ audit, resolveTarget: vi.fn(async () => { order.push('resolve'); return target; }) });
        await handleComputerTools(request(execBody()), owned);
        expect(order.slice(0, 2)).toEqual(['resolve', 'claim']);
    });

    it("OSRCV-6: a lost-job lookup is scoped to the caller's own rows", async () => {
        const audit = fakeAudit();
        audit.lost.set(`someone-else|${COMPUTER}|${JOB}`, {
            procedure: 'computerTools.exec', toolName: null, requestId: 'req-x', exitCode: null,
            createdAt: '2026-11-20T00:00:00.000Z', completedAt: null,
        });
        const d = deps({ audit, forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 404, text: JSON.stringify({ ok: false, error: 'job_not_found' }) })) });
        const res = await handleComputerTools(request(jobBody()), d);
        expect(res.status).toBe(404);
        expect(audit.findExecutingJob).toHaveBeenCalledWith(principal.userId, COMPUTER, JOB);
    });
});

describe('computer-tools receiver — forward, relay and audit', () => {
    it('relays a successful list catalog, writing one audit row, and re-resolves the target for drift', async () => {
        const resolveTarget = vi.fn(async () => target as typeof target | null);
        const d = deps({ resolveTarget, forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 200, text: JSON.stringify(sampleCatalog) })) });
        const res = await handleComputerTools(request(JSON.stringify({ op: 'list' })), d);
        expect(res.status).toBe(200);
        expect(await body(res)).toEqual(sampleCatalog);
        expect(resolveTarget).toHaveBeenCalledTimes(2); // resolve, then drift re-resolve
        expect(d.audit.rows).toHaveLength(1);
        expect(d.audit.rows[0]).toMatchObject({ procedure: 'computerTools.list', state: null, error: null, requestId: null });
    });

    it('a refresh worker reply must carry previousDigest/changed — a bare catalog is a shape mismatch (computer_unavailable)', async () => {
        const d = deps({ forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 200, text: JSON.stringify(sampleCatalog) })) });
        const res = await handleComputerTools(request(JSON.stringify({ op: 'refresh' })), d);
        expect(res.status).toBe(503);
        expect(await body(res)).toEqual({ ok: false, error: 'computer_unavailable' });
    });

    it('relays a successful exec Job, forwards op without the op key, and audits jobId+state', async () => {
        const d = deps();
        const raw = execBody({ command: 'echo hi', cwd: 'src' });
        const res = await handleComputerTools(request(raw), d);
        expect(res.status).toBe(200);
        expect(await body(res)).toMatchObject({ ok: true, jobId: JOB, state: 'exited' });
        const [, computerId, fwdTarget, op, input] = (d.forward as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(computerId).toBe(COMPUTER);
        expect(fwdTarget).toEqual(target);
        expect(op).toBe('exec');
        expect(input).toEqual({ command: 'echo hi', cwd: 'src', timeoutSeconds: 120, background: false, requestId: expect.any(String) });
        expect(d.audit.rows[0]).toMatchObject({ jobId: JOB, state: 'exited', error: null, commandSha256: expect.any(String), commandPrefix: expect.any(String) });
    });

    it('never stores the full command: only its sha256 and a bounded, redacted prefix', async () => {
        const d = deps();
        const secret = 'ghp_' + 'A'.repeat(36);
        await handleComputerTools(request(execBody({ command: `curl -H "Authorization: Bearer ${secret}" https://x` })), d);
        const row = d.audit.rows[0]!;
        expect(row.commandPrefix).not.toContain(secret);
        expect(row.commandPrefix!.length).toBeLessThanOrEqual(120);
        expect(row.commandSha256).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('computer-tools receiver — worker error status table', () => {
    const cases: { body: () => string; status: number; error: string }[] = [
        { body: () => callBody(), status: 404, error: 'tool_not_found' },
        { body: () => callBody(), status: 429, error: 'terminal_jobs_busy' },
        { body: () => execBody(), status: 429, error: 'terminal_jobs_busy' },
        { body: () => execBody(), status: 400, error: 'tools_invalid_request' },
        { body: () => execBody(), status: 503, error: 'computer_unavailable' },
        { body: () => JSON.stringify({ op: 'list' }), status: 503, error: 'computer_unavailable' },
    ];
    it('relays exactly the allowed (status, error) pairs per op', async () => {
        for (const c of cases) {
            const d = deps({ forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: c.status, text: JSON.stringify({ ok: false, error: c.error }) })) });
            const res = await handleComputerTools(request(c.body()), d);
            expect(res.status, c.error).toBe(c.status);
            expect((await body(res)).error, c.error).toBe(c.error);
            expect(d.audit.rows.at(-1), c.error).toMatchObject({ error: c.error });
        }
    });

    it('rejects a disallowed (status, error) pairing as the op-correct uncertain fallback', async () => {
        // tool_not_found is not a legal worker error for a read; a 403; a 503 with the wrong string.
        const bad: { body: () => string; status: number; error: string; op: 'exec' | 'list' }[] = [
            { body: () => JSON.stringify({ op: 'list' }), status: 404, error: 'tool_not_found', op: 'list' },
            { body: () => execBody(), status: 403, error: 'computer_unavailable', op: 'exec' },
            { body: () => execBody(), status: 503, error: 'nonsense', op: 'exec' },
        ];
        for (const c of bad) {
            const d = deps({ forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: c.status, text: JSON.stringify({ ok: false, error: c.error }) })) });
            const res = await handleComputerTools(request(c.body()), d);
            expect(res.status, JSON.stringify(c)).toBe(503);
            expect((await body(res)).error, JSON.stringify(c)).toBe(c.op === 'exec' ? 'tools_uncertain' : 'computer_unavailable');
        }
    });
});

describe('computer-tools receiver — reply validation and uncertainty', () => {
    it('falls back (sent→tools_uncertain, read→computer_unavailable) on a network error, non-JSON, bad status or bad shape', async () => {
        const forwards: ForwardResult[] = [
            { kind: 'error' },
            { kind: 'reply', status: 200, text: 'not json' },
            { kind: 'reply', status: 200, text: JSON.stringify(sampleJob({ state: 'bogus' })) }, // invalid enum
            { kind: 'reply', status: 200, text: JSON.stringify({ ok: false, error: 'computer_unavailable' }) }, // ok:false at 200
            { kind: 'reply', status: 500, text: JSON.stringify({ ok: false, error: 'boom' }) }, // unrecognized status
        ];
        for (const f of forwards) {
            const dExec = deps({ forward: vi.fn(async () => f) });
            const execRes = await handleComputerTools(request(execBody()), dExec);
            expect(execRes.status, JSON.stringify(f)).toBe(503);
            expect((await body(execRes)).error, JSON.stringify(f)).toBe('tools_uncertain');

            const dList = deps({ forward: vi.fn(async () => f) });
            const listRes = await handleComputerTools(request(JSON.stringify({ op: 'list' })), dList);
            expect((await body(listRes)).error, JSON.stringify(f)).toBe('computer_unavailable');
        }
    });

    it('treats placement drift after a successful reply as 503 computer_unavailable, recording the job it ran', async () => {
        const resolveTarget = vi.fn()
            .mockResolvedValueOnce(target)
            .mockResolvedValueOnce({ sandboxId: SANDBOX, binding: 'd'.repeat(64) });
        const d = deps({ resolveTarget });
        const res = await handleComputerTools(request(execBody()), d);
        expect(res.status).toBe(503);
        expect(await body(res)).toEqual({ ok: false, error: 'computer_unavailable' });
        expect(d.audit.rows[0]).toMatchObject({ jobId: JOB, state: 'exited', error: 'computer_unavailable' });
    });
});

describe('computer-tools receiver — idempotency and replay', () => {
    it('a same-body replay polls the recorded job as op "job" (never re-executes) and writes a replay row', async () => {
        const audit = fakeAudit();
        const forward = vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 200, text: JSON.stringify(sampleJob()) }));
        const d = deps({ audit, forward });
        const raw = execBody();
        expect((await handleComputerTools(request(raw), d)).status).toBe(200);
        const second = await handleComputerTools(request(raw), d);
        expect(second.status).toBe(200);
        expect(forward).toHaveBeenCalledTimes(2);
        const calls = forward.mock.calls as unknown as [unknown, unknown, unknown, string, Record<string, unknown>][];
        expect(calls[0]![3]).toBe('exec');
        expect(calls[1]![3]).toBe('job'); // replay forwarded as job, not re-executed
        expect(calls[1]![4]).toEqual({ jobId: JOB });
        expect(audit.rows).toHaveLength(2);
        expect(audit.rows[1]).toMatchObject({ replayOf: audit.rows[0]!.id });
    });

    it('a different body under a reused requestId is 409 request_conflict and does not forward again', async () => {
        const audit = fakeAudit();
        const d = deps({ audit });
        const id = randomUUID();
        expect((await handleComputerTools(request(execBody({ requestId: id, command: 'one' })), d)).status).toBe(200);
        (d.forward as ReturnType<typeof vi.fn>).mockClear();
        const conflict = await handleComputerTools(request(execBody({ requestId: id, command: 'two' })), d);
        expect(conflict.status).toBe(409);
        expect(await body(conflict)).toEqual({ ok: false, error: 'request_conflict' });
        expect(d.forward).not.toHaveBeenCalled();
        expect(audit.rows.at(-1)).toMatchObject({ replayOf: audit.rows[0]!.id, error: 'request_conflict' });
    });

    it('a replay whose first attempt recorded no jobId is 503 tools_uncertain', async () => {
        const audit = fakeAudit();
        const d = deps({ audit, forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'error' })) });
        const raw = execBody();
        expect((await handleComputerTools(request(raw), d)).status).toBe(503); // first attempt: uncertain, no jobId
        const replay = await handleComputerTools(request(raw), d);
        expect(replay.status).toBe(503);
        expect(await body(replay)).toEqual({ ok: false, error: 'tools_uncertain' });
    });
});

describe('computer-tools receiver — lost job synthesis', () => {
    it('synthesizes a lost Job from the audit row when the worker 404s a jobId we hold', async () => {
        const audit = fakeAudit();
        audit.lost.set(`${principal.userId}|${COMPUTER}|${JOB}`, {
            procedure: 'computerTools.exec', toolName: null, requestId: 'req-x', exitCode: null,
            createdAt: '2026-11-20T00:00:00.000Z', completedAt: '2026-11-20T00:00:05.000Z',
        });
        const d = deps({ audit, forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 404, text: JSON.stringify({ ok: false, error: 'job_not_found' }) })) });
        const res = await handleComputerTools(request(jobBody()), d);
        expect(res.status).toBe(200);
        expect(await body(res)).toEqual({
            ok: true, jobId: JOB, kind: 'terminal', name: null, requestId: 'req-x', state: 'lost', exitCode: null, signal: null,
            stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
            startedAt: '2026-11-20T00:00:00.000Z', endedAt: '2026-11-20T00:00:05.000Z', timeoutSeconds: 0, background: false,
        });
    });

    it('relays the 404 job_not_found when the audit holds no such job', async () => {
        const d = deps({ forward: vi.fn(async (): Promise<ForwardResult> => ({ kind: 'reply', status: 404, text: JSON.stringify({ ok: false, error: 'job_not_found' }) })) });
        const res = await handleComputerTools(request(jobBody()), d);
        expect(res.status).toBe(404);
        expect(await body(res)).toEqual({ ok: false, error: 'job_not_found' });
    });
});

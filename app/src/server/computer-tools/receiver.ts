/**
 * Delegated computer-tools / terminal receiver (contract §3.2). Orchestrates one
 * `POST /api/mcp/computer-tools/<computerId>` end to end with injected dependencies:
 *
 *   gate (op-independent pins, then per-op switch) → transport → strict body/op → verify
 *   → one audit row per verified call → resolve target → forward to Worker → validate reply
 *   → idempotency (claim / replay / conflict) → drift re-check → relay or fail closed.
 *
 * Order of refusals (§3.1 status table): 404 `tools_unavailable` (gate) and 400
 * `tools_invalid_request` (transport/body) happen before any verification or send. A rejected
 * delegation is 401 `tools_unauthorized` and never falls back to "no credential". Everything
 * after a successful verification writes exactly one audit row, including refused/failed ones.
 */
import { createHash } from 'node:crypto';

import { readSmallBody } from '../browser-observe/receiver';

import type { AuditEntry, AuditOutcome, ComputerToolsAudit, LostJobRecord } from './audit';
import {
    ALLOWED_WORKER_ERRORS, COMPUTER_TOOLS_PATH, COMPUTER_TOOLS_PROTOCOL, MAX_REQUEST_BYTES,
    SCOPE_FOR_OP, SENT_OPS, type ComputerToolsBody, type ComputerToolsOp,
    inputWithoutOp, opYieldsJob, parseComputerToolsBody, procedureForOp, successSchemaForOp,
    uncertainErrorFor, workerErrorReply,
} from './contract';
import { commandPrefix } from './redaction';

export type ComputerToolsPrincipal = { userId: string; clientId: string; scope: string; procedure: string; jti: string };
export type ComputerToolsTarget = { sandboxId: string; binding: string };
export type ForwardResult = { kind: 'reply'; status: number; text: string } | { kind: 'error' };

export interface ComputerToolsDeps {
    /** Op-independent pins present (issuer/audience/Worker URL/secret). */
    enabled: boolean;
    /** The per-op family switch (EZIL_DELEGATED_COMPUTER_TOOLS / EZIL_DELEGATED_TERMINAL), read per request. */
    opEnabled: (op: ComputerToolsOp) => boolean;
    verify: (headers: Headers, serializedInput: string, procedure: string, scope: string) => Promise<ComputerToolsPrincipal | null>;
    resolveTarget: (principal: ComputerToolsPrincipal, computerId: string) => Promise<ComputerToolsTarget | null>;
    forward: (
        principal: ComputerToolsPrincipal, computerId: string, target: ComputerToolsTarget,
        op: ComputerToolsOp, input: Record<string, unknown>,
    ) => Promise<ForwardResult>;
    audit: ComputerToolsAudit;
}

const sha256hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function reply(payload: unknown, status: number): Response {
    return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}
function fail(error: string, status: number): Response {
    return reply({ ok: false, error }, status);
}

interface Context {
    op: ComputerToolsOp;
    body: ComputerToolsBody;
    computerId: string;
    raw: string;
    principal: ComputerToolsPrincipal;
    procedure: string;
    scope: string;
}

export async function handleComputerTools(request: Request, deps: ComputerToolsDeps): Promise<Response> {
    // Op-independent gate first: an undeployed feature is hidden (§3.2 "off → 404 tools_unavailable").
    if (!deps.enabled) return fail('tools_unavailable', 404);

    const url = new URL(request.url);
    const computerId = COMPUTER_TOOLS_PATH.exec(url.pathname)?.[1];
    if (request.method !== 'POST' || url.search !== '' || !computerId
        || request.headers.get('content-type') !== 'application/json') {
        return fail('tools_invalid_request', 400);
    }

    let raw: string;
    let parsed: ReturnType<typeof parseComputerToolsBody>;
    try {
        raw = await readSmallBody(request, MAX_REQUEST_BYTES);
        parsed = parseComputerToolsBody(JSON.parse(raw));
    } catch {
        return fail('tools_invalid_request', 400);
    }
    if (!parsed) return fail('tools_invalid_request', 400);
    const { op, body } = parsed;

    // Per-op family switch, after the op is known and before verification.
    if (!deps.opEnabled(op)) return fail('tools_unavailable', 404);

    const procedure = procedureForOp(op);
    const scope = SCOPE_FOR_OP[op];
    const serializedInput = [COMPUTER_TOOLS_PROTOCOL, 'POST', url.pathname, raw].join('\n');

    const principal = await deps.verify(request.headers, serializedInput, procedure, scope);
    if (!principal) return fail('tools_unauthorized', 401);

    const ctx: Context = { op, body, computerId, raw, principal, procedure, scope };
    try {
        return SENT_OPS.has(op) ? await handleSent(deps, ctx) : await handleRead(deps, ctx);
    } catch {
        // A failure after verification (e.g. the audit/DB is unavailable): fail closed, do not re-execute.
        return fail(uncertainErrorFor(op), 503);
    }
}

/** The immutable audit identity for this verified call. */
function entryFor(ctx: Context): AuditEntry {
    const hasRequest = SENT_OPS.has(ctx.op);
    const command = ctx.op === 'exec' ? (ctx.body as { command: string }).command : null;
    return {
        userId: ctx.principal.userId, computerId: ctx.computerId, clientId: ctx.principal.clientId,
        jti: ctx.principal.jti, procedure: ctx.procedure, scope: ctx.scope,
        requestId: hasRequest ? (ctx.body as { requestId: string }).requestId : null,
        requestSha256: hasRequest ? sha256hex(ctx.raw) : null,
        toolName: ctx.op === 'call' ? (ctx.body as { name: string }).name : null,
        commandSha256: command !== null ? sha256hex(command) : null,
        commandPrefix: command !== null ? commandPrefix(command) : null,
    };
}

/** list / refresh / job: not idempotent-keyed; one audit row written with the outcome. */
async function handleRead(deps: ComputerToolsDeps, ctx: Context): Promise<Response> {
    const entry = entryFor(ctx);
    const target = await deps.resolveTarget(ctx.principal, ctx.computerId);
    if (!target) {
        await deps.audit.record(entry, null, notFoundOutcome());
        return fail('computer_not_found', 404);
    }
    const input = inputWithoutOp(ctx.body);
    const queriedJobId = ctx.op === 'job' ? String(input.jobId) : null;
    const forwarded = await deps.forward(ctx.principal, ctx.computerId, target, ctx.op, input);
    const result = await interpret(deps, ctx, target, ctx.op, forwarded, queriedJobId);
    await deps.audit.record(entry, null, result.outcome);
    return result.response;
}

/** call / exec / cancel: claim the (computer, procedure, requestId) slot atomically, then execute or replay. */
async function handleSent(deps: ComputerToolsDeps, ctx: Context): Promise<Response> {
    const entry = entryFor(ctx);
    const claim = await deps.audit.claimOriginal(entry);
    if (claim.claimed) {
        const target = await deps.resolveTarget(ctx.principal, ctx.computerId);
        if (!target) {
            await deps.audit.finalize(claim.id, notFoundOutcome());
            return fail('computer_not_found', 404);
        }
        const input = inputWithoutOp(ctx.body);
        const queriedJobId = ctx.op === 'cancel' ? String(input.jobId) : null;
        const forwarded = await deps.forward(ctx.principal, ctx.computerId, target, ctx.op, input);
        const result = await interpret(deps, ctx, target, ctx.op, forwarded, queriedJobId);
        await deps.audit.finalize(claim.id, result.outcome);
        return result.response;
    }

    // Replay: never re-execute. Same body → poll the recorded job as op `job`; different body → conflict.
    const { original } = claim;
    if (original.requestSha256 !== entry.requestSha256) {
        await deps.audit.record(entry, original.id, { jobId: null, state: null, exitCode: null, error: 'request_conflict' });
        return fail('request_conflict', 409);
    }
    if (original.jobId === null) {
        // The first attempt recorded no jobId (concurrent in-flight, or it failed before a job existed): unknown.
        await deps.audit.record(entry, original.id, { jobId: null, state: null, exitCode: null, error: 'tools_uncertain' });
        return fail('tools_uncertain', 503);
    }
    const target = await deps.resolveTarget(ctx.principal, ctx.computerId);
    if (!target) {
        await deps.audit.record(entry, original.id, { jobId: original.jobId, state: null, exitCode: null, error: 'computer_not_found' });
        return fail('computer_not_found', 404);
    }
    const forwarded = await deps.forward(ctx.principal, ctx.computerId, target, 'job', { jobId: original.jobId });
    const result = await interpret(deps, ctx, target, 'job', forwarded, original.jobId);
    await deps.audit.record(entry, original.id, result.outcome);
    return result.response;
}

const notFoundOutcome = (): AuditOutcome => ({ jobId: null, state: null, exitCode: null, error: 'computer_not_found' });

/**
 * Validate the Worker reply strictly against the forwarded op's shape and the status table, then
 * decide the response and the audit outcome. `forwardedOp` is `job` for a replay; the uncertain
 * fallback keys off the ORIGINAL op (`ctx.op`). On a 200 success, the target is re-resolved and
 * drift is 503 `computer_unavailable`. A `job_not_found` for a jobId we hold becomes a lost Job.
 */
async function interpret(
    deps: ComputerToolsDeps, ctx: Context, target: ComputerToolsTarget,
    forwardedOp: ComputerToolsOp, forwarded: ForwardResult, queriedJobId: string | null,
): Promise<{ response: Response; outcome: AuditOutcome }> {
    const fallbackError = uncertainErrorFor(ctx.op);
    const fallback = (): { response: Response; outcome: AuditOutcome } => ({
        response: fail(fallbackError, 503),
        outcome: { jobId: null, state: null, exitCode: null, error: fallbackError },
    });

    if (forwarded.kind === 'error') return fallback();
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(forwarded.text);
    } catch {
        return fallback();
    }

    if (forwarded.status === 200) {
        const success = successSchemaForOp(forwardedOp).safeParse(parsedBody);
        if (!success.success) return fallback();
        const value = success.data as Record<string, unknown> & { jobId?: string; state?: string; exitCode?: number | null };
        const job = opYieldsJob(forwardedOp)
            ? { jobId: value.jobId ?? null, state: value.state ?? null, exitCode: value.exitCode ?? null }
            : { jobId: null, state: null, exitCode: null };

        const fresh = await deps.resolveTarget(ctx.principal, ctx.computerId);
        if (!fresh || fresh.binding !== target.binding || fresh.sandboxId !== target.sandboxId) {
            return { response: fail('computer_unavailable', 503), outcome: { ...job, error: 'computer_unavailable' } };
        }
        return { response: reply(value, 200), outcome: { ...job, error: null } };
    }

    const err = workerErrorReply.safeParse(parsedBody);
    if (!err.success || ALLOWED_WORKER_ERRORS[forwardedOp].get(forwarded.status) !== err.data.error) return fallback();
    const error = err.data.error;

    if (error === 'job_not_found' && queriedJobId) {
        const lost = await deps.audit.findExecutingJob(ctx.computerId, queriedJobId);
        if (lost) {
            const body = synthesizeLostJob(queriedJobId, lost);
            return { response: reply(body, 200), outcome: { jobId: queriedJobId, state: 'lost', exitCode: body.exitCode, error: null } };
        }
        return { response: fail('job_not_found', 404), outcome: { jobId: queriedJobId, state: null, exitCode: null, error: 'job_not_found' } };
    }

    return { response: fail(error, forwarded.status), outcome: { jobId: null, state: null, exitCode: null, error } };
}

/** The Job shape for a jobId toolsd has forgotten (§5.2): state `lost`, empty output, fields from the audit row. */
function synthesizeLostJob(jobId: string, lost: LostJobRecord) {
    return {
        ok: true as const,
        jobId,
        kind: lost.procedure === 'computerTools.call' ? ('tool' as const) : ('terminal' as const),
        name: lost.toolName,
        requestId: lost.requestId,
        state: 'lost' as const,
        exitCode: lost.exitCode,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: lost.createdAt,
        endedAt: lost.completedAt,
        timeoutSeconds: 0,
        background: false,
    };
}

/**
 * Wire contract for the delegated computer-tools / terminal receiver
 * (`EZIL-COMPUTER-TOOLS/1`, frozen contract §§2.2, 3.1, 3.2, 5.3, 5.4).
 *
 * Staging only: every op is off by default and the receiver works only on the exact
 * `connect-staging → os-staging → api-desktop-staging` pins below. This module owns the
 * strict request grammar, the op → procedure/scope map (the delegation policy), the
 * strict Worker-reply shapes, and the per-request gate predicates. It names no database,
 * environment mutation or network. `app/src/server/browser-observe/*` is NOT imported.
 */
import { z } from 'zod';

import type { DelegationPolicy } from '@/server/api/delegation-core';

// ── Pins ───────────────────────────────────────────────────────────────────
export const COMPUTER_TOOLS_STAGING_MCP = 'https://connect-staging.ezil.work';
export const COMPUTER_TOOLS_STAGING_OS = 'https://os-staging.ezil.work';
export const COMPUTER_TOOLS_STAGING_WORKER = 'https://api-desktop-staging.ezil.work';
export const COMPUTER_TOOLS_PROTOCOL = 'EZIL-COMPUTER-TOOLS/1';
export const COMPUTER_TOOLS_TARGET_PURPOSE = 'ezil-computer-tools-v1';
export const COMPUTER_TOOLS_PATH =
    /^\/api\/mcp\/computer-tools\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

/** Bounds (§3.1, §3.3). */
export const MAX_REQUEST_BYTES = 32_768;
export const MAX_WORKER_REPLY_BYTES = 524_288;
export const FORWARD_TIMEOUT_MS = 15_000;
/** Secret-redacted command prefix stored in the audit (§5.4). */
export const MAX_COMMAND_PREFIX = 120;

// ── Ops, procedures, scopes ──────────────────────────────────────────────────
export const COMPUTER_TOOLS_OPS = ['list', 'refresh', 'call', 'exec', 'job', 'cancel'] as const;
export type ComputerToolsOp = (typeof COMPUTER_TOOLS_OPS)[number];

const SCOPE_READ = 'ezil:computer-tools:read';
const SCOPE_CALL = 'ezil:computer-tools:call';
const SCOPE_TERMINAL = 'ezil:terminal:run';

/** `computerTools.<op>`; the MCP signs the same string in its `proc` claim. */
export const procedureForOp = (op: ComputerToolsOp): string => `computerTools.${op}`;

export const SCOPE_FOR_OP: Readonly<Record<ComputerToolsOp, string>> = {
    list: SCOPE_READ, refresh: SCOPE_READ, call: SCOPE_CALL,
    exec: SCOPE_TERMINAL, job: SCOPE_TERMINAL, cancel: SCOPE_TERMINAL,
};

/** The policy handed to `verifyDelegation`: procedure → the one exact scope it requires (§3.1). */
export const COMPUTER_TOOLS_DELEGATION_POLICY: DelegationPolicy = {
    scopeByProcedure: new Map(COMPUTER_TOOLS_OPS.map((op) => [procedureForOp(op), SCOPE_FOR_OP[op]] as const)),
};

/** `tools` family (list/refresh/call) vs `terminal` family (exec/job/cancel) — the two OS gate switches. */
export type ToolFamily = 'tools' | 'terminal';
export const FAMILY_FOR_OP: Readonly<Record<ComputerToolsOp, ToolFamily>> = {
    list: 'tools', refresh: 'tools', call: 'tools',
    exec: 'terminal', job: 'terminal', cancel: 'terminal',
};

/** call/exec/cancel are "sent" ops: an uncertain outcome is `tools_uncertain`. Reads use `computer_unavailable`. */
export const SENT_OPS: ReadonlySet<ComputerToolsOp> = new Set(['call', 'exec', 'cancel']);
export const uncertainErrorFor = (op: ComputerToolsOp): 'tools_uncertain' | 'computer_unavailable' =>
    SENT_OPS.has(op) ? 'tools_uncertain' : 'computer_unavailable';

// ── Gate (§3.2) ──────────────────────────────────────────────────────────────
export type ComputerToolsEnv = Record<string, string | undefined>;

/** Op-independent pins: the exact staging issuer/audience, Worker origin and a present HMAC secret. */
export function computerToolsConfigured(env: ComputerToolsEnv): boolean {
    return env.EZIL_DELEGATION_ISSUER === COMPUTER_TOOLS_STAGING_MCP
        && env.EZIL_DELEGATION_AUDIENCE === COMPUTER_TOOLS_STAGING_OS
        && env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.replace(/\/$/, '') === COMPUTER_TOOLS_STAGING_WORKER
        && Boolean(env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim());
}

/** The per-op family switch (read per request). `tools` → EZIL_DELEGATED_COMPUTER_TOOLS, `terminal` → EZIL_DELEGATED_TERMINAL. */
export function opSwitchEnabled(env: ComputerToolsEnv, op: ComputerToolsOp): boolean {
    return FAMILY_FOR_OP[op] === 'tools'
        ? env.EZIL_DELEGATED_COMPUTER_TOOLS === 'enabled'
        : env.EZIL_DELEGATED_TERMINAL === 'enabled';
}

// ── Strict request grammar (§2.2, §3.1) ──────────────────────────────────────
/** A JSON object (never an array or primitive); `arguments` is advisory and opaque to the OS. */
const jsonObject = z.custom<Record<string, unknown>>(
    (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    { message: 'expected a JSON object' },
);
const requestId = z.string().uuid();
const jobId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const command = z.string().min(1).max(8_000).refine((c) => !c.includes('\u0000'), { message: 'command must not contain NUL' });
const relativeCwd = z.string().max(512).refine(
    (c) => !c.startsWith('/') && !c.split('/').includes('..') && !/[\u0000-\u001f\u007f]/.test(c),
    { message: 'cwd must be a relative workspace path with no "/" prefix or ".." segment' },
);

const listRequest = z.object({ op: z.literal('list') }).strict();
const refreshRequest = z.object({ op: z.literal('refresh') }).strict();
const callRequest = z.object({
    op: z.literal('call'), name: z.string().min(1).max(64), arguments: jsonObject, requestId,
}).strict();
const execRequest = z.object({
    op: z.literal('exec'), command, cwd: relativeCwd.optional(),
    timeoutSeconds: z.number().int().min(1).max(3_600), background: z.boolean(), requestId,
}).strict().superRefine((data, ctx) => {
    if (!data.background && data.timeoutSeconds > 600) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timeoutSeconds'], message: 'foreground timeoutSeconds is at most 600' });
    }
});
const jobRequest = z.object({ op: z.literal('job'), jobId }).strict();
const cancelRequest = z.object({ op: z.literal('cancel'), jobId, requestId }).strict();

const REQUEST_SCHEMAS: Readonly<Record<ComputerToolsOp, z.ZodTypeAny>> = {
    list: listRequest, refresh: refreshRequest, call: callRequest,
    exec: execRequest, job: jobRequest, cancel: cancelRequest,
};

export type CallBody = z.infer<typeof callRequest>;
export type ExecBody = z.infer<typeof execRequest>;
export type JobBody = z.infer<typeof jobRequest>;
export type CancelBody = z.infer<typeof cancelRequest>;
export type ComputerToolsBody = z.infer<typeof listRequest> | z.infer<typeof refreshRequest> | CallBody | ExecBody | JobBody | CancelBody;

/**
 * Parse one request body strictly (op first, exact keys per op). Returns the op and the
 * parsed body, or null for anything malformed — the receiver maps null to 400
 * `tools_invalid_request`. `op` is read before any other key so the procedure can be
 * derived before verification (§3.2).
 */
export function parseComputerToolsBody(value: unknown): { op: ComputerToolsOp; body: ComputerToolsBody } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const op = (value as { op?: unknown }).op;
    if (typeof op !== 'string' || !(COMPUTER_TOOLS_OPS as readonly string[]).includes(op)) return null;
    const parsed = REQUEST_SCHEMAS[op as ComputerToolsOp].safeParse(value);
    return parsed.success ? { op: op as ComputerToolsOp, body: parsed.data as ComputerToolsBody } : null;
}

/** The forwarded `input` is the body without `op` (§3.3). */
export function inputWithoutOp(body: ComputerToolsBody): Record<string, unknown> {
    const input: Record<string, unknown> = { ...body };
    delete input.op;
    return input;
}

// ── Strict Worker-reply grammar (§2.2, §5.3) ─────────────────────────────────
const toolState = z.enum(['running', 'exited', 'timed_out', 'cancelled', 'lost']);
const catalogDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const toolEntry = z.object({
    name: z.string(), description: z.string(), inputSchema: jsonObject,
    timeoutSeconds: z.number().int(), source: z.literal('computer'),
}).strict();
const catalogShape = {
    catalogDigest, tools: z.array(toolEntry).max(32),
    invalid: z.array(z.object({ dir: z.string(), error: z.string() }).strict()).max(32),
};
const jobShape = {
    jobId, kind: z.enum(['tool', 'terminal']), name: z.string().nullable(), requestId: z.string().nullable(),
    state: toolState, exitCode: z.number().int().nullable(), signal: z.string().nullable(),
    stdout: z.string(), stderr: z.string(), stdoutBytes: z.number().int(), stderrBytes: z.number().int(),
    stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
    startedAt: z.string(), endedAt: z.string().nullable(), timeoutSeconds: z.number().int(), background: z.boolean(),
};

const workerListSuccess = z.object({ ok: z.literal(true), ...catalogShape }).strict();
const workerRefreshSuccess = z.object({ ok: z.literal(true), ...catalogShape, previousDigest: z.string().nullable(), changed: z.boolean() }).strict();
const workerCallSuccess = z.object({ ok: z.literal(true), ...jobShape, catalogDigest }).strict();
const workerJobSuccess = z.object({ ok: z.literal(true), ...jobShape }).strict();

export const workerErrorReply = z.object({ ok: z.literal(false), error: z.string() }).strict();
export type WorkerJob = z.infer<typeof workerJobSuccess>;

/** The strict success schema expected for a given forwarded op (`job` for replays). */
export function successSchemaForOp(op: ComputerToolsOp): z.ZodTypeAny {
    switch (op) {
        case 'list': return workerListSuccess;
        case 'refresh': return workerRefreshSuccess;
        case 'call': return workerCallSuccess;
        default: return workerJobSuccess; // exec, job, cancel
    }
}

/** Whether a Worker success reply for this op carries a Job (every op but list/refresh). */
export const opYieldsJob = (op: ComputerToolsOp): boolean => op !== 'list' && op !== 'refresh';

/**
 * The only Worker (status, error) pairs the OS relays for a given forwarded op; anything
 * else is an uncertain/unavailable fallback (§3.1 status table). Keyed by the FORWARDED op.
 */
export const ALLOWED_WORKER_ERRORS: Readonly<Record<ComputerToolsOp, ReadonlyMap<number, string>>> = {
    list: new Map([[503, 'computer_unavailable']]),
    refresh: new Map([[503, 'computer_unavailable']]),
    call: new Map([[404, 'tool_not_found'], [429, 'terminal_jobs_busy'], [503, 'computer_unavailable']]),
    exec: new Map([[400, 'tools_invalid_request'], [429, 'terminal_jobs_busy'], [503, 'computer_unavailable']]),
    job: new Map([[404, 'job_not_found'], [503, 'computer_unavailable']]),
    cancel: new Map([[404, 'job_not_found'], [503, 'computer_unavailable']]),
};

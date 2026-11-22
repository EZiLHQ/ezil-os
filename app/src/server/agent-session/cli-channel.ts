/**
 * `POST /api/editor-bridge/v1/cli` — the in-computer `ezil chat` CLI reaching its
 * EZiL Chat sessions (`ws2-contract-cfda97e.md` §7, item 4).
 *
 * A SIBLING of the editor sync (`./sync-route.ts`): the Worker verifies the
 * computer's own editor-bridge boot token, then forwards the body signed with
 * the shared Worker secret over a DISTINCT label:
 *
 *   x-ezil-signature: v1=hex(HMAC-SHA256(secret, `editor-cli.v1.<ts>.<sandbox>.<sha256 hex body>`))
 *
 * The label is the separation that matters: a sync signature (`editor-bridge.v1.…`)
 * never verifies here and a CLI signature never verifies on the sync route.
 *
 * Unlike the sync, this channel ENQUEUES work — it calls the very same OS services
 * as the tRPC procedures `agentSession.create / send / list / events`, so a CLI
 * session is the same `ezil_control_operations` / `ezil_agent_operations` record
 * the MCP `list_sessions` reads. The caller is the person operating their own
 * computer, so the OAuth client id is `''` (what `clientOf` returns for a person's
 * own session). Everything is scoped to the computer the sandbox resolves to and
 * its current owner: a session of another owner OR another computer is
 * `session_not_found`. Off (404 `cli_unavailable`) unless
 * `editorDelegationEnabled(env) && EZIL_EDITOR_CLI === "enabled"`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { ControlCaller, ControlRow, CreateInput } from './control-store';
import { SessionStoreError, type Op, type SessionDb, type SessionEvent, type SessionRow, type SqlExecutor } from './store';

export const EDITOR_CLI_MAX_BODY_BYTES = 32 * 1024;
export const EDITOR_CLI_MAX_SKEW_SECONDS = 60;
const SANDBOX = /^guac-([0-9a-f]{16})-([0-9a-f]{16})$/;
/** Caller-supplied v4 UUID (the `browser_action` regex), never generated server-side. */
const uuidV4 = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
/** sessionId: any UUID, matching `agentSession.*`'s `z.string().uuid()`. */
const sessionId = z.string().uuid();
/** A model token exactly as the agentSession router bounds it. */
const model = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/);
const effort = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);

/** The strict `{op, args, requestId}` envelope; `requestId` doubles as the services' idempotency key. */
const cliRequest = z.discriminatedUnion('op', [
    z.object({ op: z.literal('chat.new'), args: z.object({ model: model.optional(), effort: effort.optional() }).strict(), requestId: uuidV4 }).strict(),
    z.object({ op: z.literal('chat.send'), args: z.object({ sessionId, text: z.string().min(1).max(16_384) }).strict(), requestId: uuidV4 }).strict(),
    z.object({ op: z.literal('chat.list'), args: z.object({}).strict(), requestId: uuidV4 }).strict(),
    z.object({ op: z.literal('chat.read'), args: z.object({ sessionId, cursor: z.number().int().min(0).optional() }).strict(), requestId: uuidV4 }).strict(),
]);
type CliRequest = z.infer<typeof cliRequest>;

export const editorCliPayload = (timestamp: string, sandbox: string, body: Uint8Array) =>
    `editor-cli.v1.${timestamp}.${sandbox}.${createHash('sha256').update(body).digest('hex')}`;

/** `v1=hex(HMAC-SHA256(secret, editor-cli.v1.<ts>.<sandbox>.<sha256 hex body>))` — the DISTINCT label, matching the Worker. */
export function signEditorCli(secret: string, timestamp: string, sandbox: string, body: Uint8Array): string {
    return `v1=${createHmac('sha256', secret).update(editorCliPayload(timestamp, sandbox, body)).digest('hex')}`;
}

/** The services behind `agentSession.create / send / list / events`, injected so the unit test can drive the channel. */
export interface CliChannelServices {
    create(db: SessionDb, caller: ControlCaller, input: CreateInput): Promise<ControlRow>;
    send(db: SessionDb, caller: ControlCaller, input: { sessionId: string; text: string; idempotencyKey: string }): Promise<Op>;
    list(db: SqlExecutor, userId: string, computerId?: string): Promise<SessionRow[]>;
    getSession(db: SqlExecutor, userId: string, sessionId: string): Promise<SessionRow>;
    events(db: SqlExecutor, userId: string, sessionId: string, after?: number, limit?: number): Promise<{ events: SessionEvent[]; next: number | null }>;
}

export interface CliChannelDeps {
    db: SessionDb;
    /** `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`; the signature cannot be verified without it. */
    secret: string | undefined;
    /** `editorDelegationEnabled(env) && EZIL_EDITOR_CLI === "enabled"`, read per request. */
    enabled: boolean;
    now: () => number;
    /** Resolve a sandbox name to exactly one `{id, userId}`, the way the sync does (`computerForSandbox`). */
    computerForSandbox(db: SqlExecutor, sandbox: string): Promise<{ id: string; userId: string } | null>;
    services: CliChannelServices;
}

/** The person's own session: no OAuth client, exactly what `clientOf` returns for a signed-in person. */
const CLI_CLIENT_ID = '';

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const ok = (result: Record<string, unknown>) => reply(200, { ok: true, result });
const err = (status: number, error: string) => reply(status, { ok: false, error });

async function readBody(request: Request): Promise<Uint8Array | null> {
    if (Number(request.headers.get('content-length') ?? 0) > EDITOR_CLI_MAX_BODY_BYTES) return null;
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > EDITOR_CLI_MAX_BODY_BYTES) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** `SessionStoreError` → the channel's enumerated codes; anything else re-thrown to the 500 catch. */
function mapStoreError(error: unknown): Response {
    if (error instanceof SessionStoreError) {
        // NOT_FOUND: the session (or its still-owned computer) is gone → session_not_found.
        if (error.code === 'NOT_FOUND') return err(404, 'session_not_found');
        // BAD_REQUEST (bad text, effort_not_per_session) and CONFLICT (requestId reused with a different body)
        // are both the caller's fault: cli_invalid_request.
        return err(400, 'cli_invalid_request');
    }
    throw error;
}

/** The session must be this owner's AND on the sandbox's computer; otherwise `session_not_found`. */
async function sessionOnComputer(deps: CliChannelDeps, caller: ControlCaller, computerId: string, id: string): Promise<SessionRow | Response> {
    let session: SessionRow;
    try {
        session = await deps.services.getSession(deps.db, caller.userId, id);
    } catch (error) {
        if (error instanceof SessionStoreError && error.code === 'NOT_FOUND') return err(404, 'session_not_found');
        throw error;
    }
    if (session.computerId !== computerId) return err(404, 'session_not_found');
    return session;
}

async function dispatch(deps: CliChannelDeps, computer: { id: string; userId: string }, parsed: CliRequest): Promise<Response> {
    const caller: ControlCaller = { userId: computer.userId, clientId: CLI_CLIENT_ID };
    switch (parsed.op) {
        case 'chat.new': {
            let row: ControlRow;
            try {
                row = await deps.services.create(deps.db, caller,
                    { computerId: computer.id, model: parsed.args.model, effort: parsed.args.effort, idempotencyKey: parsed.requestId });
            } catch (error) {
                return mapStoreError(error);
            }
            // The two states the editor's own condition makes final for a create:
            if (row.status === 'disconnected') return err(409, 'editor_disconnected');
            if (row.reason === 'editor_controls_unsupported') return err(409, 'editor_controls_unsupported');
            return ok({ sessionId: row.sessionId, operationId: row.id, status: row.status });
        }
        case 'chat.send': {
            const gate = await sessionOnComputer(deps, caller, computer.id, parsed.args.sessionId);
            if (gate instanceof Response) return gate;
            let op: Op;
            try {
                op = await deps.services.send(deps.db, caller, { sessionId: parsed.args.sessionId, text: parsed.args.text, idempotencyKey: parsed.requestId });
            } catch (error) {
                return mapStoreError(error);
            }
            return ok({ sessionId: op.sessionId, operationId: op.id, status: op.status });
        }
        case 'chat.list': {
            const sessions = await deps.services.list(deps.db, caller.userId, computer.id);
            return ok({ sessions });
        }
        case 'chat.read': {
            const gate = await sessionOnComputer(deps, caller, computer.id, parsed.args.sessionId);
            if (gate instanceof Response) return gate;
            const { events, next } = await deps.services.events(deps.db, caller.userId, parsed.args.sessionId, parsed.args.cursor ?? 0);
            return ok({ sessionId: parsed.args.sessionId, events, cursor: next });
        }
    }
}

export async function handleEditorCli(request: Request, deps: CliChannelDeps): Promise<Response> {
    if (!deps.enabled) return err(404, 'cli_unavailable');
    // method/content-type/size are not among the enumerated channel errors; the Worker only ever sends a bounded
    // POST application/json, so any violation is a malformed request: 400 cli_invalid_request.
    if (request.method !== 'POST') return err(400, 'cli_invalid_request');

    const sandbox = request.headers.get('x-ezil-sandbox') ?? '';
    const timestamp = request.headers.get('x-ezil-timestamp') ?? '';
    const signature = request.headers.get('x-ezil-signature') ?? '';
    if (!SANDBOX.test(sandbox) || !/^\d{1,12}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)
        || Math.abs(deps.now() / 1000 - Number(timestamp)) > EDITOR_CLI_MAX_SKEW_SECONDS) {
        return err(401, 'cli_unauthorized');
    }

    let body: Uint8Array | null;
    try {
        body = await readBody(request);
    } catch {
        return err(400, 'cli_invalid_request');
    }
    if (body === null) return err(400, 'cli_invalid_request');

    // A present-but-invalid signature is 401, never "no credential": without the secret nothing can verify.
    if (!deps.secret) return err(401, 'cli_unauthorized');
    const expected = Buffer.from(signEditorCli(deps.secret, timestamp, sandbox, body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return err(401, 'cli_unauthorized');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
        return err(400, 'cli_invalid_request');
    }

    let parsed: CliRequest;
    try {
        parsed = cliRequest.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
    } catch {
        return err(400, 'cli_invalid_request');
    }

    try {
        const computer = await deps.computerForSandbox(deps.db, sandbox);
        if (!computer) return err(404, 'cli_unavailable');
        return await dispatch(deps, computer, parsed);
    } catch (error) {
        console.error(JSON.stringify({ event: 'ezil_editor_cli_error', op: parsed.op, message: error instanceof Error ? error.message : 'unknown' }));
        return err(500, 'cli_internal');
    }
}

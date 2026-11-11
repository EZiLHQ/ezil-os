/**
 * `POST /api/editor-bridge/v1/sync` — the editor in one computer syncing its
 * EZiL Chat sessions (EZiL MCP CONTRACT.md v3.0).
 *
 * Only the Worker calls this. The Worker first verifies the computer's own
 * boot-scoped token (the same one the editor already uses for `/ai/v1`, rotated
 * on every boot), then forwards the body signed with the shared Worker secret:
 *
 *   x-ezil-sandbox:   guac-<user16>-<computer16>
 *   x-ezil-timestamp: unix seconds (within 60 s)
 *   x-ezil-signature: v1=hex(HMAC-SHA256(secret, `editor-bridge.v1.<ts>.<sandbox>.<sha256 hex of body>`))
 *
 * The sandbox name must resolve to exactly one live computer, and everything
 * the sync touches is that computer's and its current owner's. Each sync carries
 * a per-owner sequence number, so a replayed or reordered request is refused. Nothing here can enqueue work: that is
 * only the person's side (`agentSession.send`). Off unless EZIL_EDITOR_BRIDGE
 * is "enabled" and the Worker secret is set.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
    EDITOR_REPORTS,
    EDITOR_REPORTS_V2,
    MAX_REPORTS,
    MAX_RESPONSE_CHARS,
    MAX_SESSIONS,
    syncEditor,
    type SessionDb,
    type SqlExecutor,
} from './store';

export const EDITOR_SYNC_MAX_BODY_BYTES = 256 * 1024;
export const EDITOR_SYNC_MAX_SKEW_SECONDS = 60;
const SANDBOX = /^guac-([0-9a-f]{16})-([0-9a-f]{16})$/;

export const editorSyncPayload = (timestamp: string, sandbox: string, body: Uint8Array) =>
    `editor-bridge.v1.${timestamp}.${sandbox}.${createHash('sha256').update(body).digest('hex')}`;

export function signEditorSync(secret: string, timestamp: string, sandbox: string, body: Uint8Array): string {
    return `v1=${createHmac('sha256', secret).update(editorSyncPayload(timestamp, sandbox, body)).digest('hex')}`;
}

/** Protocol 1, byte for byte what OS has always accepted: a protocol-1 body carrying anything of protocol 2 is refused. */
const sessionV1 = z.object({
    resource: z.string().min(1).max(2048),
    title: z.string().max(512),
    open: z.boolean(),
    status: z.enum(['idle', 'running', 'unknown']),
}).strict();
const reportV1 = z.object({
    operationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    status: z.enum(EDITOR_REPORTS),
    reason: z.string().regex(/^[a-z_]{1,64}$/).optional(),
    requestId: z.string().max(256).optional(),
    mode: z.string().max(64).optional(),
    selectedModelId: z.string().max(256).optional(),
    responseText: z.string().max(MAX_RESPONSE_CHARS).optional(),
}).strict();
const head = {
    ownerId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    epoch: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const bodyV1 = z.object({
    protocol: z.literal(1), ...head,
    sessions: z.array(sessionV1).max(MAX_SESSIONS).optional(),
    reports: z.array(reportV1).max(MAX_REPORTS).optional(),
}).strict();

/** Protocol 2 (docs/EDITOR-BRIDGE-PROTOCOL-2.md): the same, plus each session's model and the catalog, and `applied` reports. */
const modelToken = z.string().min(1).max(256);
const catalogRow = z.object({
    id: modelToken,
    label: z.string().max(128),
    engine: z.literal('ezil-chat'),
    // No per-session effort exists in this editor: a row offering one is refused, never read as true.
    efforts: z.array(z.never()).max(0),
    defaultEffort: z.null(),
    configuredEffort: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).nullable(),
    // Not sent by the shipped editor. Only a row carrying it can ever be attested as this account's (control-store.ts).
    availability: z.literal('available').optional(),
}).strict();
const catalog = z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), models: z.array(catalogRow).max(100), observedAt: z.number().int().min(0) }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.string().regex(/^[a-z_]{1,64}$/), observedAt: z.number().int().min(0) }).strict(),
]);
const bodyV2 = z.object({
    protocol: z.literal(2), ...head,
    sessions: z.array(sessionV1.extend({ model: modelToken.nullable(), requests: z.number().int().min(0).nullable() }).strict()).max(MAX_SESSIONS).optional(),
    reports: z.array(reportV1.extend({
        status: z.enum(EDITOR_REPORTS_V2),
        sessionResource: z.string().min(1).max(2048).optional(),
        model: modelToken.nullable().optional(),
        requestCount: z.number().int().min(0).optional(),
        observedAt: z.number().int().min(0).optional(),
    }).strict()).max(MAX_REPORTS).optional(),
    catalog: catalog.optional(),
}).strict();
const effortToken = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);
const catalogRowV3 = catalogRow.extend({ efforts: z.array(effortToken).max(16), defaultEffort: effortToken.nullable() })
    .refine(row => new Set(row.efforts).size === row.efforts.length && (row.defaultEffort === null || row.efforts.includes(row.defaultEffort)));
const bodyV3 = bodyV2.extend({ protocol: z.literal(3),
    sessions: z.array(sessionV1.extend({ model: modelToken.nullable(), effort: effortToken.nullable(), requests: z.number().int().min(0).nullable() }).strict()).max(MAX_SESSIONS).optional(),
    reports: z.array(reportV1.extend({ status: z.enum(EDITOR_REPORTS_V2), sessionResource: z.string().min(1).max(2048).optional(),
        model: modelToken.nullable().optional(), effort: effortToken.nullable().optional(), selectedEffort: effortToken.nullable().optional(),
        requestCount: z.number().int().min(0).optional(), observedAt: z.number().int().min(0).optional() }).strict()).max(MAX_REPORTS).optional(),
    catalog: z.discriminatedUnion('status', [z.object({ status:z.literal('available'), models:z.array(catalogRowV3).max(100), observedAt:z.number().int().min(0) }).strict(),
        z.object({ status:z.literal('unavailable'), reason:z.string().regex(/^[a-z_]{1,64}$/), observedAt:z.number().int().min(0) }).strict()]).optional(),
}).strict();
const syncBody = z.discriminatedUnion('protocol', [bodyV1, bodyV2, bodyV3]);

export interface EditorSyncDeps {
    db: SessionDb;
    secret: string | undefined;
    enabled: string | undefined;
    /**
     * `enabled` once migration 0025 is applied: only then is protocol 2 answered and acted on. Off, a protocol-2 body is
     * accepted (so a window that already upgraded keeps syncing) but handled, and answered, as protocol 1.
     */
    controls?: string | undefined;
    /** Enable only after 0026 and protocol-3 readers are qualified. */
    effort?: string | undefined;
    now: () => number;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
    if (Number(request.headers.get('content-length') ?? 0) > EDITOR_SYNC_MAX_BODY_BYTES) return null;
    if (!request.body) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > EDITOR_SYNC_MAX_BODY_BYTES) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** Exactly one live computer for this sandbox name, or null (none, deleted, or an ambiguous prefix). */
export async function computerForSandbox(db: SqlExecutor, sandbox: string): Promise<{ id: string; userId: string } | null> {
    const match = SANDBOX.exec(sandbox);
    if (!match) return null;
    const rows = await db.execute(sql`/* editor-bridge:computer */
        SELECT id::text AS id, user_id::text AS user_id FROM public.ezil_computers
        WHERE deleted_at IS NULL
          AND left(replace(lower(user_id::text), '-', ''), 16) = ${match[1]!}
          AND left(replace(lower(id::text), '-', ''), 16) = ${match[2]!}
        LIMIT 2`);
    if (rows.length !== 1) return null;
    return { id: String(rows[0]!.id), userId: String(rows[0]!.user_id) };
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function handleEditorSync(request: Request, deps: EditorSyncDeps): Promise<Response> {
    if (deps.enabled !== 'enabled' || !deps.secret?.trim()) return reply(503, { error: 'editor_bridge_disabled' });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const sandbox = request.headers.get('x-ezil-sandbox') ?? '';
    const timestamp = request.headers.get('x-ezil-timestamp') ?? '';
    const signature = request.headers.get('x-ezil-signature') ?? '';
    if (!SANDBOX.test(sandbox) || !/^\d{1,12}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)
        || Math.abs(deps.now() / 1000 - Number(timestamp)) > EDITOR_SYNC_MAX_SKEW_SECONDS) {
        return reply(401, { error: 'invalid_signature' });
    }
    let body: Uint8Array | null;
    try {
        body = await readBody(request);
    } catch {
        return reply(400, { error: 'invalid_body' });
    }
    if (body === null) return reply(413, { error: 'body_too_large' });
    const expected = Buffer.from(signEditorSync(deps.secret, timestamp, sandbox, body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return reply(401, { error: 'invalid_signature' });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
        return reply(415, { error: 'unsupported_media_type' });
    }

    let parsed: z.infer<typeof syncBody>;
    try {
        parsed = syncBody.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
    } catch {
        return reply(400, { error: 'invalid_sync' });
    }
    try {
        const computer = await computerForSandbox(deps.db, sandbox);
        if (!computer) return reply(404, { error: 'unknown_computer' });
        const controls = deps.controls === 'enabled';
        const effort = controls && deps.effort === 'enabled';
        const result = await syncEditor(deps.db, computer, parsed, { controls, effort });
        if (result.owner === 'gone') return reply(404, { error: 'unknown_computer' });
        if (result.owner === 'replayed') return reply(409, { error: 'replayed_sync' });
        console.info(JSON.stringify({
            event: 'ezil_editor_sync', computer_id: computer.id, owner: result.owner,
            epoch: result.owner === 'self' ? result.epoch : null, delivered: result.owner === 'self' ? result.deliver.length : 0,
            reports: parsed.reports?.length ?? 0, applied: result.owner === 'self' ? result.applied : 0,
        }));
        return reply(200, { ok: true, protocol: effort && parsed.protocol === 3 ? 3 : controls ? 2 : 1, ...(effort ? { supportedProtocols: [1, 2, 3] } : {}), ...result });
    } catch {
        return reply(500, { error: 'sync_failed' });
    }
}

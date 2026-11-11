/**
 * "agentSession" tRPC Router — EZiL Chat sessions in the person's own
 * computers, reached through the editor bridge (EZiL MCP CONTRACT.md v3.0).
 *
 * Reads: list / get / events / operation, plus the MCP session controls' models / settings / control.
 * Writes: send / cancel, and the controls' create / configure, each with an
 * idempotency key. Everything is owner-scoped: another person's session or
 * operation is NOT_FOUND, exactly like a missing one. The EZiL MCP reaches
 * these only through `delegationGate` (ezil:sessions:read / :write).
 *
 * v3.0 resumes only sessions the editor reported; it never creates one. An
 * instruction runs in the session's own pane with that pane's mode, model and
 * tool approvals, and waits at most QUEUE_TTL_MS for a connected editor.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
    configureSession,
    createSession,
    getControl,
    listModels,
    sessionSettings,
} from '@/server/agent-session/control-store';
import {
    cancelOperation,
    getOperation,
    getSession,
    listEvents,
    listSessions,
    sendInstruction,
    SessionStoreError,
    type SessionDb,
} from '@/server/agent-session/store';

import { clientOf, controlCall } from '../control-call';
import { createTRPCRouter, protectedProcedure } from '../trpc';

const uuid = z.string().uuid();

/** A model or effort token (never free text): what the editor catalog names, bounded and without control characters. */
const model = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/);
const effort = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/);

async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof SessionStoreError) throw new TRPCError({ code: error.code });
        throw error;
    }
}

export const agentSessionRouter = createTRPCRouter({
    list: protectedProcedure
        .input(z.object({ computerId: uuid.optional() }).strict().optional())
        .query(({ ctx, input }) => run(() => listSessions(ctx.db, ctx.user.id, input?.computerId))),

    get: protectedProcedure
        .input(z.object({ sessionId: uuid }).strict())
        .query(({ ctx, input }) => run(() => getSession(ctx.db, ctx.user.id, input.sessionId))),

    events: protectedProcedure
        .input(z.object({ sessionId: uuid, after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() }).strict())
        .query(({ ctx, input }) => run(() => listEvents(ctx.db, ctx.user.id, input.sessionId, input.after ?? 0, input.limit ?? 50))),

    operation: protectedProcedure
        .input(z.object({ operationId: uuid }).strict())
        .query(({ ctx, input }) => run(() => getOperation(ctx.db, ctx.user.id, input.operationId))),

    /** EZiL MCP session controls (proposals/session-controls.md): the editor-allowed catalog, or unavailable with a reason and no models. */
    models: protectedProcedure
        .input(z.object({ computerId: uuid }).strict())
        .query(({ ctx, input }) => run(() => listModels(ctx.db, ctx.user.id, input.computerId))),

    /** Owner-scoped runtime readback only: `settings` is null unless a connected editor reported it. */
    settings: protectedProcedure
        .input(z.object({ sessionId: uuid }).strict())
        .query(({ ctx, input }) => run(() => sessionSettings(ctx.db, ctx.user.id, input.sessionId))),

    /** The stored outcome of an earlier create or configure by this client under a key, for the MCP's retry reconciliation. */
    control: protectedProcedure
        .input(z.object({ kind: z.enum(['create', 'configure']), idempotencyKey: uuid }).strict())
        .query(({ ctx, input }) => run(() => getControl(ctx.db, { userId: ctx.user.id, clientId: clientOf(ctx) }, input))),

    create: protectedProcedure
        .input(z.object({ computerId: uuid, model: model.optional(), effort: effort.optional(), idempotencyKey: uuid }).strict())
        .mutation(({ ctx, input }) => controlCall(ctx, 'agentSession.create', input.idempotencyKey, () =>
            createSession(ctx.db as unknown as SessionDb, { userId: ctx.user.id, clientId: clientOf(ctx) }, input))),

    configure: protectedProcedure
        .input(z.object({ sessionId: uuid, model: model.optional(), effort: effort.optional(), idempotencyKey: uuid }).strict()
            .refine((value) => value.model !== undefined || value.effort !== undefined, { message: 'Nothing to change' }))
        .mutation(({ ctx, input }) => controlCall(ctx, 'agentSession.configure', input.idempotencyKey, () =>
            configureSession(ctx.db as unknown as SessionDb, { userId: ctx.user.id, clientId: clientOf(ctx) }, input))),

    send: protectedProcedure
        .input(z.object({ sessionId: uuid, text: z.string().min(1).max(16_384), idempotencyKey: uuid }).strict())
        .mutation(({ ctx, input }) => run(() =>
            sendInstruction(ctx.db as unknown as SessionDb, { userId: ctx.user.id, clientId: clientOf(ctx) }, input))),

    cancel: protectedProcedure
        .input(z.object({ operationId: uuid, idempotencyKey: uuid }).strict())
        .mutation(({ ctx, input }) => run(() =>
            cancelOperation(ctx.db as unknown as SessionDb, { userId: ctx.user.id, clientId: clientOf(ctx) }, input))),
});

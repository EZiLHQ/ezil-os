import { z } from 'zod';

import { validateInferenceTrace } from '../ai-traces/contract.js';
import { assessmentChatContent } from './chat-content.js';
import { assessmentTerminalCommands } from './terminal-commands.js';

export const consentVersion = 'assignment-evidence-v2';
export const legacyConsentVersion = 'assignment-evidence-v1';
export const attemptLifetimeMs = 6 * 60 * 60 * 1000;
export const maxAttemptEvents = 10_000;
export const uuid = z.string().uuid().transform(value => value.toLowerCase());

const ref = z.string().max(255).regex(/^refs\/heads\/[a-zA-Z0-9._/-]+$/)
    .refine(value => !value.includes('..') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')));
const repositoryUrl = z.string().regex(/^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}\.git$/)
    .refine(value => !value.includes('..'));

export const pilotSchema = z.object({
    id: uuid,
    ownerId: uuid,
    computerId: uuid,
    repositoryId: z.string().regex(/^[a-z0-9]{1,64}$/),
    repositoryUrl,
    ref,
    baseSha: z.string().regex(/^[a-f0-9]{40}$/).refine(value => !/^0+$/.test(value)),
    captureChat: z.boolean().optional(),
}).strict();

export type EvidencePilot = z.infer<typeof pilotSchema>;

export function readEvidencePilot(env: Record<string, string | undefined>): EvidencePilot | null {
    const funding = env.BILLING_FUNDING_URL;
    if (funding !== 'https://ai-staging.ezil.work' && funding !== 'https://ai-staging.ezil.work/') return null;
    const config = env.EZIL_ASSIGNMENT_EVIDENCE_PILOT;
    if (!config || config.length > 2048) return null;
    try {
        const parsed = pilotSchema.safeParse(JSON.parse(config));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

const appDetail = z.object({ app: z.literal('code') }).strict();
const safePath = z.string().min(1).max(240).regex(/^[a-zA-Z0-9_. /-]+$/).refine(path =>
    path.split('/').every(part => part && part !== '.' && part !== '..'
        && !/^\.(?:env|git)(?:[.-]|$)/i.test(part)
        && !/(?:\.pem|\.key|\.p12|\.pfx|\.kdbx|^id_(?:rsa|ed25519)|credentials|secrets?)/i.test(part)));
const occurredAt = z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)));
const baseEvent = z.object({ id: uuid, occurredAt });
const openedFile = z.object({ path: safePath }).strict();
const reviewedFile = z.object({
    path: safePath,
    startLine: z.number().int().min(1).max(2_000_000),
    endLine: z.number().int().min(1).max(2_000_000),
}).strict().refine(value => value.endLine >= value.startLine);
const modelResult = z.object({
    requestId: uuid,
    model: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/i)
        .refine(value => !/secret|token|passw|bearer|credential|cookie|session|api.?key|[a-z0-9]{32,}/i.test(value)),
    outcome: z.enum(['completed', 'failed', 'cancelled']),
    trace: z.unknown().optional(),
}).strict().transform((value, context) => {
    if (value.trace === undefined) return { requestId: value.requestId, model: value.model, outcome: value.outcome };
    const trace = validateInferenceTrace(value.trace);
    if (!trace || trace.requestId !== value.requestId || trace.modelAlias !== value.model || trace.outcome !== value.outcome) {
        context.addIssue({ code: 'custom', message: 'The inference trace does not match its request.' });
        return z.NEVER;
    }
    return { requestId: value.requestId, model: value.model, outcome: value.outcome, trace };
});
const shape = <K extends string, S extends z.ZodTypeAny>(kind: K, detail: S) =>
    baseEvent.extend({ kind: z.literal(kind), detail }).strict();

const chatRequestId = z.string().regex(/^request_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)
    .transform(value => value.toLowerCase());
const chatContent = z.discriminatedUnion('contentStatus', [
    z.object({ chatRequestId, contentStatus: z.literal('captured'), text: z.string().min(1).max(16 * 1024) }).strict(),
    z.object({ chatRequestId, contentStatus: z.enum(['unavailable', 'over_limit', 'withheld']) }).strict(),
]).transform(value => value.contentStatus === 'captured'
    ? { chatRequestId: value.chatRequestId, ...assessmentChatContent(value.text) }
    : value);
const terminalCompletion = z.object({
    executionId: uuid,
    command: z.string().max(120).nullable().transform(value => value !== null && assessmentTerminalCommands.includes(value) ? value : null),
    exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
    durationMs: z.number().int().min(0).max(attemptLifetimeMs).nullable(),
}).strict();

export const eventSchema = z.discriminatedUnion('kind', [
    shape('app.opened', appDetail),
    shape('app.focused', appDetail),
    shape('app.minimized', appDetail),
    shape('app.restored', appDetail),
    shape('app.closed', appDetail),
    shape('activity.resumed', z.object({}).strict()),
    shape('activity.visibility', z.object({ state: z.enum(['foreground', 'background']) }).strict()),
    shape('code.file_opened', openedFile),
    shape('code.file_reviewed', reviewedFile),
    shape('model.completed', modelResult),
    shape('chat.prompt_submitted', chatContent),
    shape('chat.response_completed', chatContent),
    shape('chat.request_retried', z.object({ chatRequestId, retryChatRequestId: chatRequestId }).strict()
        .refine(value => value.chatRequestId !== value.retryChatRequestId)),
    shape('chat.gateway_linked', z.object({ chatRequestId, requestId: uuid }).strict()),
    shape('terminal.command_finished', terminalCompletion),
]);

export const commandSchema = z.discriminatedUnion('action', [
    z.object({
        action: z.literal('start'), computerId: uuid,
        consentVersion: z.enum([legacyConsentVersion, consentVersion]),
        captureChat: z.boolean().optional(),
    }).strict(),
    z.object({ action: z.literal('append'), attemptId: uuid, events: z.array(eventSchema).min(1).max(40) }).strict(),
    z.object({ action: z.literal('end'), attemptId: uuid }).strict(),
]).superRefine((command, context) => {
    if (command.action === 'append' && new Set(command.events.map(event => event.id)).size !== command.events.length) {
        context.addIssue({ code: 'custom', path: ['events'], message: 'Event IDs must be distinct within a batch.' });
    }
});

export type AssignmentEvidenceEvent = z.infer<typeof eventSchema>;
export type EvidenceCommand = z.infer<typeof commandSchema>;

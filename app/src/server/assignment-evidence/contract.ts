import { z } from 'zod';

export const consentVersion = 'assignment-evidence-v1';
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
}).strict();
const shape = <K extends string, S extends z.ZodTypeAny>(kind: K, detail: S) =>
    baseEvent.extend({ kind: z.literal(kind), detail }).strict();

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
]);

export const commandSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('start'), computerId: uuid, consentVersion: z.literal(consentVersion) }).strict(),
    z.object({ action: z.literal('append'), attemptId: uuid, events: z.array(eventSchema).min(1).max(40) }).strict(),
    z.object({ action: z.literal('end'), attemptId: uuid }).strict(),
]).superRefine((command, context) => {
    if (command.action === 'append' && new Set(command.events.map(event => event.id)).size !== command.events.length) {
        context.addIssue({ code: 'custom', path: ['events'], message: 'Event IDs must be distinct within a batch.' });
    }
});

export type AssignmentEvidenceEvent = z.infer<typeof eventSchema>;
export type EvidenceCommand = z.infer<typeof commandSchema>;

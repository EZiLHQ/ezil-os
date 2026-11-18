/**
 * Feedback wire contract — AUTHORITATIVE (`docs/FEEDBACK-CONTROLS-CONTRACT.md` §3).
 * The shell builds exactly this shape; the route parses with these schemas and
 * nothing else. Every object is `.strict()`: an unknown key is a 400, never
 * silently stored.
 */
import { z } from 'zod';

export const FEEDBACK_CATEGORIES = ['bug', 'idea', 'other'] as const;
export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const FEEDBACK_LIMITS = Object.freeze({
    descriptionMax: 4000,
    descriptionPreview: 140,
    bodyBytesNoScreenshot: 32 * 1024,
    bodyBytesWithScreenshot: Math.floor(2.5 * 1024 * 1024),
    imageBytesMax: Math.floor(1.5 * 1024 * 1024),
    imageSideMax: 4096,
    /** Images per report (`screenshots`). Their decoded total stays inside the unchanged 2.5 MiB body and 3 MB proxy limit. */
    imagesMax: 5,
    imagesBytesTotal: Math.floor(1.75 * 1024 * 1024),
    /** FEEDBACK-DIAG: per recent event; see `sanitizeDiagnostics` for the shape allowlist. */
    recentEventReasonMax: 96,
    recentEventCorrelationIdMax: 64,
    /** At most this many recent events (the newest) keep a reason/correlation id. */
    recentEventsAnnotatedMax: 10,
    /** Upload-first: a staged image must be this fresh when its report is finalized; a re-PUT renews it. */
    stagedImageFreshMs: 3_600_000,
    /** Upload-first: staged images that never became a report are deleted after this. */
    stagedImageTtlMs: 86_400_000,
    /** Upload-first: tickets (reports not yet finalized) one user may hold staged images for at once. */
    stagedTicketsPerUser: 3,
    perUserPerHour: 10,
    perUserPerDay: 30,
    globalAttachmentBytesPerDay: 500 * 1024 * 1024,
    globalAttachmentBytesTotal: 5 * 1024 * 1024 * 1024,
    listMax: 50,
});

export const FEEDBACK_RETENTION_DAYS = Object.freeze({ attachments: 30, reports: 180, accessLog: 365 });

const short = (max: number) => z.string().max(max);
const int = z.number().int().min(0).max(1_000_000_000);

/** App-failure v1: keep aligned with FEEDBACK-APP-FAILURES-CONTRACT.md §§2–3. */
export const APP_FAILURE_CODES = {
    interrupted: ['stream_interrupted'],
    network: ['network_offline', 'network_failed'],
    timeout: ['request_timeout', 'first_token_timeout'],
    auth: ['auth_expired', 'auth_invalid', 'session_expired'],
    credits: ['credits_exhausted'],
    entitlement: ['membership_required', 'model_not_entitled'],
    rate_limit: ['rate_limited'],
    provider: ['provider_error', 'provider_overloaded', 'provider_refused', 'model_unavailable'],
    cancellation: ['request_cancelled'],
    app_startup: ['app_start_failed', 'app_start_timeout', 'chat_unavailable'],
} as const;

export const APP_FAILURE_REQUEST_ID_FIELDS = [
    'clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'retryOfClientRequestId',
] as const;

export const APP_FAILURE_LIMITS = Object.freeze({ recordsMax: 10, ageMsMax: 1_800_000 });

const MODEL_KEY = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;
/**
 * Provider namespaces a catalog model key may start with (`ns/model` or
 * `ns.model`). There is no static model catalog in this repo, so the
 * namespace is the allowlist; a producer omits any other key.
 */
export const MODEL_KEY_NAMESPACES = Object.freeze([
    'anthropic', 'openai', 'google', 'gemini', 'vertex', 'bedrock', 'aws-bedrock', 'amazon', 'azure',
    'qwen', 'moonshot', 'moonshotai', 'kimi', 'zai', 'z-ai', 'glm', 'deepseek', 'mistral', 'meta', 'llama',
    'xai', 'cohere', 'minimax', 'groq', 'cerebras', 'openrouter', 'ezil',
]);
const NAMESPACES = new Set<string>(MODEL_KEY_NAMESPACES);
/** Model families a bare key (no namespace) may start with, e.g. `claude-sonnet-5-5`, `ezil-fast`. */
export const MODEL_KEY_FAMILIES = Object.freeze([
    'claude', 'gemini', 'gpt', 'qwen', 'kimi', 'glm', 'deepseek', 'mistral', 'codestral', 'llama', 'grok',
    'nova', 'ezil', 'minimax', 'command', 'sonar',
]);
const FAMILIES = new Set<string>(MODEL_KEY_FAMILIES);
const REGION = /^(?:us|eu|apac|global|au|jp)\./;
const TOKEN_WORD = /secret|token|passw|bearer|api[-_]?key|private|credential|session|cookie/;
const TOKEN_PREFIX = /^(?:sk|sb|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_]/;

/**
 * A catalog-shaped model key and nothing that could be a credential, path or
 * URL: an optional region prefix, then an allowlisted provider namespace or a
 * bare key of an allowlisted model family, with model segments (split on `/`,
 * `.`, `:`) none of which looks like a token. Dated keys stay valid.
 * Mirrored in shell/ezil/ui/feedback/app-failures.js; contract §2.
 */
export function isSafeModelKey(value: unknown): value is string {
    // `$` also matches before a final newline, hence the explicit exact test.
    if (typeof value !== 'string' || !MODEL_KEY.test(value) || value !== value.trim()) return false;
    if (value.includes('://') || value.split('/').length > 2) return false;
    // An optional inference-region prefix, then `ns/model`, `ns.model` or a bare family key.
    const key = value.replace(REGION, '');
    const match = /^([a-z0-9-]+)[/.](.+)$/.exec(key);
    let model: string;
    if (match && NAMESPACES.has(match[1]!)) model = match[2]!;
    else if (FAMILIES.has(/^[a-z]+/.exec(key)?.[0] ?? '')) model = key;
    else return false;
    const segments = model.split(/[/.:]/);
    if (segments.some(segment => !segment || TOKEN_PREFIX.test(segment) || TOKEN_WORD.test(segment)
        || /[a-z0-9]{20,}/.test(segment))) return false;
    // The model name itself carries a version or a family separator.
    return /[0-9-]/.test(segments[0]!);
}

const appFailureId = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The strict server record includes the shell's app and age, never producer context. */
export const appFailureRecordSchema = z.object({
    eventId: appFailureId,
    source: z.enum(['ezil_chat', 'code_app']),
    operation: z.enum(['chat_request', 'app_start']),
    category: z.enum(['interrupted', 'network', 'timeout', 'auth', 'credits', 'entitlement', 'rate_limit', 'provider', 'cancellation', 'app_startup']),
    code: z.enum(['unexpected_error', ...Object.values(APP_FAILURE_CODES).flat()]),
    stage: z.enum(['startup', 'admission', 'request', 'headers', 'stream']),
    outcome: z.enum(['failed', 'retrying', 'recovered', 'cancelled']),
    streamReason: z.enum(['eof', 'malformed_event', 'missing_terminal']).optional(),
    cancellationSource: z.enum(['caller', 'user_stop', 'unknown']).optional(),
    clientRequestId: appFailureId.optional(),
    gatewayRequestId: appFailureId.optional(),
    vscodeRequestId: appFailureId.optional(),
    retryOfClientRequestId: appFailureId.optional(),
    attempt: z.number().int().min(1).max(64).optional(),
    retryable: z.boolean().optional(),
    durationMs: z.number().int().min(0).max(3_600_000).optional(),
    modelKey: z.string().refine(isSafeModelKey, 'Not a catalog-shaped model key').optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    app: z.literal('code'),
    ageMs: z.number().int().min(0).max(APP_FAILURE_LIMITS.ageMsMax),
}).strict()
    .refine(record => record.code === 'unexpected_error' || (APP_FAILURE_CODES[record.category] as readonly string[]).includes(record.code),
        { path: ['code'], message: 'Code does not belong to this category' })
    .refine(record => record.streamReason === undefined || record.stage === 'stream',
        { path: ['streamReason'], message: 'Stream reason requires the stream stage' })
    // Cancellation is neutral and never a failure: its source is required, and
    // `cancelled` belongs to it alone.
    .refine(record => (record.category === 'cancellation') === (record.cancellationSource !== undefined),
        { path: ['cancellationSource'], message: 'Cancellation source is required for cancellation only' })
    .refine(record => (record.category === 'cancellation') === (record.outcome === 'cancelled'),
        { path: ['outcome'], message: 'Only a cancellation has the cancelled outcome' });

export const diagnosticsSchema = z
    .object({
        session: z.object({
            capturedAt: z.string().datetime(), pageAgeMs: int,
            online: z.boolean(), visibility: z.enum(['visible', 'hidden']),
            network: z.object({ effectiveType: z.enum(['slow-2g', '2g', '3g', '4g']).optional(), saveData: z.boolean().optional() }).strict().optional(),
        }).strict(),
        traceApp: z.enum(['secure-browser', 'desktop', 'code', 'app-store', 'settings', 'preview']),
        tracePhases: z.array(z.object({ code: z.string().regex(/^[a-z][a-z0-9_:-]{0,39}$/), tMs: int }).strict()).max(24),
        shellVersion: short(64),
        appCommit: short(64),
        browser: z.object({ family: short(32), major: int }).strict(),
        os: short(32),
        deviceClass: z.enum(['phone', 'tablet', 'desktop']),
        viewport: z.object({ w: int, h: int, dpr: z.number().min(0).max(16) }).strict(),
        fullscreen: z.boolean(),
        fullbleed: z.boolean(),
        computerStatus: short(32),
        traceId: short(64),
        phases: z.array(short(40)).max(24),
        // `reason`/`correlationId` (FEEDBACK-DIAG) are LENGTH-bounded here and
        // SHAPE-allowlisted by `sanitizeDiagnostics`, which drops a mismatch: a
        // charset drift between shell and server must cost one field, not 400
        // the user's whole report.
        recentEvents: z.array(z.object({
            eventClass: short(40), site: short(80), code: short(80),
            ageMs: int.optional(), reason: short(FEEDBACK_LIMITS.recentEventReasonMax).optional(),
            correlationId: short(FEEDBACK_LIMITS.recentEventCorrelationIdMax).optional(),
        }).strict()).max(50),
        // Bounded but lenient on the wire: `sanitizeDiagnostics` validates each
        // entry and drops a malformed one, so it never rejects the whole report.
        appFailures: z.array(z.unknown()).max(APP_FAILURE_LIMITS.recordsMax),
        stream: z.object({ state: short(24).optional(), kbps: int.optional(), rttMs: int.optional() }).strict(),
    })
    .partial()
    .strict();

export type FeedbackDiagnostics = z.infer<typeof diagnosticsSchema>;

const feedbackImageSchema = z
    .object({ contentType: z.enum(FEEDBACK_IMAGE_TYPES), dataBase64: z.string().min(1) })
    .strict();

export type FeedbackImageInput = z.infer<typeof feedbackImageSchema>;

const stagedImageRefSchema = z
    .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), contentType: z.enum(FEEDBACK_IMAGE_TYPES) })
    .strict();

export const feedbackSubmitSchema = z
    .object({
        v: z.literal(1),
        clientRequestId: z.string().uuid(),
        category: z.enum(FEEDBACK_CATEGORIES),
        // A blank description is a valid report: the form has one optional field, and the attachments can carry it.
        description: z.string().trim().max(FEEDBACK_LIMITS.descriptionMax),
        computerId: z.string().uuid().nullable().optional(),
        diagnostics: diagnosticsSchema.nullable().optional(),
        // One image keeps the original key, so older queued bodies and older servers stay compatible.
        screenshot: feedbackImageSchema.nullable().optional(),
        // Two or more images, in the order the reporter arranged them.
        screenshots: z.array(feedbackImageSchema).min(1).max(FEEDBACK_LIMITS.imagesMax).optional(),
        // Upload-first: images already staged by `PUT ?crid=` for this clientRequestId, by hash, in report order.
        screenshotRefs: z.array(stagedImageRefSchema).min(1).max(FEEDBACK_LIMITS.imagesMax).optional(),
    })
    .strict()
    .refine(body => [body.screenshot != null, body.screenshots !== undefined, body.screenshotRefs !== undefined].filter(Boolean).length <= 1,
        { path: ['screenshots'], message: 'Send one of screenshot, screenshots or screenshotRefs' })
    .refine(body => new Set(body.screenshotRefs?.map(ref => ref.sha256)).size === (body.screenshotRefs?.length ?? 0),
        { path: ['screenshotRefs'], message: 'The same image twice' });

export type FeedbackSubmit = z.infer<typeof feedbackSubmitSchema>;
export type StagedImageRef = z.infer<typeof stagedImageRefSchema>;

/** The submitted images as one ordered list, whichever key carried them. */
export function submittedImages(input: Pick<FeedbackSubmit, 'screenshot' | 'screenshots'>): FeedbackImageInput[] {
    return input.screenshots ?? (input.screenshot ? [input.screenshot] : []);
}

export interface FeedbackCreated {
    id: string;
    createdAt: string;
    screenshotAccepted: boolean;
    /** Images stored with the report: all submitted ones, or 0 when the attachment budget refused them. */
    screenshotCount: number;
}

/** Answer to an upload-first `PUT`: the hash the server computed, and whether that report is already stored with it. */
export interface FeedbackStaged {
    sha256: string;
    finalized: boolean;
}

export interface FeedbackReportSummary {
    id: string;
    createdAt: string;
    category: (typeof FEEDBACK_CATEGORIES)[number];
    descriptionPreview: string;
    hasScreenshot: boolean;
    screenshotCount: number;
    status: string;
}

export const FEEDBACK_STATUSES = ['new', 'investigating', 'resolved'] as const;
export const FEEDBACK_ACCESS_ACTIONS = ['view_report', 'view_screenshot', 'delete', 'status_new', 'status_investigating', 'status_resolved'] as const;

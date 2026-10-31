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
    /** FEEDBACK-DIAG: per recent event; see `sanitizeDiagnostics` for the shape allowlist. */
    recentEventReasonMax: 96,
    recentEventCorrelationIdMax: 64,
    /** At most this many recent events (the newest) keep a reason/correlation id. */
    recentEventsAnnotatedMax: 10,
    perUserPerHour: 10,
    perUserPerDay: 30,
    globalAttachmentBytesPerDay: 500 * 1024 * 1024,
    globalAttachmentBytesTotal: 5 * 1024 * 1024 * 1024,
    listMax: 50,
});

export const FEEDBACK_RETENTION_DAYS = Object.freeze({ attachments: 30, reports: 180, accessLog: 365 });

const short = (max: number) => z.string().max(max);
const int = z.number().int().min(0).max(1_000_000_000);

export const diagnosticsSchema = z
    .object({
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
            reason: short(FEEDBACK_LIMITS.recentEventReasonMax).optional(),
            correlationId: short(FEEDBACK_LIMITS.recentEventCorrelationIdMax).optional(),
        }).strict()).max(50),
        stream: z.object({ state: short(24).optional(), kbps: int.optional(), rttMs: int.optional() }).strict(),
    })
    .partial()
    .strict();

export type FeedbackDiagnostics = z.infer<typeof diagnosticsSchema>;

export const feedbackSubmitSchema = z
    .object({
        v: z.literal(1),
        clientRequestId: z.string().uuid(),
        category: z.enum(FEEDBACK_CATEGORIES),
        description: z.string().trim().min(1).max(FEEDBACK_LIMITS.descriptionMax),
        computerId: z.string().uuid().nullable().optional(),
        diagnostics: diagnosticsSchema.nullable().optional(),
        screenshot: z
            .object({ contentType: z.enum(FEEDBACK_IMAGE_TYPES), dataBase64: z.string().min(1) })
            .strict()
            .nullable()
            .optional(),
    })
    .strict();

export type FeedbackSubmit = z.infer<typeof feedbackSubmitSchema>;

export interface FeedbackCreated {
    id: string;
    createdAt: string;
    screenshotAccepted: boolean;
}

export interface FeedbackReportSummary {
    id: string;
    createdAt: string;
    category: (typeof FEEDBACK_CATEGORIES)[number];
    descriptionPreview: string;
    hasScreenshot: boolean;
    status: string;
}

export const FEEDBACK_ACCESS_ACTIONS = ['view_report', 'view_screenshot', 'delete'] as const;

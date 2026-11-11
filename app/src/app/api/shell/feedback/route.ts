import { after } from 'next/server';
import type { FeedbackDb } from '@/server/feedback/ingest';
import { drainFeedbackNotifications } from '@/server/feedback/notifications';
import { feedbackNotificationMailer } from '@/server/feedback/notification-mail';
import { createTRPCContext } from '@/server/api/trpc';
import { deploySha } from '@/server/feedback/deploy-sha';
import { handleFeedbackRequest } from '@/server/feedback/http-handler';
import type { ShellFeatureEnv } from '@/server/shell/features';

export const runtime = 'nodejs';
export const maxDuration = 20;

async function handle(req: Request): Promise<Response> {
    let committedDb: FeedbackDb | undefined;
    const response = await handleFeedbackRequest(req, {
        env: process.env as ShellFeatureEnv,
        deploySha: deploySha(process.env),
        getContext: async (request) => {
            const headers = new Headers(request.headers);
            headers.set('x-trpc-source', 'shell-http');
            const ctx = await createTRPCContext({ headers });
            committedDb = ctx.db;
            return { user: ctx.user, db: ctx.db };
        },
    });
    const mailer = feedbackNotificationMailer(process.env.FEEDBACK_SMTP2GO_API_KEY);
    if (req.method === 'POST' && response.status === 201 && committedDb && mailer) {
        const db = committedDb;
        // Fast delivery after the committed response; process death or a busy
        // drain leaves the durable row for the independent minute cron.
        try { after(async () => {
            try { await drainFeedbackNotifications(db, mailer); }
            catch { console.warn('[feedback] notification delivery deferred'); }
        }); } catch { console.warn('[feedback] notification delivery deferred'); }
    }
    return response;
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
// Explicit exports prevent Next's automatic OPTIONS/HEAD handling from
// bypassing the feature-off 404 (docs/FEEDBACK-CONTROLS-CONTRACT.md:13).
export const PUT = handle;
export const PATCH = handle;
export const OPTIONS = handle;
export const HEAD = handle;

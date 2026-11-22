import { createTRPCContext } from '@/server/api/trpc';
import { db } from '@/server/db';
import { eventsBatch } from '@/server/interview/service';
import { shellErrorResponse, shellJson } from '@/server/shell/http';
import { stagingGitQaAccepted } from '@/server/works/project-repo';

/**
 * `/api/shell/interview-events` (docs/contracts/interview-evidence-v1.md §7.3).
 *
 * A TRANSPORT ONLY: `createTRPCContext` authenticates; `@/server/interview/service` enforces "the bound candidate
 * while started", the closed client-reported type list, the 1-20 batch bound and the 120/min limit, and writes the
 * derived `agent.turn_start` before each `agent.turn_end`. The staging gate is checked first (A6).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
    try {
        const gateOn = stagingGitQaAccepted();
        let body: Record<string, unknown> | null = null;
        try { body = (await req.json()) as Record<string, unknown>; } catch { body = null; }

        const headers = new Headers(req.headers);
        headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({ headers });

        const result = await eventsBatch(db, {
            gateOn, osUserId: ctx.user?.id ?? null,
            interviewId: body?.interviewId, events: body?.events, now: () => new Date().toISOString(),
        });
        return shellJson(result.body, result.status);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/interview-events');
    }
}

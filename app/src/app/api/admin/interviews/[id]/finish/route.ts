import { createTRPCContext } from '@/server/api/trpc';
import { db } from '@/server/db';
import { adminAuthzOf, adminFinish } from '@/server/interview/service';
import { shellErrorResponse, shellJson } from '@/server/shell/http';
import { stagingGitQaAccepted } from '@/server/works/project-repo';

/**
 * `POST /api/admin/interviews/:id/finish` (docs/contracts/interview-evidence-v1.md §7.3): moves to `finished`,
 * idempotent; `interview.finished` is written only when prior state was consented or started. Bearer +
 * `isTelemetryAdmin`. Gate first (A6).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
        const gateOn = stagingGitQaAccepted();
        const { id } = await context.params;
        const ctx = await createTRPCContext({ headers: req.headers });
        const authz = adminAuthzOf(ctx.user, process.env.TELEMETRY_ADMIN_EMAILS);
        const result = await adminFinish(db, { gateOn, authz, interviewId: id, now: () => new Date().toISOString() });
        return shellJson(result.body, result.status);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/admin/interviews/:id/finish');
    }
}

import { createTRPCContext } from '@/server/api/trpc';
import { db } from '@/server/db';
import { adminAuthzOf, adminEvents } from '@/server/interview/service';
import { shellErrorResponse, shellJson } from '@/server/shell/http';
import { stagingGitQaAccepted } from '@/server/works/project-repo';

/**
 * `GET /api/admin/interviews/:id/events` (docs/contracts/interview-evidence-v1.md §7.3): `{v:1, interviewId,
 * identity, events}` in `seq` order, after purging rows older than the 30-day retention. Bearer + `isTelemetryAdmin`;
 * unknown id is 404. Gate first (A6).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
        const gateOn = stagingGitQaAccepted();
        const { id } = await context.params;
        const ctx = await createTRPCContext({ headers: req.headers });
        const authz = adminAuthzOf(ctx.user, process.env.TELEMETRY_ADMIN_EMAILS);
        const result = await adminEvents(db, { gateOn, authz, interviewId: id });
        return shellJson(result.body, result.status);
    } catch (err) {
        return shellErrorResponse(err, 'GET /api/admin/interviews/:id/events');
    }
}

import { createTRPCContext } from '@/server/api/trpc';
import { db } from '@/server/db';
import { adminAuthzOf, adminBearerPrecheck, adminRegister } from '@/server/interview/service';
import { shellErrorResponse, shellJson } from '@/server/shell/http';
import { stagingGitQaAccepted } from '@/server/works/project-repo';

/**
 * `POST /api/admin/interviews` (docs/contracts/interview-evidence-v1.md §7.3): the operator registers an interview
 * in `registered`. Bearer + `isTelemetryAdmin`; the same body again is 200, a conflicting one is 409. Gate first (A6).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
    try {
        const gateOn = stagingGitQaAccepted();
        // E4: require a bearer and never reach createTRPCContext's cookie fallback (a browser cookie cannot drive this).
        const precheck = adminBearerPrecheck(gateOn, req.headers.get('authorization'));
        if (precheck) return shellJson(precheck.body, precheck.status);
        let body: unknown = null;
        try { body = await req.json(); } catch { body = null; }
        const ctx = await createTRPCContext({ headers: req.headers });
        const authz = adminAuthzOf(ctx.user, process.env.TELEMETRY_ADMIN_EMAILS);
        const result = await adminRegister(db, { gateOn, authz, body });
        return shellJson(result.body, result.status);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/admin/interviews');
    }
}

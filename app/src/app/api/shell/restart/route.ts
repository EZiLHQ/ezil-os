import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/restart` — restart the desktop stack inside one of the caller's
 * live containers, without destroying the container, the computer, or the
 * workspace.
 *
 * This is the app-side half of a seam that shipped in two pieces: the Worker
 * built `POST /sandbox/:name/restart` and the shell built
 * `shell/ezil/ui/Settings/tabs/troubleshoot.js` + `session.restartDesktop()`,
 * but nothing connected them and no `restart` key was published, so the button
 * feature-detected itself permanently OFF. Exactly like `../focus/route.ts`,
 * adding this file AND the `restart` key to `SHELL_API_ROUTES` at the same time
 * is what turns the control on; neither alone does anything, and the key must
 * be removed the moment this file is.
 *
 * 🔴 `maxDuration = 300`, matching `../desktop/route.ts` rather than
 * `../focus/route.ts`, and that is the point of difference between them. A
 * focus switch is one 150-400ms `exec`. A restart is a SIGTERM the Worker will
 * wait up to 20s to see confirmed (`RESTART_STOP_DEADLINE_MS`) followed by the
 * same ~22s cold boot `/sandbox/preview` pays — so the platform's 10-15s
 * default (docs/PLATFORM-NOTES.md §13) would kill this handler in the middle of
 * a restart that was going to succeed, and the user would be told it failed
 * while their desktop quietly came back.
 * AWS also needs this budget: its Worker only queues the host restart (202).
 * requestAwsRestart waits up to 180s for the new Neko runtime, whose startup
 * gate includes code-server readiness, before this route returns success.
 *
 * Like every other `/api/shell/*` handler this is a TRANSPORT only. Ownership
 * is checked exactly once, inside the procedure; the sandbox id is derived
 * there from the session, never read from this body.
 *
 *   POST { computerId } -> { ok, errorCode?, correlationId? }
 *
 * Round 3: an AWS desktop restart answers a DISTINCT `errorCode`
 * (`restart_not_running|busy|budget_exhausted|host_unreachable|timeout|unavailable`), and
 * `{ computerId, scope: 'computer', requestId }` restarts the WHOLE computer (stop, then a
 * server-initiated open on the same size) and returns at once with its transition:
 *   -> { ok: true, transitionId, path: 'restart', size } | { ok: false, errorCode: 'restart_<reason>' }
 * Progress of that restart is `computer.progress` (docs/aws-computers/SWITCH-CONTRACT.md).
 */
export const maxDuration = 300;

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body, same order as the sibling
        // routes: an unauthenticated caller learns exactly one thing.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '', scope = 'desktop', requestId } = (body ?? {}) as { computerId?: string; scope?: unknown; requestId?: string };
        if (scope !== 'desktop' && scope !== 'computer') {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Unknown restart scope.' } }, 400);
        }
        if (scope === 'computer') {
            const result = await caller.computer.restartComputer({ computerId, requestId: requestId ?? '' });
            return shellJson(result.ok ? result : { ok: false, errorCode: `restart_${result.reason}`, reason: result.reason });
        }

        const result = await caller.cloudflareGuacamole.restartDesktop({ computerId, ...(requestId === undefined ? {} : { requestId }) });

        return shellJson(result);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/restart');
    }
}

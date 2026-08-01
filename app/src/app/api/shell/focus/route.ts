import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/focus` — foreground an app inside one of the caller's computers.
 *
 * This is the transport the shell's in-stream app switcher feature-detects.
 * Before it existed, `shell/ezil/apps/desktop-window.js` looked for
 * `desktopState.endpoints.focus`, found nothing, and (correctly) drew no
 * switcher at all rather than POST to a URL it had invented. Adding the key to
 * `SHELL_API_ROUTES` and this file at the same time is what turns the switcher
 * on; neither alone does anything.
 *
 * 🔴 NO `maxDuration` override, unlike `../desktop/route.ts` and
 * `../preview-url/route.ts`, and that is a decision rather than an omission.
 * Those two can cold-boot a container (~22s measured) and would be killed by
 * the platform's 10-15s default (docs/PLATFORM-NOTES.md §13). This one cannot:
 * `cloudflareGuacamole.focusApp` calls `POST /sandbox/:name/focus`, whose only
 * work is one `exec` of `neko-switch-app.sh` against a container the user is
 * already streaming — measured at 150-400ms, bounded at 15s by the provider's
 * own `AbortSignal.timeout`. A focus switch that needs five minutes is a focus
 * switch that has failed, and should say so rather than hang.
 *
 * Like every other `/api/shell/*` handler this is a TRANSPORT only. Ownership
 * is checked exactly once, inside the procedure, and the `app` value is
 * validated exactly once, by that procedure's `z.enum(FOCUSABLE_APPS)` — one
 * authorization implementation, one validation implementation.
 *
 *   POST { computerId, app } -> { ok, app, error?, correlationId }
 */

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body — an unauthenticated caller
        // should learn exactly one thing (not signed in), not whether their
        // JSON happened to be well-formed. Same order as the sibling routes.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '', app = '' } = (body ?? {}) as { computerId?: string; app?: string };

        const result = await caller.cloudflareGuacamole.focusApp({
            computerId,
            // Cast, not re-validation: the procedure's zod enum is the single
            // gate, and it rejects anything else as a 400. Re-checking here
            // would be a second implementation of the same rule, free to drift.
            app: app as 'chromium',
        });

        return shellJson(result);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/focus');
    }
}

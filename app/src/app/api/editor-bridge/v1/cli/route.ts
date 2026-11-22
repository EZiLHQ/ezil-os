import { handleEditorCli, type CliChannelDeps } from '@/server/agent-session/cli-channel';
import { createSession } from '@/server/agent-session/control-store';
import { getSession, listEvents, listSessions, sendInstruction, type SessionDb } from '@/server/agent-session/store';
import { computerForSandbox } from '@/server/agent-session/sync-route';
import { editorDelegationEnabled } from '@/server/api/editor-delegation';
import { db } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Worker-forwarded Chat CLI channel; see `server/agent-session/cli-channel.ts`. */
export async function POST(request: Request): Promise<Response> {
    const database = db as unknown as SessionDb;
    return handleEditorCli(request, {
        db: database,
        secret: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET,
        enabled: editorDelegationEnabled(process.env) && process.env.EZIL_EDITOR_CLI === 'enabled',
        now: () => Date.now(),
        computerForSandbox,
        services: {
            create: (d, caller, input) => createSession(d, caller, input),
            send: (d, caller, input) => sendInstruction(d, caller, input),
            list: (d, userId, computerId) => listSessions(d, userId, computerId),
            getSession: (d, userId, sessionId) => getSession(d, userId, sessionId),
            events: (d, userId, sessionId, after, limit) => listEvents(d, userId, sessionId, after, limit),
        },
    } satisfies CliChannelDeps);
}

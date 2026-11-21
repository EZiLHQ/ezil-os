import { z } from 'zod';

export const BROWSER_OBSERVE_SCOPE = 'ezil:browser:read';
export const BROWSER_OBSERVE_PROCEDURE = 'browserSession.observe';
export const BROWSER_OBSERVE_PATH = /^\/api\/mcp\/browser-sessions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/observe$/;
export const BROWSER_STAGING_MCP = 'https://connect-staging.ezil.work';
export const BROWSER_STAGING_OS = 'https://os-staging.ezil.work';
export const BROWSER_STAGING_WORKER = 'https://api-desktop-staging.ezil.work';
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const browserObserveRequest = z.object({ browserSessionId: sessionId.optional() }).strict();
export type BrowserObserveRequest = z.infer<typeof browserObserveRequest>;
export const browserObserveSuccess = z.object({
    ok: z.literal(true),
    browserSessionId: sessionId,
    expiresAt: z.string().datetime({ precision: 3 }),
    observed: z.enum(['profile_builder', 'interactive_sign_in_required']),
    profileHeadingVisible: z.boolean(),
    universeIdentity: z.literal('unverified'),
}).strict();
export const browserRuntimeFailure = z.object({
    ok: z.literal(false),
    error: z.enum(['browser_page_unavailable', 'browser_session_stale', 'browser_unavailable']),
}).strict();

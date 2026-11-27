import { startWorkAuth } from '@/server/auth/work-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The hidden child of a cold EZiL OS assignment frame: one silent EZiL ID attempt. See `@/server/auth/work-auth`. */
export function GET(request: Request): Response {
    return startWorkAuth(request);
}

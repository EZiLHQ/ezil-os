import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/env';
import * as schema from './schema';

/**
 * `postgres.js` connection pool, tuned per `docs/PLATFORM-NOTES.md` §13
 * ("Serverless multiplies DB pools"):
 *
 *   - `max`           — capped explicitly. A serverless platform (Vercel)
 *                       spins up many warm instances, each carrying its own
 *                       pool; an unbounded (or large) per-instance pool
 *                       multiplies against instance count and can exhaust
 *                       Postgres' own connection limit. Kept small — this
 *                       app talks to Supabase's transaction pooler, which
 *                       already multiplexes connections upstream.
 *   - `idle_timeout`  — NON-ZERO so idle connections are released back to
 *                       the pooler instead of held open indefinitely by a
 *                       warm serverless instance that may sit idle for
 *                       minutes between invocations.
 *   - `prepare: false`— required for Supabase's transaction-mode pooler,
 *                       which does not support prepared statements (each
 *                       pooled connection may be reused across unrelated
 *                       client sessions).
 */
const queryClient = postgres(env.SUPABASE_DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    prepare: false,
});

export const db = drizzle(queryClient, { schema });

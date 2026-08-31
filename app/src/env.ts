import { z } from 'zod';

/**
 * Server-only environment. Validated eagerly at import time so a missing
 * variable fails loudly at boot instead of surfacing as a confusing runtime
 * error deep in a request handler.
 *
 * `CLOUDFLARE_GUACAMOLE_WORKER_URL` / `CLOUDFLARE_GUACAMOLE_HMAC_SECRET` are
 * optional here (not every environment — e.g. a local dev box without a
 * deployed Worker — has them wired up yet); callers that need the desktop
 * provider check `resolveCloudflareGuacamoleConfig().isConfigured` rather
 * than assuming these are always present.
 */
const serverSchema = z.object({
    SUPABASE_DATABASE_URL: z.string().min(1, 'SUPABASE_DATABASE_URL is required'),
    CLOUDFLARE_GUACAMOLE_WORKER_URL: z.string().optional(),
    CLOUDFLARE_GUACAMOLE_HMAC_SECRET: z.string().optional(),
    /**
     * Guards `POST /api/cron/telemetry-maintenance` (the hourly telemetry
     * retention job — see `docs/telemetry.md` and
     * `docs/telemetry-design.md` §7.2). Vercel Cron sends
     * `Authorization: Bearer $CRON_SECRET` automatically when this env var
     * is set on the project.
     *
     * OPTIONAL and UNSET BY DEFAULT on purpose: if it is missing, the route
     * returns 404 rather than running unauthenticated — fail CLOSED, so a
     * deploy that forgot to configure the secret cannot expose a delete
     * endpoint to the internet. `.min(32)` is a floor, not a real strength
     * guarantee; treat it as a shared secret, not a password.
     */
    CRON_SECRET: z.string().min(32).optional(),
    /**
     * Comma-separated allow-list of emails permitted to open
     * `/admin/telemetry` (see `@/server/telemetry/admin.ts`). No roles table
     * exists in this schema, and introducing one for a single internal
     * review page is out of scope here — this is the smallest correct gate,
     * not a placeholder for a fancier one. Unset by default: with no
     * allow-list configured, the page is unreachable by anyone (fail
     * closed), never "reachable by every signed-in user".
     */
    TELEMETRY_ADMIN_EMAILS: z.string().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

/**
 * Client-safe environment — every key here is inlined into the browser
 * bundle at build time by Next.js. Never put a secret in this schema.
 */
const clientSchema = z.object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_URL is required'),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
});

const isServer = typeof window === 'undefined';

const parsedServer = isServer
    ? serverSchema.safeParse({
          SUPABASE_DATABASE_URL: process.env.SUPABASE_DATABASE_URL,
          CLOUDFLARE_GUACAMOLE_WORKER_URL: process.env.CLOUDFLARE_GUACAMOLE_WORKER_URL,
          CLOUDFLARE_GUACAMOLE_HMAC_SECRET: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET,
          CRON_SECRET: process.env.CRON_SECRET,
          TELEMETRY_ADMIN_EMAILS: process.env.TELEMETRY_ADMIN_EMAILS,
          NODE_ENV: process.env.NODE_ENV,
      })
    : null;

if (parsedServer && !parsedServer.success) {
    console.error(
        '[env] Invalid server environment variables:',
        parsedServer.error.flatten().fieldErrors,
    );
    throw new Error('Invalid server environment variables — see console output above.');
}

const parsedClient = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!parsedClient.success) {
    console.error(
        '[env] Invalid client environment variables:',
        parsedClient.error.flatten().fieldErrors,
    );
    throw new Error('Invalid client environment variables — see console output above.');
}

export const env = {
    ...(parsedServer?.data ?? {
        SUPABASE_DATABASE_URL: '',
        CLOUDFLARE_GUACAMOLE_WORKER_URL: undefined,
        CLOUDFLARE_GUACAMOLE_HMAC_SECRET: undefined,
        CRON_SECRET: undefined,
        TELEMETRY_ADMIN_EMAILS: undefined,
        NODE_ENV: process.env.NODE_ENV ?? 'development',
    }),
    ...parsedClient.data,
};

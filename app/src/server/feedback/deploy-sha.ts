/**
 * The deployed commit a feedback report is stamped with (round-3 F6). Same
 * source as `/api/health` (`app/src/app/api/health/route.ts`): the image's
 * `EZIL_GIT_SHA` (set from the Docker build arg, `app/Dockerfile`), falling
 * back to Vercel's commit SHA. Anything that is not a lowercase hex object id
 * is dropped to null, so a mis-set env value can never be stored as a "SHA".
 * Stamped server-side, never taken from the client: diagnostics consent is
 * off by default, and a client value could be forged.
 */
const SHA = /^[0-9a-f]{7,64}$/;

export function deploySha(envIn: Readonly<Record<string, string | undefined>> = process.env): string | null {
    const raw = envIn.EZIL_GIT_SHA || envIn.VERCEL_GIT_COMMIT_SHA || '';
    return SHA.test(raw) ? raw : null;
}

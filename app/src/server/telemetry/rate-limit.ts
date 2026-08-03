/**
 * Best-effort, PER-INSTANCE rate limit on telemetry ingest, keyed by
 * `user_hash`. Stated plainly: this is NOT a distributed rate limiter.
 * Vercel runs many warm serverless instances, each with its own in-memory
 * `Map`, so the true worst-case ceiling under a determined flood from one
 * account is (this limit) × (instance count), not this limit alone.
 *
 * It exists as a first, free line of defence ahead of the two controls that
 * DO hold regardless of instance count:
 *   - `TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH` bounds a single request's cost.
 *   - `shouldShedLoad()` (`./load-shed.ts`) bounds the whole table's write
 *     rate against the ACTUAL row count, globally, no matter which user or
 *     how many instances are hammering it.
 * A user who defeats this per-instance limiter by hitting many instances
 * still cannot out-run the global row-count breaker.
 */

const WINDOW_MS = 60_000;
/** The shell flushes at most every 10s (design §4.3) plus visibility-change
 * and pagehide triggers — a legitimate client rarely exceeds a handful of
 * requests per minute. 20 leaves generous headroom for tab-juggling. */
const MAX_REQUESTS_PER_WINDOW = 20;
/** Bounds the tracking Map itself so a flood of DISTINCT (or spoofed) user
 * hashes cannot grow it without limit — fails OPEN (does not rate-limit new
 * users) once full, trusting `shouldShedLoad()` as the real backstop. */
const MAX_TRACKED_USERS = 20_000;

interface Bucket {
    count: number;
    windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** `true` when this request should be dropped for exceeding its per-user,
 * per-instance, per-minute budget. Never throws. */
export function isRateLimited(userHash: string): boolean {
    const now = Date.now();
    const existing = buckets.get(userHash);

    if (!existing || now - existing.windowStart >= WINDOW_MS) {
        if (!existing && buckets.size >= MAX_TRACKED_USERS) return false; // fail open, see doc comment
        buckets.set(userHash, { count: 1, windowStart: now });
        return false;
    }

    existing.count++;
    return existing.count > MAX_REQUESTS_PER_WINDOW;
}

/** Test-only: drop all tracked buckets. */
export function resetRateLimitForTests(): void {
    buckets.clear();
}

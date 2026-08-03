/**
 * The gate on `/admin/telemetry` (the review page — job 2 of the telemetry
 * design). A comma-separated, human-edited email allow-list read from
 * `TELEMETRY_ADMIN_EMAILS`. No roles table exists in this schema
 * (`@/server/db/schema`), and inventing one for a single internal page is
 * new infrastructure the brief does not ask for — this is the smallest
 * correct gate, not a stand-in for a fancier one.
 *
 * FAILS CLOSED: an unset or empty allow-list means the page is unreachable
 * by EVERY signed-in user, never reachable by all of them. There is no
 * "if unconfigured, allow" branch anywhere in this file.
 */

/** Pure so it is trivially testable without `@/env`'s eager validation. */
export function isTelemetryAdmin(email: string | null | undefined, allowList: string | undefined): boolean {
    if (!email || !allowList) return false;
    const normalizedTarget = email.trim().toLowerCase();
    if (!normalizedTarget) return false;
    const allowed = allowList
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    return allowed.includes(normalizedTarget);
}

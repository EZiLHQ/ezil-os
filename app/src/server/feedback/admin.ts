/**
 * The feedback review allow-list, read from FEEDBACK_ADMIN_EMAILS by the
 * server entry points. Unconfigured means nobody; no role or owner bypass.
 * Pure for tests, without importing the eagerly validated environment.
 */
export function isFeedbackAdmin(email: string | null | undefined, allowList: string | undefined): boolean {
    if (!email || !allowList) return false;
    const target = email.trim().toLowerCase();
    if (!target) return false;
    return allowList.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).includes(target);
}

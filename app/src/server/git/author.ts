/** Repo-local commit attribution, supplied only after verifying the EZiL ID token. */
export interface GitAuthor { name: string; email: string }

const safeName = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f<>]/u.test(value);
const safeEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254
    && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/u.test(value);

export function isGitAuthor(value: unknown): value is GitAuthor {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const author = value as Record<string, unknown>;
    return Object.keys(author).sort().join(',') === 'email,name' && safeName(author.name) && safeEmail(author.email);
}

/** Call only with the signed claims of an already verified ID token, never browser profile metadata. */
export function gitAuthorFromVerifiedClaims(claims: Record<string, unknown>): GitAuthor | undefined {
    if (claims.email_verified !== true || !safeEmail(claims.email)) return undefined;
    const displayName = typeof claims.name === 'string' ? claims.name.trim() : undefined;
    const name = safeName(displayName) ? displayName : claims.email.slice(0, claims.email.indexOf('@'));
    return safeName(name) ? { name, email: claims.email } : undefined;
}
